import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COUPON_SQL, checkCoupon } from "../src/shared/coupons-db";
import { priceFor } from "../src/shared/pricing";
import { adminGet, adminPost, codeOf, db, get, newAdminSession, newOwner, passTurnstile } from "./helpers";

// Discount coupons (issue #40). Test values only.
beforeEach(() => passTurnstile());
afterEach(() => vi.restoreAllMocks());

async function proId() {
  return (await db.prepare("SELECT id FROM plans WHERE legacy_key = 'pro'").first<{ id: string }>())?.id ?? "";
}

async function priceThePro() {
  await db.prepare("UPDATE plans SET monthly_price_minor = 150000, yearly_price_minor = 1500000 WHERE legacy_key = 'pro'").run();
}

let codeSeq = 0;
/** A coupon form with every field. Codes are unique per test. */
function couponForm(overrides: Record<string, string> = {}) {
  codeSeq++;
  return { code: `TEST${codeSeq}`, percent_off: "20", billing_period: "any", duration: "once", plan_id: "", restaurant: "", max_redemptions: "", expires: "", ...overrides };
}

async function coupon(code: string) {
  return db
    .prepare("SELECT id, code, percent_off, billing_period, duration, plan_id, restaurant_id, max_redemptions, redeemed_count, expires_at, status FROM coupons WHERE code = ?")
    .bind(code)
    .first<Record<string, unknown>>();
}

async function subscription(restaurantId: string) {
  return db
    .prepare("SELECT price_minor, coupon_id, coupon_percent_off, coupon_duration FROM subscriptions WHERE restaurant_id = ?")
    .bind(restaurantId)
    .first<{ price_minor: number; coupon_id: string | null; coupon_percent_off: number | null; coupon_duration: string | null }>();
}

describe("priceFor", () => {
  it.each([
    ["no coupon", 150000, null, false, { listMinor: 150000, discountMinor: 0, finalMinor: 150000 }],
    ["20% of Rs 1,500", 150000, { percentOff: 20, duration: "once" }, false, { listMinor: 150000, discountMinor: 30000, finalMinor: 120000 }],
    ["50% of Rs 15,000", 1500000, { percentOff: 50, duration: "recurring" }, false, { listMinor: 1500000, discountMinor: 750000, finalMinor: 750000 }],
    ["100% is free, never below 0", 150050, { percentOff: 100, duration: "once" }, false, { listMinor: 150050, discountMinor: 150050, finalMinor: 0 }],
    // 15% of Rs 999 is Rs 149.85, so the discount rounds to Rs 150.
    ["rounds the discount to the nearest rupee", 99900, { percentOff: 15, duration: "once" }, false, { listMinor: 99900, discountMinor: 15000, finalMinor: 84900 }],
    // 10% of Rs 5 is Rs 0.50, which rounds up to Rs 1.
    ["rounds .5 up", 500, { percentOff: 10, duration: "once" }, false, { listMinor: 500, discountMinor: 100, finalMinor: 400 }],
    ["a one-time coupon does not apply to a renewal", 150000, { percentOff: 20, duration: "once" }, true, { listMinor: 150000, discountMinor: 0, finalMinor: 150000 }],
    ["a recurring coupon applies to a renewal", 150000, { percentOff: 20, duration: "recurring" }, true, { listMinor: 150000, discountMinor: 30000, finalMinor: 120000 }],
  ] as const)("%s", (_label, listMinor, couponValue, isRenewal, expected) => {
    expect(priceFor({ listMinor, coupon: couponValue, isRenewal })).toEqual(expected);
  });
});

