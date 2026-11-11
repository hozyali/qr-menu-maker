// Plan queries (issue #38). Plans are shared by all restaurants, so these are reviewed queries
// outside the tenant helper (Laws 17 and 18). Admin changes must only run after the admin
// session and role check. Every value is bound.
import { type Entitlements, FEATURES, type LegacyPlan, type LimitKey, type SwitchKey } from "./plans";

// The SQL is listed here so a test can prove each query uses an index (Law 26).
export const PLANS_SQL = {
  entitlementsByLegacy: `SELECT p.id, p.name, p.is_free, e.feature_key, e.enabled, e.limit_value
                         FROM plans p LEFT JOIN plan_entitlements e ON e.plan_id = p.id
                         WHERE p.legacy_key = ?`,
  // The plans table stays small. The list walks it in display order and counts restaurants per
  // plan through the restaurants_plan index.
  list: `SELECT p.id, p.name, p.is_free, p.monthly_price_minor, p.yearly_price_minor, p.is_signup_default, p.status,
                p.legacy_key,
                (SELECT COUNT(*) FROM restaurants r WHERE r.plan = p.legacy_key) AS restaurant_count
         FROM plans p ORDER BY p.sort_order, p.created_at, p.id`,
  byId: `SELECT p.id, p.name, p.is_free, p.monthly_price_minor, p.yearly_price_minor, p.is_signup_default, p.status,
                p.legacy_key, e.feature_key, e.enabled, e.limit_value,
                (SELECT COUNT(*) FROM restaurants r WHERE r.plan = p.legacy_key) AS restaurant_count
         FROM plans p LEFT JOIN plan_entitlements e ON e.plan_id = p.id WHERE p.id = ?`,
};

type Row = Record<string, unknown>;

function toEntitlements(rows: Row[]): Entitlements | null {
  const first = rows[0];
  if (!first) return null;
  const entitlements: Entitlements = {
    planId: String(first.id),
    planName: String(first.name),
    isFree: first.is_free === 1,
    switches: {},
    limits: {},
  };
  for (const row of rows) {
    const feature = FEATURES.find((f) => f.key === row.feature_key);
    if (!feature) continue;
    if (feature.type === "switch") {
      entitlements.switches[feature.key as SwitchKey] = row.enabled === 1;
    } else {
      entitlements.limits[feature.key as LimitKey] = row.limit_value === null ? null : Number(row.limit_value);
    }
  }
  return entitlements;
}

/** The features of a restaurant's plan, in one indexed query. */
export async function loadEntitlements(db: D1Database, plan: LegacyPlan): Promise<Entitlements> {
  const { results } = await db.prepare(PLANS_SQL.entitlementsByLegacy).bind(plan).all<Row>();
  const entitlements = toEntitlements(results);
  // The seed plans come from migration 0005. Without them nothing can be decided safely.
  if (!entitlements) throw new Error(`Plan "${plan}" is missing. Run migration 0005_plans.sql.`);
  return entitlements;
}

export interface PlanSummary {
  id: string;
  name: string;
  isFree: boolean;
  monthlyPriceMinor: number | null;
  yearlyPriceMinor: number | null;
  isSignupDefault: boolean;
  status: "active" | "archived";
  legacyKey: string | null;
  restaurantCount: number;
}

const toSummary = (row: Row): PlanSummary => ({
  id: String(row.id),
  name: String(row.name),
  isFree: row.is_free === 1,
  monthlyPriceMinor: row.monthly_price_minor === null ? null : Number(row.monthly_price_minor),
  yearlyPriceMinor: row.yearly_price_minor === null ? null : Number(row.yearly_price_minor),
  isSignupDefault: row.is_signup_default === 1,
  status: row.status === "archived" ? "archived" : "active",
  legacyKey: row.legacy_key === null ? null : String(row.legacy_key),
  restaurantCount: Number(row.restaurant_count ?? 0),
});

export async function listPlans(db: D1Database): Promise<PlanSummary[]> {
  const { results } = await db.prepare(PLANS_SQL.list).all<Row>();
  return results.map(toSummary);
}

