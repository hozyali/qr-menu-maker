import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleRequest } from "../src/index";
import { addBillingPeriod } from "../src/shared/pakistan-date";
import { SUBSCRIPTION_SQL } from "../src/shared/subscriptions-db";
import { APP, adminPost, codeOf, db, get, newAdminSession, newOwner, passTurnstile, post, subscribe } from "./helpers";

// Restaurant subscriptions, plan expiry, and dishes over the plan's limit (issue #39). Test values only.
beforeEach(() => passTurnstile());
afterEach(() => vi.restoreAllMocks());

const site = (path: string) => handleRequest(new Request(`https://tomatofry.com${path}`), env);

async function subscription(restaurantId: string) {
  return db
    .prepare("SELECT p.name, s.billing_period, s.status, s.ends_at, s.price_minor FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.restaurant_id = ?")
    .bind(restaurantId)
    .first<{ name: string; billing_period: string; status: string; ends_at: number | null; price_minor: number }>();
}

let planSeq = 0;
/** A free plan with a small dish limit, added straight to the database for these tests. */
async function smallPlan(maxItems: number) {
  planSeq++;
  // 32 hex characters, like real plan ids, so the admin routes accept it.
  const id = `5a11${String(planSeq).padStart(28, "0")}`;
  const now = Date.now();
  await db.batch([
    db.prepare("INSERT INTO plans (id, name, is_free, status, sort_order, created_at, updated_at) VALUES (?, ?, 1, 'active', 50, ?, ?)").bind(id, `Small ${planSeq}`, now, now),
    db.prepare("INSERT INTO plan_entitlements (plan_id, feature_key, enabled, limit_value) VALUES (?, 'max_items', NULL, ?)").bind(id, maxItems),
    ...["custom_theme", "dish_photos", "logo"].map((key) =>
      db.prepare("INSERT INTO plan_entitlements (plan_id, feature_key, enabled, limit_value) VALUES (?, ?, 1, NULL)").bind(id, key),
    ),
    db.prepare("INSERT INTO plan_entitlements (plan_id, feature_key, enabled, limit_value) VALUES (?, 'hide_powered_by', 0, NULL)").bind(id),
  ]);
  return id;
}

/** An owner with five dishes, added in order while on the unlimited Pro plan. */
async function ownerWithFiveDishes(name: string) {
  const owner = await newOwner(name);
  await subscribe(owner.restaurantId, "pro");
  await post("/categories", { name: "Karahi" }, owner.cookie);
  const category = await db.prepare("SELECT id FROM categories WHERE restaurant_id = ?").bind(owner.restaurantId).first<{ id: string }>();
  const ids: string[] = [];
  for (let i = 1; i <= 5; i++) {
    await post("/items", { category_id: category?.id ?? "", name: `${name} dish ${i}`, price_label: [""], price_amount: ["100"] }, owner.cookie);
    // Distinct times keep the oldest-first order certain.
    const row = await db.prepare("SELECT id FROM items WHERE name = ?").bind(`${name} dish ${i}`).first<{ id: string }>();
    await db.prepare("UPDATE items SET created_at = ? WHERE id = ?").bind(1_000 + i, row?.id).run();
    ids.push(row?.id ?? "");
  }
  return { ...owner, categoryId: category?.id ?? "", ids, code: await codeOf(owner.restaurantId) };
}

const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x10, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20, 1, 2, 3, 4]);
function uploadPhoto(itemId: string, cookie: string) {
  const form = new FormData();
  form.append("photo", new File([WEBP], "a.webp", { type: "image/webp" }));
  const headers = new Headers({ origin: APP, cookie, "cf-connecting-ip": "192.0.2.88" });
  return handleRequest(new Request(`${APP}/items/${itemId}/photo`, { method: "POST", headers, body: form }), env);
}

describe("billing periods", () => {
  it.each([
    ["2026-12-15", "monthly", "2027-01-15"],
    ["2026-01-31", "monthly", "2026-02-28"],
    ["2028-01-31", "monthly", "2028-02-29"],
    ["2026-03-31", "monthly", "2026-04-30"],
    ["2026-11-16", "yearly", "2027-11-16"],
    ["2028-02-29", "yearly", "2029-02-28"],
  ] as const)("%s plus one %s period is %s", (start, period, end) => {
    expect(addBillingPeriod(start, period)).toBe(end);
  });
});

