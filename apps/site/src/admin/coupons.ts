import type { Context, Hono } from "hono";
import { html } from "hono/html";
import { findRestaurantRef } from "../shared/admin-db";
import { codeExists, type CouponRow, createCoupon, getCoupon, listCoupons, type NewCoupon, setCouponStatus } from "../shared/coupons-db";
import { page } from "../shared/layout";
import { endOfPakistanDay, pakistanDate } from "../shared/pakistan-date";
import { getPlan, listPlans } from "../shared/plans-db";
import { readText } from "../shared/validation";
import { adminHeader } from "./nav";
import type { AdminEnv } from "./restaurants";

// Admin coupon pages (issue #40). The admin session and role are checked before these routes run.

type AdminContext = Context<AdminEnv>;
type FormValues = Record<string, string>;

const COUPON_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FIELDS = ["code", "percent_off", "billing_period", "duration", "plan_id", "restaurant", "max_redemptions", "expires"] as const;

function notFound(c: AdminContext) {
  return c.html(page("Not found", html`<h1>Not found</h1><p class="lead">There is no such coupon. <a href="/coupons">Back to coupons</a></p>`), 404);
}

/** Reads and checks the coupon form on the server (Law 19). */
async function readCouponForm(c: AdminContext, form: FormData): Promise<{ coupon: NewCoupon } | { error: string }> {
  const v: FormValues = {};
  for (const key of FIELDS) v[key] = readText(form, key);
  const code = (v.code ?? "").toUpperCase();
  if (!/^[A-Z0-9-]{4,20}$/.test(code)) return { error: "Use a code of 4 to 20 letters, numbers, or dashes, like RAMZAN-50." };
  if (await codeExists(c.env.DB, code)) return { error: "That code already exists. Choose another." };
  if (!/^\d{1,3}$/.test(v.percent_off ?? "") || Number(v.percent_off) < 1 || Number(v.percent_off) > 100) {
    return { error: "Enter a discount from 1 to 100 percent, as a whole number." };
  }
  if (v.billing_period !== "monthly" && v.billing_period !== "yearly" && v.billing_period !== "any") return { error: "Choose the billing period." };
  if (v.duration !== "once" && v.duration !== "recurring") return { error: "Choose one time or recurring." };

  let planId: string | null = null;
  if (v.plan_id) {
    const plan = /^[0-9a-f]{32}$/.test(v.plan_id) ? await getPlan(c.env.DB, v.plan_id) : null;
    // Coupons discount a price, so they only make sense on a paid plan.
    if (!plan || plan.isFree) return { error: "Choose a paid plan, or any paid plan." };
    planId = plan.id;
  }
  let restaurantId: string | null = null;
  if (v.restaurant) {
    const restaurant = await findRestaurantRef(c.env.DB, v.restaurant);
    if (!restaurant) return { error: "No restaurant has that menu code or id." };
    restaurantId = restaurant.id;
  }
  let maxRedemptions: number | null = null;
  if (v.max_redemptions) {
    if (!/^\d{1,6}$/.test(v.max_redemptions) || Number(v.max_redemptions) < 1) return { error: "Enter a use limit of 1 or more, or leave it empty." };
    maxRedemptions = Number(v.max_redemptions);
  }
  let expiresAt: number | null = null;
  if (v.expires) {
    expiresAt = endOfPakistanDay(v.expires);
    if (expiresAt === null || expiresAt <= Date.now()) return { error: "Choose a real date, today or later, or leave it empty." };
  }
  return {
    coupon: {
      code,
      percentOff: Number(v.percent_off),
      billingPeriod: v.billing_period,
      duration: v.duration,
      planId,
      restaurantId,
      maxRedemptions,
      expiresAt,
      expiresLabel: expiresAt === null ? null : (v.expires ?? null),
    },
  };
}

function rulesLine(row: CouponRow): string {
  const period = row.billingPeriod === "any" ? "monthly or yearly" : row.billingPeriod;
  return `${row.duration === "recurring" ? "Every period" : "First period"}, ${period}, ${row.planName ?? "any paid plan"}`;
}

