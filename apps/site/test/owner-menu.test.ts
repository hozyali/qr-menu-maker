import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { planLimit, planAllows, effectivePlan } from "../src/shared/plans";
import { loadEntitlements } from "../src/shared/plans-db";
import { db, get, newOwner, passTurnstile, post } from "./helpers";

beforeEach(() => passTurnstile());
afterEach(() => vi.restoreAllMocks());

const categoryId = async (restaurantId: string, name: string) =>
  (await db.prepare("SELECT id FROM categories WHERE restaurant_id = ? AND name = ?").bind(restaurantId, name).first<{ id: string }>())?.id ?? "";

const itemRow = async (name: string) =>
  db
    .prepare("SELECT id, restaurant_id, name, description, is_available, category_id FROM items WHERE name = ?")
    .bind(name)
    .first<{ id: string; restaurant_id: string; name: string; description: string | null; is_available: number; category_id: string }>();

const prices = async (itemId: string) =>
  (
    await db
      .prepare("SELECT label, amount_minor FROM item_prices WHERE item_id = ? ORDER BY sort_order")
      .bind(itemId)
      .all<{ label: string; amount_minor: number }>()
  ).results;

async function addDish(cookie: string, category: string, name: string, priceRows: [string, string][]) {
  return post(
    "/items",
    {
      category_id: category,
      name,
      description: "",
      price_label: priceRows.map((p) => p[0]),
      price_amount: priceRows.map((p) => p[1]),
    },
    cookie,
  );
}

describe("plans", () => {
  // Since issue #38 the plans live in the database. These check the seeded plans through the same
  // functions the app uses.
  it("gives the Free plan 25 dishes and the theme", async () => {
    const free = await loadEntitlements(db, "free");
    expect(planLimit(free, "max_items")).toBe(25);
    expect(planAllows(free, "custom_theme")).toBe(true);
  });

  it("gives Pro unlimited dishes", async () => {
    expect(planLimit(await loadEntitlements(db, "pro"), "max_items")).toBeNull();
  });

  it("treats an expired Pro plan as Free", () => {
    expect(effectivePlan("pro", 1, 2)).toBe("free");
    expect(effectivePlan("pro", null, 2)).toBe("pro");
    expect(effectivePlan("pro", 5, 2)).toBe("pro");
  });
});

describe("categories", () => {
  it("adds a category and shows it on the dashboard", async () => {
    const { cookie } = await newOwner();
    const response = await post("/categories", { name: "Karahi" }, cookie);
    expect(response.status).toBe(303);
    expect(await (await get("/", cookie)).text()).toContain("Karahi");
  });

  it("renames, moves, and deletes its own category", async () => {
    const { cookie, restaurantId } = await newOwner();
    await post("/categories", { name: "First" }, cookie);
    await post("/categories", { name: "Second" }, cookie);
    const second = await categoryId(restaurantId, "Second");

    await post(`/categories/${second}/move`, { direction: "up" }, cookie);
    const order = await db
      .prepare("SELECT name FROM categories WHERE restaurant_id = ? ORDER BY sort_order")
      .bind(restaurantId)
      .all<{ name: string }>();
    expect(order.results.map((r) => r.name)).toEqual(["Second", "First"]);

    await post(`/categories/${second}/rename`, { name: "Renamed" }, cookie);
    expect(await categoryId(restaurantId, "Renamed")).toBe(second);

    const confirm = await get(`/categories/${second}/delete`, cookie);
    expect(await confirm.text()).toContain("Renamed");
    await post(`/categories/${second}/delete`, {}, cookie);
    expect(await categoryId(restaurantId, "Renamed")).toBe("");
  });

  it("refuses an empty category name", async () => {
    const { cookie, restaurantId } = await newOwner();
    const response = await post("/categories", { name: "   " }, cookie);
    expect(response.status).toBe(400);
    const count = await db.prepare("SELECT COUNT(*) AS n FROM categories WHERE restaurant_id = ?").bind(restaurantId).first<{ n: number }>();
    expect(count?.n).toBe(0);
  });
});

