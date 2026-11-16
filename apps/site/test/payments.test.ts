import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleRequest } from "../src/index";
import { PAYMENT_SQL } from "../src/shared/payments-db";
import { ADMIN, APP, adminGet, adminPost, db, get, newAdminSession, newOwner, passTurnstile, post, subscribe } from "./helpers";

// Offline payments: bank details, receipt upload, and admin approval (issue #41). Test values only.
beforeEach(() => passTurnstile());
afterEach(() => vi.restoreAllMocks());

const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x10, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20, 1, 2, 3, 4]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const PDF = new TextEncoder().encode("%PDF-1.4 receipt");
const DAY = 24 * 60 * 60 * 1000;

async function proId() {
  return (await db.prepare("SELECT id FROM plans WHERE legacy_key = 'pro'").first<{ id: string }>())?.id ?? "";
}

async function priceThePro() {
  await db.prepare("UPDATE plans SET monthly_price_minor = 150000, yearly_price_minor = 1500000, status = 'active' WHERE legacy_key = 'pro'").run();
}

/** Sends the owner's upgrade form, with a receipt file unless `file` is null. */
function submitUpgrade(cookie: string, fields: Record<string, string>, file: { bytes: Uint8Array; name: string; type: string } | null = { bytes: WEBP, name: "receipt.webp", type: "image/webp" }) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  if (file) form.append("receipt", new File([file.bytes], file.name, { type: file.type }));
  const headers = new Headers({ origin: APP, cookie, "cf-connecting-ip": "192.0.2.99" });
  return handleRequest(new Request(`${APP}/plan`, { method: "POST", headers, body: form }), env);
}

async function latestRequest(restaurantId: string) {
  return db
    .prepare("SELECT id, plan_id, billing_period, coupon_id, list_price_minor, discount_minor, amount_minor, receipt_key, status, review_note FROM payment_requests WHERE restaurant_id = ? ORDER BY created_at DESC, id DESC LIMIT 1")
    .bind(restaurantId)
    .first<Record<string, unknown>>();
}

async function subscription(restaurantId: string) {
  return db
    .prepare("SELECT p.name, s.billing_period, s.status, s.started_at, s.ends_at, s.price_minor, s.coupon_percent_off FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.restaurant_id = ?")
    .bind(restaurantId)
    .first<Record<string, unknown>>();
}

async function setBankDetails(text: string) {
  const admin = await newAdminSession();
  expect((await adminPost("/settings", { bank_details: text }, admin.cookie)).status).toBe(303);
  return admin;
}

/** An owner who has sent a monthly Pro request with a receipt. */
async function ownerWithRequest(name: string, fields: Record<string, string> = {}) {
  await priceThePro();
  const owner = await newOwner(name);
  const response = await submitUpgrade(owner.cookie, { plan_id: await proId(), period: "monthly", intent: "submit", ...fields });
  expect(response.status).toBe(303);
  const request = await latestRequest(owner.restaurantId);
  return { ...owner, requestId: String(request?.id), receiptKey: String(request?.receipt_key) };
}

describe("admin settings", () => {
  it("saves the bank details, logs it, and shows them to owners", async () => {
    await setBankDetails("Meezan Bank\nAccount title: TomatoFry Demo\nIBAN: PK00 TEST 0000 0000 0000 0000");
    const log = await db.prepare("SELECT 1 FROM audit_log WHERE action = 'settings_updated'").first();
    expect(log).not.toBeNull();
    await priceThePro();
    const owner = await newOwner("Bank Shown");
    const body = await (await get("/plan", owner.cookie)).text();
    expect(body).toContain("Account title: TomatoFry Demo");
  });

  it("refuses bank details over 1,000 characters, and is closed to owners", async () => {
    const admin = await newAdminSession();
    expect((await adminPost("/settings", { bank_details: "x".repeat(1001) }, admin.cookie)).status).toBe(400);
    const owner = await newOwner("Settings Closed");
    expect((await adminGet("/settings", owner.cookie)).status).toBe(303);
    expect((await adminPost("/settings", { bank_details: "Hacked" }, owner.cookie)).status).toBe(303);
    const value = await db.prepare("SELECT value FROM app_settings WHERE key = 'bank_details'").first<{ value: string }>();
    expect(value?.value ?? "").not.toBe("Hacked");
  });
});

