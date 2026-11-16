import type { Context, Hono } from "hono";
import { html } from "hono/html";
import { checkCoupon } from "../shared/coupons-db";
import { page } from "../shared/layout";
import { checkImageUpload, deletePhotos, newReceiptKey } from "../shared/media";
import { formatMoney } from "../shared/money";
import { pakistanDate } from "../shared/pakistan-date";
import { getSetting } from "../shared/payments-db";
import { planLimit } from "../shared/plans";
import { listPlans, type PlanSummary } from "../shared/plans-db";
import { type CouponTerms, type Price, priceFor } from "../shared/pricing";
import { type CurrentPlan, currentPlan } from "../shared/subscriptions-db";
import { tenantDb } from "../shared/tenant-db";
import { readText } from "../shared/validation";
import type { OwnerEnv } from "./menu";

// The owner's plan page: upgrade or renew by paying offline and uploading a receipt (issue #41).
// The restaurant always comes from the login session (Law 18).

type OwnerContext = Context<OwnerEnv>;
type FormValues = { plan_id: string; period: string; coupon: string; owner_note: string };

const DAY = 24 * 60 * 60 * 1000;
const RENEWAL_WINDOW = 7 * DAY;

/** Paid plans on offer: active, with both prices set. */
const onOffer = (plans: PlanSummary[]) =>
  plans.filter((p) => !p.isFree && p.status === "active" && p.monthlyPriceMinor !== null && p.yearlyPriceMinor !== null);

/**
 * Whether the owner can pay now. Free, trial, or ended plans can always upgrade. A paid plan can be
 * renewed in its last 7 days (owner decision, plan issue #1). A paid plan with no end has nothing to pay.
 */
function whenCanPay(current: CurrentPlan, now: number): { now: true } | { now: false; from: number | null } {
  if (current.entitlements.isFree || current.status === "trial" || current.ended) return { now: true };
  if (current.endsAt === null) return { now: false, from: null };
  const from = current.endsAt - RENEWAL_WINDOW;
  return now >= from ? { now: true } : { now: false, from };
}

interface PageState {
  current: CurrentPlan;
  values: FormValues;
  error?: string;
  price?: Price;
  status?: number;
}

