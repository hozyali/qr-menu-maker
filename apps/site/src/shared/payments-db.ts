// Offline payments (issue #41): admin settings and the admin side of payment requests.
// The admin reviews payments from every restaurant, so these are reviewed queries outside the
// tenant helper (Laws 17 and 18). They must only run after the admin session and role check.
// The owner side of payment requests is in the tenant helper (tenant-db.ts). Every value is bound.
import { redemptionStatements } from "./coupons-db";
import { subscriptionUpsert } from "./subscriptions-db";

export const PAYMENT_PAGE_SIZE = 50;

// The SQL is listed here so a test can prove each query uses an index (Law 26).
export const PAYMENT_SQL = {
  setting: "SELECT value FROM app_settings WHERE key = ?1",
  // Waiting payments, oldest first, so none is forgotten.
  pendingFirst: `SELECT q.id, q.billing_period, q.amount_minor, q.created_at, r.name AS restaurant_name, p.name AS plan_name
                 FROM payment_requests q JOIN restaurants r ON r.id = q.restaurant_id JOIN plans p ON p.id = q.plan_id
                 WHERE q.status = 'pending' ORDER BY q.created_at, q.id LIMIT ?1`,
  pendingAfter: `SELECT q.id, q.billing_period, q.amount_minor, q.created_at, r.name AS restaurant_name, p.name AS plan_name
                 FROM payment_requests q JOIN restaurants r ON r.id = q.restaurant_id JOIN plans p ON p.id = q.plan_id
                 WHERE q.status = 'pending' AND (q.created_at, q.id) > (?1, ?2) ORDER BY q.created_at, q.id LIMIT ?3`,
  // Approved or rejected payments, newest first.
  reviewedFirst: `SELECT q.id, q.billing_period, q.amount_minor, q.created_at, r.name AS restaurant_name, p.name AS plan_name
                  FROM payment_requests q JOIN restaurants r ON r.id = q.restaurant_id JOIN plans p ON p.id = q.plan_id
                  WHERE q.status = ?1 ORDER BY q.created_at DESC, q.id DESC LIMIT ?2`,
  reviewedAfter: `SELECT q.id, q.billing_period, q.amount_minor, q.created_at, r.name AS restaurant_name, p.name AS plan_name
                  FROM payment_requests q JOIN restaurants r ON r.id = q.restaurant_id JOIN plans p ON p.id = q.plan_id
                  WHERE q.status = ?1 AND (q.created_at, q.id) < (?2, ?3) ORDER BY q.created_at DESC, q.id DESC LIMIT ?4`,
  byId: `SELECT q.id, q.restaurant_id, q.plan_id, q.billing_period, q.coupon_id, q.coupon_percent_off, q.coupon_duration,
                q.list_price_minor, q.discount_minor, q.amount_minor, q.receipt_key, q.status, q.owner_note, q.review_note,
                q.created_at, q.reviewed_at, r.name AS restaurant_name, p.name AS plan_name, c.code AS coupon_code
         FROM payment_requests q JOIN restaurants r ON r.id = q.restaurant_id JOIN plans p ON p.id = q.plan_id
         LEFT JOIN coupons c ON c.id = q.coupon_id WHERE q.id = ?1`,
};

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  return (await db.prepare(PAYMENT_SQL.setting).bind(key).first<{ value: string }>())?.value ?? null;
}

