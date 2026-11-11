import { html } from "hono/html";

// One header for every admin page (Law 15). `current` marks the open section for screen readers.
export function adminHeader(title: string, current: "restaurants" | "plans" | null) {
  return html`<header class="top">
<h1>${title}</h1>
<form method="post" action="/logout"><button class="button secondary small" type="submit">Log out</button></form>
</header>
<nav class="tabs admin-nav" aria-label="Admin sections">
<a class="tab${current === "restaurants" ? " on" : ""}" href="/"${current === "restaurants" ? html` aria-current="page"` : ""}>Restaurants</a>
<a class="tab${current === "plans" ? " on" : ""}" href="/plans"${current === "plans" ? html` aria-current="page"` : ""}>Plans</a>
</nav>`;
}
