import { Hono } from "hono";
import { serveMedia } from "../shared/media";
import { findPublicMenu, findPublicTheme } from "../shared/public-menu-db";
import { themeCss } from "../shared/theme";
import { menuNotFoundPage, menuPage, unavailablePage } from "./menu-page";

// Public area on tomatofry.com: the home page and the public menu at /r/<slug>.
export const siteApp = new Hono<{ Bindings: Env }>();

// Slugs are made at signup from English letters, numbers, and single dashes.
// Anything else cannot be a menu, so it is refused before any database read.
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const validSlug = (slug: string) => slug.length <= 120 && SLUG.test(slug);

// Dish photos for the public menu.
siteApp.get("/media/*", (c) => serveMedia(c.env.MEDIA, c.req.path));

// Each restaurant's colours as a small stylesheet, because the CSP does not allow inline styles.
siteApp.get("/r/:slug/theme.css", async (c) => {
  const slug = c.req.param("slug");
  const theme = validSlug(slug) ? await findPublicTheme(c.env.DB, slug) : null;
  if (!theme) return new Response("Not found", { status: 404 });
  return new Response(themeCss(theme), {
    headers: {
      "content-type": "text/css; charset=utf-8",
      // The page links this file with the theme in the query, so a changed theme gets a new address.
      "cache-control": "public, max-age=86400",
    },
  });
});

siteApp.get("/r/:slug", async (c) => {
  const slug = c.req.param("slug");
  const menu = validSlug(slug) ? await findPublicMenu(c.env.DB, slug, Date.now()) : null;
  if (!menu) return c.html(menuNotFoundPage(), 404);
  const { theme } = menu.restaurant;
  const themeHref = `/r/${slug}/theme.css?v=${theme.color.slice(1)}-${theme.mode}`;
  if (menu.status === "suspended") {
    return c.html(unavailablePage(menu.restaurant, themeHref));
  }
  return c.html(menuPage(menu.restaurant, menu.categories, themeHref));
});

siteApp.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));