describe("subscriptions", () => {
  it("puts every new signup on the signup plan with no end", async () => {
    const owner = await newOwner("Signup Plan");
    expect(await subscription(owner.restaurantId)).toMatchObject({ name: "Free", billing_period: "none", status: "active", ends_at: null, price_minor: 0 });
  });

  it("falls back to the signup plan the moment a paid period ends, with no job", async () => {
    const owner = await newOwner("Expiry Place");
    const code = await codeOf(owner.restaurantId);
    await subscribe(owner.restaurantId, "pro", Date.now() + 60_000);
    expect(await (await get("/", owner.cookie)).text()).toMatch(/Pro until \d{4}-\d{2}-\d{2}/);
    expect(await (await site(`/r/${code}`)).text()).not.toContain("Powered by TomatoFry");
    await subscribe(owner.restaurantId, "pro", Date.now() - 1);
    expect(await (await get("/", owner.cookie)).text()).toContain("<strong>Free</strong>");
    expect(await (await site(`/r/${code}`)).text()).toContain("Powered by TomatoFry");
    // The menu and QR code keep working (Law 28).
    expect((await site(`/r/${code}`)).status).toBe(200);
  });
});

describe("signup plan switch", () => {
  it("lets the admin choose another free plan for new signups, keeping only one", async () => {
    const admin = await newAdminSession();
    const small = await smallPlan(10);
    const freeId = (await db.prepare("SELECT id FROM plans WHERE legacy_key = 'free'").first<{ id: string }>())?.id ?? "";
    try {
      const form = { name: "Small signup", kind: "free", monthly: "", yearly: "", max_items: "10", custom_theme: "on", dish_photos: "on", logo: "on", signup_default: "on" };
      expect((await adminPost(`/plans/${small}`, form, admin.cookie)).status).toBe(303);
      const defaults = await db.prepare("SELECT id FROM plans WHERE is_signup_default = 1").all<{ id: string }>();
      expect(defaults.results.map((r) => r.id)).toEqual([small]);
      const owner = await newOwner("Gets Small");
      expect((await subscription(owner.restaurantId))?.name).toBe("Small signup");
    } finally {
      await db.batch([
        db.prepare("UPDATE plans SET is_signup_default = 0 WHERE is_signup_default = 1"),
        db.prepare("UPDATE plans SET is_signup_default = 1 WHERE id = ?").bind(freeId),
      ]);
    }
  });

  it("refuses a paid or archived plan as the signup plan, and refuses leaving no signup plan", async () => {
    const admin = await newAdminSession();
    const pro = (await db.prepare("SELECT id FROM plans WHERE legacy_key = 'pro'").first<{ id: string }>())?.id ?? "";
    const free = (await db.prepare("SELECT id FROM plans WHERE legacy_key = 'free'").first<{ id: string }>())?.id ?? "";
    const paid = { name: "Pro", kind: "paid", monthly: "", yearly: "", max_items: "", max_items_unlimited: "on", custom_theme: "on", hide_powered_by: "on", dish_photos: "on", logo: "on", signup_default: "on" };
    expect((await adminPost(`/plans/${pro}`, paid, admin.cookie)).status).toBe(400);
    const archived = await smallPlan(5);
    await db.prepare("UPDATE plans SET status = 'archived' WHERE id = ?").bind(archived).run();
    const freeForm = { name: "Small archived", kind: "free", monthly: "", yearly: "", max_items: "5", signup_default: "on" };
    expect((await adminPost(`/plans/${archived}`, freeForm, admin.cookie)).status).toBe(400);
    // Unticking the box on the current signup plan would leave none.
    const untick = { name: "Free", kind: "free", monthly: "", yearly: "", max_items: "25", custom_theme: "on", dish_photos: "on", logo: "on" };
    expect((await adminPost(`/plans/${free}`, untick, admin.cookie)).status).toBe(400);
    const defaults = await db.prepare("SELECT id FROM plans WHERE is_signup_default = 1").all<{ id: string }>();
    expect(defaults.results.map((r) => r.id)).toEqual([free]);
  });
});

