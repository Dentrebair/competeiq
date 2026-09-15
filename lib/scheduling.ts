import { isSignalLive } from "@/lib/signals";
import type { SignalType } from "@/lib/signals";

/**
 * Turning `signal_configs.frequency_hours` into the pg-boss schedule for
 * start_scrape — replaces the Apify Schedules API calls n8n's Config Loader
 * used to make (ADR-0005: "one pg-boss schedule per active competitor, with
 * the interval set by the fastest frequency_hours among its enabled live
 * signals"). Pure, no I/O.
 */

export interface SignalConfigForScheduling {
  signal_type: SignalType;
  frequency_hours: number;
  enabled: boolean;
}

/**
 * The fastest cadence among a competitor's enabled, live signals, or null
 * when none qualify (every signal disabled, or all enabled ones are not yet
 * live — see isSignalLive). Null means: no schedule should exist.
 */
export function fastestEnabledFrequency(configs: SignalConfigForScheduling[]): number | null {
  const hours = configs
    .filter((c) => c.enabled && isSignalLive(c.signal_type))
    .map((c) => c.frequency_hours);
  return hours.length > 0 ? Math.min(...hours) : null;
}

/**
 * A cron expression for "every N hours", covering the UI's actual choices
 * (components/competitors/monitoring.tsx: 1, 3, 6, 8, 12, 24, 48, 168) and any
 * other value in the CHECK-constrained 1–168 range that divides cleanly.
 *
 * Standard 5-field cron's hour field only spans 0-23, so the "every N hours"
 * step syntax cannot express that once N passes a day — days need the day-of-month field
 * instead. Throws rather than silently producing a wrong cadence for a value
 * that doesn't divide cleanly (e.g. 30) — none of the UI's choices hit that case.
 */
export function frequencyToCron(hours: number): string {
  if (!Number.isInteger(hours) || hours < 1) {
    throw new Error(`frequency_hours must be a positive integer, got ${hours}`);
  }
  if (hours < 24) return `0 */${hours} * * *`;
  if (hours === 24) return "0 0 * * *";
  if (hours % 24 === 0) return `0 0 */${hours / 24} * *`;
  throw new Error(
    `frequency_hours ${hours} does not convert cleanly to cron (must be <24, exactly 24, or a multiple of 24)`,
  );
}

/**
 * What a competitor's schedule should look like right now, or null to clear it.
 *
 * `minFrequencyHours`, when given, clamps the cadence to no faster than that —
 * the free-tier guardrail (lib/tier.ts) enforcing "at most weekly" without
 * having to rewrite what the operator actually picked in `signal_configs`.
 * Absent, this behaves exactly as before.
 */
export function scheduleFor(
  active: boolean,
  configs: SignalConfigForScheduling[],
  minFrequencyHours?: number,
): { cron: string } | null {
  if (!active) return null;
  const fastest = fastestEnabledFrequency(configs);
  if (fastest === null) return null;
  const hours = minFrequencyHours ? Math.max(fastest, minFrequencyHours) : fastest;
  return { cron: frequencyToCron(hours) };
}
