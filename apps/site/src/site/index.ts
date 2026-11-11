import { type Context, Hono } from "hono";
import { MENU_CODE, menuLink } from "../shared/menu-link";
import { serveMedia } from "../shared/media";
import { findPublicMenu, findPublicTheme } from "../shared/public-menu-db";
import { themeCss } from "../shared/theme";
import { menuNotFoundPage, menuPage, unavailablePage } from "./menu-page";

// Public area on tomatofry.com: the home page and the public menu at /r/<code>.
export const siteApp = new Hono<{ Bindings: Env }>();

// Menu links are /r/<code> or /r/<code>/<name-city> (issue #32). Only the code is read: the name part
// is for people and search engines, so any name, old or new, opens the same menu without a redirect.
// A code that does not match the format is refused before any database read.

// Dish photos for the public menu.
siteApp.get("/media/*", (c) => serveMedia(c.env.MEDIA, c.req.path));

// Each restaurant's colours as a small stylesheet, because the CSP does not allow inline styles.
// It is registered before the name route. A name part never contains a dot, so it cannot clash.
siteApp.get("/r/:code/theme.css", async (c) => {
  const code = c.req.param("code");
  const theme = MENU_CODE.test(code) ? await findPublicTheme(c.env.DB, code) : null;
  if (!theme) return new Response("Not found", { status: 404 });
  return new Response(themeCss(theme), {
    headers: {
      "content-type": "text/css; charset=utf-8",
      // The page links this file with the theme in the query, so a changed theme gets a new address.
      "cache-control": "public, max-age=86400",
    },
  });
});

async function showMenu(c: Context<{ Bindings: Env }>) {
  const code = c.req.param("code") ?? "";
  const menu = MENU_CODE.test(code) ? await findPublicMenu(c.env.DB, code, Date.now()) : null;
  if (!menu) return c.html(menuNotFoundPage(), 404);
  const { theme } = menu.restaurant;
  const themeHref = `/r/${code}/theme.css?v=${theme.color.slice(1)}-${theme.mode}`;
  // Search engines get one address per menu, with the current name and city.
  const canonical = menuLink(code, menu.restaurant.name, menu.restaurant.city);
  if (menu.status === "suspended") {
    return c.html(unavailablePage(menu.restaurant, themeHref, canonical));
  }
  return c.html(menuPage(menu.restaurant, menu.categories, themeHref, canonical));
}

siteApp.get("/r/:code", showMenu);
siteApp.get("/r/:code/:name", showMenu);

siteApp.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));
