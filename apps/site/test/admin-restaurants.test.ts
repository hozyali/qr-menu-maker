import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { handleRequest } from "../src/index";
import { ADMIN_SQL, PAGE_SIZE } from "../src/shared/admin-db";
import { ADMIN, adminGet, adminPost, codeOf, db, get, newAdminSession, newOwner, passTurnstile } from "./helpers";

beforeEach(() => passTurnstile());
afterEach(() => vi.restoreAllMocks());

const site = (path: string) => handleRequest(new Request(`https://tomatofry.com${path}`), env);

let seq = 0;
/** Adds a restaurant straight to the database, so paging tests can make many quickly. */
async function insertRestaurant(name: string, createdAt: number) {
  seq++;
  const userId = crypto.randomUUID();
  const id = crypto.randomUUID();
  await db.batch([
    db.prepare("INSERT INTO users (id, email, password_hash, role, created_at) VALUES (?, ?, 'x', 'owner', ?)").bind(userId, `page${seq}@example.test`, createdAt),
    db
      .prepare("INSERT INTO restaurants (id, owner_user_id, name, slug, menu_code, city, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'Lahore', ?, ?)")
      .bind(id, userId, name, `page-slug-${seq}`, `pg${String(seq).padStart(4, "0")}`.slice(0, 6), createdAt, createdAt),
  ]);
  return id;
}

async function restaurantRow(id: string) {
  return db.prepare("SELECT plan, plan_expires_at, status FROM restaurants WHERE id = ?").bind(id).first<{ plan: string; plan_expires_at: number | null; status: string }>();
}

async function auditRows(restaurantId: string) {
  const { results } = await db
    .prepare("SELECT actor_user_id, action, details FROM audit_log WHERE restaurant_id = ? ORDER BY created_at, id")
    .bind(restaurantId)
    .all<{ actor_user_id: string; action: string; details: string }>();
  return results;
}

describe("admin access", () => {
  it("needs an admin session for every restaurant page", async () => {
    const owner = await newOwner("Admin Access");
    for (const path of ["/", `/restaurants/${owner.restaurantId}`, `/restaurants/${owner.restaurantId}/suspend`]) {
      const response = await adminGet(path, owner.cookie);
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/login");
    }
    const post = await adminPost(`/restaurants/${owner.restaurantId}/plan`, { plan: "pro", expires: "" }, owner.cookie);
    expect(post.status).toBe(303);
    expect((await restaurantRow(owner.restaurantId))?.plan).toBe("free");
  });
});

describe("restaurant list", () => {
  it("lists restaurants newest first with the owner's email and plan", async () => {
    const admin = await newAdminSession();
    const owner = await newOwner("Listed Place");
    const body = await (await adminGet("/", admin.cookie)).text();
    expect(body).toContain("Listed Place");
    expect(body).toMatch(/menu-owner\d+@example\.test/);
    expect(body).toContain(`href="/restaurants/${owner.restaurantId}"`);
    expect(body).toContain("Free");
  });

  it("pages through every restaurant once, with no gaps or repeats", async () => {
    const admin = await newAdminSession();
    // Two rows share a time, so the id must break the tie.
    const base = 2_000_000_000_000;
    const ids: string[] = [];
    for (let i = 0; i < PAGE_SIZE + 7; i++) ids.push(await insertRestaurant(`Paged ${i}`, base + Math.floor(i / 2)));

    const seen: string[] = [];
    let path = "/";
    for (let pages = 0; pages < 20 && path; pages++) {
      const body = await (await adminGet(path, admin.cookie)).text();
      seen.push(...[...body.matchAll(/href="\/restaurants\/([0-9a-f-]{36})"/g)].map((m) => m[1] ?? ""));
      path = body.match(/href="(\/\?before=[^"]+)"/)?.[1]?.replace(/&amp;/g, "&") ?? "";
    }
    for (const id of ids) expect(seen.filter((s) => s === id)).toHaveLength(1);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("ignores a broken page cursor", async () => {
    const admin = await newAdminSession();
    expect((await adminGet("/?before=not-a-cursor", admin.cookie)).status).toBe(200);
  });
});

describe("restaurant detail", () => {
  it("shows the details, menu link, and dish count", async () => {
    const admin = await newAdminSession();
    const owner = await newOwner("Detail Place");
    const body = await (await adminGet(`/restaurants/${owner.restaurantId}`, admin.cookie)).text();
    expect(body).toContain("Detail Place");
    expect(body).toContain(`tomatofry.com/r/${await codeOf(owner.restaurantId)}`);
    expect(body).toContain("0300 1234567");
    expect(body).toMatch(/Dishes<\/span>\s*<strong>0<\/strong>/);
  });

  it("returns 404 for an unknown or malformed id", async () => {
    const admin = await newAdminSession();
    expect((await adminGet(`/restaurants/${crypto.randomUUID()}`, admin.cookie)).status).toBe(404);
    expect((await adminGet("/restaurants/../../users", admin.cookie)).status).toBe(404);
  });
});

describe("plan changes", () => {
  it("sets Pro until the end of the chosen day in Pakistan and logs it", async () => {
    const admin = await newAdminSession();
    const owner = await newOwner("Plan Pro");
    const response = await adminPost(`/restaurants/${owner.restaurantId}/plan`, { plan: "pro", expires: "2099-03-31" }, admin.cookie);
    expect(response.status).toBe(303);
    const row = await restaurantRow(owner.restaurantId);
    expect(row?.plan).toBe("pro");
    // 31 March 2099, 23:59:59.999 in Pakistan (UTC+5).
    expect(row?.plan_expires_at).toBe(Date.UTC(2099, 2, 31, 23, 59, 59, 999) - 5 * 60 * 60 * 1000);
    const audit = await auditRows(owner.restaurantId);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_user_id: admin.userId, action: "plan_changed" });
    expect(JSON.parse(audit[0]?.details ?? "{}")).toMatchObject({ from: { plan: "free" }, to: { plan: "pro", expires: "2099-03-31" } });
    // The owner sees the new plan on the next request.
    expect(await (await get("/", owner.cookie)).text()).toContain("Pro");
  });

  it("allows Pro with no end date, and Free always clears the date", async () => {
    const admin = await newAdminSession();
    const owner = await newOwner("Plan Open");
    await adminPost(`/restaurants/${owner.restaurantId}/plan`, { plan: "pro", expires: "" }, admin.cookie);
    expect(await restaurantRow(owner.restaurantId)).toMatchObject({ plan: "pro", plan_expires_at: null });
    await adminPost(`/restaurants/${owner.restaurantId}/plan`, { plan: "free", expires: "2099-01-01" }, admin.cookie);
    expect(await restaurantRow(owner.restaurantId)).toMatchObject({ plan: "free", plan_expires_at: null });
  });

  it.each([
    ["an unknown plan", { plan: "gold", expires: "" }],
    ["a past date", { plan: "pro", expires: "2020-01-01" }],
    ["a broken date", { plan: "pro", expires: "2099-02-30" }],
    ["a date in another format", { plan: "pro", expires: "31/03/2099" }],
  ])("refuses %s and changes nothing", async (_label, form) => {
    const admin = await newAdminSession();
    const owner = await newOwner("Plan Refuse");
    expect((await adminPost(`/restaurants/${owner.restaurantId}/plan`, form, admin.cookie)).status).toBe(400);
    expect(await restaurantRow(owner.restaurantId)).toMatchObject({ plan: "free", plan_expires_at: null });
    expect(await auditRows(owner.restaurantId)).toHaveLength(0);
  });

  it("refuses a plan form posted from another site", async () => {
    const admin = await newAdminSession();
    const owner = await newOwner("Plan Csrf");
    const response = await adminPost(`/restaurants/${owner.restaurantId}/plan`, { plan: "pro", expires: "" }, admin.cookie, "https://evil.example");
    expect(response.status).toBe(403);
    expect((await restaurantRow(owner.restaurantId))?.plan).toBe("free");
  });
});