describe("dishes", () => {
  it("adds a dish with half and full prices", async () => {
    const { cookie, restaurantId } = await newOwner();
    await post("/categories", { name: "Karahi" }, cookie);
    const karahi = await categoryId(restaurantId, "Karahi");
    const response = await addDish(cookie, karahi, "Chicken karahi", [
      ["Half", "1300"],
      ["Full", "2,400"],
    ]);
    expect(response.status).toBe(303);
    const item = await itemRow("Chicken karahi");
    expect(item?.restaurant_id).toBe(restaurantId);
    expect(await prices(item?.id ?? "")).toEqual([
      { label: "Half", amount_minor: 130000 },
      { label: "Full", amount_minor: 240000 },
    ]);
    const page = await (await get(`/?c=${karahi}`, cookie)).text();
    expect(page).toContain("Chicken karahi");
    expect(page).toContain("Rs 2,400");
  });

  it("skips empty price rows and needs at least one price", async () => {
    const { cookie, restaurantId } = await newOwner();
    await post("/categories", { name: "Drinks" }, cookie);
    const drinks = await categoryId(restaurantId, "Drinks");
    const none = await addDish(cookie, drinks, "No price", [["", ""]]);
    expect(none.status).toBe(400);
    expect(await itemRow("No price")).toBeNull();

    await addDish(cookie, drinks, "Lassi", [
      ["", "350"],
      ["", ""],
    ]);
    const lassi = await itemRow("Lassi");
    expect(await prices(lassi?.id ?? "")).toEqual([{ label: "", amount_minor: 35000 }]);
  });

  it("refuses a negative or non-number price", async () => {
    const { cookie, restaurantId } = await newOwner();
    await post("/categories", { name: "BBQ" }, cookie);
    const bbq = await categoryId(restaurantId, "BBQ");
    expect((await addDish(cookie, bbq, "Bad price", [["", "-5"]])).status).toBe(400);
    expect((await addDish(cookie, bbq, "Bad price 2", [["", "abc"]])).status).toBe(400);
  });

  it("edits a dish and replaces its prices", async () => {
    const { cookie, restaurantId } = await newOwner();
    await post("/categories", { name: "Karahi" }, cookie);
    const karahi = await categoryId(restaurantId, "Karahi");
    await addDish(cookie, karahi, "Old name", [["", "100"]]);
    const item = await itemRow("Old name");
    await post(
      `/items/${item?.id}`,
      { category_id: karahi, name: "New name", description: "Fresh", price_label: ["Half", "Full"], price_amount: ["700", "1300"] },
      cookie,
    );
    const edited = await itemRow("New name");
    expect(edited?.description).toBe("Fresh");
    expect(await prices(edited?.id ?? "")).toEqual([
      { label: "Half", amount_minor: 70000 },
      { label: "Full", amount_minor: 130000 },
    ]);
  });

  it("switches a dish to not available and back", async () => {
    const { cookie, restaurantId } = await newOwner();
    await post("/categories", { name: "Karahi" }, cookie);
    await addDish(cookie, await categoryId(restaurantId, "Karahi"), "Toggle me", [["", "100"]]);
    const item = await itemRow("Toggle me");
    await post(`/items/${item?.id}/availability`, { available: "0" }, cookie);
    expect((await itemRow("Toggle me"))?.is_available).toBe(0);
    await post(`/items/${item?.id}/availability`, { available: "1" }, cookie);
    expect((await itemRow("Toggle me"))?.is_available).toBe(1);
  });

  it("deletes a dish after the confirmation page", async () => {
    const { cookie, restaurantId } = await newOwner();
    await post("/categories", { name: "Karahi" }, cookie);
    await addDish(cookie, await categoryId(restaurantId, "Karahi"), "Delete me", [["", "100"]]);
    const item = await itemRow("Delete me");
    expect(await (await get(`/items/${item?.id}/delete`, cookie)).text()).toContain("Delete me");
    await post(`/items/${item?.id}/delete`, {}, cookie);
    expect(await itemRow("Delete me")).toBeNull();
    expect(await prices(item?.id ?? "")).toEqual([]);
  });

  it("stops the Free plan at 25 dishes", async () => {
    const { cookie, restaurantId } = await newOwner();
    await post("/categories", { name: "Many" }, cookie);
    const many = await categoryId(restaurantId, "Many");
    for (let i = 1; i <= 25; i++) {
      await addDish(cookie, many, `Dish ${restaurantId} ${i}`, [["", "100"]]);
    }
    const response = await addDish(cookie, many, `Dish ${restaurantId} 26`, [["", "100"]]);
    expect(response.status).toBe(403);
    // Since issue #38 the message names the restaurant's own plan, because the admin can rename plans.
    expect(await response.text()).toContain("Your Free plan allows 25 dishes.");
    const count = await db.prepare("SELECT COUNT(*) AS n FROM items WHERE restaurant_id = ?").bind(restaurantId).first<{ n: number }>();
    expect(count?.n).toBe(25);
  });

  it("lets Pro add more than 25 dishes", async () => {
    const { cookie, restaurantId } = await newOwner();
    await db.prepare("UPDATE restaurants SET plan = 'pro' WHERE id = ?").bind(restaurantId).run();
    await post("/categories", { name: "Many" }, cookie);
    const many = await categoryId(restaurantId, "Many");
    for (let i = 1; i <= 26; i++) {
      await addDish(cookie, many, `Pro dish ${restaurantId} ${i}`, [["", "100"]]);
    }
    const count = await db.prepare("SELECT COUNT(*) AS n FROM items WHERE restaurant_id = ?").bind(restaurantId).first<{ n: number }>();
    expect(count?.n).toBe(26);
  });
});

