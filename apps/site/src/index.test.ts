import { describe, expect, it } from "vitest";
import { handleRequest } from "./index";

// The static asset service is the only outside dependency, so it is replaced with a small stand-in.
const LANDING = "landing page";
const env = {
  ASSETS: {
    fetch: async () => new Response(LANDING, { headers: { "content-type": "text/html" } }),
  },
} as unknown as Env;

const get = (url: string) => handleRequest(new Request(url), env);

describe("hostname routing", () => {
  it("serves the static site on the root domain", async () => {
    const response = await get("https://tomatofry.com/");
    expect(await response.text()).toBe(LANDING);
  });

  it("serves the owner area on the app hostname", async () => {
    const response = await get("https://app.tomatofry.com/login");
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("Log in");
    expect(body).not.toContain(LANDING);
  });

  it("serves the admin area on the admin hostname", async () => {
    // The admin home needs a login since issue #34, so the public login page is checked here.
    const response = await get("https://admin.tomatofry.com/login");
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("Admin log in");
    expect(body).not.toContain(LANDING);
  });

  it("does not serve static site files on the owner hostname", async () => {
    // Without a session the owner area sends visitors to the login page instead of any file.
    const response = await get("https://app.tomatofry.com/qr.svg");
    expect(response.status).not.toBe(200);
    expect(await response.text()).not.toContain(LANDING);
  });

  it("returns 404 for a hostname it does not know", async () => {
    const response = await get("https://other.example.com/");
    expect(response.status).toBe(404);
  });

  it("routes local development hostnames the same way", async () => {
    const response = await get("http://admin.localhost:8787/login");
    expect(await response.text()).toContain("Admin log in");
  });
});

describe("security headers", () => {
  const urls = [
    "https://tomatofry.com/",
    "https://app.tomatofry.com/",
    "https://admin.tomatofry.com/",
    "https://app.tomatofry.com/missing",
    "https://other.example.com/",
  ];

  it.each(urls)("are set on %s", async (url) => {
    const { headers } = await get(url);
    expect(headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(headers.get("x-content-type-options")).toBe("nosniff");
    expect(headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(headers.get("strict-transport-security")).toContain("max-age=");
    expect(headers.get("permissions-policy")).toContain("camera=()");
  });

  it("allows Google Fonts only on the static site", async () => {
    const site = await get("https://tomatofry.com/");
    const owner = await get("https://app.tomatofry.com/");
    expect(site.headers.get("content-security-policy")).toContain("fonts.googleapis.com");
    expect(owner.headers.get("content-security-policy")).not.toContain("fonts.googleapis.com");
  });

  it("keeps the owner and admin areas out of search engines", async () => {
    const owner = await get("https://app.tomatofry.com/");
    const admin = await get("https://admin.tomatofry.com/");
    expect(owner.headers.get("x-robots-tag")).toBe("noindex");
    expect(admin.headers.get("x-robots-tag")).toBe("noindex");
  });
});
