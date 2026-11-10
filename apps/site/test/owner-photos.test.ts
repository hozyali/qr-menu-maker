import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleRequest } from "../src/index";
import { APP, db, get, newOwner, passTurnstile, post } from "./helpers";

beforeEach(() => passTurnstile());
afterEach(() => vi.restoreAllMocks());

// The first bytes of each file type. The server checks these, not the file name.
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x10, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20, 1, 2, 3, 4]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 1, 2, 3]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 1, 2]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

function upload(path: string, bytes: Uint8Array, name: string, type: string, cookie: string) {
  const form = new FormData();
  form.append("photo", new File([bytes], name, { type }));
  const headers = new Headers({ origin: APP, cookie, "cf-connecting-ip": "192.0.2.10" });
  return handleRequest(new Request(`${APP}${path}`, { method: "POST", headers, body: form }), env);
}

async function ownerWithDish(name = "Photo Kitchen") {
  const owner = await newOwner(name);
  await post("/categories", { name: "Karahi" }, owner.cookie);
  const category = await db
    .prepare("SELECT id FROM categories WHERE restaurant_id = ?")
    .bind(owner.restaurantId)
    .first<{ id: string }>();
  const dishName = `Dish ${owner.restaurantId}`;
  await post("/items", { category_id: category?.id ?? "", name: dishName, price_label: [""], price_amount: ["100"] }, owner.cookie);
  const item = await db.prepare("SELECT id FROM items WHERE name = ?").bind(dishName).first<{ id: string }>();
  return { ...owner, categoryId: category?.id ?? "", itemId: item?.id ?? "" };
}

const photoKey = async (itemId: string) =>
  (await db.prepare("SELECT photo_key FROM items WHERE id = ?").bind(itemId).first<{ photo_key: string | null }>())?.photo_key ?? null;

describe("uploading a dish photo", () => {
  it("stores a WEBP photo under the owner's restaurant", async () => {
    const owner = await ownerWithDish();
    const response = await upload(`/items/${owner.itemId}/photo`, WEBP, "karahi.webp", "image/webp", owner.cookie);
    expect(response.status).toBe(303);
    const key = await photoKey(owner.itemId);
    expect(key).toMatch(new RegExp(`^restaurants/${owner.restaurantId}/[0-9a-f-]{36}\\.webp$`));
    const object = await env.MEDIA.get(key ?? "");
    expect(new Uint8Array(await object!.arrayBuffer())).toEqual(WEBP);
    expect(object?.httpMetadata?.contentType).toBe("image/webp");
  });

  it("accepts JPG and PNG", async () => {
    const owner = await ownerWithDish();
    expect((await upload(`/items/${owner.itemId}/photo`, JPEG, "a.jpg", "image/jpeg", owner.cookie)).status).toBe(303);
    expect(await photoKey(owner.itemId)).toMatch(/\.jpg$/);
    expect((await upload(`/items/${owner.itemId}/photo`, PNG, "a.png", "image/png", owner.cookie)).status).toBe(303);
    expect(await photoKey(owner.itemId)).toMatch(/\.png$/);
  });

  it("refuses SVG, even when it claims to be a PNG", async () => {
    const owner = await ownerWithDish();
    expect((await upload(`/items/${owner.itemId}/photo`, SVG, "a.svg", "image/svg+xml", owner.cookie)).status).toBe(400);
    expect((await upload(`/items/${owner.itemId}/photo`, SVG, "a.png", "image/png", owner.cookie)).status).toBe(400);
    expect(await photoKey(owner.itemId)).toBeNull();
  });

  it("refuses a file larger than 1 MB", async () => {
    const owner = await ownerWithDish();
    const big = new Uint8Array(1024 * 1024 + 1);
    big.set(JPEG);
    expect((await upload(`/items/${owner.itemId}/photo`, big, "big.jpg", "image/jpeg", owner.cookie)).status).toBe(400);
    expect(await photoKey(owner.itemId)).toBeNull();
  });

  it("deletes the old file when the photo is replaced", async () => {
    const owner = await ownerWithDish();
    await upload(`/items/${owner.itemId}/photo`, WEBP, "1.webp", "image/webp", owner.cookie);
    const first = await photoKey(owner.itemId);
    await upload(`/items/${owner.itemId}/photo`, JPEG, "2.jpg", "image/jpeg", owner.cookie);
    expect(await photoKey(owner.itemId)).not.toBe(first);
    expect(await env.MEDIA.head(first ?? "")).toBeNull();
  });

  it("removes a photo and its file", async () => {
    const owner = await ownerWithDish();
    await upload(`/items/${owner.itemId}/photo`, WEBP, "1.webp", "image/webp", owner.cookie);
    const key = await photoKey(owner.itemId);
    await post(`/items/${owner.itemId}/photo/delete`, {}, owner.cookie);
    expect(await photoKey(owner.itemId)).toBeNull();
    expect(await env.MEDIA.head(key ?? "")).toBeNull();
  });

  it("deletes the file when the dish is deleted", async () => {
    const owner = await ownerWithDish();
    await upload(`/items/${owner.itemId}/photo`, WEBP, "1.webp", "image/webp", owner.cookie);
    const key = await photoKey(owner.itemId);
    await post(`/items/${owner.itemId}/delete`, {}, owner.cookie);
    expect(await env.MEDIA.head(key ?? "")).toBeNull();
  });

  it("deletes the files when the category is deleted", async () => {
    const owner = await ownerWithDish();
    await upload(`/items/${owner.itemId}/photo`, WEBP, "1.webp", "image/webp", owner.cookie);
    const key = await photoKey(owner.itemId);
    await post(`/categories/${owner.categoryId}/delete`, {}, owner.cookie);
    expect(await env.MEDIA.head(key ?? "")).toBeNull();
  });

  it("shows the photo on the dashboard", async () => {
    const owner = await ownerWithDish();
    await upload(`/items/${owner.itemId}/photo`, WEBP, "1.webp", "image/webp", owner.cookie);
    const key = await photoKey(owner.itemId);
    expect(await (await get("/", owner.cookie)).text()).toContain(`/media/${key}`);
  });
});

