import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encode } from "uqr";
import { menuUrl } from "../src/shared/menu-link";
import { codeOf, db, get, newOwner, passTurnstile, post } from "./helpers";

beforeEach(() => passTurnstile());
afterEach(() => vi.restoreAllMocks());


interface DecodedPng {
  width: number;
  height: number;
  colorType: number;
  bitDepth: number;
  /** One byte per pixel, 0 black and 255 white. */
  pixels: Uint8Array;
}

/** A small PNG reader for 8-bit grayscale images, so the test can check every pixel. */
async function decodePng(bytes: Uint8Array): Promise<DecodedPng> {
  expect([...bytes.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  let bitDepth = -1;
  const idat: Uint8Array[] = [];
  while (offset < bytes.length) {
    const length = view.getUint32(offset);
    const type = new TextDecoder().decode(bytes.slice(offset + 4, offset + 8));
    const data = bytes.slice(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      bitDepth = data[8] ?? -1;
      colorType = data[9] ?? -1;
    }
    if (type === "IDAT") idat.push(data);
    offset += 12 + length;
  }
  const stream = new Blob(idat).stream().pipeThrough(new DecompressionStream("deflate"));
  const raw = new Uint8Array(await new Response(stream).arrayBuffer());
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    // Each row starts with a filter byte. The encoder uses filter 0 (none).
    expect(raw[y * (width + 1)]).toBe(0);
    pixels.set(raw.slice(y * (width + 1) + 1, (y + 1) * (width + 1)), y * width);
  }
  return { width, height, colorType, bitDepth, pixels };
}

describe("QR code", () => {
  it("needs a login", async () => {
    for (const path of ["/qr", "/qr.png", "/qr/print"]) {
      const response = await get(path);
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/login");
    }
  });

  it("always points to the restaurant's permanent code on tomatofry.com", () => {
    expect(menuUrl("k7x2p9")).toBe("https://tomatofry.com/r/k7x2p9");
  });

  it("downloads a PNG that encodes exactly the menu link", async () => {
    const owner = await newOwner("QR Png");
    const code = await codeOf(owner.restaurantId);
    const response = await get("/qr.png", owner.cookie);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-disposition")).toBe(`attachment; filename="menu-qr-${code}.png"`);
    // A cached old image could carry an old link, so the download is never cached.
    expect(response.headers.get("cache-control")).toBe("no-store");

    const png = await decodePng(new Uint8Array(await response.arrayBuffer()));
    expect(png.colorType).toBe(0);
    expect(png.bitDepth).toBe(8);
    expect(png.width).toBe(png.height);
    expect(png.width).toBeGreaterThanOrEqual(1000);

    // Rebuild the expected QR from the link and compare the centre of every module.
    const expected = encode(`https://tomatofry.com/r/${code}`, { ecc: "Q", border: 4 }).data;
    const scale = png.width / expected.length;
    expect(Number.isInteger(scale)).toBe(true);
    expected.forEach((row, y) =>
      row.forEach((dark, x) => {
        const px = png.pixels[Math.floor((y + 0.5) * scale) * png.width + Math.floor((x + 0.5) * scale)];
        expect(px).toBe(dark ? 0 : 255);
      }),
    );
  });

  it("ignores any code or id in the request", async () => {
    const a = await newOwner("QR Owner A");
    const b = await newOwner("QR Owner B");
    const bCode = await codeOf(b.restaurantId);
    const aCode = await codeOf(a.restaurantId);
    const response = await get(`/qr.png?code=${bCode}&id=${b.restaurantId}`, a.cookie);
    expect(response.headers.get("content-disposition")).toContain(aCode);
    const page = await (await get(`/qr?code=${bCode}`, a.cookie)).text();
    expect(page).toContain(`tomatofry.com/r/${aCode}`);
    expect(page).not.toContain(bCode);
  });

  it("shows the QR page with the link, a download, and the print card", async () => {
    const owner = await newOwner("QR Page");
    const code = await codeOf(owner.restaurantId);
    const body = await (await get("/qr", owner.cookie)).text();
    expect(body).toContain(`https://tomatofry.com/r/${code}`);
    expect(body).toContain('href="/qr.png"');
    expect(body).toContain('href="/qr/print"');
    expect(body).toMatch(/<svg[^>]*role="img"/);
  });

  it("prints a table card with the name, logo, QR, and scan text", async () => {
    const owner = await newOwner("QR Print <b>");
    const code = await codeOf(owner.restaurantId);
    const body = await (await get("/qr/print", owner.cookie)).text();
    expect(body).toContain("Scan for menu");
    expect(body).toContain(`tomatofry.com/r/${code}`);
    expect(body).toContain("QR Print &lt;b&gt;");
    expect(body).toMatch(/<svg[^>]*role="img"/);
  });

  it("keeps the same QR when a Pro plan expires", async () => {
    const owner = await newOwner("QR Expired");
    const before = new Uint8Array(await (await get("/qr.png", owner.cookie)).arrayBuffer());
    await db.prepare("UPDATE restaurants SET plan = 'pro', plan_expires_at = 1 WHERE id = ?").bind(owner.restaurantId).run();
    await post("/profile", { name: "Renamed Place", city: "Karachi", phone: "0300 1234567" }, owner.cookie);
    const after = new Uint8Array(await (await get("/qr.png", owner.cookie)).arrayBuffer());
    expect(after).toEqual(before);
  });
});
