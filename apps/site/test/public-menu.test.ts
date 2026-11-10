import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleRequest } from "../src/index";
import { PUBLIC_MENU_SQL } from "../src/shared/public-menu-db";
import { contrastRatio, themeColors } from "../src/shared/theme";
import { db, get, newOwner, passTurnstile, post } from "./helpers";

beforeEach(() => passTurnstile());
afterEach(() => vi.restoreAllMocks());

const site = (path: string) => handleRequest(new Request(`https://tomatofry.com${path}`), env);

async function slugOf(restaurantId: string) {
  return (await db.prepare("SELECT slug FROM restaurants WHERE id = ?").bind(restaurantId).first<{ slug: string }>())?.slug ?? "";
}

/** An owner with a two-category menu. */
async function ownerWithMenu(name: string) {
  const owner = await newOwner(name);
  await post("/categories", { name: "Karahi" }, owner.cookie);
  await post("/categories", { name: "Drinks" }, owner.cookie);
  const cats = await db
    .prepare("SELECT id, name FROM categories WHERE restaurant_id = ? ORDER BY sort_order")
    .bind(owner.restaurantId)
    .all<{ id: string; name: string }>();
  const karahi = cats.results.find((c) => c.name === "Karahi")?.id ?? "";
  const drinks = cats.results.find((c) => c.name === "Drinks")?.id ?? "";
  await post("/items", { category_id: karahi, name: `${name} chicken karahi`, description: "Green chilli", price_label: ["Half", "Full"], price_amount: ["1300", "2400"] }, owner.cookie);
  await post("/items", { category_id: karahi, name: `${name} mutton karahi`, price_label: [""], price_amount: ["4900"] }, owner.cookie);
  await post("/items", { category_id: drinks, name: `${name} lassi`, price_label: [""], price_amount: ["350"] }, owner.cookie);
  const mutton = await db.prepare("SELECT id FROM items WHERE name = ?").bind(`${name} mutton karahi`).first<{ id: string }>();
  await post(`/items/${mutton?.id}/availability`, { available: "0" }, owner.cookie);
  return { ...owner, slug: await slugOf(owner.restaurantId) };
}

describe("public menu page", () => {
  it("shows the restaurant, categories, dishes, and prices", async () => {
    const owner = await ownerWithMenu("Menu One");
    const response = await site(`/r/${owner.slug}`);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("Menu One");
    expect(body.indexOf("Karahi")).toBeLessThan(body.indexOf("Drinks"));
    expect(body).toContain("Menu One chicken karahi");
    expect(body).toContain("Half");
    expect(body).toContain("Rs 2,400");
    expect(body).toContain("Rs 350");
  });

  it("marks a dish that is not available today", async () => {
    const owner = await ownerWithMenu("Menu Two");
    const body = await (await site(`/r/${owner.slug}`)).text();
    const mutton = body.slice(body.indexOf("Menu Two mutton karahi"));
    expect(mutton.slice(0, 400)).toContain("Not available today");
  });

  it("shows only this restaurant's dishes", async () => {
    const a = await ownerWithMenu("Isolated A");
    await ownerWithMenu("Isolated B");
    const body = await (await site(`/r/${a.slug}`)).text();
    expect(body).toContain("Isolated A chicken karahi");
    expect(body).not.toContain("Isolated B");
  });

  it("never shows private account details", async () => {
    const owner = await ownerWithMenu("Private Fields");
    const body = await (await site(`/r/${owner.slug}`)).text();
    expect(body).not.toContain("@example.test");
    expect(body).not.toContain("pbkdf2");
  });

  it("shows Powered by on Free and hides it on active Pro", async () => {
    const owner = await ownerWithMenu("Plan Check");
    expect(await (await site(`/r/${owner.slug}`)).text()).toContain("Powered by TomatoFry");
    await db.prepare("UPDATE restaurants SET plan = 'pro', plan_expires_at = NULL WHERE id = ?").bind(owner.restaurantId).run();
    expect(await (await site(`/r/${owner.slug}`)).text()).not.toContain("Powered by TomatoFry");
    await db.prepare("UPDATE restaurants SET plan_expires_at = 1 WHERE id = ?").bind(owner.restaurantId).run();
    const expired = await site(`/r/${owner.slug}`);
    expect(expired.status).toBe(200);
    expect(await expired.text()).toContain("Powered by TomatoFry");
  });

  it("shows a suspended restaurant as unavailable", async () => {
    const owner = await ownerWithMenu("Suspended Place");
    await db.prepare("UPDATE restaurants SET status = 'suspended' WHERE id = ?").bind(owner.restaurantId).run();
    const body = await (await site(`/r/${owner.slug}`)).text();
    expect(body).toContain("This menu is currently unavailable");
    expect(body).not.toContain("Suspended Place chicken karahi");
  });

  it("returns 404 for an unknown or malformed link", async () => {
    expect((await site("/r/no-such-restaurant")).status).toBe(404);
    expect((await site("/r/..%2F..%2Fetc")).status).toBe(404);
  });

  it("links to a call button with the restaurant phone", async () => {
    const owner = await ownerWithMenu("Phone Place");
    const body = await (await site(`/r/${owner.slug}`)).text();
    expect(body).toMatch(/href="tel:\+?\d+"/);
  });

  it("escapes what the owner typed", async () => {
    const owner = await newOwner("Escape Check");
    await post("/categories", { name: "<b>Bold</b>" }, owner.cookie);
    // Empty categories are hidden on the public menu, so the category gets one dish.
    const category = await db.prepare("SELECT id FROM categories WHERE restaurant_id = ?").bind(owner.restaurantId).first<{ id: string }>();
    await post("/items", { category_id: category?.id ?? "", name: "<i>Dish</i>", price_label: [""], price_amount: ["100"] }, owner.cookie);
    const body = await (await site(`/r/${await slugOf(owner.restaurantId)}`)).text();
    expect(body).not.toContain("<b>Bold</b>");
    expect(body).toContain("&lt;b&gt;Bold&lt;/b&gt;");
    expect(body).not.toContain("<i>Dish</i>");
  });
});

