// All restaurant data goes through this helper, so every query is limited to one restaurant (Law 18).
// The restaurant id must come from the login session, never from anything the browser sends.
import { type Theme, toTheme } from "./theme";
import type { ProfileInput } from "./validation";

export interface Profile extends ProfileInput {
  menuCode: string;
  logoKey: string | null;
}

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
  /** R2 key of the dish photo, or null. */
  photoKey: string | null;
  prices: Price[];
}

export function tenantDb(db: D1Database, restaurantId: string) {
  if (!restaurantId) {
    throw new Error("tenantDb needs a restaurant id");
  }

  const categoryBelongs = async (categoryId: string) =>
    (await db
      .prepare("SELECT id FROM categories WHERE restaurant_id = ? AND id = ?")
      .bind(restaurantId, categoryId)
      .first()) !== null;

  // Prices are saved as a fixed list, so editing a dish replaces them all at once.
  const priceInserts = (itemId: string, prices: Price[]) =>
    prices.map((price, index) =>
      db
        .prepare(
          "INSERT INTO item_prices (id, restaurant_id, item_id, label, amount_minor, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(crypto.randomUUID(), restaurantId, itemId, price.label, price.amountMinor, index),
    );

  return {
    /** The restaurant's own details (issue #28). The menu code is read only: it never changes (Law 28). */
    async getProfile(): Promise<Profile | null> {
      const row = await db
        .prepare("SELECT name, menu_code, city, address, phone, whatsapp, maps_url, hours, note, logo_key FROM restaurants WHERE id = ?")
        .bind(restaurantId)
        .first<Record<string, string | null>>();
      if (!row) return null;
      return {
        name: row.name ?? "",
        menuCode: row.menu_code ?? "",
        city: row.city ?? "",
        address: row.address ?? "",
        phone: row.phone ?? "",
        whatsapp: row.whatsapp ?? "",
        mapsUrl: row.maps_url ?? "",
        hours: row.hours ?? "",
        note: row.note ?? "",
        logoKey: row.logo_key ?? null,
      };
    },

    /** Saves the checked details. Empty optional fields are stored as NULL. The menu code is never written. */
    async updateProfile(p: ProfileInput): Promise<void> {
      const orNull = (value: string) => (value ? value : null);
      await db
        .prepare(
          `UPDATE restaurants SET name = ?, city = ?, address = ?, phone = ?, whatsapp = ?, maps_url = ?, hours = ?, note = ?, updated_at = ?
           WHERE id = ?`,
        )
        .bind(p.name, p.city, orNull(p.address), p.phone, orNull(p.whatsapp), orNull(p.mapsUrl), orNull(p.hours), orNull(p.note), Date.now(), restaurantId)
        .run();
    },

    /** Sets or clears the logo. Returns the previous key, so its file can be deleted. */
    async setLogo(logoKey: string | null): Promise<string | null> {
      const [before] = await db.batch<{ logo_key: string | null }>([
        db.prepare("SELECT logo_key FROM restaurants WHERE id = ?").bind(restaurantId),
        db.prepare("UPDATE restaurants SET logo_key = ?, updated_at = ? WHERE id = ?").bind(logoKey, Date.now(), restaurantId),
      ]);
      return before?.results[0]?.logo_key ?? null;
    },

    /** The menu theme of this restaurant (issue #24). */
    async getTheme(): Promise<Theme> {
      const row = await db
        .prepare("SELECT theme_color, theme_mode, photo_size FROM restaurants WHERE id = ?")
        .bind(restaurantId)
        .first<Record<string, unknown>>();
      return toTheme(row?.theme_color, row?.theme_mode, row?.photo_size);
    },

    /** The caller checks the values first. The database also refuses anything outside the allowed set. */
    async setTheme(theme: Theme): Promise<void> {
      await db
        .prepare("UPDATE restaurants SET theme_color = ?, theme_mode = ?, photo_size = ?, updated_at = ? WHERE id = ?")
        .bind(theme.color, theme.mode, theme.photoSize, Date.now(), restaurantId)
        .run();
    },

    async listCategories(): Promise<Category[]> {
      const { results } = await db
        .prepare("SELECT id, name, sort_order FROM categories WHERE restaurant_id = ? ORDER BY sort_order, id")
        .bind(restaurantId)
        .all<Category>();
      return results;
    },

    async getCategory(id: string): Promise<{ id: string; name: string; itemCount: number } | null> {
      const row = await db
        .prepare(
          `SELECT c.id, c.name, (SELECT COUNT(*) FROM items i WHERE i.restaurant_id = c.restaurant_id AND i.category_id = c.id) AS item_count
           FROM categories c WHERE c.restaurant_id = ? AND c.id = ?`,
        )
        .bind(restaurantId, id)
        .first<{ id: string; name: string; item_count: number }>();
      return row ? { id: row.id, name: row.name, itemCount: row.item_count } : null;
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

    /** Swaps the category with its neighbour. Returns false if this restaurant has no such category. */
    async moveCategory(id: string, direction: "up" | "down"): Promise<boolean> {
      const categories = await this.listCategories();
      const index = categories.findIndex((category) => category.id === id);
      if (index < 0) return false;
      const other = categories[direction === "up" ? index - 1 : index + 1];
      const current = categories[index];
      if (!other || !current) return true;
      await db.batch([
        db
          .prepare("UPDATE categories SET sort_order = ? WHERE restaurant_id = ? AND id = ?")
          .bind(other.sort_order, restaurantId, current.id),
        db
          .prepare("UPDATE categories SET sort_order = ? WHERE restaurant_id = ? AND id = ?")
          .bind(current.sort_order, restaurantId, other.id),
      ]);
      return true;
    },

    /** Returns false if this restaurant has no such category. Its items are removed with it. */
    async deleteCategory(id: string): Promise<boolean> {
      const { meta } = await db
        .prepare("DELETE FROM categories WHERE restaurant_id = ? AND id = ?")
        .bind(restaurantId, id)
        .run();
      return meta.changes > 0;
    },

    async countItems(): Promise<number> {
      const row = await db
        .prepare("SELECT COUNT(*) AS n FROM items WHERE restaurant_id = ?")
        .bind(restaurantId)
        .first<{ n: number }>();
      return row?.n ?? 0;
    },

    /** All dishes in one category, with their prices, in menu order. */
    async listItems(categoryId: string): Promise<Item[]> {
      const [itemResult, priceResult] = await db.batch<Record<string, unknown>>([
        db
          .prepare(
            "SELECT id, category_id, name, description, is_available, photo_key FROM items WHERE restaurant_id = ? AND category_id = ? ORDER BY sort_order, id",
          )
          .bind(restaurantId, categoryId),
        db
          .prepare(
            `SELECT p.item_id, p.label, p.amount_minor FROM item_prices p
             JOIN items i ON i.restaurant_id = p.restaurant_id AND i.id = p.item_id
             WHERE p.restaurant_id = ? AND i.category_id = ? ORDER BY p.item_id, p.sort_order`,
          )
          .bind(restaurantId, categoryId),
      ]);
      const pricesByItem = new Map<string, Price[]>();
      for (const row of priceResult?.results ?? []) {
        const list = pricesByItem.get(String(row.item_id)) ?? [];
        list.push({ label: String(row.label), amountMinor: Number(row.amount_minor) });
        pricesByItem.set(String(row.item_id), list);
      }
      return (itemResult?.results ?? []).map((row) => ({
        id: String(row.id),
        categoryId: String(row.category_id),
        name: String(row.name),
        description: row.description === null ? null : String(row.description),
        isAvailable: row.is_available === 1,
        photoKey: row.photo_key === null ? null : String(row.photo_key),
        prices: pricesByItem.get(String(row.id)) ?? [],
      }));
    },

    /** Returns null if the category does not belong to this restaurant. */
    async createItem(item: NewItem): Promise<{ id: string } | null> {
      if (!(await categoryBelongs(item.categoryId))) {
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
        ...priceInserts(id, item.prices),
      ]);
      return { id };
    },

    /** Returns false if the dish or the new category does not belong to this restaurant. */
    async updateItem(id: string, item: NewItem): Promise<boolean> {
      if (!(await this.getItem(id)) || !(await categoryBelongs(item.categoryId))) {
        return false;
      }
      await db.batch([
        db
          .prepare(
            "UPDATE items SET category_id = ?, name = ?, description = ?, updated_at = ? WHERE restaurant_id = ? AND id = ?",
          )
          .bind(item.categoryId, item.name, item.description ?? null, Date.now(), restaurantId, id),
        db.prepare("DELETE FROM item_prices WHERE restaurant_id = ? AND item_id = ?").bind(restaurantId, id),
        ...priceInserts(id, item.prices),
      ]);
      return true;
    },

    /** Returns false if this restaurant has no such dish. */
    async setItemAvailable(id: string, available: boolean): Promise<boolean> {
      const { meta } = await db
        .prepare("UPDATE items SET is_available = ?, updated_at = ? WHERE restaurant_id = ? AND id = ?")
        .bind(available ? 1 : 0, Date.now(), restaurantId, id)
        .run();
      return meta.changes > 0;
    },

    /** Sets or clears the dish photo. Returns false if this restaurant has no such dish. */
    async setItemPhoto(id: string, photoKey: string | null): Promise<boolean> {
      const { meta } = await db
        .prepare("UPDATE items SET photo_key = ?, updated_at = ? WHERE restaurant_id = ? AND id = ?")
        .bind(photoKey, Date.now(), restaurantId, id)
        .run();
      return meta.changes > 0;
    },

    /** Photo keys of every dish in a category, so the files can be removed with it. */
    async photoKeysInCategory(categoryId: string): Promise<string[]> {
      const { results } = await db
        .prepare("SELECT photo_key FROM items WHERE restaurant_id = ? AND category_id = ? AND photo_key IS NOT NULL")
        .bind(restaurantId, categoryId)
        .all<{ photo_key: string }>();
      return results.map((row) => row.photo_key);
    },

    /** Returns false if this restaurant has no such dish. Its prices are removed with it. */
    async deleteItem(id: string): Promise<boolean> {
      const { meta } = await db
        .prepare("DELETE FROM items WHERE restaurant_id = ? AND id = ?")
        .bind(restaurantId, id)
        .run();
      return meta.changes > 0;
    },

    /** Returns null if this restaurant has no such item. */
    async getItem(id: string): Promise<Item | null> {
      const [itemResult, priceResult] = await db.batch<Record<string, unknown>>([
        db
          .prepare(
            "SELECT id, category_id, name, description, is_available, photo_key FROM items WHERE restaurant_id = ? AND id = ?",
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
        photoKey: row.photo_key === null ? null : String(row.photo_key),
        prices: (priceResult?.results ?? []).map((price) => ({
          label: String(price.label),
          amountMinor: Number(price.amount_minor),
        })),
      };
    },
  };
}
