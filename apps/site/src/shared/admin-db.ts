// Master admin queries (issue #36). The admin works across all restaurants, so these are separate,
// explicit, reviewed queries outside the tenant helper (Law 18). The caller must have checked the
// admin session and role first. Every value is bound (Law 17).
import { effectivePlan, type LegacyPlan } from "./plans";

export const PAGE_SIZE = 25;

// The SQL is listed here so a test can prove each query uses an index (Law 26).
export const ADMIN_SQL = {
  // Newest first. Keyset paging on (created_at, id) matches the restaurants_created index, so a later
  // page costs the same as the first. One extra row tells us whether there is a next page.
  listFirst: `SELECT r.id, r.name, r.city, r.plan, r.plan_expires_at, r.status, r.created_at, u.email
              FROM restaurants r JOIN users u ON u.id = r.owner_user_id
              ORDER BY r.created_at DESC, r.id DESC LIMIT ?`,
  listAfter: `SELECT r.id, r.name, r.city, r.plan, r.plan_expires_at, r.status, r.created_at, u.email
              FROM restaurants r JOIN users u ON u.id = r.owner_user_id
              WHERE (r.created_at, r.id) < (?, ?)
              ORDER BY r.created_at DESC, r.id DESC LIMIT ?`,
  detail: `SELECT r.id, r.name, r.city, r.address, r.phone, r.whatsapp, r.menu_code, r.plan, r.plan_expires_at,
                  r.status, r.created_at, u.email,
                  (SELECT COUNT(*) FROM items i WHERE i.restaurant_id = r.id) AS dish_count
           FROM restaurants r JOIN users u ON u.id = r.owner_user_id WHERE r.id = ?`,
  history: `SELECT a.action, a.details, a.created_at, u.email
            FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
            WHERE a.restaurant_id = ? ORDER BY a.created_at DESC, a.id DESC LIMIT 20`,
};

export interface RestaurantRow {
  id: string;
  name: string;
  city: string | null;
  plan: LegacyPlan;
  /** The stored plan, before an expired Pro turns into Free. */
  storedPlan: string;
  planExpiresAt: number | null;
  status: string;
  createdAt: number;
  email: string;
}

const toRow = (row: Record<string, unknown>, now: number): RestaurantRow => ({
  id: String(row.id),
  name: String(row.name),
  city: row.city === null ? null : String(row.city),
  storedPlan: String(row.plan),
  planExpiresAt: row.plan_expires_at === null ? null : Number(row.plan_expires_at),
  plan: effectivePlan(String(row.plan), row.plan_expires_at === null ? null : Number(row.plan_expires_at), now),
  status: String(row.status),
  createdAt: Number(row.created_at),
  email: String(row.email),
});

export interface Cursor {
  createdAt: number;
  id: string;
}

export async function listRestaurants(db: D1Database, before: Cursor | null, now: number) {
  const statement = before
    ? db.prepare(ADMIN_SQL.listAfter).bind(before.createdAt, before.id, PAGE_SIZE + 1)
    : db.prepare(ADMIN_SQL.listFirst).bind(PAGE_SIZE + 1);
  const { results } = await statement.all<Record<string, unknown>>();
  const rows = results.slice(0, PAGE_SIZE).map((row) => toRow(row, now));
  const last = rows[rows.length - 1];
  const next: Cursor | null = results.length > PAGE_SIZE && last ? { createdAt: last.createdAt, id: last.id } : null;
  return { rows, next };
}

export interface RestaurantDetail extends RestaurantRow {
  address: string | null;
  phone: string | null;
  whatsapp: string | null;
  menuCode: string;
  dishCount: number;
}

export async function getRestaurant(db: D1Database, id: string, now: number): Promise<RestaurantDetail | null> {
  const row = await db.prepare(ADMIN_SQL.detail).bind(id).first<Record<string, unknown>>();
  if (!row) return null;
  const text = (value: unknown) => (value === null || value === undefined ? null : String(value));
  return {
    ...toRow(row, now),
    address: text(row.address),
    phone: text(row.phone),
    whatsapp: text(row.whatsapp),
    menuCode: String(row.menu_code),
    dishCount: Number(row.dish_count),
  };
}

export interface HistoryEntry {
  action: string;
  details: string | null;
  createdAt: number;
  actorEmail: string | null;
}

export async function restaurantHistory(db: D1Database, id: string): Promise<HistoryEntry[]> {
  const { results } = await db.prepare(ADMIN_SQL.history).bind(id).all<Record<string, unknown>>();
  return results.map((row) => ({
    action: String(row.action),
    details: row.details === null ? null : String(row.details),
    createdAt: Number(row.created_at),
    actorEmail: row.email === null ? null : String(row.email),
  }));
}

/** An admin change and its audit row, saved together in one transaction, so a change is never unlogged. */
async function changeWithAudit(
  db: D1Database,
  update: D1PreparedStatement,
  audit: { actorUserId: string; action: string; restaurantId: string; details: unknown },
): Promise<void> {
  await db.batch([
    update,
    db
      .prepare("INSERT INTO audit_log (id, actor_user_id, action, restaurant_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(crypto.randomUUID(), audit.actorUserId, audit.action, audit.restaurantId, JSON.stringify(audit.details), Date.now()),
  ]);
}

export async function setPlan(
  db: D1Database,
  actorUserId: string,
  restaurant: RestaurantDetail,
  change: { plan: LegacyPlan; expiresAt: number | null; expiresLabel: string | null; fromLabel: string | null },
): Promise<void> {
  await changeWithAudit(
    db,
    db
      .prepare("UPDATE restaurants SET plan = ?, plan_expires_at = ?, updated_at = ? WHERE id = ?")
      .bind(change.plan, change.expiresAt, Date.now(), restaurant.id),
    {
      actorUserId,
      action: "plan_changed",
      restaurantId: restaurant.id,
      details: {
        from: { plan: restaurant.storedPlan, expires: change.fromLabel },
        to: { plan: change.plan, expires: change.expiresLabel },
      },
    },
  );
}

export async function setStatus(db: D1Database, actorUserId: string, restaurantId: string, status: "active" | "suspended") {
  await changeWithAudit(
    db,
    db.prepare("UPDATE restaurants SET status = ?, updated_at = ? WHERE id = ?").bind(status, Date.now(), restaurantId),
    { actorUserId, action: status === "suspended" ? "restaurant_suspended" : "restaurant_reactivated", restaurantId, details: null },
  );
}
