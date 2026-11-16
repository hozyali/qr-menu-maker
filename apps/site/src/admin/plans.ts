import type { Context, Hono } from "hono";
import { html } from "hono/html";
import { page } from "../shared/layout";
import { formatMoney } from "../shared/money";
import { FEATURES, type LimitKey, type SwitchKey } from "../shared/plans";
import { createPlan, getPlan, listPlans, type PlanDetail, type PlanInput, setPlanStatus, updatePlan } from "../shared/plans-db";
import { readText } from "../shared/validation";
import { adminHeader } from "./nav";
import type { AdminEnv } from "./restaurants";

// Admin plan editor (issue #38). The admin session and role are checked before these routes run.

type AdminContext = Context<AdminEnv>;
type FormValues = Record<string, string>;

const PLAN_ID = /^[0-9a-f]{32}$/;
const MAX_RUPEES = 9_999_999;

function notFound(c: AdminContext) {
  return c.html(page("Not found", html`<h1>Not found</h1><p class="lead">There is no such plan. <a href="/plans">Back to plans</a></p>`), 404);
}

/** Rupees as typed ("1,500") to paisa. Empty means not set. */
function readPrice(value: string): number | null | "invalid" {
  const cleaned = value.replace(/[,\s]/g, "");
  if (!cleaned) return null;
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(cleaned) || Number(cleaned) <= 0 || Number(cleaned) > MAX_RUPEES) return "invalid";
  return Math.round(Number(cleaned) * 100);
}

/** Reads and checks the plan form on the server (Law 19). Returns the input or an error message. */
function readPlanForm(form: FormData): { input: PlanInput; values: FormValues } | { error: string; values: FormValues } {
  const values: FormValues = {};
  for (const key of ["name", "kind", "monthly", "yearly", "max_items", "max_items_unlimited"]) values[key] = readText(form, key);
  for (const feature of FEATURES) if (feature.type === "switch") values[feature.key] = readText(form, feature.key);

  if (values.name!.length < 2 || values.name!.length > 40) return { error: "Use a plan name of 2 to 40 characters.", values };
  if (values.kind !== "free" && values.kind !== "paid") return { error: "Choose Free or Paid.", values };
  const isFree = values.kind === "free";
  let monthly: number | null = null;
  let yearly: number | null = null;
  if (!isFree) {
    const m = readPrice(values.monthly!);
    const y = readPrice(values.yearly!);
    if (m === "invalid" || y === "invalid") return { error: "Prices must be numbers in rupees, like 1500 or 15,000.", values };
    // Both prices or neither. A paid plan without prices is saved but not offered for sale.
    if ((m === null) !== (y === null)) return { error: "Enter both the monthly and the yearly price, or neither.", values };
    monthly = m;
    yearly = y;
  }

  const switches = {} as Record<SwitchKey, boolean>;
  const limits = {} as Record<LimitKey, number | null>;
  for (const feature of FEATURES) {
    if (feature.type === "switch") {
      switches[feature.key] = values[feature.key] === "on";
    } else if (values[`${feature.key}_unlimited`] === "on") {
      limits[feature.key] = null;
    } else {
      const raw = values[feature.key] ?? "";
      if (!/^\d{1,6}$/.test(raw)) return { error: `${feature.label}: enter a whole number of 0 or more, or tick Unlimited.`, values };
      limits[feature.key] = Number(raw);
    }
  }
  return { input: { name: values.name!, isFree, monthlyPriceMinor: monthly, yearlyPriceMinor: yearly, switches, limits }, values };
}

function inputFromPlan(plan: PlanDetail): PlanInput {
  const switches = {} as Record<SwitchKey, boolean>;
  const limits = {} as Record<LimitKey, number | null>;
  for (const feature of FEATURES) {
    if (feature.type === "switch") switches[feature.key] = plan.entitlements.switches[feature.key] === true;
    else {
      const value = plan.entitlements.limits[feature.key];
      limits[feature.key] = value === undefined ? 0 : value;
    }
  }
  return { name: plan.name, isFree: plan.isFree, monthlyPriceMinor: plan.monthlyPriceMinor, yearlyPriceMinor: plan.yearlyPriceMinor, switches, limits };
}

const rupees = (minor: number | null) => (minor === null ? "" : String(minor / 100));

