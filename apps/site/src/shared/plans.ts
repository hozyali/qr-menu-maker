// Every plan feature and limit is read from this file only.
// Later the admin will edit plans in the database. Then only this file changes, not the routes that ask.

export type Plan = "free" | "pro";
export type Feature = "custom_theme";
export type Limit = "max_items";

interface Entitlements {
  features: Record<Feature, boolean>;
  /** null means no limit. */
  limits: Record<Limit, number | null>;
}

const PLANS: Record<Plan, Entitlements> = {
  // Which plan gets the theme is still undecided, so both have it for now.
  free: { features: { custom_theme: true }, limits: { max_items: 25 } },
  pro: { features: { custom_theme: true }, limits: { max_items: null } },
};

/** An expired Pro plan counts as Free. The menu and QR code keep working either way (Law 28). */
export function effectivePlan(plan: string, planExpiresAt: number | null, now: number): Plan {
  if (plan === "pro" && (planExpiresAt === null || planExpiresAt > now)) {
    return "pro";
  }
  return "free";
}

export function planAllows(plan: Plan, feature: Feature): boolean {
  return PLANS[plan].features[feature];
}

export function planLimit(plan: Plan, limit: Limit): number | null {
  return PLANS[plan].limits[limit];
}
