// Server-side checks for account forms (Law 19). The browser's own checks are never trusted.

export type FieldErrors = Record<string, string>;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** 10 to 15 digits. Spaces, dashes, and a leading + are allowed. */
export function isPhone(value: string): boolean {
  return /^\+?[\d\s-]+$/.test(value) && /^\d{10,15}$/.test(value.replace(/[\s+-]/g, ""));
}

export function readText(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export interface SignupInput {
  email: string;
  password: string;
  phone: string;
  restaurant: string;
  city: string;
}

export function validateSignup(input: SignupInput): FieldErrors {
  const errors: FieldErrors = {};
  if (input.email.length > 254 || !EMAIL_PATTERN.test(input.email)) {
    errors.email = "Enter a valid email address.";
  }
  if (input.password.length < 10 || input.password.length > 128) {
    errors.password = "Use 10 to 128 characters.";
  }
  if (!isPhone(input.phone)) {
    errors.phone = "Enter a phone number with 10 to 15 digits.";
  }
  if (input.restaurant.length < 2 || input.restaurant.length > 60) {
    errors.restaurant = "Use 2 to 60 characters.";
  } else if (!slugify(input.restaurant)) {
    // The permanent menu link is built from English letters and numbers.
    errors.restaurant = "Include some English letters or numbers, so we can make your menu link.";
  }
  if (input.city.length < 2 || input.city.length > 40 || !slugify(input.city)) {
    errors.city = "Enter your city in English letters.";
  }
  return errors;
}

export interface ProfileInput {
  name: string;
  city: string;
  address: string;
  phone: string;
  whatsapp: string;
  mapsUrl: string;
  hours: string;
  note: string;
}

// Google Maps share links come in these forms. Any other host is refused, so the public menu can
// never send customers to another site (Law 17).
const MAPS_ANY_PATH = new Set(["maps.app.goo.gl", "maps.google.com"]);
const MAPS_UNDER_PATH = new Set(["google.com", "www.google.com", "google.com.pk", "www.google.com.pk", "goo.gl"]);

export function isGoogleMapsUrl(value: string): boolean {
  if (value.length > 500) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  return MAPS_ANY_PATH.has(url.hostname) || (MAPS_UNDER_PATH.has(url.hostname) && url.pathname.startsWith("/maps"));
}

export function validateProfile(input: ProfileInput): FieldErrors {
  const errors: FieldErrors = {};
  if (input.name.length < 2 || input.name.length > 60) errors.name = "Use 2 to 60 characters.";
  if (input.city.length < 2 || input.city.length > 40) errors.city = "Use 2 to 40 characters.";
  if (input.address.length > 160) errors.address = "Keep the address to 160 characters.";
  if (!isPhone(input.phone)) errors.phone = "Enter a phone number with 10 to 15 digits.";
  if (input.whatsapp && !isPhone(input.whatsapp)) errors.whatsapp = "Enter a WhatsApp number with 10 to 15 digits, or leave it empty.";
  if (input.mapsUrl && !isGoogleMapsUrl(input.mapsUrl)) errors.maps_url = "Use a Google Maps link, like https://maps.app.goo.gl/... Links to other sites are not allowed.";
  if (input.hours.length > 80) errors.hours = "Keep the hours to 80 characters.";
  if (input.note.length > 200) errors.note = "Keep the note to 200 characters.";
  return errors;
}
