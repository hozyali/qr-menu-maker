// Prices for subscriptions (issue #40). Money is always whole paisa, never floating point.

export interface CouponTerms {
  percentOff: number;
  /** "once" discounts the first paid period only. "recurring" discounts renewals too. */
  duration: "once" | "recurring";
}

export interface Price {
  listMinor: number;
  discountMinor: number;
  finalMinor: number;
}

/**
 * The price of one billing period. The discount is rounded to the nearest rupee (.5 rounds up),
 * is never more than the list price, and a one-time coupon does not apply to a renewal.
 */
export function priceFor({ listMinor, coupon, isRenewal }: { listMinor: number; coupon: CouponTerms | null; isRenewal: boolean }): Price {
  if (!coupon || (coupon.duration === "once" && isRenewal)) {
    return { listMinor, discountMinor: 0, finalMinor: listMinor };
  }
  // Integer maths: (list × percent) is in hundredths of paisa. Adding half a rupee before the
  // division rounds to the nearest rupee.
  const roundedRupees = Math.floor((listMinor * coupon.percentOff + 5000) / 10000);
  const discountMinor = Math.min(listMinor, roundedRupees * 100);
  return { listMinor, discountMinor, finalMinor: listMinor - discountMinor };
}
