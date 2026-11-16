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
  setStatus,
  setSubscription,
} from "../shared/admin-db";
import { page } from "../shared/layout";
import { menuLink } from "../shared/menu-link";
import { formatMoney } from "../shared/money";
import { addBillingPeriod, endOfPakistanDay, pakistanDate } from "../shared/pakistan-date";
import { getPlan, listPlans } from "../shared/plans-db";
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

// Since issue #39 the plan comes from the restaurant's subscription.
function planLabel(row: RestaurantRow): string {
  if (row.ended && row.endsAt !== null) return `${row.defaultPlanName} (${row.planName} ended ${pakistanDate(row.endsAt)})`;
  const period = row.billingPeriod === "none" ? "" : `, ${row.billingPeriod}`;
  return row.endsAt === null ? `${row.planName}${period}` : `${row.planName}${period}, until ${pakistanDate(row.endsAt)}`;
}

type PlanFormValues = { plan_id: string; period: string; end: string; end_date: string };

function statusBadge(status: string) {
  return html`<span class="badge ${status === "active" ? "ok" : "warn"}">${status === "active" ? "Active" : "Suspended"}</span>`;
}

function notFound(c: AdminContext) {
  return c.html(page("Not found", html`<h1>Not found</h1><p class="lead">There is no such restaurant. <a href="/">Back to the list</a></p>`), 404);
}

function describe(entry: HistoryEntry): string {
  if (entry.action === "subscription_changed" && entry.details) {
    try {
      type Side = { plan?: string; period?: string; ends?: string | null };
      const d = JSON.parse(entry.details) as { from?: Side; to?: Side };
      const side = (x?: Side) => `${x?.plan ?? "?"}${x?.period && x.period !== "none" ? ` ${x.period}` : ""}${x?.ends ? ` until ${x.ends}` : ""}`;
      return `Plan: ${side(d.from)} to ${side(d.to)}`;
    } catch {
      return entry.action;
    }
  }
  // Entries written before issue #39 used "plan_changed".
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

async function detailPage(c: AdminContext, id: string, error = "", values?: PlanFormValues) {
  const now = Date.now();
  const restaurant = await getRestaurant(c.env.DB, id, now);
  if (!restaurant) return null;
  const history = await restaurantHistory(c.env.DB, id);
  const link = menuLink(restaurant.menuCode, restaurant.name, restaurant.city);
  // Archived plans are not offered, except the restaurant's current plan so the form shows it.
  const plans = (await listPlans(c.env.DB)).filter((p) => p.status === "active" || p.id === restaurant.planId);
  const form: PlanFormValues = values ?? {
    plan_id: restaurant.ended ? "" : (restaurant.planId ?? ""),
    period: restaurant.billingPeriod,
    end: restaurant.endsAt === null || restaurant.ended ? "none" : "date",
    end_date: restaurant.endsAt === null || restaurant.ended ? "" : pakistanDate(restaurant.endsAt),
  };
  const checked = (on: boolean) => (on ? html` checked` : "");
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
<p class="meta">Now: ${planLabel(restaurant)}${restaurant.priceMinor > 0 ? `, ${formatMoney(restaurant.priceMinor)} a period` : ""}</p>
<form class="form" method="post" action="/restaurants/${restaurant.id}/plan" novalidate>
<div class="field"><label for="plan_id">Plan</label>
<select id="plan_id" name="plan_id">${plans.map(
      (p) => html`<option value="${p.id}"${p.id === form.plan_id ? html` selected` : ""}>${p.name}${p.isFree ? " (free)" : ""}${p.status === "archived" ? " (archived)" : ""}</option>`,
    )}</select></div>
<fieldset class="choices"><legend>Billing period</legend>
<label class="choice"><input type="radio" name="period" value="monthly"${checked(form.period === "monthly")}> Monthly</label>
<label class="choice"><input type="radio" name="period" value="yearly"${checked(form.period === "yearly")}> Yearly</label>
<label class="choice"><input type="radio" name="period" value="none"${checked(form.period === "none")}> None</label>
</fieldset>
<fieldset class="choices"><legend>Ends</legend>
<label class="choice"><input type="radio" name="end" value="period"${checked(form.end === "period")}> After one billing period</label>
<label class="choice"><input type="radio" name="end" value="date"${checked(form.end === "date")}> On a date</label>
<label class="choice"><input type="radio" name="end" value="none"${checked(form.end === "none")}> No end</label>
</fieldset>
<div class="field"><label for="end_date">Last day</label>
<input id="end_date" name="end_date" type="date" value="${form.end_date}" aria-describedby="end-hint">
<p class="hint" id="end-hint">Used with "On a date". The plan ends at 11:59 pm Pakistan time on this day. A free plan has no period and no end. When a plan ends, the restaurant moves to the signup plan, and the menu and QR code keep working.</p></div>
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
    const body = await c.req.formData();
    const values: PlanFormValues = {
      plan_id: readText(body, "plan_id"),
      period: readText(body, "period"),
      end: readText(body, "end"),
      end_date: readText(body, "end_date"),
    };
    const fail = async (message: string) => c.html((await detailPage(c, id, message, values)) ?? "", 400);

    // Checked on the server (Law 19). The plan must exist and be on offer, unless it is the current one.
    const plan = /^[0-9a-f]{32}$/.test(values.plan_id) ? await getPlan(c.env.DB, values.plan_id) : null;
    if (!plan) return fail("Choose a plan.");
    if (plan.status === "archived" && plan.id !== restaurant.planId) return fail("That plan is archived. Restore it first.");
    if (!["monthly", "yearly", "none"].includes(values.period)) return fail("Choose a billing period.");
    if (!["period", "date", "none"].includes(values.end)) return fail("Choose when the plan ends.");

    let period = values.period as "monthly" | "yearly" | "none";
    let endsAt: number | null = null;
    let endsLabel: string | null = null;
    if (plan.isFree) {
      // A free plan never has a billing period, an end, or a price.
      period = "none";
    } else {
      if (period === "none") return fail("A paid plan needs a monthly or yearly billing period.");
      if (values.end === "period") {
        endsLabel = addBillingPeriod(pakistanDate(Date.now()), period);
      } else if (values.end === "date") {
        if (endOfPakistanDay(values.end_date) === null) return fail("Enter a real date.");
        endsLabel = values.end_date;
      }
      if (endsLabel !== null) {
        endsAt = endOfPakistanDay(endsLabel);
        if (endsAt === null || endsAt <= Date.now()) return fail("Choose today or a later day.");
      }
    }
    // The price for this period is copied, so later price changes do not affect it.
    const price = period === "monthly" ? plan.monthlyPriceMinor : period === "yearly" ? plan.yearlyPriceMinor : null;
    await setSubscription(
      c.env.DB,
      c.get("admin").userId,
      restaurant,
      { planId: plan.id, planName: plan.name, period, endsAt, endsLabel, priceMinor: price ?? 0 },
      restaurant.endsAt === null ? null : pakistanDate(restaurant.endsAt),
    );
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
