// Password hashing with PBKDF2-SHA256 from Web Crypto (Law 19).
// 100,000 iterations is the most the Workers runtime allows for PBKDF2.
const ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BITS = 256;

const encoder = new TextEncoder();

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, HASH_BITS);
  return new Uint8Array(bits);
}

/** Returns "pbkdf2-sha256$<iterations>$<salt>$<hash>", so the settings can change later without breaking old hashes. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt, ITERATIONS);
  return `pbkdf2-sha256$${ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iterationText, saltText, hashText] = stored.split("$");
  const iterations = Number(iterationText);
  if (scheme !== "pbkdf2-sha256" || !saltText || !hashText || !Number.isInteger(iterations) || iterations < 1) {
    return false;
  }
  const expected = fromBase64(hashText);
  const actual = await derive(password, fromBase64(saltText), iterations);
  // Constant-time comparison, so the response time does not reveal how much of the hash matched.
  return actual.byteLength === expected.byteLength && crypto.subtle.timingSafeEqual(actual, expected);
}

// Used when an email is unknown, so a failed login takes the same time either way.
let dummyHash: Promise<string> | undefined;
export function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword("not a real password");
  return dummyHash;
}
