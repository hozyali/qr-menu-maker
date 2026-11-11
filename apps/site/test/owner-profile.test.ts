import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleRequest } from "../src/index";
import { APP, db, get, newOwner, passTurnstile, post } from "./helpers";

beforeEach(() => passTurnstile());
afterEach(() => vi.restoreAllMocks());

const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x10, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20, 1, 2, 3, 4]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 1, 2]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

const site = (path: string) => handleRequest(new Request(`https://tomatofry.com${path}`), env);

function uploadLogo(bytes: Uint8Array, name: string, type: string, cookie: string) {
  const form = new FormData();
  form.append("logo", new File([bytes], name, { type }));
  const headers = new Headers({ origin: APP, cookie, "cf-connecting-ip": "192.0.2.20" });
  return handleRequest(new Request(`${APP}/profile/logo`, { method: "POST", headers, body: form }), env);
}

async function restaurant(id: string) {
  return db
    .prepare("SELECT name, menu_code, city, address, phone, whatsapp, maps_url, hours, note, logo_key FROM restaurants WHERE id = ?")
    .bind(id)
    .first<Record<string, string | null>>();
}

/** A restaurant with one dish, so its public menu has content. */
async function ownerWithDish(name: string) {
  const owner = await newOwner(name);
  await post("/categories", { name: "Karahi" }, owner.cookie);
  const category = await db.prepare("SELECT id FROM categories WHERE restaurant_id = ?").bind(owner.restaurantId).first<{ id: string }>();
  await post("/items", { category_id: category?.id ?? "", name: "Chicken karahi", price_label: [""], price_amount: ["1300"] }, owner.cookie);
  return owner;
}

const FULL_PROFILE = {
  name: "Profile Karahi House",
  city: "Lahore",
  address: "12 Food Street, Gulberg",
  phone: "0300 1234567",
  whatsapp: "0321 7654321",
  maps_url: "https://maps.app.goo.gl/AbCdEf123",
  hours: "Daily 12 pm to 1 am",
  note: "Prices include tax.",
};

describe("restaurant profile", () => {
  it("needs a login", async () => {
    const response = await get("/profile");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/login");
  });

  it("shows the current details", async () => {
    const owner = await newOwner("Profile Show");
    const body = await (await get("/profile", owner.cookie)).text();
    expect(body).toContain("Profile Show");
    expect(body).toContain("0300 1234567");
  });

  it("saves the details and shows them on the public menu", async () => {
    const owner = await ownerWithDish("Profile Save");
    const response = await post("/profile", FULL_PROFILE, owner.cookie);
    expect(response.status).toBe(303);
    const row = await restaurant(owner.restaurantId);
    expect(row).toMatchObject({ name: "Profile Karahi House", address: "12 Food Street, Gulberg", whatsapp: "0321 7654321", note: "Prices include tax." });

    const menu = await (await site(`/r/${row?.menu_code}`)).text();
    expect(menu).toContain("Profile Karahi House");
    expect(menu).toContain("12 Food Street, Gulberg");
    expect(menu).toContain("Daily 12 pm to 1 am");
    expect(menu).toContain("Prices include tax.");
    expect(menu).toContain('href="https://wa.me/923217654321"');
    expect(menu).toContain('href="https://maps.app.goo.gl/AbCdEf123"');
  });

  it("never changes the menu code when the name or city changes", async () => {
    const owner = await newOwner("Profile Code");
    const before = (await restaurant(owner.restaurantId))?.menu_code;
    await post("/profile", { ...FULL_PROFILE, name: "A New Name", city: "Karachi" }, owner.cookie);
    const after = await restaurant(owner.restaurantId);
    expect(after?.menu_code).toBe(before);
    expect(after?.name).toBe("A New Name");
  });

  it("clears empty optional fields", async () => {
    const owner = await ownerWithDish("Profile Clear");
    await post("/profile", FULL_PROFILE, owner.cookie);
    await post("/profile", { ...FULL_PROFILE, whatsapp: "", maps_url: "", hours: "", note: "", address: "" }, owner.cookie);
    const row = await restaurant(owner.restaurantId);
    expect(row).toMatchObject({ whatsapp: null, maps_url: null, hours: null, note: null, address: null });
    const menu = await (await site(`/r/${row?.menu_code}`)).text();
    expect(menu).not.toContain("wa.me");
  });

  it.each([
    ["a script link", "javascript:alert(1)"],
    ["a plain http link", "http://maps.google.com/?q=lahore"],
    ["a link to another site", "https://evil.example/maps"],
    ["a look-alike host", "https://maps.google.com.evil.example/x"],
  ])("refuses %s as the Maps link", async (_label, mapsUrl) => {
    const owner = await newOwner("Profile Maps");
    const response = await post("/profile", { ...FULL_PROFILE, maps_url: mapsUrl }, owner.cookie);
    expect(response.status).toBe(400);
    expect((await restaurant(owner.restaurantId))?.maps_url).toBeNull();
  });

  it("accepts the usual Google Maps link forms", async () => {
    const owner = await newOwner("Profile Maps Ok");
    for (const url of ["https://www.google.com/maps/place/Lahore", "https://maps.google.com/?q=31.5,74.3", "https://goo.gl/maps/xyz"]) {
      expect((await post("/profile", { ...FULL_PROFILE, maps_url: url }, owner.cookie)).status).toBe(303);
    }
  });

  it.each([
    ["an empty name", { name: "" }],
    ["a long name", { name: "x".repeat(61) }],
    ["a phone with too few digits", { phone: "12345" }],
    ["a WhatsApp number with letters", { whatsapp: "call me" }],
    ["a long note", { note: "x".repeat(201) }],
    ["long hours", { hours: "x".repeat(81) }],
  ])("refuses %s", async (_label, change) => {
    const owner = await newOwner("Profile Refuse");
    const before = await restaurant(owner.restaurantId);
    expect((await post("/profile", { ...FULL_PROFILE, ...change }, owner.cookie)).status).toBe(400);
    expect(await restaurant(owner.restaurantId)).toEqual(before);
  });

  it("changes only the logged-in owner's restaurant", async () => {
    const a = await newOwner("Profile A");
    const b = await newOwner("Profile B");
    const before = await restaurant(b.restaurantId);
    // A restaurant id in the form is ignored. The restaurant comes from the session only.
    await post("/profile", { ...FULL_PROFILE, restaurant_id: b.restaurantId, id: b.restaurantId }, a.cookie);
    expect(await restaurant(b.restaurantId)).toEqual(before);
    expect((await restaurant(a.restaurantId))?.name).toBe("Profile Karahi House");
  });
});