async function newCouponPage(c: AdminContext, values: FormValues, error = "") {
  const plans = (await listPlans(c.env.DB)).filter((p) => !p.isFree && p.status === "active");
  const pick = (name: string, value: string) => ((values[name] ?? "") === value ? html` checked` : "");
  return page(
    "New coupon",
    html`${adminHeader("New coupon", "coupons")}
<form class="card form" method="post" action="/coupons" novalidate>
${error ? html`<p class="error" role="alert">${error}</p>` : ""}
<div class="field"><label for="code">Code</label><input id="code" name="code" value="${values.code ?? ""}" maxlength="20" autocapitalize="characters" aria-describedby="code-hint" required>
<p class="hint" id="code-hint">4 to 20 letters, numbers, or dashes. Saved in capital letters.</p></div>
<div class="field"><label for="percent_off">Discount (%)</label><input id="percent_off" name="percent_off" value="${values.percent_off ?? ""}" inputmode="numeric" maxlength="3" required></div>
<fieldset class="choices"><legend>Billing period</legend>
<label class="choice"><input type="radio" name="billing_period" value="any"${pick("billing_period", "any")}> Monthly or yearly</label>
<label class="choice"><input type="radio" name="billing_period" value="monthly"${pick("billing_period", "monthly")}> Monthly only</label>
<label class="choice"><input type="radio" name="billing_period" value="yearly"${pick("billing_period", "yearly")}> Yearly only</label>
</fieldset>
<fieldset class="choices"><legend>How long</legend>
<label class="choice"><input type="radio" name="duration" value="once"${pick("duration", "once")}> First period only</label>
<label class="choice"><input type="radio" name="duration" value="recurring"${pick("duration", "recurring")}> Every period (recurring)</label>
</fieldset>
<div class="field"><label for="plan_id">Plan</label>
<select id="plan_id" name="plan_id"><option value="">Any paid plan</option>${plans.map(
      (p) => html`<option value="${p.id}"${values.plan_id === p.id ? html` selected` : ""}>${p.name}</option>`,
    )}</select></div>
<div class="field"><label for="restaurant">Only for one restaurant (optional)</label><input id="restaurant" name="restaurant" value="${values.restaurant ?? ""}" maxlength="36" aria-describedby="restaurant-hint">
<p class="hint" id="restaurant-hint">The restaurant's menu code, like k7x2p9, from its menu link. Leave empty for every restaurant.</p></div>
<div class="field"><label for="max_redemptions">Use limit (optional)</label><input id="max_redemptions" name="max_redemptions" value="${values.max_redemptions ?? ""}" inputmode="numeric" maxlength="6" aria-describedby="limit-hint">
<p class="hint" id="limit-hint">How many restaurants can use it. Each restaurant can use a coupon once.</p></div>
<div class="field"><label for="expires">Last day (optional)</label><input id="expires" name="expires" type="date" value="${values.expires ?? ""}" aria-describedby="expires-hint">
<p class="hint" id="expires-hint">The coupon works until 11:59 pm Pakistan time on this day.</p></div>
<button class="button" type="submit">Create coupon</button>
<a class="button secondary" href="/coupons">Cancel</a>
</form>`,
    "",
    "wide",
  );
}

export function registerCouponRoutes(app: Hono<AdminEnv>) {
  app.get("/coupons", async (c) => {
    const match = /^(\d{1,16})\.([0-9a-f-]{36})$/.exec(c.req.query("before") ?? "");
    const { rows, next } = await listCoupons(c.env.DB, match ? { createdAt: Number(match[1]), id: match[2] ?? "" } : null);
    return c.html(
      page(
        "Coupons",
        html`${adminHeader("Coupons", "coupons")}
<p class="lead">Percentage discounts for paid plans. Coupons can be turned off, never deleted. <a class="button small" href="/coupons/new">New coupon</a></p>
${rows.length === 0
    ? html`<div class="card empty"><h2>No coupons yet</h2><p>Create one to give a restaurant a discount on a paid plan.</p></div>`
    : html`<div class="card table-wrap"><table class="table">
<caption class="sr-only">Coupons, newest first</caption>
<thead><tr><th scope="col">Code</th><th scope="col">Discount</th><th scope="col">For</th><th scope="col">Uses</th><th scope="col">Last day</th><th scope="col">Status</th></tr></thead>
<tbody>${rows.map(
        (row) => html`<tr>
<td><strong>${row.code}</strong>${row.restaurantName ? html`<span class="meta">Only ${row.restaurantName}</span>` : ""}</td>
<td>${row.percentOff}%</td>
<td class="wrap">${rulesLine(row)}</td>
<td>${row.maxRedemptions === null ? `${row.redeemedCount}` : `${row.redeemedCount} of ${row.maxRedemptions}`}</td>
<td>${row.expiresAt === null ? "None" : pakistanDate(row.expiresAt)}</td>
<td><span class="badge ${row.status === "active" ? "ok" : "warn"}">${row.status === "active" ? "Active" : "Off"}</span>
<form method="post" action="/coupons/${row.id}/${row.status === "active" ? "disable" : "enable"}"><button class="button secondary small" type="submit">${row.status === "active" ? "Turn off" : "Turn on"}</button></form></td>
</tr>`,
      )}</tbody></table></div>`}
${next ? html`<p class="pager"><a class="button secondary small" href="/coupons?before=${next.createdAt}.${next.id}">Older coupons</a></p>` : ""}`,
        "",
        "wide",
      ),
    );
  });

  app.get("/coupons/new", async (c) => c.html(await newCouponPage(c, { billing_period: "any", duration: "once" })));

  app.post("/coupons", async (c) => {
    const form = await c.req.formData();
    const result = await readCouponForm(c, form);
    if ("error" in result) {
      const values: FormValues = {};
      for (const key of FIELDS) values[key] = readText(form, key);
      return c.html(await newCouponPage(c, values, result.error), 400);
    }
    try {
      await createCoupon(c.env.DB, c.get("admin").userId, result.coupon);
    } catch {
      // Another admin saved the same code a moment ago. The UNIQUE rule refused this one.
      return c.html(await newCouponPage(c, Object.fromEntries(FIELDS.map((k) => [k, readText(form, k)])), "That code already exists. Choose another."), 400);
    }
    return c.redirect("/coupons", 303);
  });

  for (const [path, status] of [["disable", "disabled"], ["enable", "active"]] as const) {
    app.post(`/coupons/:id/${path}`, async (c) => {
      const id = c.req.param("id");
      const coupon = COUPON_ID.test(id) ? await getCoupon(c.env.DB, id) : null;
      if (!coupon) return notFound(c);
      if (coupon.status !== status) await setCouponStatus(c.env.DB, c.get("admin").userId, coupon, status);
      return c.redirect("/coupons", 303);
    });
  }
}
