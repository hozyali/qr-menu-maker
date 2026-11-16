// Plan features (issue #38). Every feature and limit check goes through planAllows and planLimit,
// so the rest of the app never needs to know which plan has what (plan issue #1).
// Plans and their settings live in the database and are edited by the admin. This file only lists
// the features that exist, because the code is what turns each one on or off.

export const FEATURES = [
  { key: "max_items", type: "limit", label: "Dishes on the menu", description: "How many dishes the menu can have. Extra dishes cannot be added." },
  { key: "custom_theme", type: "switch", label: "Theme editor", description: "Pick a brand colour, a light or dark background, and the photo size." },
  { key: "hide_powered_by", type: "switch", label: "Remove Powered by TomatoFry", description: "Hides the TomatoFry line at the bottom of the public menu." },
  { key: "dish_photos", type: "switch", label: "Dish photos", description: "Upload a photo for each dish and show it on the menu." },
  { key: "logo", type: "switch", label: "Restaurant logo", description: "Upload a logo and show it at the top of the menu." },
] as const;

type Feature = (typeof FEATURES)[number];
export type SwitchKey = Extract<Feature, { type: "switch" }>["key"];
export type LimitKey = Extract<Feature, { type: "limit" }>["key"];
export type FeatureKey = Feature["key"];

export interface Entitlements {
  planId: string;
  planName: string;
  isFree: boolean;
  switches: Partial<Record<SwitchKey, boolean>>;
  /** A missing limit means 0. null means unlimited. */
  limits: Partial<Record<LimitKey, number | null>>;
}

export function planAllows(entitlements: Entitlements, feature: SwitchKey): boolean {
  return entitlements.switches[feature] === true;
}

export function planLimit(entitlements: Entitlements, limit: LimitKey): number | null {
  const value = entitlements.limits[limit];
  return value === undefined ? 0 : value;
}

/** Until subscriptions arrive (issue #39), restaurants.plan picks the plan. An expired Pro counts as Free. */
export type LegacyPlan = "free" | "pro";
export function effectivePlan(plan: string, planExpiresAt: number | null, now: number): LegacyPlan {
  if (plan === "pro" && (planExpiresAt === null || planExpiresAt > now)) {
    return "pro";
  }
  return "free";
}
