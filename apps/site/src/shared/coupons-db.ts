// Discount coupons (issue #40). Coupons are shared across restaurants and managed by the admin, so
// these are reviewed queries outside the tenant helper (Laws 17 and 18). Admin changes must only
// run after the admin session and role check. Every value is bound.
import type { CouponTerms } from "./pricing";

export const COUPON_PAGE_SIZE = 50;

// The SQL is listed here so a test can prove each query uses an index (Law 26).
export const COUPON_SQL = {
  // The code column is COLLATE NOCASE, so this matches any letter case through its unique index.
  byCode: `SELECT id, code, percent_off, billing_period, duration, plan_id, restaurant_id, max_redemptions,
                  redeemed_count, expires_at, status
           FROM coupons WHERE code = ?1`,
  usedBy: "SELECT 1 FROM coupon_redemptions WHERE coupon_id = ?1 AND restaurant_id = ?2",
  listFirst: `SELECT c.id, c.code, c.percent_off, c.billing_period, c.duration, c.max_redemptions, c.redeemed_count,
                     c.expires_at, c.status, c.created_at, p.name AS plan_name, r.name AS restaurant_name
              FROM coupons c LEFT JOIN plans p ON p.id = c.plan_id LEFT JOIN restaurants r ON r.id = c.restaurant_id
              ORDER BY c.created_at DESC, c.id DESC LIMIT ?1`,
  listAfter: `SELECT c.id, c.code, c.percent_off, c.billing_period, c.duration, c.max_redemptions, c.redeemed_count,
                     c.expires_at, c.status, c.created_at, p.name AS plan_name, r.name AS restaurant_name
              FROM coupons c LEFT JOIN plans p ON p.id = c.plan_id LEFT JOIN restaurants r ON r.id = c.restaurant_id
              WHERE (c.created_at, c.id) < (?1, ?2)
              ORDER BY c.created_at DESC, c.id DESC LIMIT ?3`,
  byId: "SELECT id, code, status, restaurant_id FROM coupons WHERE id = ?1",
};

export type CouponReason =
  | "not found"
  | "expired"
  | "disabled"
  | "used up"
  | "not for this plan"
  | "not for this billing period"
  | "not for this restaurant"
  | "already used by this restaurant";

// Owners never learn that a code exists for another restaurant, so these two share one message.
const OWNER_MESSAGES: Record<CouponReason, string> = {
  "not found": "This coupon cannot be used.",
  "not for this restaurant": "This coupon cannot be used.",
  expired: "This coupon has expired.",
  disabled: "This coupon is no longer active.",
  "used up": "This coupon has been fully used.",
  "not for this plan": "This coupon is not for this plan.",
  "not for this billing period": "This coupon is not for this billing period.",
  "already used by this restaurant": "You have already used this coupon.",
};

export interface UsableCoupon extends CouponTerms {
  id: string;
  code: string;
}

export type CouponCheck =
  | { ok: true; coupon: UsableCoupon }
  | { ok: false; reason: CouponReason; ownerMessage: string };

const refuse = (reason: CouponReason): CouponCheck => ({ ok: false, reason, ownerMessage: OWNER_MESSAGES[reason] });

/** Whether a restaurant can use a coupon for a plan and billing period right now. */
export async function checkCoupon(
  db: D1Database,
  code: string,
  context: { restaurantId: string; planId: string; period: "monthly" | "yearly"; now: number },
): Promise<CouponCheck> {
  const row = await db.prepare(COUPON_SQL.byCode).bind(code.trim()).first<Record<string, unknown>>();
  if (!row) return refuse("not found");
  if (row.status !== "active") return refuse("disabled");
  if (row.expires_at !== null && Number(row.expires_at) <= context.now) return refuse("expired");
  if (row.max_redemptions !== null && Number(row.redeemed_count) >= Number(row.max_redemptions)) return refuse("used up");
  if (row.restaurant_id !== null && row.restaurant_id !== context.restaurantId) return refuse("not for this restaurant");
  if (row.plan_id !== null && row.plan_id !== context.planId) return refuse("not for this plan");
  if (row.billing_period !== "any" && row.billing_period !== context.period) return refuse("not for this billing period");
  if (await db.prepare(COUPON_SQL.usedBy).bind(row.id, context.restaurantId).first()) return refuse("already used by this restaurant");
  return {
    ok: true,
    coupon: {
      id: String(row.id),
      code: String(row.code),
      percentOff: Number(row.percent_off),
      duration: row.duration === "recurring" ? "recurring" : "once",
    },
  };
}

/**
 * The statements that record one use, for the same batch as the subscription change.
 * The UNIQUE (coupon_id, restaurant_id) rule and the redeemed_count CHECK make the whole batch fail
 * if the coupon was already used by this restaurant or has reached its limit, even when two saves
 * happen at the same moment.
 */
