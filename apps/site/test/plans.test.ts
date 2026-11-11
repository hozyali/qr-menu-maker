import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleRequest } from "../src/index";
import { FEATURES } from "../src/shared/plans";
import { PLANS_SQL } from "../src/shared/plans-db";
import { APP, adminGet, adminPost, codeOf, db, get, newAdminSession, newOwner, passTurnstile, post } from "./helpers";

// Plans stored in the database and edited by the admin (issue #38). Test values only.
beforeEach(() => passTurnstile());
afterEach(() => vi.restoreAllMocks());

const site = (path: string) => handleRequest(new Request(`https://tomatofry.com${path}`), env);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x10, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20, 1, 2, 3, 4]);

function upload(path: string, field: string, cookie: string) {
  const form = new FormData();
  form.append(field, new File([WEBP], "a.webp", { type: "image/webp" }));
  const headers = new Headers({ origin: APP, cookie, "cf-connecting-ip": "192.0.2.77" });
  return handleRequest(new Request(`${APP}${path}`, { method: "POST", headers, body: form }), env);
}

async function planByLegacy(key: "free" | "pro") {
  return db.prepare("SELECT id, name, is_free, is_signup_default, status FROM plans WHERE legacy_key = ?").bind(key).first<{ id: string; name: string; is_free: number; is_signup_default: number; status: string }>();
}

async function entitlements(planId: string) {
  const { results } = await db.prepare("SELECT feature_key, enabled, limit_value FROM plan_entitlements WHERE plan_id = ?").bind(planId).all<{ feature_key: string; enabled: number | null; limit_value: number | null }>();
  return Object.fromEntries(results.map((r) => [r.feature_key, r.enabled ?? r.limit_value]));
}

/** The full edit form for a plan, with every switch on and the given dish limit. */
function planForm(overrides: Record<string, string> = {}, off: string[] = []) {
  const form: Record<string, string> = { name: "Test Plan", kind: "paid", monthly: "1,500", yearly: "15000", max_items: "40", ...overrides };
  for (const feature of FEATURES) if (feature.type === "switch" && !off.includes(feature.key)) form[feature.key] = "on";
  return form;
}

async function auditActions() {
  const { results } = await db.prepare("SELECT action, details FROM audit_log WHERE restaurant_id IS NULL ORDER BY created_at, id").all<{ action: string; details: string }>();
  return results;
}

async function dishOwner(name: string) {
  const owner = await newOwner(name);
  await post("/categories", { name: "Karahi" }, owner.cookie);
  const category = await db.prepare("SELECT id FROM categories WHERE restaurant_id = ?").bind(owner.restaurantId).first<{ id: string }>();
  await post("/items", { category_id: category?.id ?? "", name: `${name} dish`, price_label: [""], price_amount: ["100"] }, owner.cookie);
  const item = await db.prepare("SELECT id FROM items WHERE name = ?").bind(`${name} dish`).first<{ id: string }>();
  return { ...owner, categoryId: category?.id ?? "", itemId: item?.id ?? "" };
}

async function setFreeSwitch(key: string, enabled: 0 | 1) {
  const free = await planByLegacy("free");
  await db.prepare("UPDATE plan_entitlements SET enabled = ? WHERE plan_id = ? AND feature_key = ?").bind(enabled, free?.id, key).run();
}

describe("seeded plans", () => {
  it("has Free as the only signup default, and Pro, with the agreed features", async () => {
    const free = await planByLegacy("free");
    const pro = await planByLegacy("pro");
    expect(free).toMatchObject({ name: "Free", is_free: 1, is_signup_default: 1, status: "active" });
    expect(pro).toMatchObject({ name: "Pro", is_free: 0, is_signup_default: 0, status: "active" });
    expect(await entitlements(free?.id ?? "")).toEqual({ max_items: 25, custom_theme: 1, hide_powered_by: 0, dish_photos: 1, logo: 1 });
    expect(await entitlements(pro?.id ?? "")).toEqual({ max_items: null, custom_theme: 1, hide_powered_by: 1, dish_photos: 1, logo: 1 });
    const defaults = await db.prepare("SELECT COUNT(*) AS n FROM plans WHERE is_signup_default = 1").first<{ n: number }>();
    expect(defaults?.n).toBe(1);
  });

  it("lists every feature with a label and description", () => {
    expect(FEATURES.map((f) => f.key)).toEqual(["max_items", "custom_theme", "hide_powered_by", "dish_photos", "logo"]);
    for (const feature of FEATURES) {
      expect(feature.label.length).toBeGreaterThan(3);
      expect(feature.description.length).toBeGreaterThan(10);
    }
  });
});

