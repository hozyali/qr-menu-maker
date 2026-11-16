import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleRequest } from "../src/index";
import { TRIAL_SQL } from "../src/shared/trials-db";
import { adminGet, adminPost, codeOf, db, get, newAdminSession, newOwner, passTurnstile, post, subscribe } from "./helpers";

// Free trial offers (issue #42). Test values only.
beforeEach(() => passTurnstile());
afterEach(async () => {
  vi.restoreAllMocks();
  // Offers for everyone would leak into other tests, so each test ends them.
  await db.prepare("UPDATE trial_offers SET status = 'ended' WHERE target_type = 'all'").run();
});

const site = (path: string) => handleRequest(new Request(`https://tomatofry.com${path}`), env);
const DAY = 24 * 60 * 60 * 1000;

async function proId() {
  return (await db.prepare("SELECT id FROM plans WHERE legacy_key = 'pro'").first<{ id: string }>())?.id ?? "";
}

function offerForm(overrides: Record<string, string> = {}) {
  return { plan_id: "", days: "30", target: "all", restaurant: "", ends: "", ...overrides };
}

async function createOffer(admin: { cookie: string }, overrides: Record<string, string> = {}) {
  const response = await adminPost("/trials", offerForm({ plan_id: await proId(), ...overrides }), admin.cookie);
  expect(response.status).toBe(303);
  return (await db.prepare("SELECT id FROM trial_offers ORDER BY created_at DESC, id DESC LIMIT 1").first<{ id: string }>())?.id ?? "";
}

async function subscription(restaurantId: string) {
  return db
    .prepare("SELECT p.name, s.status, s.ends_at, s.price_minor, s.billing_period FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.restaurant_id = ?")
    .bind(restaurantId)
    .first<{ name: string; status: string; ends_at: number | null; price_minor: number; billing_period: string }>();
}

