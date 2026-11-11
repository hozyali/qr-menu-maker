import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { html, raw } from "hono/html";
import { createOwner, findOwnerLogin, findOwnerSession, menuCodeExists, slugExists } from "../shared/accounts-db";
import { checkLogin, endSession, sessionToken, startSession, tooManyRequests } from "../shared/auth";
import { newMenuCode } from "../shared/menu-link";
import { page } from "../shared/layout";
import { serveMedia } from "../shared/media";
import { registerMenuRoutes, type OwnerEnv } from "./menu";
import { registerProfileRoutes } from "./profile";
import { registerQrRoutes } from "./qr";
import { registerThemeRoutes } from "./theme";
import { hashPassword } from "../shared/password";
import { verifyTurnstile } from "../shared/turnstile";
import { type FieldErrors, normalizeEmail, readText, slugify, validateSignup } from "../shared/validation";

// Owner area on app.tomatofry.com. It never serves the static site files.
export const ownerApp = new Hono<OwnerEnv>();

// Owner sessions last 7 days. The shared login and session rules live in shared/auth.ts (issue #34).
const SESSION_SECONDS = 7 * 24 * 60 * 60;
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

  // The menu code is what links and QR codes use, and it never changes (Law 28).
  // A clash is very unlikely (31^6 codes), but a taken code is replaced before saving.
  let menuCode = newMenuCode();
  for (let tries = 0; (await menuCodeExists(c.env.DB, menuCode)) && tries < 5; tries++) {
    menuCode = newMenuCode();
  }

  // The old name-based slug column is still NOT NULL UNIQUE, so it is filled as before. Links no longer use it.
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
      menuCode,
    }));
  } catch {
    // The same message for a taken email and any other failure, so this form cannot be used
    // to find out who has an account.
    return c.html(signupPage(c.env.TURNSTILE_SITE_KEY, shown, {}, GENERIC_SIGNUP_ERROR), 400);
  }
  await startSession(c, c.env.DB, userId, SESSION_SECONDS);
  return c.redirect("/", 303);
});

ownerApp.get("/login", (c) => c.html(loginPage()));

ownerApp.post("/login", async (c) => {
  if (await tooManyRequests(c)) {
    return c.html(loginPage("", "Too many attempts. Please wait a minute."), 429);
  }
  // Only owners with a restaurant can log in here. Admin accounts are refused (issue #34).
  const result = await checkLogin(c.env.DB, await c.req.formData(), findOwnerLogin, "login");
  if (!result.ok) return c.html(loginPage(result.email, result.message), result.status);
  await startSession(c, c.env.DB, result.userId, SESSION_SECONDS);
  return c.redirect("/", 303);
});

ownerApp.post("/logout", async (c) => {
  await endSession(c, c.env.DB);
  return c.redirect("/login", 303);
});

// Every route below needs a logged-in owner. The restaurant comes from the session only (Law 18).
ownerApp.use("*", async (c, next) => {
  const token = sessionToken(c);
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
