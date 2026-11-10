import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleRequest } from "../src/index";

const APP = "https://app.tomatofry.com";
const db = env.DB;

// Each request gets its own address unless a test sets one, so rate limits do not leak between tests.
let ipCounter = 1;
const nextIp = () => `198.51.100.${ipCounter++ % 250}`;

type FormValues = Record<string, string>;

function post(path: string, form: FormValues, options: { cookie?: string; origin?: string; ip?: string } = {}) {
  const headers = new Headers({
    "content-type": "application/x-www-form-urlencoded",
    origin: options.origin ?? APP,
    "cf-connecting-ip": options.ip ?? nextIp(),
  });
  if (options.cookie) headers.set("cookie", options.cookie);
  return handleRequest(
    new Request(`${APP}${path}`, { method: "POST", headers, body: new URLSearchParams(form) }),
    env,
  );
}

function get(path: string, cookie?: string) {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  return handleRequest(new Request(`${APP}${path}`, { headers }), env);
}

/** Turns a Set-Cookie header into the value a browser would send back. */
function sessionCookie(response: Response): string {
  const header = response.headers.get("set-cookie") ?? "";
  return header.split(";")[0] ?? "";
}

let counter = 0;
function signupForm(overrides: FormValues = {}): FormValues {
  counter++;
  return {
    email: `owner${counter}@example.test`,
    password: "correct horse battery",
    phone: "0300 1234567",
    restaurant: `Test Kitchen ${counter}`,
    city: "Lahore",
    "cf-turnstile-response": "token",
    ...overrides,
  };
}

async function signUp(overrides: FormValues = {}) {
  const form = signupForm(overrides);
  const response = await post("/signup", form);
  return { form, response, cookie: sessionCookie(response) };
}

