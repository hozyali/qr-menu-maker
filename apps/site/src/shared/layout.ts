import { html } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";

// One page shell for the owner and admin areas, so every screen shares the same design system (Law 15).
// Values placed in `html` templates are escaped automatically (Law 19).
export function page(
  title: string,
  body: HtmlEscapedString | Promise<HtmlEscapedString>,
  head: unknown = "",
  // "wide" is for the dashboard, which needs room for the menu list.
  width: "narrow" | "wide" = "narrow",
) {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · TomatoFry</title>
<link rel="icon" href="/logo.svg" type="image/svg+xml">
<link rel="stylesheet" href="/app.css">
${head}
</head>
<body>
<main class="shell${width === "wide" ? " wide" : ""}">
<a class="brand" href="/"><img src="/logo.svg" alt="" width="32" height="32"><span>TomatoFry</span></a>
${body}
</main>
</body>
</html>`;
}