export function redemptionStatements(db: D1Database, couponId: string, restaurantId: string): D1PreparedStatement[] {
  const now = Date.now();
  return [
    db
      .prepare("INSERT INTO coupon_redemptions (id, coupon_id, restaurant_id, created_at) VALUES (?, ?, ?, ?)")
      .bind(crypto.randomUUID(), couponId, restaurantId, now),
    db.prepare("UPDATE coupons SET redeemed_count = redeemed_count + 1, updated_at = ? WHERE id = ?").bind(now, couponId),
  ];
}

export interface NewCoupon {
  code: string;
  percentOff: number;
  billingPeriod: "monthly" | "yearly" | "any";
  duration: "once" | "recurring";
  planId: string | null;
  restaurantId: string | null;
  maxRedemptions: number | null;
  expiresAt: number | null;
  /** For the audit log. */
  expiresLabel: string | null;
}

function auditInsert(db: D1Database, actorUserId: string, action: string, restaurantId: string | null, details: unknown) {
  return db
    .prepare("INSERT INTO audit_log (id, actor_user_id, action, restaurant_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), actorUserId, action, restaurantId, JSON.stringify(details), Date.now());
}

export async function codeExists(db: D1Database, code: string): Promise<boolean> {
  return (await db.prepare(COUPON_SQL.byCode).bind(code).first()) !== null;
}

/** The coupon and its audit row are saved in one transaction. */
export async function createCoupon(db: D1Database, actorUserId: string, coupon: NewCoupon): Promise<void> {
  const id = crypto.randomUUID();
  const now = Date.now();
  await db.batch([
    db
      .prepare(
        `INSERT INTO coupons (id, code, percent_off, billing_period, duration, plan_id, restaurant_id, max_redemptions,
                              redeemed_count, expires_at, status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'active', ?, ?, ?)`,
      )
      .bind(id, coupon.code, coupon.percentOff, coupon.billingPeriod, coupon.duration, coupon.planId, coupon.restaurantId,
        coupon.maxRedemptions, coupon.expiresAt, actorUserId, now, now),
    auditInsert(db, actorUserId, "coupon_created", coupon.restaurantId, {
      couponId: id,
      code: coupon.code,
      percentOff: coupon.percentOff,
      billingPeriod: coupon.billingPeriod,
      duration: coupon.duration,
      planId: coupon.planId,
      maxRedemptions: coupon.maxRedemptions,
      expires: coupon.expiresLabel,
    }),
  ]);
}

export async function getCoupon(db: D1Database, id: string) {
  return db.prepare(COUPON_SQL.byId).bind(id).first<{ id: string; code: string; status: string; restaurant_id: string | null }>();
}

export async function setCouponStatus(
  db: D1Database,
  actorUserId: string,
  coupon: { id: string; code: string; restaurant_id: string | null },
  status: "active" | "disabled",
): Promise<void> {
  await db.batch([
    db.prepare("UPDATE coupons SET status = ?, updated_at = ? WHERE id = ?").bind(status, Date.now(), coupon.id),
    auditInsert(db, actorUserId, status === "disabled" ? "coupon_disabled" : "coupon_enabled", coupon.restaurant_id, {
      couponId: coupon.id,
      code: coupon.code,
    }),
  ]);
}

export interface CouponRow {
  id: string;
  code: string;
  percentOff: number;
  billingPeriod: string;
  duration: string;
  maxRedemptions: number | null;
  redeemedCount: number;
  expiresAt: number | null;
  status: string;
  createdAt: number;
  planName: string | null;
  restaurantName: string | null;
}

export async function listCoupons(db: D1Database, before: { createdAt: number; id: string } | null) {
  const statement = before
    ? db.prepare(COUPON_SQL.listAfter).bind(before.createdAt, before.id, COUPON_PAGE_SIZE + 1)
    : db.prepare(COUPON_SQL.listFirst).bind(COUPON_PAGE_SIZE + 1);
  const { results } = await statement.all<Record<string, unknown>>();
  const rows: CouponRow[] = results.slice(0, COUPON_PAGE_SIZE).map((row) => ({
    id: String(row.id),
    code: String(row.code),
    percentOff: Number(row.percent_off),
    billingPeriod: String(row.billing_period),
    duration: String(row.duration),
    maxRedemptions: row.max_redemptions === null ? null : Number(row.max_redemptions),
    redeemedCount: Number(row.redeemed_count),
    expiresAt: row.expires_at === null ? null : Number(row.expires_at),
    status: String(row.status),
    createdAt: Number(row.created_at),
    planName: row.plan_name === null ? null : String(row.plan_name),
    restaurantName: row.restaurant_name === null ? null : String(row.restaurant_name),
  }));
  const last = rows[rows.length - 1];
  return { rows, next: results.length > COUPON_PAGE_SIZE && last ? { createdAt: last.createdAt, id: last.id } : null };
}
