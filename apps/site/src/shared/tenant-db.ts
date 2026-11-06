// All restaurant data goes through this helper, so every query is limited to one restaurant (Law 18).
// The restaurant id must come from the login session, never from anything the browser sends.

export interface Category {
  id: string;
  name: string;
  sort_order: number;
}

export interface Price {
  label: string;
  amountMinor: number;
}

export interface NewItem {
  categoryId: string;
  name: string;
  description?: string;
  prices: Price[];
}

export interface Item {
  id: string;
  categoryId: string;
  name: string;
  description: string | null;
  isAvailable: boolean;
  prices: Price[];
}

export function tenantDb(db: D1Database, restaurantId: string) {
  if (!restaurantId) {
    throw new Error("tenantDb needs a restaurant id");
  }

  return {
    async listCategories(): Promise<Category[]> {
      const { results } = await db
        .prepare("SELECT id, name, sort_order FROM categories WHERE restaurant_id = ? ORDER BY sort_order, id")
        .bind(restaurantId)
        .all<Category>();
      return results;
    },

    async createCategory(name: string): Promise<{ id: string }> {
      const id = crypto.randomUUID();
      await db
        .prepare(
          `INSERT INTO categories (id, restaurant_id, name, sort_order, created_at)
           VALUES (?1, ?2, ?3, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM categories WHERE restaurant_id = ?2), ?4)`,
        )
        .bind(id, restaurantId, name, Date.now())
        .run();
      return { id };
    },

    /** Returns false if this restaurant has no such category. */
    async renameCategory(id: string, name: string): Promise<boolean> {
      const { meta } = await db
        .prepare("UPDATE categories SET name = ? WHERE restaurant_id = ? AND id = ?")
        .bind(name, restaurantId, id)
        .run();
      return meta.changes > 0;
    },

    /** Returns false if this restaurant has no such category. Its items are removed with it. */
    async deleteCategory(id: string): Promise<boolean> {
      const { meta } = await db
        .prepare("DELETE FROM categories WHERE restaurant_id = ? AND id = ?")
        .bind(restaurantId, id)
        .run();
      return meta.changes > 0;
    },

    /** Returns null if the category does not belong to this restaurant. */
    async createItem(item: NewItem): Promise<{ id: string } | null> {
      const category = await db
        .prepare("SELECT id FROM categories WHERE restaurant_id = ? AND id = ?")
        .bind(restaurantId, item.categoryId)
        .first();
      if (!category) {
        return null;
      }

      const id = crypto.randomUUID();
      const now = Date.now();
      // A batch runs as one transaction, so an item never exists without its prices.
      await db.batch([
        db
          .prepare(
            `INSERT INTO items (id, restaurant_id, category_id, name, description, sort_order, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5,
               (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM items WHERE restaurant_id = ?2 AND category_id = ?3),
               ?6, ?6)`,
          )
          .bind(id, restaurantId, item.categoryId, item.name, item.description ?? null, now),
        ...item.prices.map((price, index) =>
          db
            .prepare(
              "INSERT INTO item_prices (id, restaurant_id, item_id, label, amount_minor, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
            )
            .bind(crypto.randomUUID(), restaurantId, id, price.label, price.amountMinor, index),
        ),
      ]);
      return { id };
    },

    /** Returns null if this restaurant has no such item. */
    async getItem(id: string): Promise<Item | null> {
      const [itemResult, priceResult] = await db.batch<Record<string, unknown>>([
        db
          .prepare(
            "SELECT id, category_id, name, description, is_available FROM items WHERE restaurant_id = ? AND id = ?",
          )
          .bind(restaurantId, id),
        db
          .prepare(
            "SELECT label, amount_minor FROM item_prices WHERE restaurant_id = ? AND item_id = ? ORDER BY sort_order",
          )
          .bind(restaurantId, id),
      ]);
      const row = itemResult?.results[0];
      if (!row) {
        return null;
      }
      return {
        id: String(row.id),
        categoryId: String(row.category_id),
        name: String(row.name),
        description: row.description === null ? null : String(row.description),
        isAvailable: row.is_available === 1,
        prices: (priceResult?.results ?? []).map((price) => ({
          label: String(price.label),
          amountMinor: Number(price.amount_minor),
        })),
      };
    },
  };
}
