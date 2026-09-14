/**
 * Formatting shared across the console.
 *
 * No imports and no `server-only` marker: these run in both the server render
 * and the browser, and every one of them must produce the *same string* on both
 * sides or React discards the tree with a hydration error.
 */

/**
 * Pinned locale, deliberately.
 *
 * `undefined` uses the ambient locale, which is not the same on both sides of an
 * SSR render: Node defaults to en-US ("$30.00") while a browser in India
 * resolves en-IN ("US$30.00"). React sees the two differ and regenerates the
 * tree on the client.
 *
 * en-US because these are US storefront prices, and "$19.99" is how that price
 * is written on the site being monitored.
 */
const PRICE_LOCALE = "en-US";

export function formatPrice(
  value: number | null | undefined,
  currency: string | null | undefined,
): string | null {
  if (typeof value !== "number" || Number.isNaN(value)) return null;
  if (!currency) return value.toFixed(2);
  try {
    return new Intl.NumberFormat(PRICE_LOCALE, { style: "currency", currency }).format(value);
  } catch {
    // Unknown or malformed currency code — show the number rather than nothing.
    return `${currency} ${value.toFixed(2)}`;
  }
}

/** "+12.0%" / "−33.3%". Null when there is no delta to state. */
export function formatDelta(deltaPct: number | null | undefined): string | null {
  if (typeof deltaPct !== "number" || Number.isNaN(deltaPct)) return null;
  // A real minus sign, not a hyphen: these sit in a tabular column beside
  // prices, and the hyphen is visibly too short to read as a negative.
  const sign = deltaPct > 0 ? "+" : deltaPct < 0 ? "−" : "";
  return `${sign}${Math.abs(deltaPct).toFixed(1)}%`;
}

/**
 * UTC day key ("2026-08-25"), or "unknown" for an unparseable timestamp.
 *
 * UTC rather than local, and not by accident: a local-date key would place a
 * 01:00 IST alert in a different bucket on the server than in the browser, so
 * the two renders would disagree about the *structure* of a grid, not merely a
 * label. It also matches every other absolute timestamp the app shows.
 */
export function utcDayKey(iso: string): string {
  const time = new Date(iso).getTime();
  return Number.isNaN(time) ? "unknown" : new Date(time).toISOString().slice(0, 10);
}

const DAY_LABEL = new Intl.DateTimeFormat(PRICE_LOCALE, {
  weekday: "short",
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

const DAY_SHORT = new Intl.DateTimeFormat(PRICE_LOCALE, {
  weekday: "short",
  timeZone: "UTC",
});

const DAY_NUMBER = new Intl.DateTimeFormat(PRICE_LOCALE, {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

export function formatDayKey(key: string): string {
  if (key === "unknown") return "Undated";
  return DAY_LABEL.format(new Date(`${key}T00:00:00Z`));
}

/** "Wed" / "26 Aug" — the two halves of a heatmap column heading. */
export function splitDayKey(key: string): { weekday: string; date: string } {
  const at = new Date(`${key}T00:00:00Z`);
  return { weekday: DAY_SHORT.format(at), date: DAY_NUMBER.format(at) };
}

export function shiftDayKey(key: string, days: number): string {
  return new Date(Date.parse(`${key}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** Inclusive range of UTC day keys, oldest first. */
export function dayKeyRange(endKey: string, length: number): string[] {
  return Array.from({ length }, (_, index) => shiftDayKey(endKey, index - (length - 1)));
}

/** "20–26 Aug 2026" — the label over a heatmap window. */
export function formatDayRange(from: string, to: string): string {
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  const sameMonth = start.getUTCMonth() === end.getUTCMonth();
  const startText = new Intl.DateTimeFormat(PRICE_LOCALE, {
    day: "numeric",
    month: sameMonth ? undefined : "short",
    timeZone: "UTC",
  }).format(start);
  const endText = new Intl.DateTimeFormat(PRICE_LOCALE, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(end);
  return `${startText} – ${endText}`;
}
