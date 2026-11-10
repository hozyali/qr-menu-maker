import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { tenantDb } from "../src/shared/tenant-db";

// Raw queries are allowed in tests only, to set up data and to look behind the helper.
const db = env.DB;
const A = "restaurant-a";
const B = "restaurant-b";

async function addRestaurant(id: string) {
  await db.batch([
    db
      .prepare("INSERT INTO users (id, email, password_hash, role, created_at) VALUES (?, ?, 'hash', 'owner', 1)")
      .bind(`user-${id}`, `${id}@example.test`),
    db
      .prepare("INSERT INTO restaurants (id, owner_user_id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)")
      .bind(id, `user-${id}`, `Name ${id}`, id),
  ]);
}

let categoryOfB: { id: string };
let itemOfB: { id: string };

beforeAll(async () => {
  await addRestaurant(A);
  await addRestaurant(B);
  await tenantDb(db, A).createCategory("Karahi of A");
  categoryOfB = await tenantDb(db, B).createCategory("Karahi of B");
  const item = await tenantDb(db, B).createItem({
    categoryId: categoryOfB.id,
    name: "Chicken karahi",
    prices: [
      { label: "Half", amountMinor: 130000 },
      { label: "Full", amountMinor: 240000 },
    ],
  });
  if (!item) throw new Error("Test setup failed");
  itemOfB = item;
});