describe("tenant isolation through every route (Law 18)", () => {
  let a: { cookie: string; restaurantId: string };
  let b: { cookie: string; restaurantId: string };
  let bCategory: string;
  let bItem: string;

  beforeEach(async () => {
    a = await newOwner("Owner A");
    b = await newOwner("Owner B");
    await post("/categories", { name: "B secret category" }, b.cookie);
    bCategory = await categoryId(b.restaurantId, "B secret category");
    await addDish(b.cookie, bCategory, `B secret dish ${b.restaurantId}`, [["", "999"]]);
    bItem = (await itemRow(`B secret dish ${b.restaurantId}`))?.id ?? "";
  });

  it("does not show B's menu on A's dashboard", async () => {
    const page = await (await get(`/?c=${bCategory}`, a.cookie)).text();
    expect(page).not.toContain("B secret category");
    expect(page).not.toContain("B secret dish");
  });

  it("does not open B's dish or category pages for A", async () => {
    expect((await get(`/items/${bItem}/edit`, a.cookie)).status).toBe(404);
    expect((await get(`/items/${bItem}/delete`, a.cookie)).status).toBe(404);
    expect((await get(`/categories/${bCategory}/delete`, a.cookie)).status).toBe(404);
  });

  it("does not let A change or delete B's dish", async () => {
    await post(`/items/${bItem}`, { category_id: bCategory, name: "Hacked", price_label: [""], price_amount: ["1"] }, a.cookie);
    await post(`/items/${bItem}/availability`, { available: "0" }, a.cookie);
    await post(`/items/${bItem}/delete`, {}, a.cookie);
    const item = await itemRow(`B secret dish ${b.restaurantId}`);
    expect(item?.is_available).toBe(1);
    expect(await prices(bItem)).toEqual([{ label: "", amount_minor: 99900 }]);
  });

  it("does not let A rename, move, or delete B's category", async () => {
    await post(`/categories/${bCategory}/rename`, { name: "Hacked" }, a.cookie);
    await post(`/categories/${bCategory}/move`, { direction: "up" }, a.cookie);
    await post(`/categories/${bCategory}/delete`, {}, a.cookie);
    expect(await categoryId(b.restaurantId, "B secret category")).toBe(bCategory);
  });

  it("does not let A add a dish to B's category or move a dish there", async () => {
    const add = await addDish(a.cookie, bCategory, "Planted by A", [["", "1"]]);
    expect(add.status).toBe(404);
    expect(await itemRow("Planted by A")).toBeNull();

    await post("/categories", { name: "A category" }, a.cookie);
    const aCategory = await categoryId(a.restaurantId, "A category");
    await addDish(a.cookie, aCategory, `A dish ${a.restaurantId}`, [["", "1"]]);
    const aItem = await itemRow(`A dish ${a.restaurantId}`);
    await post(`/items/${aItem?.id}`, { category_id: bCategory, name: "Moved", price_label: [""], price_amount: ["1"] }, a.cookie);
    expect((await itemRow(`A dish ${a.restaurantId}`))?.category_id).toBe(aCategory);
  });

  it("does not let a logged-out visitor change anything", async () => {
    const response = await post(`/items/${bItem}/delete`, {});
    expect(response.status).toBe(303);
    expect(await itemRow(`B secret dish ${b.restaurantId}`)).not.toBeNull();
  });
});