function valuesFromInput(input: PlanInput): FormValues {
  const values: FormValues = {
    name: input.name,
    kind: input.isFree ? "free" : "paid",
    monthly: rupees(input.monthlyPriceMinor),
    yearly: rupees(input.yearlyPriceMinor),
  };
  for (const feature of FEATURES) {
    if (feature.type === "switch") values[feature.key] = input.switches[feature.key] ? "on" : "";
    else {
      const limit = input.limits[feature.key];
      values[feature.key] = limit === null ? "" : String(limit);
      values[`${feature.key}_unlimited`] = limit === null ? "on" : "";
    }
  }
  return values;
}

function priceLine(plan: { isFree: boolean; monthlyPriceMinor: number | null; yearlyPriceMinor: number | null }) {
  if (plan.isFree) return "Free";
  if (plan.monthlyPriceMinor === null || plan.yearlyPriceMinor === null) return "Paid, prices not set (not for sale)";
  return `${formatMoney(plan.monthlyPriceMinor)} a month, ${formatMoney(plan.yearlyPriceMinor)} a year`;
}

/** How much the yearly price saves against 12 monthly payments, as a whole percent. */
function yearlySaving(monthly: number | null, yearly: number | null): string {
  if (monthly === null || yearly === null || monthly * 12 <= yearly) return "";
  return `Yearly saves ${Math.round(((monthly * 12 - yearly) / (monthly * 12)) * 100)}% compared with 12 monthly payments.`;
}

function planForm(action: string, values: FormValues, restaurantCount: number | null, error = "") {
  const checked = (on: boolean) => (on ? html` checked` : "");
  const monthlyMinor = readPrice(values.monthly ?? "");
  const yearlyMinor = readPrice(values.yearly ?? "");
  const saving = typeof monthlyMinor === "number" && typeof yearlyMinor === "number" ? yearlySaving(monthlyMinor, yearlyMinor) : "";
  return html`<form class="card form plan-form" method="post" action="${action}" novalidate>
${error ? html`<p class="error" role="alert">${error}</p>` : ""}
${restaurantCount
    ? html`<p class="warning" role="status">This plan has ${restaurantCount} ${restaurantCount === 1 ? "restaurant" : "restaurants"}. Changes to features and limits apply to them right away. Price changes apply to new subscriptions only.</p>`
    : ""}
<div class="field"><label for="name">Plan name</label><input id="name" name="name" value="${values.name ?? ""}" maxlength="40" required></div>
<fieldset class="choices"><legend>Type</legend>
<label class="choice"><input type="radio" name="kind" value="free"${checked(values.kind === "free")}> Free</label>
<label class="choice"><input type="radio" name="kind" value="paid"${checked(values.kind !== "free")}> Paid</label>
</fieldset>
<div class="price-row">
<div class="field"><label for="monthly">Monthly price (Rs)</label><input id="monthly" name="monthly" value="${values.monthly ?? ""}" inputmode="decimal" maxlength="12"></div>
<div class="field"><label for="yearly">Yearly price (Rs)</label><input id="yearly" name="yearly" value="${values.yearly ?? ""}" inputmode="decimal" maxlength="12"></div>
</div>
<p class="hint">Prices are used for paid plans only. Leave both empty to keep a paid plan off sale.${saving ? ` ${saving}` : ""}</p>
<fieldset class="features"><legend>Features</legend>
${FEATURES.map((feature) =>
  feature.type === "switch"
    ? html`<label class="feature-toggle">
<input type="checkbox" name="${feature.key}"${checked(values[feature.key] === "on")}>
<span class="feature-text"><strong>${feature.label}</strong><span class="meta">${feature.description}</span></span>
</label>`
    : html`<div class="feature-toggle feature-limit">
<span class="feature-text"><label for="${feature.key}"><strong>${feature.label}</strong></label><span class="meta" id="${feature.key}-hint">${feature.description}</span></span>
<span class="limit-inputs">
<input id="${feature.key}" name="${feature.key}" value="${values[feature.key] ?? ""}" inputmode="numeric" maxlength="6" aria-describedby="${feature.key}-hint">
<label class="choice small"><input type="checkbox" name="${feature.key}_unlimited"${checked(values[`${feature.key}_unlimited`] === "on")}> Unlimited</label>
</span>
</div>`,
)}
</fieldset>
<button class="button" type="submit">Save plan</button>
<a class="button secondary" href="/plans">Cancel</a>
</form>`;
}