describe("public menu queries", () => {
  // Law 26: anyone can open a menu, so every query must use an index, never read a whole table.
  it.each(Object.entries(PUBLIC_MENU_SQL))("%s query uses an index and needs no extra sort", async (_name, sql) => {
    const { results } = await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind("x").all<{ detail: string }>();
    const details = results.map((row) => row.detail);
    expect(details.some((d) => d.startsWith("SEARCH") && d.includes("INDEX"))).toBe(true);
    expect(details.filter((d) => d.startsWith("SCAN") || d.includes("TEMP B-TREE"))).toEqual([]);
  });
});

describe("theme", () => {
  it("serves the restaurant's theme as a stylesheet", async () => {
    const owner = await ownerWithMenu("Theme Sheet");
    await post("/theme", { color: "#0f6e56", mode: "dark", photos: "small" }, owner.cookie);
    const css = await site(`/r/${owner.slug}/theme.css`);
    expect(css.headers.get("content-type")).toContain("text/css");
    const text = await css.text();
    expect(text).toContain("#0f6e56");
    const page = await (await site(`/r/${owner.slug}`)).text();
    expect(page).toContain('class="menu dark photos-small"');
  });

  it("picks dark text on a light brand colour and white text on a dark one", () => {
    expect(themeColors("#ffe066", "light").onBrand).toBe("#000000");
    expect(themeColors("#123a26", "light").onBrand).toBe("#ffffff");
  });

  it("keeps price text readable even when the brand colour is pale", () => {
    const pale = themeColors("#ffe066", "light");
    expect(contrastRatio(pale.accentText, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(pale.adjusted).toBe(true);
    const dark = themeColors("#123a26", "dark");
    expect(contrastRatio(dark.accentText, dark.background)).toBeGreaterThanOrEqual(4.5);
  });

  it("saves the theme from the owner area and refuses a bad colour", async () => {
    const owner = await newOwner("Theme Save");
    expect((await post("/theme", { color: "#c8321f", mode: "light", photos: "large" }, owner.cookie)).status).toBe(303);
    expect((await post("/theme", { color: "red; background:url(x)", mode: "light", photos: "large" }, owner.cookie)).status).toBe(400);
    expect((await post("/theme", { color: "#c8321f", mode: "neon", photos: "large" }, owner.cookie)).status).toBe(400);
    const row = await db.prepare("SELECT theme_color, theme_mode FROM restaurants WHERE id = ?").bind(owner.restaurantId).first();
    expect(row).toEqual({ theme_color: "#c8321f", theme_mode: "light" });
  });

  it("warns the owner when the colour is hard to read", async () => {
    const owner = await newOwner("Theme Warn");
    await post("/theme", { color: "#ffe066", mode: "light", photos: "large" }, owner.cookie);
    expect(await (await get("/theme", owner.cookie)).text()).toMatch(/hard to read/i);
  });

  it("changes only the logged-in owner's theme", async () => {
    const a = await newOwner("Theme A");
    const b = await newOwner("Theme B");
    await post("/theme", { color: "#3c3489", mode: "dark", photos: "small" }, a.cookie);
    const row = await db.prepare("SELECT theme_color FROM restaurants WHERE id = ?").bind(b.restaurantId).first<{ theme_color: string }>();
    expect(row?.theme_color).toBe("#c8321f");
  });
});