describe("admin coupon pages", () => {
  it("are closed to owners and visitors", async () => {
    const owner = await newOwner("Coupon Closed");
    for (const cookie of [undefined, owner.cookie]) {
      for (const path of ["/coupons", "/coupons/new"]) {
        const response = await adminGet(path, cookie);
        expect(response.status).toBe(303);
        expect(response.headers.get("location")).toBe("/login");
      }
    }
    const form = couponForm();
    expect((await adminPost("/coupons", form, owner.cookie)).status).toBe(303);
    expect(await coupon(form.code)).toBeNull();
  });

  it("creates a coupon with every rule, stored uppercase, and logs it", async () => {
    const admin = await newAdminSession();
    const owner = await newOwner("Coupon Target");
    const code = await codeOf(owner.restaurantId);
    const pro = await proId();
    const response = await adminPost(
      "/coupons",
      { code: "ramzan-50", percent_off: "50", billing_period: "yearly", duration: "recurring", plan_id: pro, restaurant: code, max_redemptions: "10", expires: "2099-12-31" },
      admin.cookie,
    );
    expect(response.status).toBe(303);
    expect(await coupon("RAMZAN-50")).toMatchObject({
      code: "RAMZAN-50",
      percent_off: 50,
      billing_period: "yearly",
      duration: "recurring",
      plan_id: pro,
      restaurant_id: owner.restaurantId,
      max_redemptions: 10,
      redeemed_count: 0,
      expires_at: Date.UTC(2099, 11, 31, 23, 59, 59, 999) - 5 * 60 * 60 * 1000,
      status: "active",
    });
    const log = await db.prepare("SELECT action FROM audit_log WHERE action = 'coupon_created' AND details LIKE '%RAMZAN-50%'").first();
    expect(log).not.toBeNull();
    const list = await (await adminGet("/coupons", admin.cookie)).text();
    expect(list).toContain("RAMZAN-50");
    expect(list).toContain("0 of 10");
  });

  it.each([
    ["a short code", { code: "AB" }],
    ["a code with spaces", { code: "BAD CODE" }],
    ["a code with other characters", { code: "50%OFF" }],
    ["0 percent", { percent_off: "0" }],
    ["over 100 percent", { percent_off: "101" }],
    ["a percent that is not a whole number", { percent_off: "12.5" }],
    ["an unknown period", { billing_period: "weekly" }],
    ["an unknown duration", { duration: "forever" }],
    ["an unknown plan", { plan_id: "0123456789abcdef0123456789abcdef" }],
    ["an unknown restaurant", { restaurant: "zzzzzz" }],
    ["a use limit of 0", { max_redemptions: "0" }],
    ["a past expiry", { expires: "2020-01-01" }],
  ])("refuses %s and saves nothing", async (_label, change) => {
    const admin = await newAdminSession();
    const form = couponForm(change);
    const before = await db.prepare("SELECT COUNT(*) AS n FROM coupons").first<{ n: number }>();
    expect((await adminPost("/coupons", form, admin.cookie)).status).toBe(400);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM coupons").first<{ n: number }>())?.n).toBe(before?.n);
  });

  it("refuses a free plan for a coupon", async () => {
    const admin = await newAdminSession();
    const free = (await db.prepare("SELECT id FROM plans WHERE legacy_key = 'free'").first<{ id: string }>())?.id ?? "";
    const form = couponForm({ plan_id: free });
    expect((await adminPost("/coupons", form, admin.cookie)).status).toBe(400);
    expect(await coupon(form.code)).toBeNull();
  });

  it("refuses a code that already exists, in any letter case", async () => {
    const admin = await newAdminSession();
    await adminPost("/coupons", couponForm({ code: "TWICE" }), admin.cookie);
    expect((await adminPost("/coupons", couponForm({ code: "twice" }), admin.cookie)).status).toBe(400);
  });

  it("disables and enables a coupon, never deletes it, and logs both", async () => {
    const admin = await newAdminSession();
    const form = couponForm();
    await adminPost("/coupons", form, admin.cookie);
    const id = String((await coupon(form.code))?.id);
    expect((await adminPost(`/coupons/${id}/disable`, {}, admin.cookie)).status).toBe(303);
    expect((await coupon(form.code))?.status).toBe("disabled");
    expect((await adminPost(`/coupons/${id}/enable`, {}, admin.cookie)).status).toBe(303);
    expect((await coupon(form.code))?.status).toBe("active");
    expect((await adminPost(`/coupons/${id}/delete`, {}, admin.cookie)).status).toBe(404);
    const actions = await db.prepare("SELECT action FROM audit_log WHERE details LIKE ? ORDER BY created_at, id").bind(`%${form.code}%`).all<{ action: string }>();
    expect(actions.results.map((r) => r.action)).toEqual(["coupon_created", "coupon_disabled", "coupon_enabled"]);
  });
});

