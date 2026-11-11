import type { Hono } from "hono";
import { html, raw } from "hono/html";
import { page } from "../shared/layout";
import { menuUrl, qrPng, qrSvg } from "../shared/qr";
import { tenantDb } from "../shared/tenant-db";
import type { OwnerEnv } from "./menu";

// QR code page, PNG download, and print card (issue #30).
// The slug comes from the login session only. Nothing in the request can choose another restaurant (Law 18).

export function registerQrRoutes(app: Hono<OwnerEnv>) {
  app.get("/qr", (c) => {
    const owner = c.get("owner");
    const url = menuUrl(owner.slug);
    return c.html(
      page(
        "QR code",
        html`<h1>Your menu QR code</h1>
<p class="lead">Customers scan this code to open your menu. It never changes, so printed cards keep working even when you edit your menu.</p>
<div class="card form qr-card">
<div class="qr-preview">${raw(qrSvg(url, `QR code for ${url}`))}</div>
<p class="meta">Opens <a href="${url}" target="_blank" rel="noopener">${url}</a></p>
<a class="button" href="/qr.png" download>Download QR code (PNG)</a>
<a class="button secondary" href="/qr/print">Print a table card</a>
<a class="button secondary" href="/">Back to dashboard</a>
</div>
<p class="hint">Before printing many cards, print one and scan it with an Android phone and an iPhone.</p>`,
      ),
    );
  });

  app.get("/qr.png", async (c) => {
    const owner = c.get("owner");
    const png = await qrPng(menuUrl(owner.slug));
    return new Response(png, {
      headers: {
        "content-type": "image/png",
        // The slug holds only letters, numbers, and dashes, so it is safe in the file name.
        "content-disposition": `attachment; filename="${owner.slug}-qr.png"`,
        "cache-control": "private, max-age=3600",
      },
    });
  });

  app.get("/qr/print", async (c) => {
    const owner = c.get("owner");
    const profile = await tenantDb(c.env.DB, owner.restaurantId).getProfile();
    const url = menuUrl(owner.slug);
    const name = profile?.name ?? owner.restaurantName;
    return c.html(html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Table card · ${name}</title>
<link rel="icon" href="/logo.svg" type="image/svg+xml">
<link rel="stylesheet" href="/app.css">
</head>
<body class="print-page">
<div class="print-tools">
<button class="button small" type="button" data-print>Print</button>
<a class="button secondary small" href="/qr">Back</a>
<p class="hint">Tip: choose "Actual size" or 100% scale in the print settings.</p>
</div>
<article class="table-card">
${profile?.logoKey ? html`<img class="table-card-logo" src="/media/${profile.logoKey}" alt="" width="96" height="96">` : ""}
<h1>${name}</h1>
<p class="table-card-cta">Scan for menu</p>
${raw(qrSvg(url, `QR code for the ${name} menu`))}
<p class="table-card-link">${url.replace("https://", "")}</p>
</article>
<script src="/print.js" defer></script>
</body>
</html>`);
  });
}