describe("dishes over the plan's limit", () => {
  it("shows only the oldest dishes up to the limit on the public menu", async () => {
    const owner = await ownerWithFiveDishes("Archive Public");
    await subscribe(owner.restaurantId, await smallPlan(3));
    const body = await (await site(`/r/${owner.code}`)).text();
    for (const n of [1, 2, 3]) expect(body).toContain(`Archive Public dish ${n}`);
    for (const n of [4, 5]) expect(body).not.toContain(`Archive Public dish ${n}`);
  });

  it("greys archived dishes in the dashboard and shows the counts", async () => {
    const owner = await ownerWithFiveDishes("Archive Dash");
    await subscribe(owner.restaurantId, await smallPlan(3));
    const body = await (await get(`/?c=${owner.categoryId}`, owner.cookie)).text();
    expect(body).toContain("3 of 3");
    expect(body).toContain("2 archived");
    const archivedRows = body.split('<li class="dish').filter((row) => row.includes("Archived: over your plan"));
    expect(archivedRows.map((row) => row.match(/Archive Dash dish (\d)/)?.[1])).toEqual(["4", "5"]);
    // Archived rows have no edit, availability, or photo actions.
    for (const row of archivedRows) {
      expect(row).not.toContain("/edit");
      expect(row).not.toContain("/availability");
    }
  });

  it("refuses every change to an archived dish on the server, but allows deleting it", async () => {
    const owner = await ownerWithFiveDishes("Archive Lock");
    await subscribe(owner.restaurantId, await smallPlan(3));
    const archived = owner.ids[4] ?? "";
    expect((await get(`/items/${archived}/edit`, owner.cookie)).status).toBe(403);
    expect((await post(`/items/${archived}`, { category_id: owner.categoryId, name: "Changed", price_label: [""], price_amount: ["1"] }, owner.cookie)).status).toBe(403);
    expect((await post(`/items/${archived}/availability`, { available: "0" }, owner.cookie)).status).toBe(403);
    expect((await uploadPhoto(archived, owner.cookie)).status).toBe(403);
    expect((await post(`/items/${archived}/photo/delete`, {}, owner.cookie)).status).toBe(403);
    const row = await db.prepare("SELECT name, is_available, photo_key FROM items WHERE id = ?").bind(archived).first();
    expect(row).toEqual({ name: "Archive Lock dish 5", is_available: 1, photo_key: null });
    expect((await post(`/items/${archived}/delete`, {}, owner.cookie)).status).toBe(303);
    expect(await db.prepare("SELECT 1 FROM items WHERE id = ?").bind(archived).first()).toBeNull();
  });

  it("brings the next archived dish back when an active one is deleted", async () => {
    const owner = await ownerWithFiveDishes("Archive Shift");
    await subscribe(owner.restaurantId, await smallPlan(3));
    await post(`/items/${owner.ids[0]}/delete`, {}, owner.cookie);
    const body = await (await site(`/r/${owner.code}`)).text();
    for (const n of [2, 3, 4]) expect(body).toContain(`Archive Shift dish ${n}`);
    expect(body).not.toContain("Archive Shift dish 5");
    expect((await get(`/items/${owner.ids[3]}/edit`, owner.cookie)).status).toBe(200);
  });

  it("brings every dish back when the limit allows it again", async () => {
    const owner = await ownerWithFiveDishes("Archive Return");
    await subscribe(owner.restaurantId, await smallPlan(3));
    await subscribe(owner.restaurantId, "pro");
    const body = await (await site(`/r/${owner.code}`)).text();
    for (const n of [1, 2, 3, 4, 5]) expect(body).toContain(`Archive Return dish ${n}`);
  });

  it("still refuses a new dish while the menu is at or over the limit", async () => {
    const owner = await ownerWithFiveDishes("Archive Add");
    await subscribe(owner.restaurantId, await smallPlan(3));
    const response = await post("/items", { category_id: owner.categoryId, name: "One more", price_label: [""], price_amount: ["100"] }, owner.cookie);
    expect(response.status).toBe(403);
  });

  it("never lets one owner touch another owner's dishes, archived or not", async () => {
    const victim = await ownerWithFiveDishes("Archive Victim");
    await subscribe(victim.restaurantId, await smallPlan(3));
    const attacker = await newOwner("Archive Attacker");
    for (const id of [victim.ids[0] ?? "", victim.ids[4] ?? ""]) {
      expect((await get(`/items/${id}/edit`, attacker.cookie)).status).toBe(404);
      expect((await post(`/items/${id}/delete`, {}, attacker.cookie)).status).toBe(404);
      expect((await post(`/items/${id}/availability`, { available: "0" }, attacker.cookie)).status).toBe(404);
    }
    const count = await db.prepare("SELECT COUNT(*) AS n FROM items WHERE restaurant_id = ?").bind(victim.restaurantId).first<{ n: number }>();
    expect(count?.n).toBe(5);
  });
});

describe("subscription queries", () => {
  // Law 26: every lookup uses an index, and nothing scans a growing table.
  it.each(Object.entries(SUBSCRIPTION_SQL))("%s searches an index and needs no extra sort", async (_name, sql) => {
    const params = (sql.match(/\?\d?/g) ?? []).map(() => "x");
    const unique = [...new Set(sql.match(/\?\d/g) ?? [])];
    const bind = unique.length > 0 ? unique.map(() => "x") : params;
    const { results } = await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...bind).all<{ detail: string }>();
    const details = results.map((row) => row.detail);
    expect(details.filter((d) => d.includes("TEMP B-TREE"))).toEqual([]);
    expect(details.filter((d) => d.startsWith("SCAN"))).toEqual([]);
  });
});
