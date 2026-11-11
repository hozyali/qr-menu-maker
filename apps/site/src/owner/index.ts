import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { csrf } from "hono/csrf";
import { html, raw } from "hono/html";
import {
  clearLoginFailures,
  createOwner,
  createSession,
  deleteSession,
  findOwnerLogin,
  findOwnerSession,
  isLoginLocked,
  recordLoginFailure,
  slugExists,
} from "../shared/accounts-db";
import { page } from "../shared/layout";
import { serveMedia } from "../shared/media";
import { registerMenuRoutes, type OwnerEnv } from "./menu";
import { registerProfileRoutes } from "./profile";
import { registerQrRoutes } from "./qr";
import { registerThemeRoutes } from "./theme";
import { getDummyHash, hashPassword, verifyPassword } from "../shared/password";
import { verifyTurnstile } from "../shared/turnstile";
import { type FieldErrors, normalizeEmail, readText, slugify, validateSignup } from "../shared/validation";

// Owner area on app.tomatofry.com. It never serves the static site files.
export const ownerApp = new Hono<OwnerEnv>();

const SESSION_COOKIE = "session"; // Sent as "__Host-session" because of the "host" prefix.
const SESSION_DAYS = 7;
const GENERIC_LOGIN_ERROR = "Email or password is wrong.";
const GENERIC_SIGNUP_ERROR = "We could not create this account. If you already have one, log in instead.";

// Form posts must come from this same site (Law 19).
ownerApp.use("*", csrf({ origin: (origin, c) => origin === new URL(c.req.url).origin }));

// The shared stylesheet and logo live with the static files, under fixed names only.
ownerApp.get("/app.css", (c) => c.env.ASSETS.fetch(new URL("/app/app.css", c.req.url)));
ownerApp.get("/logo.svg", (c) => c.env.ASSETS.fetch(new URL("/logo.svg", c.req.url)));
ownerApp.get("/photo.js", (c) => c.env.ASSETS.fetch(new URL("/app/photo.js", c.req.url)));
ownerApp.get("/print.js", (c) => c.env.ASSETS.fetch(new URL("/app/print.js", c.req.url)));
// Dish photos on the same hostname, so the dashboard needs no extra image source in its CSP.
ownerApp.get("/media/*", (c) => serveMedia(c.env.MEDIA, c.req.path));

// A rough per-address limit on account forms. The database lockout below is the strict one.
async function tooManyRequests(c: { env: Env; req: { raw: Request; path: string } }): Promise<boolean> {
  const ip = c.req.raw.headers.get("cf-connecting-ip") ?? "unknown";
  const { success } = await c.env.AUTH_LIMITER.limit({ key: `${ip}:${c.req.path}` });
  return !success;
}

async function startSession(c: Parameters<typeof setCookie>[0], db: D1Database, userId: string) {
  const token = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  await createSession(db, userId, token, Date.now() + maxAge * 1000);
  // No Domain attribute, so only this exact hostname receives the cookie (Law 19).
  setCookie(c, SESSION_COOKIE, token, { prefix: "host", path: "/", secure: true, httpOnly: true, sameSite: "Lax", maxAge });
}

function fieldBlock(name: string, label: string, type: string, value: string, errors: FieldErrors, extra = "", hint = "") {
  const error = errors[name];
  const describedBy = [hint ? `${name}-hint` : "", error ? `${name}-error` : ""].filter(Boolean).join(" ");
  return html`<div class="field">
<label for="${name}">${label}</label>
<input id="${name}" name="${name}" type="${type}" value="${value}" required ${raw(extra)}${describedBy ? html` aria-describedby="${describedBy}"` : ""}${error ? html` aria-invalid="true"` : ""}>
${hint ? html`<p class="hint" id="${name}-hint">${hint}</p>` : ""}
${error ? html`<p class="field-error" id="${name}-error">${error}</p>` : ""}
</div>`;
}

function signupPage(siteKey: string | undefined, values: Partial<Record<string, string>> = {}, errors: FieldErrors = {}, message = "") {
  if (!siteKey) {
    return page("Sign up", html`<h1>Signup opens soon</h1><p class="lead">Signup is not available yet.</p>`);
  }
  return page(
    "Sign up",
    html`<h1>Create your restaurant</h1>
<p class="lead">Put your menu online in a few minutes.</p>
<form class="card form" method="post" action="/signup" novalidate>
${message ? html`<p class="error" role="alert">${message}</p>` : ""}
${fieldBlock("restaurant", "Restaurant name", "text", values.restaurant ?? "", errors, "maxlength=60 autocomplete=organization")}
${fieldBlock("city", "City", "text", values.city ?? "", errors, "maxlength=40", "Your menu link uses the restaurant name and city. It never changes.")}
${fieldBlock("email", "Email", "email", values.email ?? "", errors, "maxlength=254 autocomplete=email")}
${fieldBlock("phone", "Phone", "tel", values.phone ?? "", errors, "maxlength=20 autocomplete=tel")}
${fieldBlock("password", "Password", "password", "", errors, "minlength=10 maxlength=128 autocomplete=new-password", "At least 10 characters.")}
<div class="cf-turnstile" data-sitekey="${siteKey}" data-action="signup"></div>
<button class="button" type="submit">Create account</button>
</form>
<p class="switch">Already have an account? <a href="/login">Log in</a></p>`,
    html`<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>`,
  );
}