async function renderPlanPage(c: OwnerContext, state: PageState) {
  const owner = c.get("owner");
  const db = tenantDb(c.env.DB, owner.restaurantId);
  const now = Date.now();
  const [plans, latest, bankDetails, used] = await Promise.all([
    listPlans(c.env.DB),
    db.latestPaymentRequest(),
    getSetting(c.env.DB, "bank_details"),
    db.countItems(),
  ]);
  const { current, values } = state;
  const limit = planLimit(current.entitlements, "max_items");
  const offered = onOffer(plans);
  const canPay = whenCanPay(current, now);
  const pending = latest?.status === "pending";
  const checked = (on: boolean) => (on ? html` checked` : "");
  const planLine = `${current.entitlements.planName}${current.status === "trial" ? " trial" : ""}${current.endsAt ? ` until ${pakistanDate(current.endsAt)}` : ""}`;

  return c.html(
    page(
      "Plan",
      html`<h1>Your plan</h1>
<div class="stats">
<div class="stat"><span class="meta">Plan</span><strong>${planLine}</strong></div>
<div class="stat"><span class="meta">Dishes</span><strong>${limit === null ? `${used}` : `${Math.min(used, limit)} of ${limit}`}</strong>${limit !== null && used > limit ? html`<span class="meta">${used - limit} archived</span>` : ""}</div>
</div>
${latest?.status === "pending"
    ? html`<section class="card notice-card" aria-labelledby="pending-heading"><h2 id="pending-heading">Waiting for approval</h2>
<p>You sent ${formatMoney(latest.amountMinor)} for ${latest.planName}, ${latest.billingPeriod}, on ${pakistanDate(latest.createdAt)}. We start your plan as soon as the payment is confirmed.</p>
<p><a href="/plan/receipts/${latest.id}" target="_blank" rel="noopener">View your receipt</a></p></section>`
    : ""}
${latest?.status === "rejected"
    ? html`<section class="card" aria-labelledby="rejected-heading"><h2 id="rejected-heading">Your last payment was not approved</h2>
<p class="error" role="alert">${latest.reviewNote ?? "Please send it again."}</p><p>You can send a new payment below.</p></section>`
    : ""}
${!pending && !canPay.now
    ? html`<div class="card empty"><h2>Nothing to pay right now</h2><p>${canPay.from === null ? "Your plan has no end date." : `You can renew from ${pakistanDate(canPay.from)}, 7 days before your plan ends.`}</p></div>`
    : ""}
${!pending && canPay.now && offered.length === 0 ? html`<div class="card empty"><h2>No paid plans yet</h2><p>Paid plans will appear here.</p></div>` : ""}
${!pending && canPay.now && offered.length > 0
    ? html`<form class="card form" method="post" action="/plan" enctype="multipart/form-data" novalidate data-photo-form data-max-side="1600">
${state.error ? html`<p class="error" role="alert">${state.error}</p>` : ""}
<fieldset class="features"><legend>Choose a plan</legend>
${offered.map(
  (p) => html`<label class="feature-toggle">
<input type="radio" name="plan_id" value="${p.id}"${checked(values.plan_id === p.id)}>
<span class="feature-text"><strong>${p.name}</strong><span class="meta">${formatMoney(p.monthlyPriceMinor ?? 0)} a month, or ${formatMoney(p.yearlyPriceMinor ?? 0)} a year</span></span>
</label>`,
)}
</fieldset>
<fieldset class="choices"><legend>Pay</legend>
<label class="choice"><input type="radio" name="period" value="monthly"${checked(values.period !== "yearly")}> Monthly</label>
<label class="choice"><input type="radio" name="period" value="yearly"${checked(values.period === "yearly")}> Yearly</label>
</fieldset>
<div class="field"><label for="coupon">Coupon (optional)</label>
<input id="coupon" name="coupon" value="${values.coupon}" maxlength="20" autocapitalize="characters"></div>
<button class="button secondary" type="submit" name="intent" value="preview">Check price</button>
${state.price
    ? html`<p class="notice" role="status">Amount to pay: <strong>${formatMoney(state.price.finalMinor)}</strong>${state.price.discountMinor > 0 ? ` (${formatMoney(state.price.listMinor)} minus ${formatMoney(state.price.discountMinor)})` : ""}.</p>`
    : ""}
<section aria-labelledby="bank-heading"><h2 id="bank-heading">How to pay</h2>
${bankDetails ? html`<p class="bank-details">${bankDetails}</p>` : html`<p class="empty">Payment details will appear here soon.</p>`}
<p class="hint">Pay the amount, then upload a screenshot or photo of the receipt. Renewing before your plan ends starts the new period on the day we approve it, so any days left are not carried over.</p></section>
<div class="drop-zone" data-drop-zone>
<label for="receipt">Payment receipt</label>
<input id="receipt" name="receipt" type="file" accept="image/jpeg,image/png,image/webp" aria-describedby="receipt-hint">
<p class="hint" id="receipt-hint">JPG, PNG, or WEBP. Drag the picture here, or choose a file.</p>
<p class="meta" data-drop-status aria-live="polite"></p>
</div>
<div class="field"><label for="owner_note">Note (optional)</label><input id="owner_note" name="owner_note" value="${values.owner_note}" maxlength="300"></div>
<button class="button" type="submit" name="intent" value="submit">Send payment</button>
</form>
<script src="/photo.js" defer></script>
<script src="/drop.js" defer></script>`
    : ""}
<p><a href="/">Back to dashboard</a></p>`,
      "",
      "wide",
    ),
    (state.status ?? 200) as 200,
  );
}

