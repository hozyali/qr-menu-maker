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
