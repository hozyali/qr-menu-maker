import type { Context, Hono } from "hono";
import { html } from "hono/html";
import { page } from "../shared/layout";
import { formatMoney } from "../shared/money";
import { addBillingPeriod, endOfPakistanDay, pakistanDate } from "../shared/pakistan-date";
import { approvePayment, getPayment, getSetting, listPayments, type PaymentStatus, rejectPayment, setSetting } from "../shared/payments-db";
import { readText } from "../shared/validation";
import { adminHeader } from "./nav";
import type { AdminEnv } from "./restaurants";

// Admin settings and offline payment review (issue #41). The admin session and role are checked
// before these routes run.

type AdminContext = Context<AdminEnv>;

const PAYMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_BANK_DETAILS = 1000;
const STATUS_LABELS: Record<PaymentStatus, string> = { pending: "Waiting", approved: "Approved", rejected: "Rejected" };

function notFound(c: AdminContext) {
  return c.html(page("Not found", html`<h1>Not found</h1><p class="lead">There is no such payment. <a href="/payments">Back to payments</a></p>`), 404);
}

function settingsPage(value: string, error = "", saved = false) {
  return page(
    "Settings",
    html`${adminHeader("Settings", "settings")}
<form class="card form" method="post" action="/settings" novalidate>
${error ? html`<p class="error" role="alert">${error}</p>` : ""}
${saved ? html`<p class="notice" role="status">Settings saved.</p>` : ""}
<div class="field"><label for="bank_details">Bank details for payments</label>
<textarea id="bank_details" name="bank_details" rows="6" maxlength="${MAX_BANK_DETAILS}" aria-describedby="bank-hint">${value}</textarea>
<p class="hint" id="bank-hint">Restaurants see this when they upgrade or renew: bank name, account title, IBAN, JazzCash or Easypaisa number. Up to 1,000 characters. Do not put passwords or secrets here.</p></div>
<button class="button" type="submit">Save settings</button>
</form>`,
    "",
    "wide",
  );
}