describe("tenant isolation for photos (Law 18)", () => {
  it("does not let Owner A add or remove a photo on Owner B's dish", async () => {
    const a = await ownerWithDish("Photo A");
    const b = await ownerWithDish("Photo B");
    await upload(`/items/${b.itemId}/photo`, WEBP, "b.webp", "image/webp", b.cookie);
    const bKey = await photoKey(b.itemId);

    const attempt = await upload(`/items/${b.itemId}/photo`, JPEG, "a.jpg", "image/jpeg", a.cookie);
    expect(attempt.status).toBe(404);
    await post(`/items/${b.itemId}/photo/delete`, {}, a.cookie);
    expect(await photoKey(b.itemId)).toBe(bKey);
    expect(await env.MEDIA.head(bKey ?? "")).not.toBeNull();

    const aFiles = await env.MEDIA.list({ prefix: `restaurants/${a.restaurantId}/` });
    expect(aFiles.objects).toHaveLength(0);
  });
});

describe("serving photos", () => {
  it("serves a stored photo with long caching", async () => {
    const owner = await ownerWithDish();
    await upload(`/items/${owner.itemId}/photo`, WEBP, "1.webp", "image/webp", owner.cookie);
    const key = await photoKey(owner.itemId);
    for (const host of ["https://tomatofry.com", APP]) {
      const response = await handleRequest(new Request(`${host}/media/${key}`), env);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/webp");
      expect(response.headers.get("cache-control")).toContain("immutable");
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(WEBP);
    }
  });

  it("only serves keys in the photo format", async () => {
    await env.MEDIA.put("private/secret.txt", "secret");
    for (const path of ["/media/private/secret.txt", "/media/restaurants/../private/secret.txt", "/media/restaurants/x/y.webp"]) {
      const response = await handleRequest(new Request(`https://tomatofry.com${path}`), env);
      expect(response.status).toBe(404);
    }
  });
});
