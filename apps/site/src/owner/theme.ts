import type { Context, Hono } from "hono";
import { html } from "hono/html";
import { page } from "../shared/layout";
import { menuPath } from "../shared/menu-link";
import { planAllows } from "../shared/plans";
import { tenantDb } from "../shared/tenant-db";
import { isHexColor, type Theme, themeColors } from "../shared/theme";
import { readText } from "../shared/validation";
import { type OwnerEnv, siteOrigin } from "./menu";

// Menu theme editor (issue #24). Which plan gets the theme is decided in plans.ts only.

type OwnerContext = Context<OwnerEnv>;

function choice(name: string, value: string, label: string, current: string) {
  return html`<label class="choice"><input type="radio" name="${name}" value="${value}"${value === current ? html` checked` : ""}> ${label}</label>`;
}

function themePage(c: OwnerContext, theme: Theme, message: { kind: "error" | "saved"; text: string } | null = null) {
  const owner = c.get("owner");
  const colors = themeColors(theme.color, theme.mode);
  return page(
    "Menu theme",
    html`<h1>Menu theme</h1>
<p class="lead">Pick your brand colour. We choose the text colours so your menu stays easy to read.</p>
<form class="card form" method="post" action="/theme" novalidate>
${message?.kind === "error" ? html`<p class="error" role="alert">${message.text}</p>` : ""}
${message?.kind === "saved" ? html`<p class="notice" role="status">${message.text}</p>` : ""}
<div class="field"><label for="color">Brand colour</label>
<input id="color" name="color" type="color" value="${theme.color}" aria-describedby="color-hint">
<p class="hint" id="color-hint">Used for the menu header and buttons.</p></div>
${colors.adjusted
    ? html`<p class="warning" role="status">This colour is hard to read as text on a ${theme.mode} background, so prices and headings use a ${theme.mode === "light" ? "darker" : "lighter"} shade of it.</p>`
    : ""}
<fieldset class="choices"><legend>Background</legend>
${choice("mode", "light", "Light", theme.mode)}
${choice("mode", "dark", "Dark", theme.mode)}
</fieldset>
<fieldset class="choices"><legend>Dish photos</legend>
${choice("photos", "large", "Large", theme.photoSize)}
${choice("photos", "small", "Small", theme.photoSize)}
</fieldset>
<button class="button" type="submit">Save theme</button>
<a class="button secondary" href="${siteOrigin(c.req.url)}${menuPath(owner.menuCode, owner.restaurantName, owner.city)}" target="_blank" rel="noopener">Open my menu</a>
<a class="button secondary" href="/">Back to dashboard</a>
</form>`,
  );
}

function notOnPlan(c: OwnerContext) {
  return c.html(
    page("Menu theme", html`<h1>Menu theme</h1><p class="lead">The menu theme is not part of your plan. <a href="/">Back to your menu</a></p>`),
    403,
  );
}

export function registerThemeRoutes(app: Hono<OwnerEnv>) {
  app.get("/theme", async (c) => {
    if (!planAllows(c.get("owner").entitlements, "custom_theme")) return notOnPlan(c);
    const theme = await tenantDb(c.env.DB, c.get("owner").restaurantId).getTheme();
    return c.html(themePage(c, theme, c.req.query("saved") ? { kind: "saved", text: "Theme saved." } : null));
  });

  app.post("/theme", async (c) => {
    if (!planAllows(c.get("owner").entitlements, "custom_theme")) return notOnPlan(c);
    const form = await c.req.formData();
    const color = readText(form, "color").toLowerCase();
    const mode = readText(form, "mode");
    const photos = readText(form, "photos");
    // Only exact known values are saved, because they end up in the menu's stylesheet (Law 19).
    if (!isHexColor(color) || (mode !== "light" && mode !== "dark") || (photos !== "large" && photos !== "small")) {
      const current = await tenantDb(c.env.DB, c.get("owner").restaurantId).getTheme();
      return c.html(themePage(c, current, { kind: "error", text: "Please pick a colour, a background, and a photo size." }), 400);
    }
    await tenantDb(c.env.DB, c.get("owner").restaurantId).setTheme({ color, mode, photoSize: photos });
    return c.redirect("/theme?saved=1", 303);
  });
}
