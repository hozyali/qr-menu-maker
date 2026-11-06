import { adminApp } from "./admin";
import { ownerApp } from "./owner";
import { type Area, withSecurityHeaders } from "./shared/security-headers";
import { siteApp } from "./site";

// Only exact hostnames are accepted, so an unknown hostname can never reach an area.
const AREAS: Record<string, Area> = {
  "tomatofry.com": "site",
  "app.tomatofry.com": "owner",
  "admin.tomatofry.com": "admin",
  // Local development with `wrangler dev`.
  localhost: "site",
  "app.localhost": "owner",
  "admin.localhost": "admin",
};

const APPS = { site: siteApp, owner: ownerApp, admin: adminApp };

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const area = AREAS[new URL(request.url).hostname] ?? null;
  const response = area
    ? await APPS[area].fetch(request, env)
    : new Response("Not found", { status: 404 });
  return withSecurityHeaders(response, area);
}

export default {
  fetch: handleRequest,
} satisfies ExportedHandler<Env>;