function loginPage(email = "", message = "") {
  return page(
    "Log in",
    html`<h1>Log in</h1>
<form class="card form" method="post" action="/login" novalidate>
${message ? html`<p class="error" role="alert">${message}</p>` : ""}
${fieldBlock("email", "Email", "email", email, {}, "maxlength=254 autocomplete=email")}
${fieldBlock("password", "Password", "password", "", {}, "maxlength=128 autocomplete=current-password")}
<button class="button" type="submit">Log in</button>
</form>
<p class="switch">New to TomatoFry? <a href="/signup">Create an account</a></p>`,
  );
}

ownerApp.get("/signup", (c) => c.html(signupPage(c.env.TURNSTILE_SITE_KEY)));

ownerApp.post("/signup", async (c) => {
  if (await tooManyRequests(c)) {
    return c.html(signupPage(c.env.TURNSTILE_SITE_KEY, {}, {}, "Too many attempts. Please wait a minute."), 429);
  }
  if (!c.env.TURNSTILE_SITE_KEY || !c.env.TURNSTILE_SECRET_KEY || !c.env.TURNSTILE_HOSTNAME) {
    return c.html(signupPage(undefined), 503);
  }
  const form = await c.req.formData();
  const values = {
    email: normalizeEmail(readText(form, "email")),
    password: typeof form.get("password") === "string" ? String(form.get("password")) : "",
    phone: readText(form, "phone"),
    restaurant: readText(form, "restaurant"),
    city: readText(form, "city"),
  };
  const shown = { email: values.email, phone: values.phone, restaurant: values.restaurant, city: values.city };

  const errors = validateSignup(values);
  if (Object.keys(errors).length > 0) {
    return c.html(signupPage(c.env.TURNSTILE_SITE_KEY, shown, errors, "Please fix the fields below."), 400);
  }
  const human = await verifyTurnstile(
    c.env.TURNSTILE_SECRET_KEY,
    readText(form, "cf-turnstile-response"),
    c.req.header("cf-connecting-ip"),
    c.env.TURNSTILE_HOSTNAME,
  );
  if (!human) {
    return c.html(signupPage(c.env.TURNSTILE_SITE_KEY, shown, {}, "Please complete the check and try again."), 400);
  }

  // The link is permanent (Law 28). A taken link gets a number on the end.
  const base = `${slugify(values.restaurant)}-${slugify(values.city)}`;
  let slug = base;
  for (let n = 2; (await slugExists(c.env.DB, slug)) && n < 100; n++) {
    slug = `${base}-${n}`;
  }

  let userId: string;
  try {
    ({ userId } = await createOwner(c.env.DB, {
      email: values.email,
      passwordHash: await hashPassword(values.password),
      phone: values.phone,
      restaurantName: values.restaurant,
      city: values.city,
      slug,
    }));
  } catch {
    // The same message for a taken email and any other failure, so this form cannot be used
    // to find out who has an account.
    return c.html(signupPage(c.env.TURNSTILE_SITE_KEY, shown, {}, GENERIC_SIGNUP_ERROR), 400);
  }
  await startSession(c, c.env.DB, userId);
  return c.redirect("/", 303);
});

ownerApp.get("/login", (c) => c.html(loginPage()));

ownerApp.post("/login", async (c) => {
  if (await tooManyRequests(c)) {
    return c.html(loginPage("", "Too many attempts. Please wait a minute."), 429);
  }
  const form = await c.req.formData();
  const email = normalizeEmail(readText(form, "email"));
  const password = typeof form.get("password") === "string" ? String(form.get("password")) : "";
  const attemptKey = `login:${email}`;
  const now = Date.now();

  if (await isLoginLocked(c.env.DB, attemptKey, now)) {
    return c.html(loginPage(email, "Too many failed logins. Try again in 15 minutes."), 429);
  }
  const login = email.length <= 254 && password.length <= 128 ? await findOwnerLogin(c.env.DB, email) : null;
  // An unknown email still runs a hash, so both failures take about the same time.
  const valid = await verifyPassword(password, login?.passwordHash ?? (await getDummyHash()));
  if (!login || !valid) {
    await recordLoginFailure(c.env.DB, attemptKey, now);
    return c.html(loginPage(email, GENERIC_LOGIN_ERROR), 401);
  }
  await clearLoginFailures(c.env.DB, attemptKey);
  await startSession(c, c.env.DB, login.userId);
  return c.redirect("/", 303);
});

ownerApp.post("/logout", async (c) => {
  const token = getCookie(c, SESSION_COOKIE, "host");
  if (token) await deleteSession(c.env.DB, token);
  deleteCookie(c, SESSION_COOKIE, { prefix: "host", path: "/", secure: true });
  return c.redirect("/login", 303);
});

// Every route below needs a logged-in owner. The restaurant comes from the session only (Law 18).
ownerApp.use("*", async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE, "host");
  const owner = token ? await findOwnerSession(c.env.DB, token, Date.now()) : null;
  if (!owner) return c.redirect("/login", 303);
  c.set("owner", owner);
  await next();
});

// The menu dashboard and editing pages.
registerMenuRoutes(ownerApp);
// The menu theme editor.
registerThemeRoutes(ownerApp);
// The restaurant profile and logo.
registerProfileRoutes(ownerApp);
// The menu QR code, its PNG download, and the print card.
registerQrRoutes(ownerApp);
