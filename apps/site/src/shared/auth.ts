import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import {
  clearLoginFailures,
  createSession,
  deleteSession,
  isLoginLocked,
  type OwnerLogin,
  recordLoginFailure,
} from "./accounts-db";
import { getDummyHash, verifyPassword } from "./password";
import { normalizeEmail, readText } from "./validation";

// Login and session rules shared by the owner and admin areas (Law 19, issue #34).
// Moved here from owner/index.ts, so both areas follow exactly the same rules.

const SESSION_COOKIE = "session"; // Sent as "__Host-session" because of the "host" prefix.
export const GENERIC_LOGIN_ERROR = "Email or password is wrong.";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- works for every area's Hono context.
type AnyContext = Context<any>;

/** A rough per-address limit on account forms. The database lockout is the strict one. */
export async function tooManyRequests(c: AnyContext): Promise<boolean> {
  const ip = c.req.raw.headers.get("cf-connecting-ip") ?? "unknown";
  const { success } = await (c.env as Env).AUTH_LIMITER.limit({ key: `${ip}:${c.req.path}` });
  return !success;
}

export function sessionToken(c: AnyContext): string | undefined {
  return getCookie(c, SESSION_COOKIE, "host");
}

export async function startSession(c: AnyContext, db: D1Database, userId: string, maxAgeSeconds: number) {
  const token = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  await createSession(db, userId, token, Date.now() + maxAgeSeconds * 1000);
  // No Domain attribute, so only this exact hostname receives the cookie (Law 19).
  setCookie(c, SESSION_COOKIE, token, { prefix: "host", path: "/", secure: true, httpOnly: true, sameSite: "Lax", maxAge: maxAgeSeconds });
}

export async function endSession(c: AnyContext, db: D1Database) {
  const token = sessionToken(c);
  if (token) await deleteSession(db, token);
  deleteCookie(c, SESSION_COOKIE, { prefix: "host", path: "/", secure: true });
}

export type LoginResult =
  | { ok: true; userId: string }
  | { ok: false; status: 401 | 429; message: string; email: string };

/**
 * Checks a login form. `findLogin` decides which role may log in, and `lockPrefix` keeps each
 * area's failed-login count separate. An unknown email still runs a hash, so both failures take
 * about the same time.
 */
export async function checkLogin(
  db: D1Database,
  form: FormData,
  findLogin: (db: D1Database, email: string) => Promise<OwnerLogin | null>,
  lockPrefix: string,
): Promise<LoginResult> {
  const email = normalizeEmail(readText(form, "email"));
  const password = typeof form.get("password") === "string" ? String(form.get("password")) : "";
  const attemptKey = `${lockPrefix}:${email}`;
  const now = Date.now();

  if (await isLoginLocked(db, attemptKey, now)) {
    return { ok: false, status: 429, message: "Too many failed logins. Try again in 15 minutes.", email };
  }
  const login = email.length <= 254 && password.length <= 128 ? await findLogin(db, email) : null;
  const valid = await verifyPassword(password, login?.passwordHash ?? (await getDummyHash()));
  if (!login || !valid) {
    await recordLoginFailure(db, attemptKey, now);
    return { ok: false, status: 401, message: GENERIC_LOGIN_ERROR, email };
  }
  await clearLoginFailures(db, attemptKey);
  return { ok: true, userId: login.userId };
}
