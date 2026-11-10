// Security headers for every response (Law 19). Each area gets the strictest policy it can work with.

const STRICT_POLICY =
  "default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

// The owner area also loads Cloudflare Turnstile on its signup form.
const OWNER_POLICY =
  "default-src 'none'; script-src https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

// The home page also needs Google Fonts and its own script.
const SITE_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export type Area = "site" | "owner" | "admin";

export function withSecurityHeaders(response: Response, area: Area | null): Response {
  // Responses from the asset service are immutable, so copy before changing headers.
  const secured = new Response(response.body, response);
  const { headers } = secured;
  headers.set("Content-Security-Policy", area === "site" ? SITE_POLICY : area === "owner" ? OWNER_POLICY : STRICT_POLICY);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  headers.set("Strict-Transport-Security", "max-age=31536000");
  if (area !== "site") {
    headers.set("X-Robots-Tag", "noindex");
  }
  return secured;
}
