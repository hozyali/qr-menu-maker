import { Hono } from "hono";
import { serveMedia } from "../shared/media";

// Public area on tomatofry.com: the home page now, and the public menu at /r/<slug> later.
export const siteApp = new Hono<{ Bindings: Env }>();

// Dish photos for the public menu.
siteApp.get("/media/*", (c) => serveMedia(c.env.MEDIA, c.req.path));

siteApp.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));
