// Server-side checks for account forms (Law 19). The browser's own checks are never trusted.

export type FieldErrors = Record<string, string>;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
  const digits = input.phone.replace(/[\s+-]/g, "");
  if (!/^\d{10,15}$/.test(digits)) {
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