describe("admin trial offers", () => {
  it("are closed to owners and visitors", async () => {
    const owner = await newOwner("Trial Closed");
    for (const cookie of [undefined, owner.cookie]) {
      for (const path of ["/trials", "/trials/new"]) {
        const response = await adminGet(path, cookie);
        expect(response.status).toBe(303);
        expect(response.headers.get("location")).toBe("/login");
      }
    }
    expect((await adminPost("/trials", offerForm({ plan_id: await proId() }), owner.cookie)).status).toBe(303);
    const count = await db.prepare("SELECT COUNT(*) AS n FROM trial_offers").first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("creates an offer for all restaurants, lists it, and logs it", async () => {
    const admin = await newAdminSession();
    const id = await createOffer(admin, { days: "15" });
    const row = await db.prepare("SELECT plan_id, days, target_type, restaurant_id, status FROM trial_offers WHERE id = ?").bind(id).first();
    expect(row).toEqual({ plan_id: await proId(), days: 15, target_type: "all", restaurant_id: null, status: "active" });
    expect(await db.prepare("SELECT 1 FROM audit_log WHERE action = 'trial_offer_created' AND details LIKE ?").bind(`%${id}%`).first()).not.toBeNull();
    const list = await (await adminGet("/trials", admin.cookie)).text();
    expect(list).toContain("15 days");
    expect(list).toContain("All restaurants");
  });

  it("creates an offer for one restaurant by its menu code, and pre-fills it from the restaurant page", async () => {
    const admin = await newAdminSession();
    const owner = await newOwner("Trial One");
    const code = await codeOf(owner.restaurantId);
    const detail = await (await adminGet(`/restaurants/${owner.restaurantId}`, admin.cookie)).text();
    expect(detail).toContain(`href="/trials/new?restaurant=${code}"`);
    expect(await (await adminGet(`/trials/new?restaurant=${code}`, admin.cookie)).text()).toContain(`value="${code}"`);
    const id = await createOffer(admin, { target: "restaurant", restaurant: code });
    const row = await db.prepare("SELECT target_type, restaurant_id FROM trial_offers WHERE id = ?").bind(id).first();
    expect(row).toEqual({ target_type: "restaurant", restaurant_id: owner.restaurantId });
  });

  it.each([
    ["a free plan", "FREE", {}],
    ["an unknown plan", "0123456789abcdef0123456789abcdef", {}],
    ["0 days", "PRO", { days: "0" }],
    ["91 days", "PRO", { days: "91" }],
    ["days that are not a whole number", "PRO", { days: "7.5" }],
    ["an unknown target", "PRO", { target: "city" }],
    ["a restaurant target with no restaurant", "PRO", { target: "restaurant", restaurant: "" }],
    ["a restaurant that does not exist", "PRO", { target: "restaurant", restaurant: "zzzzzz" }],
    ["a past end date", "PRO", { ends: "2020-01-01" }],
  ])("refuses %s and saves nothing", async (_label, plan, change) => {
    const admin = await newAdminSession();
    const free = (await db.prepare("SELECT id FROM plans WHERE legacy_key = 'free'").first<{ id: string }>())?.id ?? "";
    const planId = plan === "FREE" ? free : plan === "PRO" ? await proId() : plan;
    const before = await db.prepare("SELECT COUNT(*) AS n FROM trial_offers").first<{ n: number }>();
    expect((await adminPost("/trials", offerForm({ plan_id: planId, ...change }), admin.cookie)).status).toBe(400);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM trial_offers").first<{ n: number }>())?.n).toBe(before?.n);
  });

  it("ends an offer early, never deletes it, and logs it", async () => {
    const admin = await newAdminSession();
    const id = await createOffer(admin);
    expect((await adminPost(`/trials/${id}/end`, {}, admin.cookie)).status).toBe(303);
    expect((await db.prepare("SELECT status FROM trial_offers WHERE id = ?").bind(id).first<{ status: string }>())?.status).toBe("ended");
    expect((await adminPost(`/trials/${id}/delete`, {}, admin.cookie)).status).toBe(404);
    expect(await db.prepare("SELECT 1 FROM audit_log WHERE action = 'trial_offer_ended' AND details LIKE ?").bind(`%${id}%`).first()).not.toBeNull();
  });
});

describe("owner trial banner", () => {
  it("shows an offer for all restaurants to a free restaurant", async () => {
    const admin = await newAdminSession();
    await createOffer(admin, { days: "30" });
    const owner = await newOwner("Banner All");
    for (const path of ["/", "/plan"]) {
      const body = await (await get(path, owner.cookie)).text();
      expect(body).toContain("Try Pro free for 30 days");
      expect(body).toContain('action="/plan/trial"');
    }
  });

  it("never shows a restaurant's own offer to another restaurant", async () => {
    const admin = await newAdminSession();
    const target = await newOwner("Banner Target");
    const other = await newOwner("Banner Other");
    await createOffer(admin, { target: "restaurant", restaurant: await codeOf(target.restaurantId), days: "15" });
    expect(await (await get("/", target.cookie)).text()).toContain("Try Pro free for 15 days");
    expect(await (await get("/", other.cookie)).text()).not.toContain("Try Pro free");
    // Starting it from the other restaurant is refused on the server too.
    const offer = (await db.prepare("SELECT id FROM trial_offers WHERE restaurant_id = ?").bind(target.restaurantId).first<{ id: string }>())?.id ?? "";
    expect((await post("/plan/trial", { offer_id: offer }, other.cookie)).status).toBe(403);
    expect((await subscription(other.restaurantId))?.status).toBe("active");
  });

  it("shows nothing to a restaurant on a paid plan, and refuses its start", async () => {
    const admin = await newAdminSession();
    const offer = await createOffer(admin);
    const owner = await newOwner("Banner Paid");
    await subscribe(owner.restaurantId, "pro", Date.now() + 20 * DAY);
    expect(await (await get("/", owner.cookie)).text()).not.toContain("Try Pro free");
    expect((await post("/plan/trial", { offer_id: offer }, owner.cookie)).status).toBe(403);
  });

  it("shows nothing for an ended offer or one that has passed its last day", async () => {
    const admin = await newAdminSession();
    const offer = await createOffer(admin);
    await db.prepare("UPDATE trial_offers SET ends_at = 1 WHERE id = ?").bind(offer).run();
    const owner = await newOwner("Banner Ended");
    expect(await (await get("/", owner.cookie)).text()).not.toContain("Try Pro free");
    expect((await post("/plan/trial", { offer_id: offer }, owner.cookie)).status).toBe(403);
  });
});

describe("starting a trial", () => {
  it("starts the plan as a trial with no price, ending after the days, and logs the owner", async () => {
    const admin = await newAdminSession();
    const offer = await createOffer(admin, { days: "30" });
    const owner = await newOwner("Start Trial");
    const before = Date.now();
    expect((await post("/plan/trial", { offer_id: offer }, owner.cookie)).status).toBe(303);
    const sub = await subscription(owner.restaurantId);
    expect(sub).toMatchObject({ name: "Pro", status: "trial", price_minor: 0, billing_period: "none" });
    expect(Number(sub?.ends_at)).toBeGreaterThan(before + 29 * DAY);
    expect(Number(sub?.ends_at)).toBeLessThan(before + 32 * DAY);
    const userId = (await db.prepare("SELECT owner_user_id FROM restaurants WHERE id = ?").bind(owner.restaurantId).first<{ owner_user_id: string }>())?.owner_user_id;
    const log = await db.prepare("SELECT actor_user_id FROM audit_log WHERE restaurant_id = ? AND action = 'trial_started'").bind(owner.restaurantId).first<{ actor_user_id: string }>();
    expect(log?.actor_user_id).toBe(userId);
    expect(await (await get("/", owner.cookie)).text()).toMatch(/Pro trial until \d{4}-\d{2}-\d{2}/);
    // The Pro features apply during the trial.
    expect(await (await site(`/r/${await codeOf(owner.restaurantId)}`)).text()).not.toContain("Powered by TomatoFry");
    // The upgrade page still offers payment during a trial.
    await db.prepare("UPDATE plans SET monthly_price_minor = 150000, yearly_price_minor = 1500000 WHERE legacy_key = 'pro'").run();
    expect(await (await get("/plan", owner.cookie)).text()).toContain('name="receipt"');
  });

  it("allows one trial per plan per restaurant, ever", async () => {
    const admin = await newAdminSession();
    const offer = await createOffer(admin);
    const owner = await newOwner("Trial Once");
    await post("/plan/trial", { offer_id: offer }, owner.cookie);
    // Back on Free after the trial, the same plan cannot be tried again, even from a new offer.
    await subscribe(owner.restaurantId, "free");
    const second = await createOffer(admin, { days: "15" });
    expect(await (await get("/", owner.cookie)).text()).not.toContain("Try Pro free");
    expect((await post("/plan/trial", { offer_id: second }, owner.cookie)).status).toBe(403);
    const uses = await db.prepare("SELECT COUNT(*) AS n FROM trial_uses WHERE restaurant_id = ?").bind(owner.restaurantId).first<{ n: number }>();
    expect(uses?.n).toBe(1);
  });

  it("moves back to Free when the trial ends, with extra dishes archived and back after paying", async () => {
    const admin = await newAdminSession();
    const offer = await createOffer(admin);
    const owner = await newOwner("Trial Ends");
    await post("/plan/trial", { offer_id: offer }, owner.cookie);
    await db.prepare("UPDATE plan_entitlements SET limit_value = 1 WHERE feature_key = 'max_items' AND plan_id = (SELECT id FROM plans WHERE legacy_key = 'free')").run();
    try {
      await post("/categories", { name: "Karahi" }, owner.cookie);
      const category = await db.prepare("SELECT id FROM categories WHERE restaurant_id = ?").bind(owner.restaurantId).first<{ id: string }>();
      for (const name of ["Trial dish A", "Trial dish B"]) {
        await post("/items", { category_id: category?.id ?? "", name, price_label: [""], price_amount: ["100"] }, owner.cookie);
        await db.prepare("UPDATE items SET created_at = ? WHERE name = ?").bind(name.endsWith("A") ? 1 : 2, name).run();
      }
      const code = await codeOf(owner.restaurantId);
      expect(await (await site(`/r/${code}`)).text()).toContain("Trial dish B");
      // The trial ends.
      await db.prepare("UPDATE subscriptions SET ends_at = ? WHERE restaurant_id = ?").bind(Date.now() - 1, owner.restaurantId).run();
      const menu = await (await site(`/r/${code}`)).text();
      expect(menu).toContain("Trial dish A");
      expect(menu).not.toContain("Trial dish B");
      expect(await (await get("/", owner.cookie)).text()).toContain("<strong>Free</strong>");
      // Paying brings the archived dish back.
      await subscribe(owner.restaurantId, "pro", Date.now() + 30 * DAY);
      expect(await (await site(`/r/${code}`)).text()).toContain("Trial dish B");
    } finally {
      await db.prepare("UPDATE plan_entitlements SET limit_value = 25 WHERE feature_key = 'max_items' AND plan_id = (SELECT id FROM plans WHERE legacy_key = 'free')").run();
    }
  });

  it("refuses an unknown offer", async () => {
    const owner = await newOwner("Trial Unknown");
    expect((await post("/plan/trial", { offer_id: crypto.randomUUID() }, owner.cookie)).status).toBe(403);
    expect((await subscription(owner.restaurantId))?.name).toBe("Free");
  });
});

describe("trial queries", () => {
  // Law 26: the eligibility lookup runs on every dashboard view, so it must search indexes only.
  it.each(Object.entries(TRIAL_SQL))("%s searches an index and needs no extra sort", async (_name, sql) => {
    const numbered = new Set(sql.match(/\?\d/g) ?? []).size;
    const values = Array.from({ length: numbered || (sql.match(/\?/g) ?? []).length }, () => "x");
    const { results } = await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...values).all<{ detail: string }>();
    const details = results.map((row) => row.detail);
    expect(details.filter((d) => d.includes("TEMP B-TREE"))).toEqual([]);
    const scans = details.filter((d) => d.startsWith("SCAN"));
    expect(scans).toEqual(_name === "listFirst" ? ["SCAN o USING INDEX trial_offers_created"] : []);
  });
});
