import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleRequest } from "../src/index";
import { createAdmin } from "../src/shared/admin-account";
import { hashPassword } from "../src/shared/password";
import { db, get, newOwner, passTurnstile, post } from "./helpers";

// Admin login on admin.tomatofry.com (issue #34). Test values only.
const ADMIN = "https://admin.tomatofry.com";
const PASSWORD = "admin test password 123";

beforeEach(() => passTurnstile());
afterEach(() => vi.restoreAllMocks());

let ip = 1;
function adminPost(path: string, form: Record<string, string>, cookie?: string, origin = ADMIN) {
  const headers = new Headers({
    "content-type": "application/x-www-form-urlencoded",
    origin,
    "cf-connecting-ip": `198.51.100.${ip++ % 250}`,
  });
  if (cookie) headers.set("cookie", cookie);
  return handleRequest(new Request(`${ADMIN}${path}`, { method: "POST", headers, body: new URLSearchParams(form) }), env);
}

function adminGet(path: string, cookie?: string) {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  return handleRequest(new Request(`${ADMIN}${path}`, { headers }), env);
}

let counter = 0;
async function newAdmin() {
  counter++;
  const email = `admin${counter}@example.test`;
  await createAdmin(db, { email, passwordHash: await hashPassword(PASSWORD) });
  return email;
}

async function adminCookie(email: string) {
  const response = await adminPost("/login", { email, password: PASSWORD });
  expect(response.status).toBe(303);
  return (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}

describe("admin login", () => {
  it("sends a visitor without a session to the login page", async () => {
    for (const path of ["/", "/restaurants", "/signup"]) {
      const response = await adminGet(path);
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/login");
    }
  });

  it("shows a login form with no signup link", async () => {
    const body = await (await adminGet("/login")).text();
    expect(body).toContain('action="/login"');
    expect(body).not.toContain("/signup");
  });

  it("logs an admin in with a host-only, 12-hour session cookie", async () => {
    const email = await newAdmin();
    const response = await adminPost("/login", { email, password: PASSWORD });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/");
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^__Host-session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toMatch(/Max-Age=43200/);
    expect(cookie).not.toMatch(/Domain=/i);

    const home = await adminGet("/", cookie.split(";")[0]);
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("TomatoFry admin");
  });

  it("gives the same answer for a wrong password and an unknown email", async () => {
    const email = await newAdmin();
    const wrong = await adminPost("/login", { email, password: "wrong password here" });
    const unknown = await adminPost("/login", { email: "nobody-admin@example.test", password: "wrong password here" });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await wrong.text()).toContain("Email or password is wrong.");
    expect(await unknown.text()).toContain("Email or password is wrong.");
  });

  it("never lets an owner account into the admin area", async () => {
    // Owner signup uses this password in the shared test helper.
    const owner = await newOwner("Admin Gate");
    const email = await db.prepare("SELECT u.email FROM users u JOIN restaurants r ON r.owner_user_id = u.id WHERE r.id = ?").bind(owner.restaurantId).first<{ email: string }>();
    expect((await adminPost("/login", { email: email?.email ?? "", password: "correct horse battery" })).status).toBe(401);
    // The owner's own session token does not open the admin area either.
    const response = await adminGet("/", owner.cookie);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/login");
  });

  it("never lets an admin account into the owner area", async () => {
    const email = await newAdmin();
    expect((await post("/login", { email, password: PASSWORD })).status).toBe(401);
    const cookie = await adminCookie(email);
    const response = await get("/", cookie);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/login");
  });

  it("checks the role on every request", async () => {
    const email = await newAdmin();
    const cookie = await adminCookie(email);
    expect((await adminGet("/", cookie)).status).toBe(200);
    await db.prepare("UPDATE users SET role = 'owner' WHERE email = ?").bind(email).run();
    expect((await adminGet("/", cookie)).status).toBe(303);
  });

  it("refuses an expired session", async () => {
    const email = await newAdmin();
    const cookie = await adminCookie(email);
    await db.prepare("UPDATE sessions SET expires_at = 1 WHERE user_id = (SELECT id FROM users WHERE email = ?)").bind(email).run();
    expect((await adminGet("/", cookie)).status).toBe(303);
  });

  it("locks an email for a while after five failed logins", async () => {
    const email = await newAdmin();
    for (let i = 0; i < 5; i++) await adminPost("/login", { email, password: "wrong password here" });
    const response = await adminPost("/login", { email, password: PASSWORD });
    expect(response.status).toBe(429);
  });

  it("logs out and ends the session", async () => {
    const email = await newAdmin();
    const cookie = await adminCookie(email);
    const response = await adminPost("/logout", {}, cookie);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/login");
    expect((await adminGet("/", cookie)).status).toBe(303);
  });

  it("refuses a login form posted from another site", async () => {
    const email = await newAdmin();
    expect((await adminPost("/login", { email, password: PASSWORD }, undefined, "https://evil.example")).status).toBe(403);
  });

  it("refuses to create a second account with the same email", async () => {
    const email = await newAdmin();
    await expect(createAdmin(db, { email: email.toUpperCase(), passwordHash: await hashPassword(PASSWORD) })).rejects.toThrow();
  });
});
