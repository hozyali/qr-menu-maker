import { slugify } from "./validation";

// Menu links (issue #32): tomatofry.com/r/<code>/<name-city>.
// Only the code finds the restaurant. The name part is for people and search engines and is never
// read, so the name and city can change while printed QR codes keep working (Law 28).
export const MENU_ORIGIN = "https://tomatofry.com";

// No look-alike characters (0, 1, i, l, o), so a code read aloud or typed from a card is not mistaken.
const ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
const CODE_LENGTH = 6;
export const MENU_CODE = /^[23456789abcdefghjkmnpqrstuvwxyz]{6}$/;

/** A new random code. Bytes of 248 and above are skipped, so every character is equally likely. */
export function newMenuCode(): string {
  let code = "";
  while (code.length < CODE_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
      if (byte < 248 && code.length < CODE_LENGTH) code += ALPHABET[byte % ALPHABET.length];
    }
  }
  return code;
}

/** The short permanent link that QR codes use. */
export function menuUrl(code: string): string {
  return `${MENU_ORIGIN}/r/${code}`;
}

/** The link with the current name and city, for sharing and search engines. */
export function menuPath(code: string, name: string, city: string | null): string {
  const words = slugify(`${name} ${city ?? ""}`).slice(0, 80).replace(/-+$/, "");
  return words ? `/r/${code}/${words}` : `/r/${code}`;
}

export function menuLink(code: string, name: string, city: string | null): string {
  return `${MENU_ORIGIN}${menuPath(code, name, city)}`;
}