describe("admin plan pages", () => {
  it("are closed to owners and visitors", async () => {
    const owner = await newOwner("Plans Closed");
    const free = await planByLegacy("free");
    for (const path of ["/plans", "/plans/new", `/plans/${free?.id}`]) {
      for (const cookie of [undefined, owner.cookie]) {
        const response = await adminGet(path, cookie);
        expect(response.status).toBe(303);
        expect(response.headers.get("location")).toBe("/login");
      }
    }
    expect((await adminPost("/plans", planForm(), owner.cookie)).status).toBe(303);
    expect(await db.prepare("SELECT 1 FROM plans WHERE name = 'Test Plan'").first()).toBeNull();
  });

  it("lists plans with prices, restaurant counts, and the signup badge", async () => {
    const admin = await newAdminSession();
    await newOwner("Plans Count");
    const body = await (await adminGet("/plans", admin.cookie)).text();
    expect(body).toContain("Free");
    expect(body).toContain("Pro");
    expect(body).toContain("Signup default");
    expect(body).toMatch(/\d+ restaurants?/);
  });

  it("shows every feature as a labelled switch or limit on the edit page", async () => {
    const admin = await newAdminSession();
    const free = await planByLegacy("free");
    const body = await (await adminGet(`/plans/${free?.id}`, admin.cookie)).text();
    for (const feature of FEATURES) {
      expect(body).toContain(feature.label);
      expect(body).toContain(`name="${feature.key}"`);
    }
    expect(body).toContain('name="max_items_unlimited"');
    expect(body).toMatch(/This plan has \d+ restaurants?/);
  });

  it("creates a paid plan with prices in paisa and logs it", async () => {
    const admin = await newAdminSession();
    const response = await adminPost("/plans", planForm({ name: "Business" }, ["hide_powered_by"]), admin.cookie);
    expect(response.status).toBe(303);
    const plan = await db.prepare("SELECT id, is_free, monthly_price_minor, yearly_price_minor, is_signup_default, legacy_key FROM plans WHERE name = 'Business'").first<Record<string, unknown>>();
    expect(plan).toMatchObject({ is_free: 0, monthly_price_minor: 150000, yearly_price_minor: 1500000, is_signup_default: 0, legacy_key: null });
    expect(await entitlements(String(plan?.id))).toEqual({ max_items: 40, custom_theme: 1, hide_powered_by: 0, dish_photos: 1, logo: 1 });
    const log = (await auditActions()).find((row) => row.action === "plan_created" && row.details.includes("Business"));
    expect(log).toBeDefined();
  });

  it("edits the Free plan's dish limit, and free restaurants follow it", async () => {
    const admin = await newAdminSession();
    const free = await planByLegacy("free");
    const owner = await dishOwner("Limit Follow");
    expect((await adminPost(`/plans/${free?.id}`, planForm({ name: "Free", kind: "free", monthly: "", yearly: "", max_items: "1" }, ["hide_powered_by"]), admin.cookie)).status).toBe(303);
    // One dish already exists, so a second is refused.
    const second = await post("/items", { category_id: owner.categoryId, name: "Second", price_label: [""], price_amount: ["100"] }, owner.cookie);
    expect(second.status).toBe(403);
    expect(await second.text()).toContain("Your Free plan allows 1 dish");
    expect(await (await get("/", owner.cookie)).text()).toContain("1 of 1");
    const log = (await auditActions()).find((row) => row.action === "plan_updated" && row.details.includes('"max_items":1'));
    expect(log).toBeDefined();
    // Restore the seed for the other tests in this file.
    await adminPost(`/plans/${free?.id}`, planForm({ name: "Free", kind: "free", monthly: "", yearly: "", max_items: "25" }, ["hide_powered_by"]), admin.cookie);
  });

  it("saves an unlimited dish limit", async () => {
    const admin = await newAdminSession();
    await adminPost("/plans", planForm({ name: "Unlimited One", max_items: "", max_items_unlimited: "on" }), admin.cookie);
    const plan = await db.prepare("SELECT id FROM plans WHERE name = 'Unlimited One'").first<{ id: string }>();
    expect((await entitlements(plan?.id ?? "")).max_items).toBeNull();
  });

  it.each([
    ["a short name", { name: "x" }],
    ["a long name", { name: "x".repeat(41) }],
    ["a negative price", { monthly: "-5" }],
    ["a price that is not a number", { yearly: "lots" }],
    ["only one price for a paid plan", { yearly: "" }],
    ["an unknown kind", { kind: "gold" }],
    ["a negative dish limit", { max_items: "-1" }],
    ["a dish limit that is not a number", { max_items: "ten" }],
  ])("refuses %s and saves nothing", async (_label, change) => {
    const admin = await newAdminSession();
    const before = await db.prepare("SELECT COUNT(*) AS n FROM plans").first<{ n: number }>();
    expect((await adminPost("/plans", planForm({ name: "Refused Plan", ...change }), admin.cookie)).status).toBe(400);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM plans").first<{ n: number }>())?.n).toBe(before?.n);
  });

  it("allows a paid plan with no prices yet, and clears prices on a free plan", async () => {
    const admin = await newAdminSession();
    await adminPost("/plans", planForm({ name: "Priceless", monthly: "", yearly: "" }), admin.cookie);
    expect(await db.prepare("SELECT monthly_price_minor, yearly_price_minor FROM plans WHERE name = 'Priceless'").first()).toEqual({ monthly_price_minor: null, yearly_price_minor: null });
    await adminPost("/plans", planForm({ name: "Free Two", kind: "free" }), admin.cookie);
    expect(await db.prepare("SELECT is_free, monthly_price_minor FROM plans WHERE name = 'Free Two'").first()).toEqual({ is_free: 1, monthly_price_minor: null });
  });

  it("archives and restores a plan, but never the signup default", async () => {
    const admin = await newAdminSession();
    await adminPost("/plans", planForm({ name: "Archive Me" }), admin.cookie);
    const plan = await db.prepare("SELECT id FROM plans WHERE name = 'Archive Me'").first<{ id: string }>();
    expect((await adminPost(`/plans/${plan?.id}/archive`, {}, admin.cookie)).status).toBe(303);
    expect((await db.prepare("SELECT status FROM plans WHERE id = ?").bind(plan?.id).first<{ status: string }>())?.status).toBe("archived");
    expect((await adminPost(`/plans/${plan?.id}/restore`, {}, admin.cookie)).status).toBe(303);
    expect((await db.prepare("SELECT status FROM plans WHERE id = ?").bind(plan?.id).first<{ status: string }>())?.status).toBe("active");

    const free = await planByLegacy("free");
    expect((await adminPost(`/plans/${free?.id}/archive`, {}, admin.cookie)).status).toBe(400);
    expect((await planByLegacy("free"))?.status).toBe("active");
    const actions = (await auditActions()).map((row) => row.action);
    expect(actions).toContain("plan_archived");
    expect(actions).toContain("plan_restored");
  });

  it("has no way to delete a plan", async () => {
    const admin = await newAdminSession();
    const free = await planByLegacy("free");
    expect((await adminPost(`/plans/${free?.id}/delete`, {}, admin.cookie)).status).toBe(404);
    expect(await planByLegacy("free")).not.toBeNull();
  });

  it("returns 404 for an unknown or malformed plan id", async () => {
    const admin = await newAdminSession();
    expect((await adminGet("/plans/0123456789abcdef0123456789abcdef", admin.cookie)).status).toBe(404);
    expect((await adminGet("/plans/..%2Fsettings", admin.cookie)).status).toBe(404);
  });
});

