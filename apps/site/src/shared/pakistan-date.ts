// Plan dates are entered and shown as Pakistan dates (UTC+5, no daylight saving).
// A Pro plan runs until the very end of its last day, 11:59:59.999 pm in Pakistan.
const OFFSET_MS = 5 * 60 * 60 * 1000;

/** "2099-03-31" becomes the last millisecond of that day in Pakistan. Returns null for a date that does not exist. */
export function endOfPakistanDay(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const start = Date.UTC(year, month - 1, day);
  const check = new Date(start);
  // Date.UTC rolls 30 February into March, so a rolled date is refused.
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return start + 24 * 60 * 60 * 1000 - 1 - OFFSET_MS;
}

/** The Pakistan date of a moment, as "2099-03-31". */
export function pakistanDate(ms: number): string {
  return new Date(ms + OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * The last day of one billing period that starts on `start` ("2026-11-16"), as a Pakistan date.
 * A month later keeps the same day number, or the month's last day if it is shorter
 * (31 January becomes 28 or 29 February). A year later turns 29 February into 28 February.
 */
export function addBillingPeriod(start: string, period: "monthly" | "yearly"): string {
  const [year, month, day] = start.split("-").map(Number) as [number, number, number];
  const targetYear = period === "yearly" ? year + 1 : month === 12 ? year + 1 : year;
  const targetMonth = period === "yearly" ? month : month === 12 ? 1 : month + 1;
  // Day 0 of the next month is the last day of the target month.
  const lastDay = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${targetYear}-${pad(targetMonth)}-${pad(Math.min(day, lastDay))}`;
}