describe("checkCoupon", () => {
  async function made(form: Record<string, string>): Promise<string> {
    const admin = await newAdminSession();
    const full = couponForm(form);
    expect((await adminPost("/coupons", full, admin.cookie)).status).toBe(303);
    return full.code;
  }

  it("accepts a valid coupon in any letter case", async () => {
    const owner = await newOwner("Check Ok");
    const code = await made({ percent_off: "25" });
    const result = await checkCoupon(db, code.toLowerCase(), { restaurantId: owner.restaurantId, planId: await proId(), period: "monthly", now: Date.now() });
    expect(result).toMatchObject({ ok: true, coupon: { percentOff: 25, duration: "once" } });
  });

  it.each([
    ["not found", async (): Promise<string> => "NOPE-NOPE", "not found"],
    ["disabled", async (): Promise<string> => {
      const code = await made({});
      await db.prepare("UPDATE coupons SET status = 'disabled' WHERE code = ?").bind(code).run();
      return code;
    }, "disabled"],
    ["expired", async (): Promise<string> => {
      const code = await made({ expires: "2099-01-01" });
      await db.prepare("UPDATE coupons SET expires_at = 1 WHERE code = ?").bind(code).run();
      return code;
    }, "expired"],
    ["used up", async (): Promise<string> => {
      const code = await made({ max_redemptions: "1" });
      await db.prepare("UPDATE coupons SET redeemed_count = 1 WHERE code = ?").bind(code).run();
      return code;
    }, "used up"],
    ["not for this billing period", async (): Promise<string> => made({ billing_period: "yearly" }), "not for this billing period"],
    ["not for this plan", async (): Promise<string> => {
      const other = "c0ffee00c0ffee00c0ffee00c0ffee00";
      const now = Date.now();
      await db.prepare("INSERT OR IGNORE INTO plans (id, name, is_free, status, sort_order, created_at, updated_at) VALUES (?, 'Other paid', 0, 'active', 60, ?, ?)").bind(other, now, now).run();
      return made({ plan_id: other });
    }, "not for this plan"],
    ["not for this restaurant", async (): Promise<string> => {
      const someoneElse = await newOwner("Check Other");
      return made({ restaurant: await codeOf(someoneElse.restaurantId) });
    }, "not for this restaurant"],
  ] as const)("refuses a coupon that is %s", async (_label, setup, reason) => {
    const owner = await newOwner("Check Refuse");
    const code = await setup();
    const result = await checkCoupon(db, code, { restaurantId: owner.restaurantId, planId: await proId(), period: "monthly", now: Date.now() });
    expect(result).toEqual({ ok: false, reason, ownerMessage: reason === "not found" || reason === "not for this restaurant" ? "This coupon cannot be used." : expect.any(String) });
  });
});

