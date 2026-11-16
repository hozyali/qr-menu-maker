import type { Context, Hono } from "hono";
import { html } from "hono/html";
import type { AdminSession } from "../shared/accounts-db";
import {
  type Cursor,
  getRestaurant,
  type HistoryEntry,
  listRestaurants,
  restaurantHistory,
  type RestaurantRow,
  setPlan,
  setStatus,
} from "../shared/admin-db";
import { page } from "../shared/layout";
import { menuLink } from "../shared/menu-link";
import { endOfPakistanDay, pakistanDate } from "../shared/pakistan-date";
import { readText } from "../shared/validation";
import { adminHeader } from "./nav";

// Master admin pages (issue #36). The admin session and role are checked before these routes run.

export type AdminEnv = { Bindings: Env; Variables: { admin: AdminSession } };
type AdminContext = Context<AdminEnv>;

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function parseCursor(value: string | undefined): Cursor | null {
  const match = value ? /^(\d{1,16})\.([0-9a-f-]{36})$/.exec(value) : null;
  return match ? { createdAt: Number(match[1]), id: match[2] ?? "" } : null;
}

function planLabel(row: RestaurantRow): string {
  if (row.plan === "pro") return row.planExpiresAt === null ? "Pro, no end date" : `Pro until ${pakistanDate(row.planExpiresAt)}`;
  if (row.storedPlan === "pro" && row.planExpiresAt !== null) return `Free (Pro ended ${pakistanDate(row.planExpiresAt)})`;
  return "Free";
}

function statusBadge(status: string) {
  return html`<span class="badge ${status === "active" ? "ok" : "warn"}">${status === "active" ? "Active" : "Suspended"}</span>`;
}

function notFound(c: AdminContext) {
  return c.html(page("Not found", html`<h1>Not found</h1><p class="lead">There is no such restaurant. <a href="/">Back to the list</a></p>`), 404);
}

function describe(entry: HistoryEntry): string {
  if (entry.action === "plan_changed" && entry.details) {
    try {
      const d = JSON.parse(entry.details) as { from?: { plan?: string; expires?: string | null }; to?: { plan?: string; expires?: string | null } };
      const side = (s?: { plan?: string; expires?: string | null }) => `${s?.plan === "pro" ? "Pro" : "Free"}${s?.expires ? ` until ${s.expires}` : ""}`;
      return `Plan: ${side(d.from)} to ${side(d.to)}`;
    } catch {
      return entry.action;
    }
  }
  return entry.action === "restaurant_suspended" ? "Suspended" : entry.action === "restaurant_reactivated" ? "Reactivated" : entry.action;
}

async function detailPage(c: AdminContext, id: string, error = "", values?: { plan: string; expires: string }) {
  const now = Date.now();
  const restaurant = await getRestaurant(c.env.DB, id, now);
  if (!restaurant) return null;
  const history = await restaurantHistory(c.env.DB, id);
  const link = menuLink(restaurant.menuCode, restaurant.name, restaurant.city);
  const plan = values?.plan ?? restaurant.storedPlan;
  const expires = values?.expires ?? (restaurant.storedPlan === "pro" && restaurant.planExpiresAt !== null ? pakistanDate(restaurant.planExpiresAt) : "");
  return page(
    restaurant.name,
    html`<p><a href="/">All restaurants</a></p>
<header class="top"><h1>${restaurant.name}</h1>${statusBadge(restaurant.status)}</header>
<div class="stats">
<div class="stat"><span class="meta">Plan</span><strong>${planLabel(restaurant)}</strong></div>
<div class="stat"><span class="meta">Dishes</span>
<strong>${restaurant.dishCount}</strong></div>
<div class="stat"><span class="meta">Menu link</span><a class="link" href="${link}" target="_blank" rel="noopener"><strong>${link.replace("https://", "")}</strong></a></div>
</div>
<section class="card">
<h2>Details</h2>
<dl class="details">
<dt>Owner email</dt><dd>${restaurant.email}</dd>
<dt>Phone</dt><dd>${restaurant.phone ?? "Not set"}</dd>
<dt>WhatsApp</dt><dd>${restaurant.whatsapp ?? "Not set"}</dd>
<dt>City</dt><dd>${restaurant.city ?? "Not set"}</dd>
<dt>Address</dt><dd>${restaurant.address ?? "Not set"}</dd>
<dt>Joined</dt><dd>${pakistanDate(restaurant.createdAt)}</dd>
</dl>
</section>
<section class="card form admin-section" aria-labelledby="plan-heading">
<h2 id="plan-heading">Plan</h2>
${error ? html`<p class="error" role="alert">${error}</p>` : ""}
<form class="form" method="post" action="/restaurants/${restaurant.id}/plan" novalidate>
<fieldset class="choices"><legend>Plan</legend>
<label class="choice"><input type="radio" name="plan" value="free"${plan === "free" ? html` checked` : ""}> Free</label>
<label class="choice"><input type="radio" name="plan" value="pro"${plan === "pro" ? html` checked` : ""}> Pro</label>
</fieldset>
<div class="field"><label for="expires">Last day of Pro</label>
<input id="expires" name="expires" type="date" value="${expires}" aria-describedby="expires-hint">
<p class="hint" id="expires-hint">Pro ends at 11:59 pm Pakistan time on this day. Leave it empty for no end date. Ignored for Free. The menu and QR code keep working when Pro ends.</p></div>
<button class="button" type="submit">Save plan</button>
</form>
</section>
<section class="card form admin-section" aria-labelledby="status-heading">
<h2 id="status-heading">Status</h2>
${restaurant.status === "active"
    ? html`<p>Suspending hides the menu from customers. The link and QR code stay the same and work again after reactivating.</p>
<a class="button danger" href="/restaurants/${restaurant.id}/suspend">Suspend restaurant</a>`
    : html`<p>This menu shows "currently unavailable" to customers.</p>
<form method="post" action="/restaurants/${restaurant.id}/reactivate"><button class="button" type="submit">Reactivate restaurant</button></form>`}
</section>
<section class="card admin-section" aria-labelledby="history-heading">
<h2 id="history-heading">Admin history</h2>
${history.length === 0
    ? html`<p class="empty">No admin changes yet.</p>`
    : html`<ul class="history">${history.map(
        (entry) => html`<li><strong>${describe(entry)}</strong><span class="meta">${pakistanDate(entry.createdAt)} by ${entry.actorEmail ?? "unknown"} (${entry.action})</span></li>`,
      )}</ul>`}
</section>`,
    "",
    "wide",
  );
}