describe("owner plan page", () => {
  it("shows the current plan, the dish usage, and paid plans with both prices", async () => {
    await priceThePro();
    const owner = await newOwner("Plan Page");
    const body = await (await get("/plan", owner.cookie)).text();
    expect(body).toContain("Free");
    expect(body).toContain("0 of 25");
    expect(body).toContain("Pro");
    expect(body).toContain("Rs 1,500");
    expect(body).toContain("Rs 15,000");
    expect(body).toContain('name="receipt"');
    expect(await (await get("/", owner.cookie)).text()).toContain('href="/plan"');
  });

  it("hides paid plans that have no prices yet", async () => {
    await db.prepare("UPDATE plans SET monthly_price_minor = NULL, yearly_price_minor = NULL WHERE legacy_key = 'pro'").run();
    const owner = await newOwner("No Prices");
    const body = await (await get("/plan", owner.cookie)).text();
    expect(body).not.toContain(`value="${await proId()}"`);
    await priceThePro();
  });

  it("checks the price with a coupon without saving anything", async () => {
    await priceThePro();
    const admin = await newAdminSession();
    await adminPost("/coupons", { code: "OWNER-20", percent_off: "20", billing_period: "any", duration: "once", plan_id: "", restaurant: "", max_redemptions: "", expires: "" }, admin.cookie);
    const owner = await newOwner("Owner Coupon");
    const response = await submitUpgrade(owner.cookie, { plan_id: await proId(), period: "monthly", coupon: "owner-20", intent: "preview" }, null);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("Rs 1,200");
    expect(await latestRequest(owner.restaurantId)).toBeNull();
  });

  it("shows owners one message for unknown codes and codes for other restaurants", async () => {
    await priceThePro();
    const admin = await newAdminSession();
    const other = await newOwner("Coupon Elsewhere");
    const code = (await db.prepare("SELECT menu_code FROM restaurants WHERE id = ?").bind(other.restaurantId).first<{ menu_code: string }>())?.menu_code ?? "";
    await adminPost("/coupons", { code: "SECRET-50", percent_off: "50", billing_period: "any", duration: "once", plan_id: "", restaurant: code, max_redemptions: "", expires: "" }, admin.cookie);
    const owner = await newOwner("Coupon Here");
    const secret = await (await submitUpgrade(owner.cookie, { plan_id: await proId(), period: "monthly", coupon: "SECRET-50", intent: "preview" }, null)).text();
    const unknown = await (await submitUpgrade(owner.cookie, { plan_id: await proId(), period: "monthly", coupon: "NO-SUCH", intent: "preview" }, null)).text();
    expect(secret).toContain("This coupon cannot be used.");
    expect(unknown).toContain("This coupon cannot be used.");
    expect(secret).not.toContain("not for this restaurant");
  });
});

