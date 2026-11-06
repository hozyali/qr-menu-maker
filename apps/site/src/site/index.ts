import { Hono } from "hono";

// Public area on tomatofry.com: the home page now, and the public menu at /r/<slug> later.
export const siteApp = new Hono<{ Bindings: Env }>();

siteApp.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));
