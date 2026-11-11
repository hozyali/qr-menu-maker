// Photo uploads and serving (Law 19). Files live in R2 under restaurants/<restaurant_id>/ (Law 18).

/** Larger files are refused. The browser shrinks photos to about 100 KB before upload. */
export const MAX_PHOTO_BYTES = 1024 * 1024;

export interface ImageType {
  contentType: "image/jpeg" | "image/png" | "image/webp";
  extension: "jpg" | "png" | "webp";
}

/** Reads the file's first bytes. The name and the browser's type claim are never trusted. SVG is never accepted. */
export function detectImage(bytes: Uint8Array): ImageType | null {
  const starts = (...values: number[]) => values.every((value, index) => bytes[index] === value);
  if (starts(0xff, 0xd8, 0xff)) return { contentType: "image/jpeg", extension: "jpg" };
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { contentType: "image/png", extension: "png" };
  // "RIFF" at 0 and "WEBP" at 8.
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return { contentType: "image/webp", extension: "webp" };
  }
  return null;
}

export type UploadCheck =
  | { ok: true; bytes: Uint8Array; type: ImageType }
  | { ok: false; error: string };

/** The same upload checks for dish photos and logos: present, at most 1 MB, and a real JPG, PNG, or WEBP. */
export async function checkImageUpload(file: File | string | null): Promise<UploadCheck> {
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choose a photo first." };
  if (file.size > MAX_PHOTO_BYTES) return { ok: false, error: "The photo is larger than 1 MB. Try a smaller one." };
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = detectImage(bytes);
  if (!type) return { ok: false, error: "Use a JPG, PNG, or WEBP photo." };
  return { ok: true, bytes, type };
}

export function newPhotoKey(restaurantId: string, type: ImageType): string {
  return `restaurants/${restaurantId}/${crypto.randomUUID()}.${type.extension}`;
}

// Only keys this app creates can be served, so nothing else stored in the bucket is reachable.
const PHOTO_KEY = /^restaurants\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(webp|jpg|png)$/;

/** Photos are public menu content behind random names, so no login is needed to view them. */
export async function serveMedia(bucket: R2Bucket, path: string): Promise<Response> {
  const key = path.replace(/^\/media\//, "");
  if (!PHOTO_KEY.test(key)) {
    return new Response("Not found", { status: 404 });
  }
  const object = await bucket.get(key);
  if (!object) {
    return new Response("Not found", { status: 404 });
  }
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  // A key is never reused for different content, so browsers can keep the file for a year.
  headers.set("cache-control", "public, max-age=31536000, immutable");
  return new Response(object.body, { headers });
}

export async function deletePhotos(bucket: R2Bucket, keys: (string | null)[]): Promise<void> {
  const present = keys.filter((key): key is string => Boolean(key));
  // R2 deletes up to 1000 keys per call.
  for (let i = 0; i < present.length; i += 1000) {
    await bucket.delete(present.slice(i, i + 1000));
  }
}
