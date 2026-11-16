// Restaurant subscriptions (issue #39). These queries read one restaurant's subscription and plan.
// The restaurant id always comes from the login session, the public menu code lookup, or an admin
// route that has checked the admin role (Law 18). Every value is bound (Law 17).
import type { Entitlements } from "./plans";
import { toEntitlements } from "./plans-db";

// The SQL is listed here so a test can prove each query uses an index (Law 26).
export const SUBSCRIPTION_SQL = {
  current: `SELECT plan_id, billing_period, status, started_at, ends_at, price_minor, coupon_percent_off, coupon_duration
            FROM subscriptions WHERE restaurant_id = ?1`,
  // The plan in use: the subscription's plan while it has not ended, otherwise the signup plan.
  // Worked out on every read, so an ended plan needs no scheduled job.
  planFeatures: `SELECT p.id, p.name, p.is_free, e.feature_key, e.enabled, e.limit_value
                 FROM plans p LEFT JOIN plan_entitlements e ON e.plan_id = p.id
                 WHERE p.id = COALESCE(
                   (SELECT s.plan_id FROM subscriptions s WHERE s.restaurant_id = ?1 AND (s.ends_at IS NULL OR s.ends_at > ?2)),
                   (SELECT d.id FROM plans d WHERE d.is_signup_default = 1))`,
  // The ids of the restaurant's oldest dishes, up to the plan's limit (LIMIT -1 means no limit).
  // Dishes after these are archived: hidden from the public and locked for the owner.
  activeItems: "SELECT id FROM items WHERE restaurant_id = ?1 ORDER BY created_at, id LIMIT ?2",
  // How many of the restaurant's dishes are older than this one. At or past the limit means archived.
  itemRank: `SELECT COUNT(*) AS n FROM items
             WHERE restaurant_id = ?1 AND (created_at, id) < (SELECT created_at, id FROM items WHERE restaurant_id = ?1 AND id = ?2)`,
};

export interface CurrentPlan {
  entitlements: Entitlements;
  /** The end of the plan in use, or null when it has no end. */
  endsAt: number | null;
  billingPeriod: "monthly" | "yearly" | "none";
  status: "active" | "trial";
  /** True when the subscription's plan has ended and the signup plan is used instead. */
  ended: boolean;
  /** The coupon terms copied onto the subscription (issue #40), while the plan has not ended. */
  coupon: { percentOff: number; duration: "once" | "recurring" } | null;
}

type Row = Record<string, unknown>;

/** The plan a restaurant uses right now, with its features, in two indexed reads. */
export async function currentPlan(db: D1Database, restaurantId: string, now: number): Promise<CurrentPlan> {
  const [subscriptionResult, planResult] = await db.batch<Row>([
    db.prepare(SUBSCRIPTION_SQL.current).bind(restaurantId),
    db.prepare(SUBSCRIPTION_SQL.planFeatures).bind(restaurantId, now),
  ]);
  const entitlements = toEntitlements(planResult?.results ?? []);
  // The signup plan comes from migration 0005. Without it nothing can be decided safely.
  if (!entitlements) throw new Error("No plan found. Run migrations 0005 and 0006.");
  const row = subscriptionResult?.results[0];
  const endsAt = row?.ends_at === null || row?.ends_at === undefined ? null : Number(row.ends_at);
  const ended = !row || (endsAt !== null && endsAt <= now);
  return {
    entitlements,
    endsAt: ended ? null : endsAt,
    billingPeriod: ended ? "none" : row?.billing_period === "monthly" || row?.billing_period === "yearly" ? row.billing_period : "none",
    status: !ended && row?.status === "trial" ? "trial" : "active",
    ended,
    coupon:
      !ended && row?.coupon_percent_off !== null && row?.coupon_percent_off !== undefined
        ? { percentOff: Number(row.coupon_percent_off), duration: row.coupon_duration === "recurring" ? "recurring" : "once" }
        : null,
  };
}

export interface NewSubscription {
  planId: string;
  period: "monthly" | "yearly" | "none";
  status: "active" | "trial";
  startedAt: number;
  endsAt: number | null;
  priceMinor: number;
  coupon: { id: string | null; percentOff: number; duration: "once" | "recurring" } | null;
}

/**
 * Writes a restaurant's subscription in place (Law 26). Used by the admin plan form (issue #39) and
 * payment approval (issue #41), always inside a batch with its audit row.
 */
export function subscriptionUpsert(db: D1Database, restaurantId: string, sub: NewSubscription): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO subscriptions (restaurant_id, plan_id, billing_period, status, started_at, ends_at, price_minor, updated_at,
                                  coupon_id, coupon_percent_off, coupon_duration)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?5, ?8, ?9, ?10)
       ON CONFLICT (restaurant_id) DO UPDATE SET plan_id = excluded.plan_id, billing_period = excluded.billing_period,
         status = excluded.status, started_at = excluded.started_at, ends_at = excluded.ends_at,
         price_minor = excluded.price_minor, updated_at = excluded.updated_at,
         coupon_id = excluded.coupon_id, coupon_percent_off = excluded.coupon_percent_off,
         coupon_duration = excluded.coupon_duration`,
    )
    .bind(restaurantId, sub.planId, sub.period, sub.status, sub.startedAt, sub.endsAt, sub.priceMinor,
      sub.coupon?.id ?? null, sub.coupon?.percentOff ?? null, sub.coupon?.duration ?? null);
}

/** SQLite treats a negative LIMIT as no limit. */
export const sqlLimit = (limit: number | null) => (limit === null ? -1 : limit);