function auditInsert(db: D1Database, actorUserId: string, action: string, restaurantId: string | null, details: unknown) {
  return db
    .prepare("INSERT INTO audit_log (id, actor_user_id, action, restaurant_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), actorUserId, action, restaurantId, JSON.stringify(details), Date.now());
}

/** One row per setting, written in place, with an audit row in the same transaction. */
export async function setSetting(db: D1Database, actorUserId: string, key: string, value: string): Promise<void> {
  const now = Date.now();
  await db.batch([
    db
      .prepare(
        `INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      )
      .bind(key, value, now, actorUserId),
    auditInsert(db, actorUserId, "settings_updated", null, { key }),
  ]);
}

export interface PaymentListRow {
  id: string;
  billingPeriod: string;
  amountMinor: number;
  createdAt: number;
  restaurantName: string;
  planName: string;
}

export type PaymentStatus = "pending" | "approved" | "rejected";

export async function listPayments(db: D1Database, status: PaymentStatus, after: { createdAt: number; id: string } | null) {
  let statement: D1PreparedStatement;
  if (status === "pending") {
    statement = after
      ? db.prepare(PAYMENT_SQL.pendingAfter).bind(after.createdAt, after.id, PAYMENT_PAGE_SIZE + 1)
      : db.prepare(PAYMENT_SQL.pendingFirst).bind(PAYMENT_PAGE_SIZE + 1);
  } else {
    statement = after
      ? db.prepare(PAYMENT_SQL.reviewedAfter).bind(status, after.createdAt, after.id, PAYMENT_PAGE_SIZE + 1)
      : db.prepare(PAYMENT_SQL.reviewedFirst).bind(status, PAYMENT_PAGE_SIZE + 1);
  }
  const { results } = await statement.all<Record<string, unknown>>();
  const rows: PaymentListRow[] = results.slice(0, PAYMENT_PAGE_SIZE).map((row) => ({
    id: String(row.id),
    billingPeriod: String(row.billing_period),
    amountMinor: Number(row.amount_minor),
    createdAt: Number(row.created_at),
    restaurantName: String(row.restaurant_name),
    planName: String(row.plan_name),
  }));
  const last = rows[rows.length - 1];
  return { rows, next: results.length > PAYMENT_PAGE_SIZE && last ? { createdAt: last.createdAt, id: last.id } : null };
}

export interface PaymentDetail {
  id: string;
  restaurantId: string;
  restaurantName: string;
  planId: string;
  planName: string;
  billingPeriod: "monthly" | "yearly";
  couponId: string | null;
  couponCode: string | null;
  couponPercentOff: number | null;
  couponDuration: "once" | "recurring" | null;
  listPriceMinor: number;
  discountMinor: number;
  amountMinor: number;
  receiptKey: string;
  status: PaymentStatus;
  ownerNote: string | null;
  reviewNote: string | null;
  createdAt: number;
  reviewedAt: number | null;
}

export async function getPayment(db: D1Database, id: string): Promise<PaymentDetail | null> {
  const row = await db.prepare(PAYMENT_SQL.byId).bind(id).first<Record<string, unknown>>();
  if (!row) return null;
  const text = (value: unknown) => (value === null || value === undefined ? null : String(value));
  return {
    id: String(row.id),
    restaurantId: String(row.restaurant_id),
    restaurantName: String(row.restaurant_name),
    planId: String(row.plan_id),
    planName: String(row.plan_name),
    billingPeriod: row.billing_period === "yearly" ? "yearly" : "monthly",
    couponId: text(row.coupon_id),
    couponCode: text(row.coupon_code),
    couponPercentOff: row.coupon_percent_off === null ? null : Number(row.coupon_percent_off),
    couponDuration: row.coupon_duration === "recurring" ? "recurring" : row.coupon_duration === "once" ? "once" : null,
    listPriceMinor: Number(row.list_price_minor),
    discountMinor: Number(row.discount_minor),
    amountMinor: Number(row.amount_minor),
    receiptKey: String(row.receipt_key),
    status: row.status === "approved" ? "approved" : row.status === "rejected" ? "rejected" : "pending",
    ownerNote: text(row.owner_note),
    reviewNote: text(row.review_note),
    createdAt: Number(row.created_at),
    reviewedAt: row.reviewed_at === null ? null : Number(row.reviewed_at),
  };
}

/**
 * Approves a payment (issue #41): marks it approved, starts the plan now, counts a new coupon's use,
 * and writes the audit row, all in one transaction. The first statement fails on a payment that is
 * no longer pending (database trigger), and the coupon rules can fail too. Either way nothing is saved.
 */
export async function approvePayment(
  db: D1Database,
  actorUserId: string,
  payment: PaymentDetail,
  period: { startedAt: number; endsAt: number; endsLabel: string },
): Promise<void> {
  await db.batch([
    db
      .prepare("UPDATE payment_requests SET status = 'approved', reviewed_at = ?, reviewed_by = ? WHERE id = ?")
      .bind(period.startedAt, actorUserId, payment.id),
    subscriptionUpsert(db, payment.restaurantId, {
      planId: payment.planId,
      period: payment.billingPeriod,
      status: "active",
      startedAt: period.startedAt,
      endsAt: period.endsAt,
      priceMinor: payment.amountMinor,
      coupon:
        payment.couponPercentOff !== null && payment.couponDuration !== null
          ? { id: payment.couponId, percentOff: payment.couponPercentOff, duration: payment.couponDuration }
          : null,
    }),
    ...(payment.couponId ? redemptionStatements(db, payment.couponId, payment.restaurantId) : []),
    auditInsert(db, actorUserId, "payment_approved", payment.restaurantId, {
      paymentId: payment.id,
      plan: payment.planName,
      period: payment.billingPeriod,
      amount: payment.amountMinor,
      coupon: payment.couponCode,
      ends: period.endsLabel,
    }),
  ]);
}

/** Rejects a payment with a note the owner sees. Fails on a payment that is no longer pending. */
export async function rejectPayment(db: D1Database, actorUserId: string, payment: PaymentDetail, note: string): Promise<void> {
  await db.batch([
    db
      .prepare("UPDATE payment_requests SET status = 'rejected', review_note = ?, reviewed_at = ?, reviewed_by = ? WHERE id = ?")
      .bind(note, Date.now(), actorUserId, payment.id),
    auditInsert(db, actorUserId, "payment_rejected", payment.restaurantId, { paymentId: payment.id, note }),
  ]);
}