export function registerPlanPageRoutes(app: Hono<OwnerEnv>) {
  app.get("/plan", async (c) => {
    const current = await currentPlan(c.env.DB, c.get("owner").restaurantId, Date.now());
    const offered = onOffer(await listPlans(c.env.DB));
    return renderPlanPage(c, { current, values: { plan_id: offered[0]?.id ?? "", period: "monthly", coupon: "", owner_note: "" } });
  });

  app.post("/plan", async (c) => {
    const owner = c.get("owner");
    const now = Date.now();
    const form = await c.req.formData();
    const values: FormValues = {
      plan_id: readText(form, "plan_id"),
      period: readText(form, "period"),
      coupon: readText(form, "coupon").toUpperCase(),
      owner_note: readText(form, "owner_note"),
    };
    const current = await currentPlan(c.env.DB, owner.restaurantId, now);
    const fail = (error: string, status = 400) => renderPlanPage(c, { current, values, error, status });

    const db = tenantDb(c.env.DB, owner.restaurantId);
    if ((await db.latestPaymentRequest())?.status === "pending") return fail("A payment is already waiting for approval.", 409);
    if (!whenCanPay(current, now).now) return fail("Your plan cannot be renewed yet.", 409);

    // Checked on the server (Law 19): an active paid plan with both prices, and a billing period.
    const plan = onOffer(await listPlans(c.env.DB)).find((p) => p.id === values.plan_id);
    if (!plan) return fail("Choose a plan.");
    if (values.period !== "monthly" && values.period !== "yearly") return fail("Choose monthly or yearly.");
    const period = values.period;
    const listMinor = (period === "monthly" ? plan.monthlyPriceMinor : plan.yearlyPriceMinor) ?? 0;

    // Paying again for the same paid plan and period is a renewal.
    const isRenewal =
      !current.ended && current.status === "active" && !current.entitlements.isFree && current.entitlements.planId === plan.id && current.billingPeriod === period;
    let couponId: string | null = null;
    let terms: CouponTerms | null = null;
    if (values.coupon) {
      const check = await checkCoupon(c.env.DB, values.coupon, { restaurantId: owner.restaurantId, planId: plan.id, period, now });
      // Owners only see the safe message, so codes meant for other restaurants stay unknown.
      if (!check.ok) return fail(check.ownerMessage);
      if (isRenewal && check.coupon.duration === "once") return fail("This coupon is for a first payment only, not a renewal.");
      couponId = check.coupon.id;
      terms = check.coupon;
    } else if (isRenewal && current.coupon?.duration === "recurring") {
      // A recurring coupon keeps applying at renewal without counting a new use (issue #40).
      terms = current.coupon;
    }
    const price = priceFor({ listMinor, coupon: terms, isRenewal });
    if (readText(form, "intent") !== "submit") return renderPlanPage(c, { current, values, price });

    if (values.owner_note.length > 300) return fail("Keep the note to 300 characters.");
    const upload = await checkImageUpload(form.get("receipt"));
    if (!upload.ok) return fail(`Receipt: ${upload.error}`);
    // The key always uses the session's restaurant id, in a private receipts folder (Law 18).
    const receiptKey = newReceiptKey(owner.restaurantId, upload.type);
    await c.env.MEDIA.put(receiptKey, upload.bytes, { httpMetadata: { contentType: upload.type.contentType } });
    try {
      await db.createPaymentRequest({
        planId: plan.id,
        period,
        couponId,
        couponTerms: terms,
        listMinor: price.listMinor,
        discountMinor: price.discountMinor,
        amountMinor: price.finalMinor,
        receiptKey,
        ownerNote: values.owner_note || null,
      });
    } catch {
      // Another request was sent a moment ago. The database allows only one waiting request.
      await deletePhotos(c.env.MEDIA, [receiptKey]);
      return fail("A payment is already waiting for approval.", 409);
    }
    return c.redirect("/plan", 303);
  });

  // Owners can open only their own receipts (Law 18). Receipts are never cached.
  app.get("/plan/receipts/:id", async (c) => {
    const request = await tenantDb(c.env.DB, c.get("owner").restaurantId).getPaymentRequest(c.req.param("id"));
    const object = request ? await c.env.MEDIA.get(request.receiptKey) : null;
    if (!object) return c.html(page("Not found", html`<h1>Not found</h1><p class="lead"><a href="/plan">Back to your plan</a></p>`), 404);
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("cache-control", "no-store");
    headers.set("content-disposition", "inline");
    return new Response(object.body, { headers });
  });
}