describe("coupons on the admin plan form", () => {
  async function adminAndOwner(name: string) {
    await priceThePro();
    const admin = await newAdminSession();
    const owner = await newOwner(name);
    return { admin, owner, pro: await proId() };
  }

  it("shows the final price before saving, and changes nothing", async () => {
    const { admin, owner, pro } = await adminAndOwner("Coupon Preview");
    const code = couponForm({ percent_off: "20" });
    await adminPost("/coupons", code, admin.cookie);
    const response = await adminPost(`/restaurants/${owner.restaurantId}/plan`, { plan_id: pro, period: "monthly", end: "period", coupon: code.code, intent: "preview" }, admin.cookie);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("Rs 1,500");
    expect(body).toContain("Rs 1,200");
    expect((await subscription(owner.restaurantId))?.price_minor).toBe(0);
    expect((await coupon(code.code))?.redeemed_count).toBe(0);
  });

  it("saves the discounted price and the coupon snapshot, and records one use", async () => {
    const { admin, owner, pro } = await adminAndOwner("Coupon Save");
    const code = couponForm({ percent_off: "50", duration: "recurring", billing_period: "yearly" });
    await adminPost("/coupons", code, admin.cookie);
    expect((await adminPost(`/restaurants/${owner.restaurantId}/plan`, { plan_id: pro, period: "yearly", end: "period", coupon: code.code }, admin.cookie)).status).toBe(303);
    const sub = await subscription(owner.restaurantId);
    const saved = await coupon(code.code);
    expect(sub).toEqual({ price_minor: 750000, coupon_id: saved?.id, coupon_percent_off: 50, coupon_duration: "recurring" });
    expect(saved?.redeemed_count).toBe(1);
    const redemption = await db.prepare("SELECT 1 FROM coupon_redemptions WHERE coupon_id = ? AND restaurant_id = ?").bind(saved?.id, owner.restaurantId).first();
    expect(redemption).not.toBeNull();
    const audit = await db.prepare("SELECT details FROM audit_log WHERE restaurant_id = ? AND action = 'subscription_changed'").bind(owner.restaurantId).first<{ details: string }>();
    expect(JSON.parse(audit?.details ?? "{}")).toMatchObject({ to: { price: 750000, coupon: code.code } });
  });

  it("clears the coupon snapshot when a plan is set without a coupon", async () => {
    const { admin, owner, pro } = await adminAndOwner("Coupon Clear");
    const code = couponForm({ duration: "recurring" });
    await adminPost("/coupons", code, admin.cookie);
    await adminPost(`/restaurants/${owner.restaurantId}/plan`, { plan_id: pro, period: "monthly", end: "period", coupon: code.code }, admin.cookie);
    await adminPost(`/restaurants/${owner.restaurantId}/plan`, { plan_id: pro, period: "monthly", end: "period", coupon: "" }, admin.cookie);
    expect(await subscription(owner.restaurantId)).toEqual({ price_minor: 150000, coupon_id: null, coupon_percent_off: null, coupon_duration: null });
  });

  it("refuses a coupon the restaurant cannot use, and changes nothing", async () => {
    const { admin, owner, pro } = await adminAndOwner("Coupon Refuse");
    const code = couponForm({ billing_period: "yearly" });
    await adminPost("/coupons", code, admin.cookie);
    const response = await adminPost(`/restaurants/${owner.restaurantId}/plan`, { plan_id: pro, period: "monthly", end: "period", coupon: code.code }, admin.cookie);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("not for this billing period");
    expect((await subscription(owner.restaurantId))?.price_minor).toBe(0);
  });

  it("refuses the same coupon twice for one restaurant", async () => {
    const { admin, owner, pro } = await adminAndOwner("Coupon Twice");
    const code = couponForm({});
    await adminPost("/coupons", code, admin.cookie);
    await adminPost(`/restaurants/${owner.restaurantId}/plan`, { plan_id: pro, period: "monthly", end: "period", coupon: code.code }, admin.cookie);
    const second = await adminPost(`/restaurants/${owner.restaurantId}/plan`, { plan_id: pro, period: "monthly", end: "period", coupon: code.code }, admin.cookie);
    expect(second.status).toBe(400);
    expect((await coupon(code.code))?.redeemed_count).toBe(1);
  });

  it("never goes over the use limit, even when two are saved at once", async () => {
    await priceThePro();
    const admin = await newAdminSession();
    const a = await newOwner("Coupon Race A");
    const b = await newOwner("Coupon Race B");
    const code = couponForm({ max_redemptions: "1" });
    await adminPost("/coupons", code, admin.cookie);
    const pro = await proId();
    const results = await Promise.all(
      [a, b].map((owner) => adminPost(`/restaurants/${owner.restaurantId}/plan`, { plan_id: pro, period: "monthly", end: "period", coupon: code.code }, admin.cookie)),
    );
    expect(results.map((r) => r.status).sort()).toEqual([303, 400]);
    expect((await coupon(code.code))?.redeemed_count).toBe(1);
    const redeemed = await db.prepare("SELECT COUNT(*) AS n FROM coupon_redemptions WHERE coupon_id = ?").bind((await coupon(code.code))?.id).first<{ n: number }>();
    expect(redeemed?.n).toBe(1);
    // The restaurant that lost keeps its old plan and price.
    const prices = [(await subscription(a.restaurantId))?.price_minor, (await subscription(b.restaurantId))?.price_minor].sort();
    expect(prices).toEqual([0, 120000]);
  });

  it("is not reachable from the owner area", async () => {
    const owner = await newOwner("Coupon Owner Area");
    expect((await get("/coupons", owner.cookie)).status).toBe(404);
  });
});

describe("coupon queries", () => {
  // Law 26: lookups use indexes, and the list pages by keyset.
  it.each(Object.entries(COUPON_SQL))("%s searches an index and needs no extra sort", async (name, sql) => {
    const numbered = new Set(sql.match(/\?\d/g) ?? []).size;
    const values = Array.from({ length: numbered || (sql.match(/\?/g) ?? []).length }, () => "x");
    const { results } = await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...values).all<{ detail: string }>();
    const details = results.map((row) => row.detail);
    expect(details.filter((d) => d.includes("TEMP B-TREE"))).toEqual([]);
    const scans = details.filter((d) => d.startsWith("SCAN"));
    expect(scans).toEqual(name === "listFirst" ? ["SCAN c USING INDEX coupons_created"] : []);
  });
});