export function registerRestaurantRoutes(app: Hono<AdminEnv>) {
  app.get("/", async (c) => {
    const { rows, next } = await listRestaurants(c.env.DB, parseCursor(c.req.query("before")), Date.now());
    return c.html(
      page(
        "Admin",
        html`${adminHeader("TomatoFry admin", "restaurants")}
<p class="lead">Logged in as ${c.get("admin").email}. Restaurants, newest first.</p>
${rows.length === 0
    ? html`<div class="card empty"><h2>No restaurants yet</h2><p>Restaurants appear here when owners sign up.</p></div>`
    : html`<div class="card table-wrap"><table class="table">
<caption class="sr-only">Restaurants, newest first</caption>
<thead><tr><th scope="col">Restaurant</th><th scope="col">Owner email</th><th scope="col">Plan</th><th scope="col">Status</th><th scope="col">Joined</th></tr></thead>
<tbody>${rows.map(
        (row) => html`<tr>
<td><a href="/restaurants/${row.id}"><strong>${row.name}</strong></a>${row.city ? html`<span class="meta">${row.city}</span>` : ""}</td>
<td class="wrap">${row.email}</td>
<td>${planLabel(row)}</td>
<td>${statusBadge(row.status)}</td>
<td>${pakistanDate(row.createdAt)}</td>
</tr>`,
      )}</tbody></table></div>`}
${next ? html`<p class="pager"><a class="button secondary small" href="/?before=${next.createdAt}.${next.id}">Older restaurants</a></p>` : ""}`,
        "",
        "wide",
      ),
    );
  });

  app.get("/restaurants/:id", async (c) => {
    const id = c.req.param("id");
    const body = ID.test(id) ? await detailPage(c, id) : null;
    return body ? c.html(body) : notFound(c);
  });

  app.post("/restaurants/:id/plan", async (c) => {
    const id = c.req.param("id");
    const restaurant = ID.test(id) ? await getRestaurant(c.env.DB, id, Date.now()) : null;
    if (!restaurant) return notFound(c);
    const form = await c.req.formData();
    const plan = readText(form, "plan");
    const expires = readText(form, "expires");
    const fail = async (message: string) => c.html((await detailPage(c, id, message, { plan, expires })) ?? "", 400);

    if (plan !== "free" && plan !== "pro") return fail("Choose Free or Pro.");
    let expiresAt: number | null = null;
    // Free never has an end date. Pro may have none, or a future day.
    if (plan === "pro" && expires) {
      expiresAt = endOfPakistanDay(expires);
      if (expiresAt === null) return fail("Enter a real date.");
      if (expiresAt <= Date.now()) return fail("Choose today or a later day.");
    }
    await setPlan(c.env.DB, c.get("admin").userId, restaurant, {
      plan,
      expiresAt,
      expiresLabel: expiresAt === null ? null : expires,
      fromLabel: restaurant.planExpiresAt === null ? null : pakistanDate(restaurant.planExpiresAt),
    });
    return c.redirect(`/restaurants/${id}`, 303);
  });

  // A confirmation page instead of a browser popup (Law 27).
  app.get("/restaurants/:id/suspend", async (c) => {
    const id = c.req.param("id");
    const restaurant = ID.test(id) ? await getRestaurant(c.env.DB, id, Date.now()) : null;
    if (!restaurant) return notFound(c);
    return c.html(
      page(
        "Suspend restaurant",
        html`<h1>Suspend ${restaurant.name}?</h1>
<div class="card form">
<p>Customers will see "This menu is currently unavailable". The owner can still log in. The link and QR code stay the same, and you can reactivate at any time.</p>
<form method="post" action="/restaurants/${restaurant.id}/suspend"><button class="button danger" type="submit">Yes, suspend</button></form>
<a class="button secondary" href="/restaurants/${restaurant.id}">Keep it active</a>
</div>`,
      ),
    );
  });

  for (const [path, status] of [["suspend", "suspended"], ["reactivate", "active"]] as const) {
    app.post(`/restaurants/:id/${path}`, async (c) => {
      const id = c.req.param("id");
      const restaurant = ID.test(id) ? await getRestaurant(c.env.DB, id, Date.now()) : null;
      if (!restaurant) return notFound(c);
      if (restaurant.status !== status) await setStatus(c.env.DB, c.get("admin").userId, id, status);
      return c.redirect(`/restaurants/${id}`, 303);
    });
  }
}