describe("features are enforced from the plan", () => {
  it("shows Powered by only when the plan does not hide it", async () => {
    const owner = await dishOwner("Powered Switch");
    const code = await codeOf(owner.restaurantId);
    expect(await (await site(`/r/${code}`)).text()).toContain("Powered by TomatoFry");
    await setFreeSwitch("hide_powered_by", 1);
    expect(await (await site(`/r/${code}`)).text()).not.toContain("Powered by TomatoFry");
    await setFreeSwitch("hide_powered_by", 0);
  });

  it("blocks the theme editor and uses the default theme when the switch is off", async () => {
    const owner = await dishOwner("Theme Switch");
    const code = await codeOf(owner.restaurantId);
    await post("/theme", { color: "#0f6e56", mode: "dark", photos: "small" }, owner.cookie);
    await setFreeSwitch("custom_theme", 0);
    expect((await get("/theme", owner.cookie)).status).toBe(403);
    expect((await post("/theme", { color: "#123456", mode: "light", photos: "large" }, owner.cookie)).status).toBe(403);
    expect(await (await site(`/r/${code}`)).text()).toContain('class="menu light photos-large"');
    expect(await (await site(`/r/${code}/theme.css`)).text()).toContain("#c8321f");
    await setFreeSwitch("custom_theme", 1);
    // The owner's saved theme comes back, because nothing was deleted.
    expect(await (await site(`/r/${code}/theme.css`)).text()).toContain("#0f6e56");
  });

  it("blocks dish photo uploads and hides photos when the switch is off", async () => {
    const owner = await dishOwner("Photo Switch");
    const code = await codeOf(owner.restaurantId);
    expect((await upload(`/items/${owner.itemId}/photo`, "photo", owner.cookie)).status).toBe(303);
    expect(await (await site(`/r/${code}`)).text()).toContain('class="photo"');
    await setFreeSwitch("dish_photos", 0);
    expect((await upload(`/items/${owner.itemId}/photo`, "photo", owner.cookie)).status).toBe(403);
    expect(await (await site(`/r/${code}`)).text()).not.toContain('class="photo"');
    expect(await (await get(`/items/${owner.itemId}/edit`, owner.cookie)).text()).not.toContain('name="photo"');
    // The stored photo is kept.
    expect((await db.prepare("SELECT photo_key FROM items WHERE id = ?").bind(owner.itemId).first<{ photo_key: string | null }>())?.photo_key).not.toBeNull();
    await setFreeSwitch("dish_photos", 1);
  });

  it("blocks logo uploads and hides the logo when the switch is off", async () => {
    const owner = await dishOwner("Logo Switch");
    const code = await codeOf(owner.restaurantId);
    expect((await upload("/profile/logo", "logo", owner.cookie)).status).toBe(303);
    expect(await (await site(`/r/${code}`)).text()).toContain('class="logo"');
    await setFreeSwitch("logo", 0);
    expect((await upload("/profile/logo", "logo", owner.cookie)).status).toBe(403);
    expect(await (await site(`/r/${code}`)).text()).not.toContain('class="logo"');
    expect(await (await get("/profile", owner.cookie)).text()).not.toContain('name="logo"');
    await setFreeSwitch("logo", 1);
  });

  it("gives an active Pro restaurant the Pro features, and an expired one the Free features", async () => {
    const owner = await dishOwner("Pro Features");
    const code = await codeOf(owner.restaurantId);
    await db.prepare("UPDATE restaurants SET plan = 'pro', plan_expires_at = NULL WHERE id = ?").bind(owner.restaurantId).run();
    expect(await (await site(`/r/${code}`)).text()).not.toContain("Powered by TomatoFry");
    expect(await (await get("/", owner.cookie)).text()).toContain("Pro");
    await db.prepare("UPDATE restaurants SET plan_expires_at = 1 WHERE id = ?").bind(owner.restaurantId).run();
    expect(await (await site(`/r/${code}`)).text()).toContain("Powered by TomatoFry");
  });
});

describe("plan queries", () => {
  // Law 26. The plans table stays small, so only the plan list may read it in order.
  it.each(Object.entries(PLANS_SQL))("%s uses indexes and needs no extra sort", async (name, sql) => {
    const params = (sql.match(/\?/g) ?? []).map(() => "x");
    const { results } = await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...params).all<{ detail: string }>();
    const details = results.map((row) => row.detail);
    expect(details.filter((d) => d.includes("TEMP B-TREE"))).toEqual([]);
    const scans = details.filter((d) => d.startsWith("SCAN"));
    expect(scans).toEqual(name === "list" ? ["SCAN p USING INDEX plans_order"] : []);
    expect(details.filter((d) => d.startsWith("SEARCH")).every((d) => d.includes("INDEX") || d.includes("PRIMARY KEY"))).toBe(true);
  });
});