async function paymentPage(c: AdminContext, id: string, error = "") {
  const payment = await getPayment(c.env.DB, id);
  if (!payment) return null;
  return page(
    "Payment",
    html`${adminHeader("Payment", "payments")}
<p><a href="/payments">All payments</a> <span class="badge ${payment.status === "approved" ? "ok" : payment.status === "rejected" ? "warn" : ""}">${STATUS_LABELS[payment.status]}</span></p>
${error ? html`<p class="error" role="alert">${error}</p>` : ""}
<section class="card">
<h2>${payment.restaurantName}</h2>
<dl class="details">
<dt>Plan</dt><dd>${payment.planName}, ${payment.billingPeriod}</dd>
<dt>Price</dt><dd>${formatMoney(payment.listPriceMinor)}</dd>
${payment.discountMinor > 0 ? html`<dt>Discount</dt><dd>${formatMoney(payment.discountMinor)}${payment.couponCode ? ` (coupon ${payment.couponCode})` : " (recurring coupon)"}</dd>` : ""}
<dt>Amount to receive</dt><dd><strong>${formatMoney(payment.amountMinor)}</strong></dd>
<dt>Sent</dt><dd>${pakistanDate(payment.createdAt)}</dd>
${payment.ownerNote ? html`<dt>Owner's note</dt><dd>${payment.ownerNote}</dd>` : ""}
${payment.reviewNote ? html`<dt>Your note</dt><dd>${payment.reviewNote}</dd>` : ""}
<dt>Restaurant</dt><dd><a href="/restaurants/${payment.restaurantId}">Open restaurant</a></dd>
</dl>
</section>
<section class="card admin-section" aria-labelledby="receipt-heading">
<h2 id="receipt-heading">Receipt</h2>
<a href="/payments/${payment.id}/receipt" target="_blank" rel="noopener"><img class="receipt" src="/payments/${payment.id}/receipt" alt="Payment receipt from ${payment.restaurantName}"></a>
</section>
${payment.status === "pending"
    ? html`<section class="card form admin-section" aria-labelledby="review-heading">
<h2 id="review-heading">Review</h2>
<p>Approve only after the money has arrived. The plan starts today and runs for one ${payment.billingPeriod === "yearly" ? "year" : "month"}.</p>
<form method="post" action="/payments/${payment.id}/approve"><button class="button" type="submit">Approve and start the plan</button></form>
<form class="form" method="post" action="/payments/${payment.id}/reject" novalidate>
<div class="field"><label for="review_note">Reason for rejecting</label>
<input id="review_note" name="review_note" maxlength="300" aria-describedby="note-hint">
<p class="hint" id="note-hint">The restaurant sees this, for example "The amount on the receipt does not match."</p></div>
<button class="button danger" type="submit">Reject</button>
</form>
</section>`
    : ""}`,
    "",
    "wide",
  );
}

export function registerPaymentRoutes(app: Hono<AdminEnv>) {
  app.get("/settings", async (c) => c.html(settingsPage((await getSetting(c.env.DB, "bank_details")) ?? "", "", c.req.query("saved") === "1")));

  app.post("/settings", async (c) => {
    // Bank details keep their line breaks, so only the ends are trimmed.
    const value = readText(await c.req.formData(), "bank_details");
    if (value.length > MAX_BANK_DETAILS) return c.html(settingsPage(value, "Keep the bank details to 1,000 characters."), 400);
    await setSetting(c.env.DB, c.get("admin").userId, "bank_details", value);
    return c.redirect("/settings?saved=1", 303);
  });

  app.get("/payments", async (c) => {
    const requested = c.req.query("status");
    const status: PaymentStatus = requested === "approved" || requested === "rejected" ? requested : "pending";
    const match = /^(\d{1,16})\.([0-9a-f-]{36})$/.exec(c.req.query("after") ?? "");
    const { rows, next } = await listPayments(c.env.DB, status, match ? { createdAt: Number(match[1]), id: match[2] ?? "" } : null);
    const tab = (value: PaymentStatus) =>
      html`<a class="tab${status === value ? " on" : ""}" href="/payments?status=${value}"${status === value ? html` aria-current="page"` : ""}>${STATUS_LABELS[value]}</a>`;
    return c.html(
      page(
        "Payments",
        html`${adminHeader("Payments", "payments")}
<p class="lead">Restaurants pay offline and upload a receipt. Approve a payment only after the money has arrived.</p>
<nav class="tabs" aria-label="Payment status">${tab("pending")}${tab("approved")}${tab("rejected")}</nav>
${rows.length === 0
    ? html`<div class="card empty"><h2>No ${STATUS_LABELS[status].toLowerCase()} payments</h2><p>${status === "pending" ? "New payments appear here when restaurants send a receipt." : "Reviewed payments appear here."}</p></div>`
    : html`<div class="card table-wrap"><table class="table">
<caption class="sr-only">${STATUS_LABELS[status]} payments</caption>
<thead><tr><th scope="col">Restaurant</th><th scope="col">Plan</th><th scope="col">Amount</th><th scope="col">Sent</th></tr></thead>
<tbody>${rows.map(
        (row) => html`<tr>
<td><a href="/payments/${row.id}"><strong>${row.restaurantName}</strong></a></td>
<td>${row.planName}, ${row.billingPeriod}</td>
<td>${formatMoney(row.amountMinor)}</td>
<td>${pakistanDate(row.createdAt)}</td>
</tr>`,
      )}</tbody></table></div>`}
${next ? html`<p class="pager"><a class="button secondary small" href="/payments?status=${status}&after=${next.createdAt}.${next.id}">More</a></p>` : ""}`,
        "",
        "wide",
      ),
    );
  });

  app.get("/payments/:id", async (c) => {
    const id = c.req.param("id");
    const body = PAYMENT_ID.test(id) ? await paymentPage(c, id) : null;
    return body ? c.html(body) : notFound(c);
  });

  // Receipts are private: only an admin can open one here, and it is never cached.
  app.get("/payments/:id/receipt", async (c) => {
    const id = c.req.param("id");
    const payment = PAYMENT_ID.test(id) ? await getPayment(c.env.DB, id) : null;
    const object = payment ? await c.env.MEDIA.get(payment.receiptKey) : null;
    if (!object) return notFound(c);
    const headers = new Headers({ "cache-control": "no-store", "content-disposition": "inline" });
    object.writeHttpMetadata(headers);
    headers.set("cache-control", "no-store");
    return new Response(object.body, { headers });
  });

  app.post("/payments/:id/approve", async (c) => {
    const id = c.req.param("id");
    const payment = PAYMENT_ID.test(id) ? await getPayment(c.env.DB, id) : null;
    if (!payment) return notFound(c);
    if (payment.status !== "pending") return c.html((await paymentPage(c, id, "This payment was already reviewed.")) ?? "", 409);
    // The owner decided the paid period starts on the approval date (plan issue #1).
    const startedAt = Date.now();
    const endsLabel = addBillingPeriod(pakistanDate(startedAt), payment.billingPeriod);
    const endsAt = endOfPakistanDay(endsLabel) ?? startedAt;
    try {
      await approvePayment(c.env.DB, c.get("admin").userId, payment, { startedAt, endsAt, endsLabel });
    } catch (error) {
      // Nothing was saved. Either another approval won the race, or the coupon can no longer be used.
      const fresh = await getPayment(c.env.DB, id);
      if (fresh && fresh.status !== "pending") return c.html((await paymentPage(c, id, "This payment was already reviewed.")) ?? "", 409);
      if (payment.couponId) {
        return c.html((await paymentPage(c, id, "The coupon on this payment can no longer be used (limit reached or already used). Nothing was saved. Reject it with a note, or ask the restaurant to send again.")) ?? "", 409);
      }
      throw error;
    }
    return c.redirect(`/payments/${id}`, 303);
  });

  app.post("/payments/:id/reject", async (c) => {
    const id = c.req.param("id");
    const payment = PAYMENT_ID.test(id) ? await getPayment(c.env.DB, id) : null;
    if (!payment) return notFound(c);
    if (payment.status !== "pending") return c.html((await paymentPage(c, id, "This payment was already reviewed.")) ?? "", 409);
    const note = readText(await c.req.formData(), "review_note");
    if (note.length < 3 || note.length > 300) return c.html((await paymentPage(c, id, "Write a reason of 3 to 300 characters. The restaurant sees it.")) ?? "", 400);
    try {
      await rejectPayment(c.env.DB, c.get("admin").userId, payment, note);
    } catch {
      return c.html((await paymentPage(c, id, "This payment was already reviewed.")) ?? "", 409);
    }
    return c.redirect(`/payments/${id}`, 303);
  });
}
