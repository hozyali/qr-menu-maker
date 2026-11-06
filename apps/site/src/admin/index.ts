import { Hono } from "hono";

// Master admin area on admin.tomatofry.com. It never serves the static site files.
export const adminApp = new Hono<{ Bindings: Env }>();

adminApp.get("/", (c) => c.html("<!doctype html><title>TomatoFry</title><h1>TomatoFry admin</h1><p>Coming soon.</p>"));
