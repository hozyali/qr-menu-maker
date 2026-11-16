// Public menu queries for tomatofry.com/r/<code> (issues #24, #32, and #39).
// Anyone can open this page, so these are separate, reviewed queries (Laws 17 and 18).
// They return only the fixed list of public fields: never the owner, email, account, or ids
// beyond what the page needs to link categories.
import { planAllows, planLimit } from "./plans";
import { currentPlan, sqlLimit } from "./subscriptions-db";
import type { Price } from "./tenant-db";
import { DEFAULT_THEME, type Theme, toTheme } from "./theme";

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
  logoKey: string | null;
  city: string | null;
  address: string | null;
  phone: string | null;
  whatsapp: string | null;
  mapsUrl: string | null;
  hours: string | null;
  note: string | null;
  country: string;
  currency: string;
  /** False when the plan has the "Remove Powered by TomatoFry" feature (issue #38). */
  showPoweredBy: boolean;
  theme: Theme;
}

export type PublicMenu =
  | { status: "active"; restaurant: PublicRestaurant; categories: PublicCategory[] }
  | { status: "suspended"; restaurant: PublicRestaurant };

// The SQL is listed here so a test can prove each query uses an index (Law 26).
export const PUBLIC_MENU_SQL = {
  restaurant: `SELECT id, name, logo_key, city, address, phone, whatsapp, maps_url, hours, note, country, currency,
                      status, theme_color, theme_mode, photo_size
               FROM restaurants WHERE menu_code = ?`,
  theme: "SELECT id, theme_color, theme_mode, photo_size FROM restaurants WHERE menu_code = ?",
  categories: "SELECT id, name FROM categories WHERE restaurant_id = ? ORDER BY sort_order, id",
  // Only the restaurant's oldest dishes up to the plan's limit are public. The rest are archived (issue #39).
  items: `SELECT id, category_id, name, description, is_available, photo_key FROM items
          WHERE restaurant_id = ?1
            AND id IN (SELECT id FROM items WHERE restaurant_id = ?1 ORDER BY created_at, id LIMIT ?2)
          ORDER BY category_id, sort_order, id`,
  prices: "SELECT item_id, label, amount_minor FROM item_prices WHERE restaurant_id = ? ORDER BY item_id, sort_order",
};

const text = (value: unknown) => (value === null || value === undefined ? null : String(value));

/** Finds a restaurant by its permanent link. Returns null if there is no such restaurant. */
async function findRestaurant(db: D1Database, code: string) {
  return db
    .prepare(PUBLIC_MENU_SQL.restaurant)
    .bind(code)
    .first<Record<string, unknown>>();
}

/** The plan's features decide which stored settings the public sees (issues #38 and #39). */
async function planFeatures(db: D1Database, row: Record<string, unknown>, now: number) {
  return (await currentPlan(db, String(row.id), now)).entitlements;
}

/** A saved theme is kept, but only shown while the plan has the theme editor. */
function shownTheme(row: Record<string, unknown>, themeAllowed: boolean): Theme {
  return themeAllowed ? toTheme(row.theme_color, row.theme_mode, row.photo_size) : DEFAULT_THEME;
}

export async function findPublicTheme(db: D1Database, code: string, now: number): Promise<Theme | null> {
  const row = await db
    .prepare(PUBLIC_MENU_SQL.theme)
    .bind(code)
    .first<Record<string, unknown>>();
  if (!row) return null;
  return shownTheme(row, planAllows(await planFeatures(db, row, now), "custom_theme"));
}

export async function findPublicMenu(db: D1Database, code: string, now: number): Promise<PublicMenu | null> {
  const row = await findRestaurant(db, code);
  if (!row) return null;
  const features = await planFeatures(db, row, now);
  // Switched-off features are hidden here, in the data, so no page can show them by mistake.
  // The stored files and settings are kept and come back when the plan allows them again.
  const photosAllowed = planAllows(features, "dish_photos");

  const restaurant: PublicRestaurant = {
    name: String(row.name),
    logoKey: planAllows(features, "logo") ? text(row.logo_key) : null,
    city: text(row.city),
    address: text(row.address),
    phone: text(row.phone),
    whatsapp: text(row.whatsapp),
    mapsUrl: text(row.maps_url),
    hours: text(row.hours),
    note: text(row.note),
    country: String(row.country),
    currency: String(row.currency),
    showPoweredBy: !planAllows(features, "hide_powered_by"),
    theme: shownTheme(row, planAllows(features, "custom_theme")),
  };
  if (row.status !== "active") {
    // A suspended menu shows nothing from the menu itself.
    return { status: "suspended", restaurant };
  }

  // Three indexed reads, all limited to this one restaurant. Each ORDER BY matches its index.
  const restaurantId = String(row.id);
  const [categoryResult, itemResult, priceResult] = await db.batch<Record<string, unknown>>([
    db.prepare(PUBLIC_MENU_SQL.categories).bind(restaurantId),
    db.prepare(PUBLIC_MENU_SQL.items).bind(restaurantId, sqlLimit(planLimit(features, "max_items"))),
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
      photoKey: photosAllowed ? text(item.photo_key) : null,
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