describe("suspending", () => {
  it("asks for confirmation on a page, not a popup", async () => {
    const admin = await newAdminSession();
    const owner = await newOwner("Suspend Ask");
    const body = await (await adminGet(`/restaurants/${owner.restaurantId}/suspend`, admin.cookie)).text();
    expect(body).toContain(`action="/restaurants/${owner.restaurantId}/suspend"`);
    expect(body).not.toMatch(/confirm\(|alert\(/);
    expect((await restaurantRow(owner.restaurantId))?.status).toBe("active");
  });

  it("suspends and reactivates, keeps the same link, and logs both", async () => {
    const admin = await newAdminSession();
    const owner = await newOwner("Suspend Place");
    const code = await codeOf(owner.restaurantId);
    expect((await adminPost(`/restaurants/${owner.restaurantId}/suspend`, {}, admin.cookie)).status).toBe(303);
    expect((await restaurantRow(owner.restaurantId))?.status).toBe("suspended");
    expect(await (await site(`/r/${code}`)).text()).toContain("This menu is currently unavailable");

    expect((await adminPost(`/restaurants/${owner.restaurantId}/reactivate`, {}, admin.cookie)).status).toBe(303);
    expect((await restaurantRow(owner.restaurantId))?.status).toBe("active");
    expect(await codeOf(owner.restaurantId)).toBe(code);
    expect((await auditRows(owner.restaurantId)).map((r) => r.action)).toEqual(["restaurant_suspended", "restaurant_reactivated"]);

    const detail = await (await adminGet(`/restaurants/${owner.restaurantId}`, admin.cookie)).text();
    expect(detail).toContain("restaurant_suspended");
    expect(detail).toContain(admin.email);
  });

  it("returns 404 when suspending an unknown restaurant and logs nothing", async () => {
    const admin = await newAdminSession();
    const id = crypto.randomUUID();
    expect((await adminPost(`/restaurants/${id}/suspend`, {}, admin.cookie)).status).toBe(404);
    expect(await auditRows(id)).toHaveLength(0);
  });
});

describe("admin queries", () => {
  // Law 26: the admin list and history grow with every restaurant and action, so each query must use an index.
  it.each(Object.entries(ADMIN_SQL))("%s searches an index and needs no extra sort", async (name, sql) => {
    const params = (sql.match(/\?/g) ?? []).map(() => "x");
    const { results } = await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...params).all<{ detail: string }>();
    const details = results.map((row) => row.detail);
    expect(details.filter((d) => d.includes("TEMP B-TREE"))).toEqual([]);
    // A SCAN reads a whole table or index. Only the first list page may scan, because it walks the
    // restaurants_created index in order and stops after one page (LIMIT).
    const scans = details.filter((d) => d.startsWith("SCAN"));
    expect(scans).toEqual(name === "listFirst" ? ["SCAN r USING INDEX restaurants_created"] : []);
    expect(details.filter((d) => d.startsWith("SEARCH")).every((d) => d.includes("INDEX"))).toBe(true);
  });
});

void ADMIN;
