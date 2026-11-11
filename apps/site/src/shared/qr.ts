import { encode } from "uqr";

// Menu QR codes (issue #30).
// A printed QR code must work for as long as the restaurant exists (Law 28), so it always uses our
// own domain and the permanent slug, never the request's host or a workers.dev address.
export const MENU_ORIGIN = "https://tomatofry.com";

export function menuUrl(slug: string): string {
  return `${MENU_ORIGIN}/r/${slug}`;
}

// Level Q recovers about 25% damage, for cards that get stained or worn on tables.
// A border of 4 modules is the quiet zone that scanners need around the code.
function qrMatrix(text: string): boolean[][] {
  return encode(text, { ecc: "Q", border: 4 }).data;
}

/** One SVG path for all dark modules, drawn on a grid of 1 unit per module. */
export function qrSvg(text: string, label: string): string {
  const matrix = qrMatrix(text);
  const size = matrix.length;
  let d = "";
  matrix.forEach((row, y) => row.forEach((dark, x) => {
    if (dark) d += `M${x} ${y}h1v1h-1z`;
  }));
  // The path holds only numbers and the label is escaped here, so the SVG is safe to place in a page.
  const safeLabel = label.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  return `<svg class="qr" role="img" aria-label="${safeLabel}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#ffffff"/><path d="${d}" fill="#000000"/></svg>`;
}

// CRC-32 for PNG chunks, as defined in the PNG specification.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * A black-and-white PNG of the QR code, at least 1,000 pixels wide, sharp enough for print.
 * It is an 8-bit grayscale image, compressed with the runtime's own zlib stream, so no image library is needed.
 */
export async function qrPng(text: string, minPixels = 1000): Promise<Uint8Array> {
  const matrix = qrMatrix(text);
  const scale = Math.max(1, Math.ceil(minPixels / matrix.length));
  const width = matrix.length * scale;

  // Each row is a filter byte (0, none) followed by one byte per pixel: 0 black, 255 white.
  const raw = new Uint8Array((width + 1) * width);
  matrix.forEach((row, y) => {
    const line = new Uint8Array(width + 1);
    row.forEach((dark, x) => line.fill(dark ? 0 : 255, 1 + x * scale, 1 + (x + 1) * scale));
    for (let i = 0; i < scale; i++) raw.set(line, (y * scale + i) * (width + 1));
  });
  const compressed = new Uint8Array(
    await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer(),
  );

  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, width);
  header[8] = 8; // bit depth
  header[9] = 0; // grayscale
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", compressed),
    chunk("IEND", new Uint8Array(0)),
  ];
  const png = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}
