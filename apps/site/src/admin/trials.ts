import type { Context, Hono } from "hono";
import { html } from "hono/html";
import { findRestaurantRef } from "../shared/admin-db";
import { page } from "../shared/layout";
import { endOfPakistanDay, pakistanDate } from "../shared/pakistan-date";
import { getPlan, listPlans } from "../shared/plans-db";
import { createTrialOffer, endTrialOffer, getTrialOffer, listTrialOffers } from "../shared/trials-db";
import { readText } from "../shared/validation";
import { adminHeader } from "./nav";
import type { AdminEnv } from "./restaurants";

// Admin free trial offers (issue #42). The admin session and role are checked before these routes run.

type AdminContext = Context<AdminEnv>;
type FormValues = { plan_id: string; days: string; target: string; restaurant: string; ends: string };

const OFFER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function notFound(c: AdminContext) {
  return c.html(page("Not found", html`<h1>Not found</h1><p class="lead">There is no such offer. <a href="/trials">Back to trials</a></p>`), 404);
}

async function newOfferPage(c: AdminContext, values: FormValues, error = "") {
  const plans = (await listPlans(c.env.DB)).filter((p) => !p.isFree && p.status === "active");
  const pick = (value: string) => (values.target === value ? html` checked` : "");
  return page(
    "New trial offer",
    html`${adminHeader("New trial offer", "trials")}
<form class="card form" method="post" action="/trials" novalidate>
${error ? html`<p class="error" role="alert">${error}</p>` : ""}
<div class="field"><label for="plan_id">Plan to try</label>
<select id="plan_id" name="plan_id">${plans.map((p) => html`<option value="${p.id}"${values.plan_id === p.id ? html` selected` : ""}>${p.name}</option>`)}</select></div>
<div class="field"><label for="days">Days</label><input id="days" name="days" value="${values.days}" inputmode="numeric" maxlength="2" aria-describedby="days-hint">
<p class="hint" id="days-hint">1 to 90, for example 15 or 30. The trial ends at 11:59 pm Pakistan time on its last day.</p></div>
<fieldset class="choices"><legend>Who can start it</legend>
<label class="choice"><input type="radio" name="target" value="all"${pick("all")}> All restaurants on a free plan</label>
<label class="choice"><input type="radio" name="target" value="restaurant"${pick("restaurant")}> One restaurant</label>
</fieldset>
<div class="field"><label for="restaurant">Restaurant (for "One restaurant")</label><input id="restaurant" name="restaurant" value="${values.restaurant}" maxlength="36" aria-describedby="restaurant-hint">
<p class="hint" id="restaurant-hint">The restaurant's menu code, like k7x2p9, from its menu link.</p></div>
<div class="field"><label for="ends">Last day to start (optional)</label><input id="ends" name="ends" type="date" value="${values.ends}" aria-describedby="ends-hint">
<p class="hint" id="ends-hint">After this day, no new trials can start. Trials already started keep running. Each restaurant can try a plan once.</p></div>
<button class="button" type="submit">Create offer</button>
<a class="button secondary" href="/trials">Cancel</a>
</form>`,
    "",
    "wide",
  );
}

