// Free trial offers (issue #42). Offers are made by the admin for all restaurants or one restaurant.
// These are reviewed queries outside the tenant helper (Laws 17 and 18). The owner-side lookups
// always take the restaurant id from the login session. Admin changes must only run after the admin
// session and role check. Every value is bound.
import { subscriptionUpsert } from "./subscriptions-db";

export const TRIAL_PAGE_SIZE = 50;

// The SQL is listed here so a test can prove each query uses an index (Law 26).
export const TRIAL_SQL = {
  // The newest active offer made for this one restaurant, for a plan it has not tried, still open now.
  forRestaurant: `SELECT o.id, o.plan_id, o.days, p.name AS plan_name FROM trial_offers o JOIN plans p ON p.id = o.plan_id
                  WHERE o.restaurant_id = ?1 AND o.status = 'active' AND o.starts_at <= ?2 AND (o.ends_at IS NULL OR o.ends_at > ?2)
                    AND p.status = 'active' AND p.is_free = 0
                    AND NOT EXISTS (SELECT 1 FROM trial_uses u WHERE u.restaurant_id = ?1 AND u.plan_id = o.plan_id)
                  ORDER BY o.created_at DESC, o.id DESC LIMIT 1`,
  // The same for offers made for all restaurants.
  forAll: `SELECT o.id, o.plan_id, o.days, p.name AS plan_name FROM trial_offers o JOIN plans p ON p.id = o.plan_id
           WHERE o.target_type = 'all' AND o.status = 'active' AND o.starts_at <= ?2 AND (o.ends_at IS NULL OR o.ends_at > ?2)
             AND p.status = 'active' AND p.is_free = 0
             AND NOT EXISTS (SELECT 1 FROM trial_uses u WHERE u.restaurant_id = ?1 AND u.plan_id = o.plan_id)
           ORDER BY o.created_at DESC, o.id DESC LIMIT 1`,
  byId: "SELECT id, plan_id, days, target_type, restaurant_id, starts_at, ends_at, status FROM trial_offers WHERE id = ?1",
  listFirst: `SELECT o.id, o.days, o.target_type, o.starts_at, o.ends_at, o.status, o.created_at, p.name AS plan_name,
                     r.name AS restaurant_name, (SELECT COUNT(*) FROM trial_uses u WHERE u.offer_id = o.id) AS started
              FROM trial_offers o JOIN plans p ON p.id = o.plan_id LEFT JOIN restaurants r ON r.id = o.restaurant_id
              ORDER BY o.created_at DESC, o.id DESC LIMIT ?1`,
  listAfter: `SELECT o.id, o.days, o.target_type, o.starts_at, o.ends_at, o.status, o.created_at, p.name AS plan_name,
                     r.name AS restaurant_name, (SELECT COUNT(*) FROM trial_uses u WHERE u.offer_id = o.id) AS started
              FROM trial_offers o JOIN plans p ON p.id = o.plan_id LEFT JOIN restaurants r ON r.id = o.restaurant_id
              WHERE (o.created_at, o.id) < (?1, ?2)
              ORDER BY o.created_at DESC, o.id DESC LIMIT ?3`,
};

export interface TrialOffer {
  id: string;
  planId: string;
  planName: string;
  days: number;
}

/**
 * The trial a restaurant can start right now, or null. An offer made for this restaurant comes before
 * one for everyone. The caller checks the restaurant is on a free plan and not already on a trial.
 */
export async function availableTrial(db: D1Database, restaurantId: string, now: number): Promise<TrialOffer | null> {
  for (const sql of [TRIAL_SQL.forRestaurant, TRIAL_SQL.forAll]) {
    const row = await db.prepare(sql).bind(restaurantId, now).first<Record<string, unknown>>();
    if (row) return { id: String(row.id), planId: String(row.plan_id), planName: String(row.plan_name), days: Number(row.days) };
  }
  return null;
}

