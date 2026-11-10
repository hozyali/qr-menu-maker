// Menu theme: the owner picks any brand colour, and the text colours are worked out here so the
// menu always stays readable (Law 15, WCAG 2.1 AA contrast of 4.5:1 for normal text).

export type ThemeMode = "light" | "dark";
export type PhotoSize = "large" | "small";

export interface Theme {
  color: string;
  mode: ThemeMode;
  photoSize: PhotoSize;
}

export const DEFAULT_THEME: Theme = { color: "#c8321f", mode: "light", photoSize: "large" };

const HEX = /^#[0-9a-f]{6}$/;
const MIN_CONTRAST = 4.5;

const PALETTES = {
  light: { background: "#f6f5f1", surface: "#ffffff", ink: "#161412", muted: "#4d4a45", line: "#e2e0da" },
  dark: { background: "#141311", surface: "#1f1d1a", ink: "#f4f2ee", muted: "#bdb8b0", line: "#34312c" },
} as const;

export function isHexColor(value: string): boolean {
  return HEX.test(value);
}

/** Reads a theme from stored values. Anything unexpected falls back to the default. */
export function toTheme(color: unknown, mode: unknown, photoSize: unknown): Theme {
  return {
    color: typeof color === "string" && isHexColor(color) ? color : DEFAULT_THEME.color,
    mode: mode === "dark" ? "dark" : "light",
    photoSize: photoSize === "small" ? "small" : "large",
  };
}

function channels(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

function toHex(rgb: number[]): string {
  return `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
}

// Relative luminance, as defined by WCAG 2.1.
function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

function mix(from: string, to: string, amount: number): string {
  const a = channels(from);
  const b = channels(to);
  return toHex(a.map((v, i) => v + ((b[i] ?? 0) - v) * amount));
}

export interface ThemeColors {
  brand: string;
  /** Text placed on top of the brand colour: black or white, whichever is easier to read. */
  onBrand: string;
  /** The brand colour, darkened or lightened only as far as needed for readable text. */
  accentText: string;
  /** True when accentText had to be changed from the brand colour. */
  adjusted: boolean;
  background: string;
  surface: string;
  ink: string;
  muted: string;
  line: string;
}

export function themeColors(color: string, mode: ThemeMode): ThemeColors {
  const brand = isHexColor(color) ? color : DEFAULT_THEME.color;
  const palette = PALETTES[mode];
  const onBrand = contrastRatio(brand, "#000000") >= contrastRatio(brand, "#ffffff") ? "#000000" : "#ffffff";

  // Text in the brand colour sits on both the page background and the cards, so it must pass on both.
  const readable = (hex: string) =>
    Math.min(contrastRatio(hex, palette.background), contrastRatio(hex, palette.surface)) >= MIN_CONTRAST;
  const target = mode === "light" ? "#000000" : "#ffffff";
  let accentText = brand;
  for (let step = 1; !readable(accentText) && step <= 20; step++) {
    accentText = mix(brand, target, step / 20);
  }
  return { brand, onBrand, accentText, adjusted: accentText !== brand, ...palette };
}

/** The menu stylesheet for one restaurant. Every value comes from themeColors, never raw input. */
export function themeCss(theme: Theme): string {
  const c = themeColors(theme.color, theme.mode);
  return `:root{--brand:${c.brand};--on-brand:${c.onBrand};--accent-text:${c.accentText};--bg:${c.background};--surface:${c.surface};--ink:${c.ink};--muted:${c.muted};--line:${c.line};color-scheme:${theme.mode}}\n`;
}
