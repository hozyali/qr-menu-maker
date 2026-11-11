import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { html } from "hono/html";
import { findAdminLogin, findAdminSession } from "../shared/accounts-db";
import { checkLogin, endSession, sessionToken, startSession, tooManyRequests } from "../shared/auth";
import { page } from "../shared/layout";
import { type AdminEnv, registerRestaurantRoutes } from "./restaurants";

// Master admin area on admin.tomatofry.com (issue #34). It never serves the static site files.
// There is no signup here: admin accounts are made only with scripts/create-admin.mjs (Law 19).
export const adminApp = new Hono<AdminEnv>();

// Admin sessions are shorter than owner sessions: 12 hours.
const SESSION_SECONDS = 12 * 60 * 60;

// Form posts must come from this same site (Law 19).
adminApp.use("*", csrf({ origin: (origin, c) => origin === new URL(c.req.url).origin }));

// The shared stylesheet and logo, under fixed names only.
adminApp.get("/app.css", (c) => c.env.ASSETS.fetch(new URL("/app/app.css", c.req.url)));
adminApp.get("/logo.svg", (c) => c.env.ASSETS.fetch(new URL("/logo.svg", c.req.url)));

function loginPage(email = "", message = "") {
  return page(
    "Admin log in",
    html`<h1>Admin log in</h1>
<form class="card form" method="post" action="/login" novalidate>
${message ? html`<p class="error" role="alert">${message}</p>` : ""}
<div class="field"><label for="email">Email</label><input id="email" name="email" type="email" value="${email}" maxlength="254" autocomplete="username" required></div>
<div class="field"><label for="password">Password</label><input id="password" name="password" type="password" maxlength="128" autocomplete="current-password" required></div>
<button class="button" type="submit">Log in</button>
</form>`,
  );
}

adminApp.get("/login", (c) => c.html(loginPage()));

adminApp.post("/login", async (c) => {
  if (await tooManyRequests(c)) {
    return c.html(loginPage("", "Too many attempts. Please wait a minute."), 429);
  }
  // Only admin accounts can log in here, with their own failed-login count.
  const result = await checkLogin(c.env.DB, await c.req.formData(), findAdminLogin, "admin-login");
  if (!result.ok) return c.html(loginPage(result.email, result.message), result.status);
  await startSession(c, c.env.DB, result.userId, SESSION_SECONDS);
  return c.redirect("/", 303);
});

adminApp.post("/logout", async (c) => {
  await endSession(c, c.env.DB);
  return c.redirect("/login", 303);
});

// Every route below needs an admin session. The role is checked on the server on every request (Law 18).
adminApp.use("*", async (c, next) => {
  const token = sessionToken(c);
  const admin = token ? await findAdminSession(c.env.DB, token, Date.now()) : null;
  if (!admin) return c.redirect("/login", 303);
  c.set("admin", admin);
  await next();
});

// The restaurant list, detail pages, plan changes, and suspension (issue #36).
registerRestaurantRoutes(adminApp);