export function registerTrialRoutes(app: Hono<AdminEnv>) {
  app.get("/trials", async (c) => {
    const match = /^(\d{1,16})\.([0-9a-f-]{36})$/.exec(c.req.query("before") ?? "");
    const { rows, next } = await listTrialOffers(c.env.DB, match ? { createdAt: Number(match[1]), id: match[2] ?? "" } : null);
    const now = Date.now();
    return c.html(
      page(
        "Trials",
        html`${adminHeader("Trials", "trials")}
<p class="lead">Free trials of a paid plan. When a trial ends without payment, the restaurant goes back to the free plan. <a class="button small" href="/trials/new">New offer</a></p>
${rows.length === 0
    ? html`<div class="card empty"><h2>No trial offers yet</h2><p>Offer a paid plan free for a few days to one restaurant or to all of them.</p></div>`
    : html`<div class="card table-wrap"><table class="table">
<caption class="sr-only">Trial offers, newest first</caption>
<thead><tr><th scope="col">Plan</th><th scope="col">Length</th><th scope="col">For</th><th scope="col">Started</th><th scope="col">Last day</th><th scope="col">Status</th></tr></thead>
<tbody>${rows.map((row) => {
        const open = row.status === "active" && (row.endsAt === null || row.endsAt > now);
        return html`<tr>
<td><strong>${row.planName}</strong></td>
<td>${row.days} days</td>
<td class="wrap">${row.targetType === "all" ? "All restaurants" : (row.restaurantName ?? "One restaurant")}</td>
<td>${row.started}</td>
<td>${row.endsAt === null ? "None" : pakistanDate(row.endsAt)}</td>
<td><span class="badge ${open ? "ok" : "warn"}">${open ? "Open" : "Ended"}</span>
${row.status === "active" ? html`<form method="post" action="/trials/${row.id}/end"><button class="button secondary small" type="submit">End offer</button></form>` : ""}</td>
</tr>`;
      })}</tbody></table></div>`}
${next ? html`<p class="pager"><a class="button secondary small" href="/trials?before=${next.createdAt}.${next.id}">Older offers</a></p>` : ""}`,
        "",
        "wide",
      ),
    );
  });

  app.get("/trials/new", async (c) => {
    const restaurant = c.req.query("restaurant") ?? "";
    // The restaurant page links here with its menu code, so the offer is ready for that restaurant.
    const values: FormValues = { plan_id: "", days: "30", target: restaurant ? "restaurant" : "all", restaurant: restaurant.slice(0, 36), ends: "" };
    return c.html(await newOfferPage(c, values));
  });

  app.post("/trials", async (c) => {
    const form = await c.req.formData();
    const values: FormValues = {
      plan_id: readText(form, "plan_id"),
      days: readText(form, "days"),
      target: readText(form, "target"),
      restaurant: readText(form, "restaurant"),
      ends: readText(form, "ends"),
    };
    const fail = async (message: string) => c.html(await newOfferPage(c, values, message), 400);
    // Checked on the server (Law 19).
    const plan = /^[0-9a-f]{32}$/.test(values.plan_id) ? await getPlan(c.env.DB, values.plan_id) : null;
    if (!plan || plan.isFree || plan.status !== "active") return fail("Choose an active paid plan.");
    if (!/^\d{1,2}$/.test(values.days) || Number(values.days) < 1 || Number(values.days) > 90) return fail("Enter 1 to 90 days.");
    if (values.target !== "all" && values.target !== "restaurant") return fail("Choose who can start it.");
    let restaurantId: string | null = null;
    if (values.target === "restaurant") {
      const restaurant = values.restaurant ? await findRestaurantRef(c.env.DB, values.restaurant) : null;
      if (!restaurant) return fail("No restaurant has that menu code or id.");
      restaurantId = restaurant.id;
    }
    let endsAt: number | null = null;
    if (values.ends) {
      endsAt = endOfPakistanDay(values.ends);
      if (endsAt === null || endsAt <= Date.now()) return fail("Choose a real last day, today or later, or leave it empty.");
    }
    await createTrialOffer(c.env.DB, c.get("admin").userId, {
      planId: plan.id,
      days: Number(values.days),
      restaurantId,
      endsAt,
      endsLabel: endsAt === null ? null : values.ends,
    });
    return c.redirect("/trials", 303);
  });

  app.post("/trials/:id/end", async (c) => {
    const id = c.req.param("id");
    const offer = OFFER_ID.test(id) ? await getTrialOffer(c.env.DB, id) : null;
    if (!offer) return notFound(c);
    if (offer.status === "active") await endTrialOffer(c.env.DB, c.get("admin").userId, offer);
    return c.redirect("/trials", 303);
  });
}
