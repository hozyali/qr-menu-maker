import { html } from "hono/html";
import { formatMoney } from "../shared/money";
import type { PublicCategory, PublicDish, PublicRestaurant } from "../shared/public-menu-db";

// The public menu page. It is light on purpose: no script, two small stylesheets, and lazy photos,
// so it opens fast on low-cost phones and slow connections.
// Values placed in `html` templates are escaped automatically (Law 19).

/** Digits for a phone link, keeping a leading +. */
function telHref(phone: string): string | null {
  const digits = phone.replace(/[^\d]/g, "");
  if (digits.length < 7) return null;
  return `tel:${phone.trim().startsWith("+") ? "+" : ""}${digits}`;
}

/** WhatsApp links need the number in international form, so a Pakistani 03xx number becomes 923xx. */
function whatsappHref(number: string, country: string): string | null {
  let digits = number.replace(/[^\d]/g, "");
  if (!number.trim().startsWith("+") && country === "PK" && digits.startsWith("0")) {
    digits = `92${digits.slice(1)}`;
  }
  return digits.length >= 10 ? `https://wa.me/${digits}` : null;
}

/** Only an https link is used, so a stored value can never become a script link. */
function safeHttpsUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function shell(restaurant: PublicRestaurant, themeHref: string, bodyClass: string, body: unknown) {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${restaurant.name} · Menu</title>
<meta name="description" content="Menu of ${restaurant.name}${restaurant.city ? `, ${restaurant.city}` : ""}">
<link rel="icon" href="/logo.svg" type="image/svg+xml">
<link rel="stylesheet" href="/menu.css">
<link rel="stylesheet" href="${themeHref}">
</head>
<body class="${bodyClass}">
${body}
</body>
</html>`;
}

function dish(item: PublicDish, currency: string) {
  return html`<li class="dish${item.isAvailable ? "" : " off"}">
${item.photoKey ? html`<img class="photo" src="/media/${item.photoKey}" alt="" loading="lazy" decoding="async" width="800" height="800">` : ""}
<div class="dish-text">
<h3>${item.name}</h3>
${item.isAvailable ? "" : html`<p class="status">Not available today</p>`}
${item.description ? html`<p class="desc">${item.description}</p>` : ""}
<ul class="prices">${item.prices.map(
    (price) => html`<li>${price.label ? html`<span class="size">${price.label}</span>` : ""}<strong>${formatMoney(price.amountMinor, currency)}</strong></li>`,
  )}</ul>
</div>
</li>`;
}

export function menuPage(restaurant: PublicRestaurant, categories: PublicCategory[], themeHref: string) {
  const tel = restaurant.phone ? telHref(restaurant.phone) : null;
  const whatsapp = restaurant.whatsapp ? whatsappHref(restaurant.whatsapp, restaurant.country) : null;
  const map = restaurant.mapsUrl ? safeHttpsUrl(restaurant.mapsUrl) : null;
  const where = [restaurant.address, restaurant.city].filter(Boolean).join(", ");
  const bodyClass = `menu ${restaurant.theme.mode} photos-${restaurant.theme.photoSize}`;

  return shell(
    restaurant,
    themeHref,
    bodyClass,
    html`<header class="hero">
<div class="wrap">
${restaurant.logoKey ? html`<img class="logo" src="/media/${restaurant.logoKey}" alt="" width="72" height="72">` : ""}
<h1>${restaurant.name}</h1>
${where ? html`<p class="where">${where}</p>` : ""}
${restaurant.hours ? html`<p class="hours">${restaurant.hours}</p>` : ""}
${tel || whatsapp || map
    ? html`<nav class="contact" aria-label="Contact ${restaurant.name}">
${tel ? html`<a class="action" href="${tel}">Call</a>` : ""}
${whatsapp ? html`<a class="action" href="${whatsapp}" rel="noopener">WhatsApp</a>` : ""}
${map ? html`<a class="action" href="${map}" rel="noopener">Map</a>` : ""}
</nav>`
    : ""}
</div>
</header>
${categories.length > 0
    ? html`<nav class="cats" aria-label="Menu sections"><div class="wrap">${categories.map(
        (cat) => html`<a href="#c-${cat.id}">${cat.name}</a>`,
      )}</div></nav>
<main class="wrap">
${categories.map(
  (cat) => html`<section class="section" id="c-${cat.id}" aria-labelledby="h-${cat.id}">
<h2 id="h-${cat.id}">${cat.name}</h2>
<ul class="dishes">${cat.dishes.map((item) => dish(item, restaurant.currency))}</ul>
</section>`,
)}
${restaurant.note ? html`<p class="note">${restaurant.note}</p>` : ""}
</main>`
    : html`<main class="wrap"><p class="empty">The menu is being prepared. Please check back soon.</p></main>`}
${restaurant.plan === "free" ? html`<footer class="powered"><a href="https://tomatofry.com/">Powered by TomatoFry</a></footer>` : ""}`,
  );
}

export function unavailablePage(restaurant: PublicRestaurant, themeHref: string) {
  return shell(
    restaurant,
    themeHref,
    `menu ${restaurant.theme.mode}`,
    html`<main class="wrap closed"><h1>${restaurant.name}</h1><p class="empty">This menu is currently unavailable.</p></main>`,
  );
}

/** Shown for a menu link that does not exist, with the same look as a menu. */
export function menuNotFoundPage() {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Menu not found · TomatoFry</title>
<meta name="robots" content="noindex">
<link rel="icon" href="/logo.svg" type="image/svg+xml">
<link rel="stylesheet" href="/menu.css">
</head>
<body class="menu light">
<main class="wrap closed"><h1>Menu not found</h1><p class="empty">Check the link or scan the QR code on your table again.</p></main>
</body>
</html>`;
}
