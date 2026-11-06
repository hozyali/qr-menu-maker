import { Hono } from "hono";

// Owner area on app.tomatofry.com. It never serves the static site files.
export const ownerApp = new Hono<{ Bindings: Env }>();

ownerApp.get("/", (c) => c.html("<!doctype html><title>TomatoFry</title><h1>TomatoFry for restaurant owners</h1><p>Coming soon.</p>"));