function auditInsert(db: D1Database, actorUserId: string, action: string, restaurantId: string | null, details: unknown) {
  return db
    .prepare("INSERT INTO audit_log (id, actor_user_id, action, restaurant_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), actorUserId, action, restaurantId, JSON.stringify(details), Date.now());
}

/**
 * Starts a trial: the plan as a trial with no price, the trial use, and the audit row, in one
 * transaction. The trial_uses primary key makes a second start for the same plan fail as a whole.
 */
export async function startTrial(
  db: D1Database,
  ownerUserId: string,
  restaurantId: string,
  offer: TrialOffer,
  period: { startedAt: number; endsAt: number; endsLabel: string },
): Promise<void> {
  await db.batch([
    db
      .prepare("INSERT INTO trial_uses (restaurant_id, plan_id, offer_id, created_at) VALUES (?, ?, ?, ?)")
      .bind(restaurantId, offer.planId, offer.id, period.startedAt),
    subscriptionUpsert(db, restaurantId, {
      planId: offer.planId,
      period: "none",
      status: "trial",
      startedAt: period.startedAt,
      endsAt: period.endsAt,
      priceMinor: 0,
      coupon: null,
    }),
    auditInsert(db, ownerUserId, "trial_started", restaurantId, { offerId: offer.id, plan: offer.planName, days: offer.days, ends: period.endsLabel }),
  ]);
}

export interface NewTrialOffer {
  planId: string;
  days: number;
  restaurantId: string | null;
  endsAt: number | null;
  endsLabel: string | null;
}

export async function createTrialOffer(db: D1Database, actorUserId: string, offer: NewTrialOffer): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  await db.batch([
    db
      .prepare(
        `INSERT INTO trial_offers (id, plan_id, days, target_type, restaurant_id, starts_at, ends_at, status, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .bind(id, offer.planId, offer.days, offer.restaurantId ? "restaurant" : "all", offer.restaurantId, now, offer.endsAt, actorUserId, now),
    auditInsert(db, actorUserId, "trial_offer_created", offer.restaurantId, {
      offerId: id,
      planId: offer.planId,
      days: offer.days,
      target: offer.restaurantId ? "restaurant" : "all",
      ends: offer.endsLabel,
    }),
  ]);
  return id;
}

export async function getTrialOffer(db: D1Database, id: string) {
  return db.prepare(TRIAL_SQL.byId).bind(id).first<{ id: string; plan_id: string; days: number; target_type: string; restaurant_id: string | null; starts_at: number; ends_at: number | null; status: string }>();
}

export async function endTrialOffer(db: D1Database, actorUserId: string, offer: { id: string; restaurant_id: string | null }): Promise<void> {
  await db.batch([
    db.prepare("UPDATE trial_offers SET status = 'ended' WHERE id = ?").bind(offer.id),
    auditInsert(db, actorUserId, "trial_offer_ended", offer.restaurant_id, { offerId: offer.id }),
  ]);
}

export interface TrialOfferRow {
  id: string;
  days: number;
  targetType: string;
  startsAt: number;
  endsAt: number | null;
  status: string;
  createdAt: number;
  planName: string;
  restaurantName: string | null;
  started: number;
}

export async function listTrialOffers(db: D1Database, before: { createdAt: number; id: string } | null) {
  const statement = before
    ? db.prepare(TRIAL_SQL.listAfter).bind(before.createdAt, before.id, TRIAL_PAGE_SIZE + 1)
    : db.prepare(TRIAL_SQL.listFirst).bind(TRIAL_PAGE_SIZE + 1);
  const { results } = await statement.all<Record<string, unknown>>();
  const rows: TrialOfferRow[] = results.slice(0, TRIAL_PAGE_SIZE).map((row) => ({
    id: String(row.id),
    days: Number(row.days),
    targetType: String(row.target_type),
    startsAt: Number(row.starts_at),
    endsAt: row.ends_at === null ? null : Number(row.ends_at),
    status: String(row.status),
    createdAt: Number(row.created_at),
    planName: String(row.plan_name),
    restaurantName: row.restaurant_name === null ? null : String(row.restaurant_name),
    started: Number(row.started),
  }));
  const last = rows[rows.length - 1];
  return { rows, next: results.length > TRIAL_PAGE_SIZE && last ? { createdAt: last.createdAt, id: last.id } : null };
}