describe("restaurant logo", () => {
  it("stores the logo under the owner's restaurant and shows it on the menu", async () => {
    const owner = await ownerWithDish("Logo Show");
    expect((await uploadLogo(WEBP, "logo.webp", "image/webp", owner.cookie)).status).toBe(303);
    const row = await restaurant(owner.restaurantId);
    expect(row?.logo_key).toMatch(new RegExp(`^restaurants/${owner.restaurantId}/[0-9a-f-]{36}\\.webp$`));
    expect(await env.MEDIA.head(row?.logo_key ?? "")).not.toBeNull();
    expect(await (await site(`/r/${row?.menu_code}`)).text()).toContain(`src="/media/${row?.logo_key}"`);
  });

  it("refuses an SVG, even with an image name", async () => {
    const owner = await newOwner("Logo Svg");
    expect((await uploadLogo(SVG, "logo.svg", "image/svg+xml", owner.cookie)).status).toBe(400);
    expect((await uploadLogo(SVG, "logo.png", "image/png", owner.cookie)).status).toBe(400);
    expect((await restaurant(owner.restaurantId))?.logo_key).toBeNull();
  });

  it("refuses a file over 1 MB", async () => {
    const owner = await newOwner("Logo Big");
    const big = new Uint8Array(1024 * 1024 + 1);
    big.set(PNG);
    expect((await uploadLogo(big, "big.png", "image/png", owner.cookie)).status).toBe(400);
    expect((await restaurant(owner.restaurantId))?.logo_key).toBeNull();
  });

  it("deletes the old file when the logo is replaced", async () => {
    const owner = await newOwner("Logo Replace");
    await uploadLogo(WEBP, "1.webp", "image/webp", owner.cookie);
    const first = (await restaurant(owner.restaurantId))?.logo_key ?? "";
    await uploadLogo(PNG, "2.png", "image/png", owner.cookie);
    expect((await restaurant(owner.restaurantId))?.logo_key).toMatch(/\.png$/);
    expect(await env.MEDIA.head(first)).toBeNull();
  });

  it("removes the logo and its file", async () => {
    const owner = await newOwner("Logo Remove");
    await uploadLogo(WEBP, "1.webp", "image/webp", owner.cookie);
    const key = (await restaurant(owner.restaurantId))?.logo_key ?? "";
    expect((await post("/profile/logo/delete", {}, owner.cookie)).status).toBe(303);
    expect((await restaurant(owner.restaurantId))?.logo_key).toBeNull();
    expect(await env.MEDIA.head(key)).toBeNull();
  });

  it("never touches another owner's logo", async () => {
    const a = await newOwner("Logo A");
    const b = await newOwner("Logo B");
    await uploadLogo(WEBP, "b.webp", "image/webp", b.cookie);
    const bKey = (await restaurant(b.restaurantId))?.logo_key ?? "";
    await uploadLogo(PNG, "a.png", "image/png", a.cookie);
    await post("/profile/logo/delete", {}, a.cookie);
    expect((await restaurant(b.restaurantId))?.logo_key).toBe(bKey);
    expect(await env.MEDIA.head(bKey)).not.toBeNull();
  });
});
