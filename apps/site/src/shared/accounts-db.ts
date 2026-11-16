// Account queries: users, sessions, and login attempts.
// These work before a restaurant is known (signup and login), so they cannot use the tenant helper.
// Every query here is reviewed by hand and never returns another restaurant's menu data (Law 18).
import type { Entitlements } from "./plans";
import { currentPlan } from "./subscriptions-db";

export interface OwnerLogin {
  userId: string;
  passwordHash: string;
}

export interface OwnerSession {
  userId: string;
  restaurantId: string;
  restaurantName: string;
  city: string | null;
  /** The permanent code in menu links and QR codes (Law 28). */
  menuCode: string;
  /** Features and limits of the plan in use (issues #38 and #39). An ended plan is already the signup plan here. */
  entitlements: Entitlements;
  /** When the plan in use ends, or null for no end. */
  planEndsAt: number | null;
}

const encoder = new TextEncoder();

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function menuCodeExists(db: D1Database, code: string): Promise<boolean> {
  return (await db.prepare("SELECT 1 FROM restaurants WHERE menu_code = ?").bind(code).first()) !== null;
}

export async function slugExists(db: D1Database, slug: string): Promise<boolean> {
  return (await db.prepare("SELECT 1 FROM restaurants WHERE slug = ?").bind(slug).first()) !== null;
}

export interface NewOwner {
  email: string;
  passwordHash: string;
  phone: string;
  restaurantName: string;
  city: string;
  /** No longer used in links, but the column is still NOT NULL UNIQUE, so it is filled as before. */
  slug: string;
  menuCode: string;
}

/** Creates the user and their restaurant together. Throws if the email or slug is already taken. */
export async function createOwner(db: D1Database, owner: NewOwner): Promise<{ userId: string }> {
  const userId = crypto.randomUUID();
  const restaurantId = crypto.randomUUID();
  const now = Date.now();
  await db.batch([
    db
      .prepare("INSERT INTO users (id, email, password_hash, phone, role, created_at) VALUES (?, ?, ?, ?, 'owner', ?)")
      .bind(userId, owner.email, owner.passwordHash, owner.phone, now),
    db
      .prepare(
        "INSERT INTO restaurants (id, owner_user_id, name, slug, menu_code, city, phone, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(restaurantId, userId, owner.restaurantName, owner.slug, owner.menuCode, owner.city, owner.phone, now, now),
    // Every new restaurant starts on the signup plan, with no end and no price (issue #39).
    db
      .prepare(
        `INSERT INTO subscriptions (restaurant_id, plan_id, billing_period, status, started_at, ends_at, price_minor, updated_at)
         VALUES (?, (SELECT id FROM plans WHERE is_signup_default = 1), 'none', 'active', ?, NULL, 0, ?)`,
      )
      .bind(restaurantId, now, now),
  ]);
  return { userId };
}

/** Only owners who have a restaurant can log in to the owner area. */
export async function findOwnerLogin(db: D1Database, email: string): Promise<OwnerLogin | null> {
  const row = await db
    .prepare(
      "SELECT u.id, u.password_hash FROM users u JOIN restaurants r ON r.owner_user_id = u.id WHERE u.email = ? AND u.role = 'owner'",
    )
    .bind(email)
    .first<{ id: string; password_hash: string }>();
  return row ? { userId: row.id, passwordHash: row.password_hash } : null;
}

/** Only accounts with the admin role can log in to the admin area (issue #34). */
export async function findAdminLogin(db: D1Database, email: string): Promise<OwnerLogin | null> {
  const row = await db
    .prepare("SELECT id, password_hash FROM users WHERE email = ? AND role = 'admin'")
    .bind(email)
    .first<{ id: string; password_hash: string }>();
  return row ? { userId: row.id, passwordHash: row.password_hash } : null;
}

export interface AdminSession {
  userId: string;
  email: string;
}

/** The role is read from the database on every request, so a changed role takes effect at once (Law 18). */
export async function findAdminSession(db: D1Database, token: string, now: number): Promise<AdminSession | null> {
  const row = await db
    .prepare(
      `SELECT u.id, u.email FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ? AND u.role = 'admin'`,
    )
    .bind(await sha256Hex(token), now)
    .first<{ id: string; email: string }>();
  return row ? { userId: row.id, email: row.email } : null;
}

export async function createSession(db: D1Database, userId: string, token: string, expiresAt: number): Promise<void> {
  await db
    .prepare("INSERT INTO sessions (id, token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), await sha256Hex(token), userId, expiresAt, Date.now())
    .run();
}

/** The restaurant id comes from here, so it always belongs to the logged-in owner (Law 18). */
export async function findOwnerSession(db: D1Database, token: string, now: number): Promise<OwnerSession | null> {
  const row = await db
    .prepare(
      `SELECT u.id AS user_id, r.id AS restaurant_id, r.name, r.city, r.menu_code
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       JOIN restaurants r ON r.owner_user_id = u.id
       WHERE s.token_hash = ? AND s.expires_at > ? AND u.role = 'owner'`,
    )
    .bind(await sha256Hex(token), now)
    .first<{ user_id: string; restaurant_id: string; name: string; city: string | null; menu_code: string }>();
  if (!row) return null;
  // The plan is read fresh on every request, so an ended plan or a plan change applies at once.
  const plan = await currentPlan(db, row.restaurant_id, now);
  return {
    userId: row.user_id,
    restaurantId: row.restaurant_id,
    restaurantName: row.name,
    city: row.city,
    menuCode: row.menu_code,
    entitlements: plan.entitlements,
    planEndsAt: plan.endsAt,
  };
}

export async function deleteSession(db: D1Database, token: string): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256Hex(token)).run();
}

// Failed logins per email, counted in one row that is updated in place (Laws 19 and 26).
const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60 * 1000;

export async function isLoginLocked(db: D1Database, key: string, now: number): Promise<boolean> {
  const row = await db
    .prepare("SELECT failed_count, window_started_at FROM login_attempts WHERE attempt_key = ?")
    .bind(key)
    .first<{ failed_count: number; window_started_at: number }>();
  return row !== null && now - row.window_started_at < WINDOW_MS && row.failed_count >= MAX_FAILURES;
}

export async function recordLoginFailure(db: D1Database, key: string, now: number): Promise<void> {
  // Starts a new window when the old one has ended.
  await db
    .prepare(
      `INSERT INTO login_attempts (attempt_key, failed_count, window_started_at) VALUES (?1, 1, ?2)
       ON CONFLICT (attempt_key) DO UPDATE SET
         failed_count = CASE WHEN ?2 - window_started_at >= ?3 THEN 1 ELSE failed_count + 1 END,
         window_started_at = CASE WHEN ?2 - window_started_at >= ?3 THEN ?2 ELSE window_started_at END`,
    )
    .bind(key, now, WINDOW_MS)
    .run();
}

export async function clearLoginFailures(db: D1Database, key: string): Promise<void> {
  await db.prepare("DELETE FROM login_attempts WHERE attempt_key = ?").bind(key).run();
}
