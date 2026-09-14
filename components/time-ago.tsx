"use client";

import { useEffect, useState } from "react";

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 60 * 60 * 24 * 365],
  ["month", 60 * 60 * 24 * 30],
  ["day", 60 * 60 * 24],
  ["hour", 60 * 60],
  ["minute", 60],
];

function relative(iso: string, now: number): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  const absolute = Math.abs(seconds);

  if (absolute < 45) return "just now";

  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, secondsPerUnit] of UNITS) {
    if (absolute >= secondsPerUnit) {
      return format.format(Math.round(seconds / secondsPerUnit), unit);
    }
  }
  return format.format(Math.round(seconds / 60), "minute");
}

/**
 * Relative timestamp that ticks.
 *
 * The server and the browser sit in different time zones and render at different
 * instants, so any relative string computed during SSR is a hydration mismatch
 * waiting to happen. Rather than paper over it with suppressHydrationWarning,
 * this renders a stable absolute date on the server and swaps to relative after
 * mount — both renders are then deterministic.
 *
 * The full timestamp stays available on hover and to assistive tech via the
 * `title` and the `<time dateTime>` attribute, because "3 days ago" is useless
 * when you need to correlate an alert with an Apify run.
 */
export function TimeAgo({ iso, className }: { iso: string; className?: string }) {
  // Guard before any Date work. `new Date(undefined).toISOString()` throws a
  // RangeError, and Intl.RelativeTimeFormat.format(NaN) does too — either would
  // take down the whole feed over one row with a bad timestamp.
  const valid = typeof iso === "string" && !Number.isNaN(new Date(iso).getTime());

  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    if (!valid) return;
    const update = () => setLabel(relative(iso, Date.now()));
    update();
    // A minute is fine: nothing here changes faster than that meaningfully.
    const timer = setInterval(update, 60_000);
    return () => clearInterval(timer);
  }, [iso, valid]);

  if (!valid) {
    return <span className={className}>unknown time</span>;
  }

  const absolute = new Date(iso).toISOString().replace("T", " ").slice(0, 16) + " UTC";

  return (
    <time dateTime={iso} title={absolute} className={className}>
      {label ?? absolute}
    </time>
  );
}