export function registerPlanRoutes(app: Hono<AdminEnv>) {
  app.get("/plans", async (c) => {
    const plans = await listPlans(c.env.DB);
    return c.html(
      page(
        "Plans",
        html`${adminHeader("Plans", "plans")}
<p class="lead">Features and limits apply to restaurants on a plan right away. <a class="button small" href="/plans/new">New plan</a></p>
<div class="plan-grid">${plans.map(
          (plan) => html`<article class="card plan-card${plan.status === "archived" ? " archived" : ""}">
<h2><a href="/plans/${plan.id}">${plan.name}</a></h2>
<p class="meta">${priceLine(plan)}</p>
<p class="badges">
${plan.isSignupDefault ? html`<span class="badge ok">Signup default</span>` : ""}
${plan.status === "archived" ? html`<span class="badge warn">Archived</span>` : ""}
</p>
<p class="meta">${plan.restaurantCount} ${plan.restaurantCount === 1 ? "restaurant" : "restaurants"}</p>
</article>`,
        )}</div>`,
        "",
        "wide",
      ),
    );
  });

  app.get("/plans/new", (c) => {
    const values: FormValues = { kind: "paid", max_items: "25" };
    for (const feature of FEATURES) if (feature.type === "switch") values[feature.key] = "on";
    return c.html(page("New plan", html`${adminHeader("New plan", "plans")}${planForm("/plans", values, null)}`, "", "wide"));
  });

  app.post("/plans", async (c) => {
    const result = readPlanForm(await c.req.formData());
    if ("error" in result) {
      return c.html(page("New plan", html`${adminHeader("New plan", "plans")}${planForm("/plans", result.values, null, result.error)}`, "", "wide"), 400);
    }
    const id = await createPlan(c.env.DB, c.get("admin").userId, result.input);
    return c.redirect(`/plans/${id}`, 303);
  });

  app.get("/plans/:id", async (c) => {
    const id = c.req.param("id");
    const plan = PLAN_ID.test(id) ? await getPlan(c.env.DB, id) : null;
    if (!plan) return notFound(c);
    return c.html(planPage(plan, valuesFromInput(inputFromPlan(plan))));
  });

  app.post("/plans/:id", async (c) => {
    const id = c.req.param("id");
    const plan = PLAN_ID.test(id) ? await getPlan(c.env.DB, id) : null;
    if (!plan) return notFound(c);
    const result = readPlanForm(await c.req.formData());
    if ("error" in result) return c.html(planPage(plan, result.values, result.error), 400);
    if (plan.isSignupDefault && !result.input.isFree) {
      return c.html(planPage(plan, result.values, "The signup plan must stay free."), 400);
    }
    await updatePlan(c.env.DB, c.get("admin").userId, id, inputFromPlan(plan), result.input);
    return c.redirect(`/plans/${id}`, 303);
  });

  for (const [path, status] of [["archive", "archived"], ["restore", "active"]] as const) {
    app.post(`/plans/:id/${path}`, async (c) => {
      const id = c.req.param("id");
      const plan = PLAN_ID.test(id) ? await getPlan(c.env.DB, id) : null;
      if (!plan) return notFound(c);
      // New restaurants always need a plan, so the signup plan cannot be archived.
      if (status === "archived" && plan.isSignupDefault) {
        return c.html(planPage(plan, valuesFromInput(inputFromPlan(plan)), "The signup plan cannot be archived."), 400);
      }
      if (plan.status !== status) await setPlanStatus(c.env.DB, c.get("admin").userId, id, status);
      return c.redirect(`/plans/${id}`, 303);
    });
  }
}

function planPage(plan: PlanDetail, values: FormValues, error = "") {
  return page(
    plan.name,
    html`${adminHeader(plan.name, "plans")}
<p><a href="/plans">All plans</a>${plan.isSignupDefault ? html` <span class="badge ok">Signup default</span>` : ""}${plan.status === "archived" ? html` <span class="badge warn">Archived</span>` : ""}</p>
${planForm(`/plans/${plan.id}`, values, plan.restaurantCount, error)}
<section class="card form admin-section" aria-labelledby="status-heading">
<h2 id="status-heading">Status</h2>
${plan.status === "active"
    ? html`<p>Archived plans are not offered to restaurants. Restaurants already on the plan keep it. Plans are never deleted.</p>
<form method="post" action="/plans/${plan.id}/archive"><button class="button secondary" type="submit">Archive plan</button></form>`
    : html`<form method="post" action="/plans/${plan.id}/restore"><button class="button" type="submit">Restore plan</button></form>`}
</section>`,
    "",
    "wide",
  );
}
