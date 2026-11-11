import { env } from "cloudflare:workers";
import { vi } from "vitest";
import { handleRequest } from "../src/index";

// Shared helpers for tests that drive the owner area through real HTTP requests.
export const APP = "https://app.tomatofry.com";
export const db = env.DB;

let ipCounter = 1;
const nextIp = () => `203.0.113.${ipCounter++ % 250}`;

export function post(path: string, form: Record<string, string | string[]>, cookie?: string) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(form)) {
    for (const item of Array.isArray(value) ? value : [value]) body.append(key, item);
  }
  const headers = new Headers({
    "content-type": "application/x-www-form-urlencoded",
    origin: APP,
    "cf-connecting-ip": nextIp(),
  });
  if (cookie) headers.set("cookie", cookie);
  return handleRequest(new Request(`${APP}${path}`, { method: "POST", headers, body }), env);
}

export function get(path: string, cookie?: string) {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  return handleRequest(new Request(`${APP}${path}`, { headers }), env);
}

/** The Turnstile service is outside our system, so its answer is replaced in tests. */
export function passTurnstile() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json({ success: true, hostname: "app.tomatofry.com" }),
  );
}

let counter = 0;
/** Signs up a new owner and returns their session cookie and restaurant id. */
export async function newOwner(name = "Test Kitchen") {
  counter++;
  const email = `menu-owner${counter}@example.test`;
  const response = await post("/signup", {
    email,
    password: "correct horse battery",
    phone: "0300 1234567",
    restaurant: `${name} ${counter}`,
    city: "Lahore",
    "cf-turnstile-response": "token",
  });
  const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const row = await db
    .prepare("SELECT r.id FROM restaurants r JOIN users u ON u.id = r.owner_user_id WHERE u.email = ?")
    .bind(email)
    .first<{ id: string }>();
  if (!cookie || !row) throw new Error("Test signup failed");
  return { cookie, restaurantId: row.id };
}

/** The permanent code that menu links and QR codes use. */
export async function codeOf(restaurantId: string): Promise<string> {
  const row = await db.prepare("SELECT menu_code FROM restaurants WHERE id = ?").bind(restaurantId).first<{ menu_code: string }>();
  return row?.menu_code ?? "";
}

// Admin area helpers (issues #34 and #36). Test values only.
export const ADMIN = "https://admin.tomatofry.com";

export function adminPost(path: string, form: Record<string, string>, cookie?: string, origin = ADMIN) {
  const headers = new Headers({
    "content-type": "application/x-www-form-urlencoded",
    origin,
    "cf-connecting-ip": nextIp(),
  });
  if (cookie) headers.set("cookie", cookie);
  return handleRequest(new Request(`${ADMIN}${path}`, { method: "POST", headers, body: new URLSearchParams(form) }), env);
}

export function adminGet(path: string, cookie?: string) {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  return handleRequest(new Request(`${ADMIN}${path}`, { headers }), env);
}

let adminCounter = 0;
/** Creates an admin account and returns its email and session cookie. */
export async function newAdminSession() {
  adminCounter++;
  const email = `helper-admin${adminCounter}@example.test`;
  const password = "admin helper password 1";
  const { createAdmin } = await import("../src/shared/admin-account");
  const { hashPassword } = await import("../src/shared/password");
  await createAdmin(db, { email, passwordHash: await hashPassword(password) });
  const response = await adminPost("/login", { email, password });
  const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  if (!cookie) throw new Error("Test admin login failed");
  const user = await db.prepare("SELECT id FROM users WHERE email = ?").bind(email).first<{ id: string }>();
  return { email, cookie, userId: user?.id ?? "" };
}
