import type { Hono } from "hono";
import { html } from "hono/html";
import type { OwnerSession } from "../shared/accounts-db";
import { page } from "../shared/layout";
import { endOfPakistanDay, pakistanDate } from "../shared/pakistan-date";
import { availableTrial, startTrial, type TrialOffer } from "../shared/trials-db";
import { readText } from "../shared/validation";
import type { OwnerEnv } from "./menu";

// Free trials on the owner side (issue #42). The restaurant always comes from the login session (Law 18).

const DAY = 24 * 60 * 60 * 1000;

/** A restaurant on a free plan, not already on a trial, can start an open offer it has not used. */
export async function trialFor(db: D1Database, owner: OwnerSession, now: number): Promise<TrialOffer | null> {
  if (!owner.entitlements.isFree || owner.planStatus === "trial") return null;
  return availableTrial(db, owner.restaurantId, now);
}

export function trialBanner(offer: TrialOffer | null) {
  if (!offer) return "";
  return html`<section class="card trial-banner" aria-labelledby="trial-heading">
<h2 id="trial-heading">Try ${offer.planName} free for ${offer.days} days</h2>
<p>No payment needed. After ${offer.days} days you go back to Free, unless you upgrade.</p>
<form method="post" action="/plan/trial"><input type="hidden" name="offer_id" value="${offer.id}"><button class="button" type="submit">Start free trial</button></form>
</section>`;
}

export function registerOwnerTrialRoutes(app: Hono<OwnerEnv>) {
  app.post("/plan/trial", async (c) => {
    const owner = c.get("owner");
    const now = Date.now();
    // The offer is found again on the server for this restaurant, so an id from the browser cannot
    // start another restaurant's offer, an ended offer, or a second trial of the same plan.
    const offer = await trialFor(c.env.DB, owner, now);
    const requested = readText(await c.req.formData(), "offer_id");
    const refused = () =>
      c.html(page("Free trial", html`<h1>This trial is not available</h1><p class="lead"><a href="/">Back to your menu</a></p>`), 403);
    if (!offer || offer.id !== requested) return refused();
    const endsLabel = pakistanDate(now + offer.days * DAY);
    const endsAt = endOfPakistanDay(endsLabel) ?? now + offer.days * DAY;
    try {
      await startTrial(c.env.DB, owner.userId, owner.restaurantId, offer, { startedAt: now, endsAt, endsLabel });
    } catch {
      // The database allows one trial per plan per restaurant. A second start at the same moment fails here.
      return refused();
    }
    return c.redirect("/", 303);
  });
}
