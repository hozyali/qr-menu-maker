// Account queries: users, sessions, and login attempts.
// These work before a restaurant is known (signup and login), so they cannot use the tenant helper.
// Every query here is reviewed by hand and never returns another restaurant's menu data (Law 18).

export interface OwnerLogin {
  userId: string;
  passwordHash: string;
}

export interface OwnerSession {
  userId: string;
  restaurantId: string;
  restaurantName: string;
  slug: string;
}

const encoder = new TextEncoder();

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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
  slug: string;
}

/** Creates the user and their restaurant together. Throws if the email or slug is already taken. */
export async function createOwner(db: D1Database, owner: NewOwner): Promise<{ userId: string }> {
  const userId = crypto.randomUUID();
  const now = Date.now();
  await db.batch([
    db
      .prepare("INSERT INTO users (id, email, password_hash, phone, role, created_at) VALUES (?, ?, ?, ?, 'owner', ?)")
      .bind(userId, owner.email, owner.passwordHash, owner.phone, now),
    db
      .prepare(
        "INSERT INTO restaurants (id, owner_user_id, name, slug, city, phone, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(crypto.randomUUID(), userId, owner.restaurantName, owner.slug, owner.city, owner.phone, now, now),
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
      `SELECT u.id AS user_id, r.id AS restaurant_id, r.name, r.slug
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       JOIN restaurants r ON r.owner_user_id = u.id
       WHERE s.token_hash = ? AND s.expires_at > ? AND u.role = 'owner'`,
    )
    .bind(await sha256Hex(token), now)
    .first<{ user_id: string; restaurant_id: string; name: string; slug: string }>();
  return row
    ? { userId: row.user_id, restaurantId: row.restaurant_id, restaurantName: row.name, slug: row.slug }
    : null;
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