describe("tenant isolation: Owner A against Owner B's data", () => {
  it("lists only the owner's own categories", async () => {
    const names = (await tenantDb(db, A).listCategories()).map((c) => c.name);
    expect(names).toEqual(["Karahi of A"]);
  });

  it("cannot rename another restaurant's category", async () => {
    expect(await tenantDb(db, A).renameCategory(categoryOfB.id, "Hacked")).toBe(false);
    const names = (await tenantDb(db, B).listCategories()).map((c) => c.name);
    expect(names).toContain("Karahi of B");
  });

  it("cannot delete another restaurant's category", async () => {
    expect(await tenantDb(db, A).deleteCategory(categoryOfB.id)).toBe(false);
    expect(await tenantDb(db, B).getItem(itemOfB.id)).not.toBeNull();
  });

  it("cannot read another restaurant's item", async () => {
    expect(await tenantDb(db, A).getItem(itemOfB.id)).toBeNull();
  });

  it("cannot add an item to another restaurant's category", async () => {
    const created = await tenantDb(db, A).createItem({
      categoryId: categoryOfB.id,
      name: "Planted",
      prices: [{ label: "", amountMinor: 100 }],
    });
    expect(created).toBeNull();
    const row = await db.prepare("SELECT COUNT(*) AS n FROM items WHERE name = 'Planted'").first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it("cannot see another restaurant's category or its dishes", async () => {
    expect(await tenantDb(db, A).getCategory(categoryOfB.id)).toBeNull();
    expect(await tenantDb(db, A).listItems(categoryOfB.id)).toEqual([]);
  });

  it("does not count another restaurant's dishes", async () => {
    expect(await tenantDb(db, A).countItems()).toBe(0);
  });

  it("cannot change, hide, or delete another restaurant's dish", async () => {
    const helper = tenantDb(db, A);
    expect(await helper.setItemAvailable(itemOfB.id, false)).toBe(false);
    expect(await helper.updateItem(itemOfB.id, { categoryId: categoryOfB.id, name: "Hacked", prices: [] })).toBe(false);
    expect(await helper.deleteItem(itemOfB.id)).toBe(false);
    const item = await tenantDb(db, B).getItem(itemOfB.id);
    expect(item?.name).toBe("Chicken karahi");
    expect(item?.isAvailable).toBe(true);
  });

  it("cannot move another restaurant's category", async () => {
    expect(await tenantDb(db, A).moveCategory(categoryOfB.id, "up")).toBe(false);
  });

  it("refuses an empty restaurant id", () => {
    expect(() => tenantDb(db, "")).toThrow();
  });
});

describe("owner's own data", () => {
  it("can rename its own category", async () => {
    const category = await tenantDb(db, A).createCategory("Old name");
    expect(await tenantDb(db, A).renameCategory(category.id, "New name")).toBe(true);
    const names = (await tenantDb(db, A).listCategories()).map((c) => c.name);
    expect(names).toContain("New name");
  });

  it("returns an item with its prices in order", async () => {
    const item = await tenantDb(db, B).getItem(itemOfB.id);
    expect(item?.name).toBe("Chicken karahi");
    expect(item?.prices).toEqual([
      { label: "Half", amountMinor: 130000 },
      { label: "Full", amountMinor: 240000 },
    ]);
  });

  it("uses random ids", async () => {
    const { id } = await tenantDb(db, A).createCategory("Random id");
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("database rules", () => {
  it("rejects an item that points at another restaurant's category", async () => {
    await expect(
      db
        .prepare("INSERT INTO items (id, restaurant_id, category_id, name, sort_order, created_at, updated_at) VALUES ('x', ?, ?, 'x', 1, 1, 1)")
        .bind(A, categoryOfB.id)
        .run(),
    ).rejects.toThrow(/FOREIGN KEY/i);
  });

  it("rejects a price that points at another restaurant's item", async () => {
    await expect(
      db
        .prepare("INSERT INTO item_prices (id, restaurant_id, item_id, label, amount_minor, sort_order) VALUES ('x', ?, ?, '', 1, 1)")
        .bind(A, itemOfB.id)
        .run(),
    ).rejects.toThrow(/FOREIGN KEY/i);
  });

  it("treats emails as the same regardless of case", async () => {
    await expect(
      db
        .prepare("INSERT INTO users (id, email, password_hash, role, created_at) VALUES ('dup', 'USER-RESTAURANT-A@example.test', 'h', 'owner', 1)")
        .run()
        .then(() =>
          db
            .prepare("INSERT INTO users (id, email, password_hash, role, created_at) VALUES ('dup2', 'user-restaurant-a@EXAMPLE.test', 'h', 'owner', 1)")
            .run(),
        ),
    ).rejects.toThrow(/UNIQUE/i);
  });

  it("rejects a second restaurant with the same slug", async () => {
    await expect(
      db
        .prepare("INSERT INTO restaurants (id, owner_user_id, name, slug, created_at, updated_at) VALUES ('c', 'dup', 'C', ?, 1, 1)")
        .bind(A)
        .run(),
    ).rejects.toThrow(/UNIQUE/i);
  });

  it("rejects an unknown role", async () => {
    await expect(
      db
        .prepare("INSERT INTO users (id, email, password_hash, role, created_at) VALUES ('r', 'r@example.test', 'h', 'superuser', 1)")
        .run(),
    ).rejects.toThrow(/CHECK/i);
  });

  it("keeps the audit log append-only", async () => {
    await db
      .prepare("INSERT INTO audit_log (id, actor_user_id, action, created_at) VALUES ('a1', 'user-restaurant-a', 'test', 1)")
      .run();
    await expect(db.prepare("UPDATE audit_log SET action = 'changed' WHERE id = 'a1'").run()).rejects.toThrow(/append-only/);
    await expect(db.prepare("DELETE FROM audit_log WHERE id = 'a1'").run()).rejects.toThrow(/append-only/);
  });
});

describe("query plans on realistic data (Law 26)", () => {
  beforeAll(async () => {
    // Fill the table so a full scan would be a real cost.
    const inserts = [];
    for (let i = 0; i < 2000; i++) {
      inserts.push(
        db
          .prepare("INSERT INTO categories (id, restaurant_id, name, sort_order, created_at) VALUES (?, ?, 'Seed', ?, 1)")
          .bind(`seed-${i}`, i % 2 === 0 ? A : B, i),
      );
    }
    await db.batch(inserts);
  });

  const plan = async (sql: string, ...values: string[]) => {
    const { results } = await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...values).all<{ detail: string }>();
    return results.map((r) => r.detail).join(" | ");
  };

  it("lists categories with an index and no sort step", async () => {
    const detail = await plan(
      "SELECT id, name, sort_order FROM categories WHERE restaurant_id = ? ORDER BY sort_order, id",
      A,
    );
    expect(detail).toContain("USING INDEX");
    expect(detail).not.toMatch(/SCAN|TEMP B-TREE/);
  });

  it("finds an item's prices with an index and no sort step", async () => {
    const detail = await plan(
      "SELECT label, amount_minor FROM item_prices WHERE restaurant_id = ? AND item_id = ? ORDER BY sort_order",
      A,
      "x",
    );
    expect(detail).toContain("USING INDEX");
    expect(detail).not.toMatch(/SCAN|TEMP B-TREE/);
  });

  it("finds a restaurant by slug with an index", async () => {
    const detail = await plan("SELECT id FROM restaurants WHERE slug = ?", A);
    expect(detail).toMatch(/USING (COVERING )?INDEX/);
  });
});
