// Public menu queries for tomatofry.com/r/<slug> (issue #24).
// Anyone can open this page, so these are separate, reviewed queries (Laws 17 and 18).
// They return only the fixed list of public fields: never the owner, email, account, or ids
// beyond what the page needs to link categories.
import { effectivePlan, type Plan } from "./plans";
import type { Price } from "./tenant-db";
import { type Theme, toTheme } from "./theme";

export interface PublicDish {
  name: string;
  description: string | null;
  isAvailable: boolean;
  photoKey: string | null;
  prices: Price[];
}

export interface PublicCategory {
  id: string;
  name: string;
  dishes: PublicDish[];
}

export interface PublicRestaurant {
  name: string;
  city: string | null;
  address: string | null;
  phone: string | null;
  whatsapp: string | null;
  mapsUrl: string | null;
  hours: string | null;
  note: string | null;
  country: string;
  currency: string;
  plan: Plan;
  theme: Theme;
}

export type PublicMenu =
  | { status: "active"; restaurant: PublicRestaurant; categories: PublicCategory[] }
  | { status: "suspended"; restaurant: PublicRestaurant };

// The SQL is listed here so a test can prove each query uses an index (Law 26).
export const PUBLIC_MENU_SQL = {
  restaurant: `SELECT id, name, city, address, phone, whatsapp, maps_url, hours, note, country, currency,
                      plan, plan_expires_at, status, theme_color, theme_mode, photo_size
               FROM restaurants WHERE slug = ?`,
  theme: "SELECT theme_color, theme_mode, photo_size FROM restaurants WHERE slug = ?",
  categories: "SELECT id, name FROM categories WHERE restaurant_id = ? ORDER BY sort_order, id",
  items: `SELECT id, category_id, name, description, is_available, photo_key FROM items
          WHERE restaurant_id = ? ORDER BY category_id, sort_order, id`,
  prices: "SELECT item_id, label, amount_minor FROM item_prices WHERE restaurant_id = ? ORDER BY item_id, sort_order",
};

const text = (value: unknown) => (value === null || value === undefined ? null : String(value));

/** Finds a restaurant by its permanent link. Returns null if there is no such restaurant. */
async function findRestaurant(db: D1Database, slug: string) {
  return db
    .prepare(PUBLIC_MENU_SQL.restaurant)
    .bind(slug)
    .first<Record<string, unknown>>();
}

export async function findPublicTheme(db: D1Database, slug: string): Promise<Theme | null> {
  const row = await db
    .prepare(PUBLIC_MENU_SQL.theme)
    .bind(slug)
    .first<Record<string, unknown>>();
  return row ? toTheme(row.theme_color, row.theme_mode, row.photo_size) : null;
}

export async function findPublicMenu(db: D1Database, slug: string, now: number): Promise<PublicMenu | null> {
  const row = await findRestaurant(db, slug);
  if (!row) return null;

  const restaurant: PublicRestaurant = {
    name: String(row.name),
    city: text(row.city),
    address: text(row.address),
    phone: text(row.phone),
    whatsapp: text(row.whatsapp),
    mapsUrl: text(row.maps_url),
    hours: text(row.hours),
    note: text(row.note),
    country: String(row.country),
    currency: String(row.currency),
    plan: effectivePlan(String(row.plan), row.plan_expires_at === null ? null : Number(row.plan_expires_at), now),
    theme: toTheme(row.theme_color, row.theme_mode, row.photo_size),
  };
  if (row.status !== "active") {
    // A suspended menu shows nothing from the menu itself.
    return { status: "suspended", restaurant };
  }

  // Three indexed reads, all limited to this one restaurant. Each ORDER BY matches its index.
  const restaurantId = String(row.id);
  const [categoryResult, itemResult, priceResult] = await db.batch<Record<string, unknown>>([
    db.prepare(PUBLIC_MENU_SQL.categories).bind(restaurantId),
    db.prepare(PUBLIC_MENU_SQL.items).bind(restaurantId),
    db.prepare(PUBLIC_MENU_SQL.prices).bind(restaurantId),
  ]);

  const pricesByItem = new Map<string, Price[]>();
  for (const price of priceResult?.results ?? []) {
    const list = pricesByItem.get(String(price.item_id)) ?? [];
    list.push({ label: String(price.label), amountMinor: Number(price.amount_minor) });
    pricesByItem.set(String(price.item_id), list);
  }
  const dishesByCategory = new Map<string, PublicDish[]>();
  for (const item of itemResult?.results ?? []) {
    const list = dishesByCategory.get(String(item.category_id)) ?? [];
    list.push({
      name: String(item.name),
      description: text(item.description),
      isAvailable: item.is_available === 1,
      photoKey: text(item.photo_key),
      prices: pricesByItem.get(String(item.id)) ?? [],
    });
    dishesByCategory.set(String(item.category_id), list);
  }

  // Empty categories are hidden, so customers never see a heading with nothing under it.
  const categories = (categoryResult?.results ?? [])
    .map((cat) => ({ id: String(cat.id), name: String(cat.name), dishes: dishesByCategory.get(String(cat.id)) ?? [] }))
    .filter((cat) => cat.dishes.length > 0);

  return { status: "active", restaurant, categories };
}