export interface PlanDetail extends PlanSummary {
  entitlements: Entitlements;
}

export async function getPlan(db: D1Database, id: string): Promise<PlanDetail | null> {
  const { results } = await db.prepare(PLANS_SQL.byId).bind(id).all<Row>();
  const first = results[0];
  const entitlements = toEntitlements(results);
  return first && entitlements ? { ...toSummary(first), entitlements } : null;
}

/** What the admin form saves. Prices are in paisa. */
export interface PlanInput {
  name: string;
  isFree: boolean;
  monthlyPriceMinor: number | null;
  yearlyPriceMinor: number | null;
  switches: Record<SwitchKey, boolean>;
  limits: Record<LimitKey, number | null>;
}

/** A plain copy of the plan for the audit log, so before and after can be compared later. */
export function planSnapshot(input: PlanInput) {
  return {
    name: input.name,
    isFree: input.isFree,
    monthly: input.monthlyPriceMinor,
    yearly: input.yearlyPriceMinor,
    ...input.switches,
    ...input.limits,
  };
}

// One row per feature, written in place: a new row, or the existing row updated (Law 26).
function entitlementUpserts(db: D1Database, planId: string, input: PlanInput): D1PreparedStatement[] {
  const sql = `INSERT INTO plan_entitlements (plan_id, feature_key, enabled, limit_value) VALUES (?, ?, ?, ?)
               ON CONFLICT (plan_id, feature_key) DO UPDATE SET enabled = excluded.enabled, limit_value = excluded.limit_value`;
  return FEATURES.map((feature) =>
    feature.type === "switch"
      ? db.prepare(sql).bind(planId, feature.key, input.switches[feature.key] ? 1 : 0, null)
      : db.prepare(sql).bind(planId, feature.key, null, input.limits[feature.key]),
  );
}

function auditInsert(db: D1Database, actorUserId: string, action: string, details: unknown) {
  return db
    .prepare("INSERT INTO audit_log (id, actor_user_id, action, restaurant_id, details, created_at) VALUES (?, ?, ?, NULL, ?, ?)")
    .bind(crypto.randomUUID(), actorUserId, action, JSON.stringify(details), Date.now());
}

/** The plan, its features, and the audit row are saved in one transaction. */
export async function createPlan(db: D1Database, actorUserId: string, input: PlanInput): Promise<string> {
  // Plan ids are random hex, like the seeded ones (Law 18).
  const id = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const now = Date.now();
  await db.batch([
    db
      .prepare(
        `INSERT INTO plans (id, name, is_free, monthly_price_minor, yearly_price_minor, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM plans), ?, ?)`,
      )
      .bind(id, input.name, input.isFree ? 1 : 0, input.monthlyPriceMinor, input.yearlyPriceMinor, now, now),
    ...entitlementUpserts(db, id, input),
    auditInsert(db, actorUserId, "plan_created", { planId: id, plan: planSnapshot(input) }),
  ]);
  return id;
}

export async function updatePlan(db: D1Database, actorUserId: string, id: string, before: PlanInput, input: PlanInput): Promise<void> {
  await db.batch([
    db
      .prepare("UPDATE plans SET name = ?, is_free = ?, monthly_price_minor = ?, yearly_price_minor = ?, updated_at = ? WHERE id = ?")
      .bind(input.name, input.isFree ? 1 : 0, input.monthlyPriceMinor, input.yearlyPriceMinor, Date.now(), id),
    // One transaction, so a plan never ends up with half of a change.
    ...entitlementUpserts(db, id, input),
    auditInsert(db, actorUserId, "plan_updated", { planId: id, from: planSnapshot(before), to: planSnapshot(input) }),
  ]);
}

export async function setPlanStatus(db: D1Database, actorUserId: string, id: string, status: "active" | "archived"): Promise<void> {
  await db.batch([
    db.prepare("UPDATE plans SET status = ?, updated_at = ? WHERE id = ?").bind(status, Date.now(), id),
    auditInsert(db, actorUserId, status === "archived" ? "plan_archived" : "plan_restored", { planId: id }),
  ]);
}