describe("sending a payment", () => {
  it("stores the request with its price snapshot and a private receipt", async () => {
    const owner = await ownerWithRequest("Send Request");
    const request = await latestRequest(owner.restaurantId);
    expect(request).toMatchObject({ plan_id: await proId(), billing_period: "monthly", list_price_minor: 150000, discount_minor: 0, amount_minor: 150000, status: "pending" });
    expect(owner.receiptKey).toMatch(new RegExp(`^restaurants/${owner.restaurantId}/receipts/[0-9a-f-]{36}\\.webp$`));
    expect(await env.MEDIA.head(owner.receiptKey)).not.toBeNull();
    const page = await (await get("/plan", owner.cookie)).text();
    expect(page).toContain("Waiting for approval");
    // The plan does not change until the admin approves.
    expect((await subscription(owner.restaurantId))?.name).toBe("Free");
  });

  it("never serves a receipt through the public media path, on any host", async () => {
    const owner = await ownerWithRequest("Receipt Private");
    for (const host of ["https://tomatofry.com", APP, ADMIN]) {
      const response = await handleRequest(new Request(`${host}/media/${owner.receiptKey}`), env);
      expect(response.status).not.toBe(200);
    }
  });

  it.each([
    ["no receipt", null],
    ["an SVG", { bytes: SVG, name: "receipt.svg", type: "image/svg+xml" }],
    ["an SVG named like a picture", { bytes: SVG, name: "receipt.png", type: "image/png" }],
    ["a PDF", { bytes: PDF, name: "receipt.pdf", type: "application/pdf" }],
    ["a file over 1 MB", { bytes: (() => { const big = new Uint8Array(1024 * 1024 + 1); big.set(WEBP); return big; })(), name: "big.webp", type: "image/webp" }],
  ] as const)("refuses %s", async (_label, file) => {
    await priceThePro();
    const owner = await newOwner("Bad Receipt");
    const response = await submitUpgrade(owner.cookie, { plan_id: await proId(), period: "monthly", intent: "submit" }, file);
    expect(response.status).toBe(400);
    expect(await latestRequest(owner.restaurantId)).toBeNull();
  });

  it("refuses a free plan, an unknown plan, and a missing period", async () => {
    await priceThePro();
    const owner = await newOwner("Bad Choice");
    const free = (await db.prepare("SELECT id FROM plans WHERE legacy_key = 'free'").first<{ id: string }>())?.id ?? "";
    for (const fields of [{ plan_id: free, period: "monthly" }, { plan_id: "0123456789abcdef0123456789abcdef", period: "monthly" }, { plan_id: await proId(), period: "none" }]) {
      expect((await submitUpgrade(owner.cookie, { ...fields, intent: "submit" })).status).toBe(400);
    }
    expect(await latestRequest(owner.restaurantId)).toBeNull();
  });

  it("allows only one waiting request at a time", async () => {
    const owner = await ownerWithRequest("One Pending");
    const second = await submitUpgrade(owner.cookie, { plan_id: await proId(), period: "yearly", intent: "submit" });
    expect(second.status).toBe(409);
    const count = await db.prepare("SELECT COUNT(*) AS n FROM payment_requests WHERE restaurant_id = ?").bind(owner.restaurantId).first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("lets owners view only their own receipt", async () => {
    const owner = await ownerWithRequest("Own Receipt");
    const response = await get(`/plan/receipts/${owner.requestId}`, owner.cookie);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const stranger = await newOwner("Other Receipt");
    expect((await get(`/plan/receipts/${owner.requestId}`, stranger.cookie)).status).toBe(404);
  });

  it("offers renewal only in the last 7 days of a paid plan, or after it ends", async () => {
    await priceThePro();
    const owner = await newOwner("Renewal Window");
    await subscribe(owner.restaurantId, "pro", Date.now() + 20 * DAY);
    expect((await submitUpgrade(owner.cookie, { plan_id: await proId(), period: "monthly", intent: "submit" })).status).toBe(409);
    expect(await (await get("/plan", owner.cookie)).text()).toMatch(/renew from \d{4}-\d{2}-\d{2}/i);
    await subscribe(owner.restaurantId, "pro", Date.now() + 5 * DAY);
    expect((await submitUpgrade(owner.cookie, { plan_id: await proId(), period: "monthly", intent: "submit" })).status).toBe(303);
  });
});

describe("admin payment review", () => {
  it("lists waiting payments first and is closed to owners", async () => {
    const owner = await ownerWithRequest("Review List");
    const admin = await newAdminSession();
    const body = await (await adminGet("/payments", admin.cookie)).text();
    expect(body).toContain(`/payments/${owner.requestId}`);
    expect(body).toContain("Rs 1,500");
    for (const path of ["/payments", `/payments/${owner.requestId}`, `/payments/${owner.requestId}/receipt`]) {
      expect((await adminGet(path, owner.cookie)).status).toBe(303);
    }
  });

  it("shows the receipt to the admin, never cached", async () => {
    const owner = await ownerWithRequest("Review Receipt");
    const admin = await newAdminSession();
    const response = await adminGet(`/payments/${owner.requestId}/receipt`, admin.cookie);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("approves: the plan starts now for one period at the paid price, in one step", async () => {
    const owner = await ownerWithRequest("Approve Me");
    const admin = await newAdminSession();
    const before = Date.now();
    expect((await adminPost(`/payments/${owner.requestId}/approve`, {}, admin.cookie)).status).toBe(303);
    const sub = await subscription(owner.restaurantId);
    expect(sub).toMatchObject({ name: "Pro", billing_period: "monthly", status: "active", price_minor: 150000 });
    expect(Number(sub?.started_at)).toBeGreaterThanOrEqual(before);
    expect(Number(sub?.ends_at)).toBeGreaterThan(before + 27 * DAY);
    expect(Number(sub?.ends_at)).toBeLessThan(before + 32 * DAY);
    expect((await latestRequest(owner.restaurantId))?.status).toBe("approved");
    const log = await db.prepare("SELECT 1 FROM audit_log WHERE restaurant_id = ? AND action = 'payment_approved'").bind(owner.restaurantId).first();
    expect(log).not.toBeNull();
    expect(await (await get("/", owner.cookie)).text()).toMatch(/Pro until \d{4}-\d{2}-\d{2}/);
  });

  it("approves a coupon payment, copying the coupon and counting one use", async () => {
    await priceThePro();
    const admin = await newAdminSession();
    await adminPost("/coupons", { code: "PAY-50", percent_off: "50", billing_period: "yearly", duration: "recurring", plan_id: "", restaurant: "", max_redemptions: "", expires: "" }, admin.cookie);
    const owner = await ownerWithRequest("Approve Coupon", { period: "yearly", coupon: "PAY-50" });
    expect(await latestRequest(owner.restaurantId)).toMatchObject({ list_price_minor: 1500000, discount_minor: 750000, amount_minor: 750000 });
    await adminPost(`/payments/${owner.requestId}/approve`, {}, admin.cookie);
    expect(await subscription(owner.restaurantId)).toMatchObject({ billing_period: "yearly", price_minor: 750000, coupon_percent_off: 50 });
    const coupon = await db.prepare("SELECT redeemed_count FROM coupons WHERE code = 'PAY-50'").first<{ redeemed_count: number }>();
    expect(coupon?.redeemed_count).toBe(1);
  });

  it("refuses to review a payment twice", async () => {
    const owner = await ownerWithRequest("Approve Twice");
    const admin = await newAdminSession();
    await adminPost(`/payments/${owner.requestId}/approve`, {}, admin.cookie);
    expect((await adminPost(`/payments/${owner.requestId}/approve`, {}, admin.cookie)).status).toBe(409);
    expect((await adminPost(`/payments/${owner.requestId}/reject`, { review_note: "Late" }, admin.cookie)).status).toBe(409);
    expect((await latestRequest(owner.restaurantId))?.status).toBe("approved");
    const logs = await db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE restaurant_id = ? AND action = 'payment_approved'").bind(owner.restaurantId).first<{ n: number }>();
    expect(logs?.n).toBe(1);
  });

  it("approves only once even when two approvals arrive together", async () => {
    const owner = await ownerWithRequest("Approve Race");
    const admin = await newAdminSession();
    const results = await Promise.all([1, 2].map(() => adminPost(`/payments/${owner.requestId}/approve`, {}, admin.cookie)));
    expect(results.map((r) => r.status).sort()).toEqual([303, 409]);
    const logs = await db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE restaurant_id = ? AND action = 'payment_approved'").bind(owner.restaurantId).first<{ n: number }>();
    expect(logs?.n).toBe(1);
  });

  it("rejects with a note that the owner sees, and lets the owner send again", async () => {
    const owner = await ownerWithRequest("Reject Me");
    const admin = await newAdminSession();
    expect((await adminPost(`/payments/${owner.requestId}/reject`, { review_note: "" }, admin.cookie)).status).toBe(400);
    expect((await adminPost(`/payments/${owner.requestId}/reject`, { review_note: "The amount on the receipt does not match." }, admin.cookie)).status).toBe(303);
    expect((await subscription(owner.restaurantId))?.name).toBe("Free");
    const page = await (await get("/plan", owner.cookie)).text();
    expect(page).toContain("The amount on the receipt does not match.");
    expect((await submitUpgrade(owner.cookie, { plan_id: await proId(), period: "monthly", intent: "submit" })).status).toBe(303);
  });

  it("returns 404 for an unknown payment", async () => {
    const admin = await newAdminSession();
    expect((await adminGet(`/payments/${crypto.randomUUID()}`, admin.cookie)).status).toBe(404);
    expect((await adminPost(`/payments/${crypto.randomUUID()}/approve`, {}, admin.cookie)).status).toBe(404);
  });
});

describe("payment queries", () => {
  // Law 26: payment lists grow with every request, so every query searches an index.
  it.each(Object.entries(PAYMENT_SQL))("%s searches an index and needs no extra sort", async (_name, sql) => {
    const numbered = new Set(sql.match(/\?\d/g) ?? []).size;
    const values = Array.from({ length: numbered || (sql.match(/\?/g) ?? []).length }, () => "x");
    const { results } = await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...values).all<{ detail: string }>();
    const details = results.map((row) => row.detail);
    expect(details.filter((d) => d.includes("TEMP B-TREE"))).toEqual([]);
    expect(details.filter((d) => d.startsWith("SCAN"))).toEqual([]);
  });
});

void post;