// The Turnstile service is outside our system, so its answer is replaced in tests.
let turnstilePasses = true;
beforeEach(() => {
  turnstilePasses = true;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://challenges.cloudflare.com/turnstile/v0/siteverify")) {
      return Response.json(
        turnstilePasses ? { success: true, hostname: "app.tomatofry.com" } : { success: false, "error-codes": ["invalid-input-response"] },
      );
    }
    throw new Error(`Unexpected request in a test: ${url}`);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("signup", () => {
  it("creates the owner and restaurant and logs them in", async () => {
    const { form, response, cookie } = await signUp({ restaurant: "Bismillah Karahi", city: "Lahore" });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/");
    expect(cookie).toMatch(/^__Host-session=.+/);

    const row = await db
      .prepare(
        "SELECT u.password_hash, r.slug, r.name FROM users u JOIN restaurants r ON r.owner_user_id = u.id WHERE u.email = ?",
      )
      .bind(form.email)
      .first<{ password_hash: string; slug: string; name: string }>();
    expect(row?.name).toBe("Bismillah Karahi");
    expect(row?.slug).toBe("bismillah-karahi-lahore");
    expect(row?.password_hash).toMatch(/^pbkdf2-sha256\$100000\$/);
    expect(row?.password_hash).not.toContain(form.password);
  });

  it("gives a second restaurant with the same name and city its own link", async () => {
    await signUp({ restaurant: "Cafe Nisar", city: "Karachi" });
    const second = await signUp({ restaurant: "Cafe Nisar", city: "Karachi" });
    expect(second.response.status).toBe(303);
    const { results } = await db
      .prepare("SELECT slug FROM restaurants WHERE slug LIKE 'cafe-nisar-karachi%' ORDER BY slug")
      .all<{ slug: string }>();
    expect(results.map((r) => r.slug)).toEqual(["cafe-nisar-karachi", "cafe-nisar-karachi-2"]);
  });

  it("sets a session cookie that only this exact hostname receives", async () => {
    const { response } = await signUp();
    const header = response.headers.get("set-cookie") ?? "";
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/Secure/i);
    expect(header).toMatch(/SameSite=Lax/i);
    expect(header).toMatch(/Path=\//);
    expect(header).not.toMatch(/Domain=/i);
  });

  it("stores only a hash of the session token", async () => {
    const { cookie } = await signUp();
    const token = decodeURIComponent(cookie.split("=")[1] ?? "");
    const plain = await db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?").bind(token).first<{ n: number }>();
    expect(plain?.n).toBe(0);
  });

  it("refuses signup when Turnstile fails", async () => {
    turnstilePasses = false;
    const { form, response } = await signUp();
    expect(response.status).toBe(400);
    const user = await db.prepare("SELECT id FROM users WHERE email = ?").bind(form.email).first();
    expect(user).toBeNull();
  });

  it("refuses a short password", async () => {
    const { form, response } = await signUp({ password: "short" });
    expect(response.status).toBe(400);
    expect(await db.prepare("SELECT id FROM users WHERE email = ?").bind(form.email).first()).toBeNull();
  });

  it("refuses an invalid email", async () => {
    const { response } = await signUp({ email: "not-an-email" });
    expect(response.status).toBe(400);
  });

  it("does not say whether an email is already registered", async () => {
    const first = await signUp();
    const again = await post("/signup", signupForm({ email: first.form.email ?? "" }));
    expect(again.status).toBe(400);
    expect(await again.text()).not.toMatch(/already registered|already exists|in use/i);
    const { results } = await db.prepare("SELECT id FROM users WHERE email = ?").bind(first.form.email).all();
    expect(results).toHaveLength(1);
  });

  it("rejects a form posted from another site", async () => {
    const response = await post("/signup", signupForm(), { origin: "https://evil.example" });
    expect(response.status).toBe(403);
  });

  it("escapes what the owner typed when showing it back", async () => {
    const response = await post("/signup", signupForm({ restaurant: "<script>alert(1)</script>", password: "short" }));
    const body = await response.text();
    expect(body).not.toContain("<script>alert(1)</script>");
    expect(body).toContain("&lt;script&gt;");
  });
});

describe("login and logout", () => {
  it("logs in with the right password", async () => {
    const { form } = await signUp();
    const response = await post("/login", { email: form.email ?? "", password: form.password ?? "" });
    expect(response.status).toBe(303);
    expect(sessionCookie(response)).toMatch(/^__Host-session=.+/);
  });

  it("gives the same answer for a wrong password and an unknown email", async () => {
    const { form } = await signUp();
    const wrong = await post("/login", { email: form.email ?? "", password: "wrong password here" });
    const unknown = await post("/login", { email: "nobody@example.test", password: "wrong password here" });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    const text = (body: string) => body.match(/<p class="error"[^>]*>([^<]*)</)?.[1];
    expect(text(await wrong.text())).toBe(text(await unknown.text()));
  });

  it("locks an email for a while after five failed logins", async () => {
    const { form } = await signUp();
    for (let i = 0; i < 5; i++) {
      await post("/login", { email: form.email ?? "", password: "wrong password here" });
    }
    const response = await post("/login", { email: form.email ?? "", password: form.password ?? "" });
    expect(response.status).toBe(429);
  });

  it("does not let an admin log in to the owner area", async () => {
    const { form } = await signUp();
    await db.prepare("UPDATE users SET role = 'admin' WHERE email = ?").bind(form.email).run();
    const response = await post("/login", { email: form.email ?? "", password: form.password ?? "" });
    expect(response.status).toBe(401);
  });

  it("logs out and ends the session", async () => {
    const { cookie } = await signUp();
    const response = await post("/logout", {}, { cookie });
    expect(response.status).toBe(303);
    expect(response.headers.get("set-cookie")).toMatch(/Max-Age=0/);
    const after = await get("/", cookie);
    expect(after.status).toBe(303);
    expect(after.headers.get("location")).toBe("/login");
  });
});

describe("owner page and tenant isolation", () => {
  it("sends a visitor without a session to the login page", async () => {
    const response = await get("/");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/login");
  });

  it("shows each owner only their own restaurant", async () => {
    const a = await signUp({ restaurant: "Owner A Grill" });
    const b = await signUp({ restaurant: "Owner B Tikka" });
    const pageA = await (await get("/", a.cookie)).text();
    const pageB = await (await get("/", b.cookie)).text();
    expect(pageA).toContain("Owner A Grill");
    expect(pageA).not.toContain("Owner B Tikka");
    expect(pageB).toContain("Owner B Tikka");
    expect(pageB).not.toContain("Owner A Grill");
  });

  it("rejects an expired session", async () => {
    const { cookie } = await signUp();
    await db.prepare("UPDATE sessions SET expires_at = 1").run();
    const response = await get("/", cookie);
    expect(response.status).toBe(303);
  });

  it("rejects a made-up session token", async () => {
    const response = await get("/", "__Host-session=made-up-token");
    expect(response.status).toBe(303);
  });
});
