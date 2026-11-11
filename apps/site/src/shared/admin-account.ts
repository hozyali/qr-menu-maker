// Creates a master admin account (issue #34). Admin accounts are never created through signup (Law 19).
// Used by scripts/create-admin.mjs and the tests. It has no imports, so Node can load it directly.
// The query is reviewed by hand and uses bound values only (Law 17).

export interface NewAdmin {
  /** Already lowercased and checked by the caller. */
  email: string;
  /** From hashPassword in password.ts. The plain password never reaches this file. */
  passwordHash: string;
}

/** Throws if the email is already used by any account, owner or admin (the column is UNIQUE, case-insensitive). */
export async function createAdmin(db: D1Database, admin: NewAdmin): Promise<{ userId: string }> {
  const userId = crypto.randomUUID();
  await db
    .prepare("INSERT INTO users (id, email, password_hash, role, created_at) VALUES (?, ?, ?, 'admin', ?)")
    .bind(userId, admin.email, admin.passwordHash, Date.now())
    .run();
  return { userId };
}
