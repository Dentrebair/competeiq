import { describe, expect, it } from "vitest";

import { fastestEnabledFrequency, frequencyToCron, scheduleFor } from "@/lib/scheduling";
import type { SignalConfigForScheduling } from "@/lib/scheduling";

const config = (
  signal_type: SignalConfigForScheduling["signal_type"],
  frequency_hours: number,
  enabled = true,
): SignalConfigForScheduling => ({ signal_type, frequency_hours, enabled });

describe("frequencyToCron", () => {
  it("converts sub-daily hours to an hourly step", () => {
    expect(frequencyToCron(1)).toBe("0 */1 * * *");
    expect(frequencyToCron(3)).toBe("0 */3 * * *");
    expect(frequencyToCron(12)).toBe("0 */12 * * *");
  });

  it("handles exactly 24 hours as daily, not an invalid hour step", () => {
    expect(frequencyToCron(24)).toBe("0 0 * * *");
  });

  it("converts multi-day multiples of 24 to a day-of-month step", () => {
    expect(frequencyToCron(48)).toBe("0 0 */2 * *");
    expect(frequencyToCron(168)).toBe("0 0 */7 * *");
  });

  it("covers every choice the UI actually offers (monitoring.tsx CADENCE_CHOICES)", () => {
    for (const hours of [1, 3, 6, 8, 12, 24, 48, 168]) {
      expect(() => frequencyToCron(hours)).not.toThrow();
    }
  });

  it("throws rather than silently misbehaving on a value that doesn't divide cleanly", () => {
    expect(() => frequencyToCron(30)).toThrow(/does not convert cleanly/);
  });

  it("throws on a non-positive or non-integer value", () => {
    expect(() => frequencyToCron(0)).toThrow();
    expect(() => frequencyToCron(-3)).toThrow();
    expect(() => frequencyToCron(2.5)).toThrow();
  });
});

describe("fastestEnabledFrequency", () => {
  it("picks the smallest frequency among enabled, live signals", () => {
    const configs = [config("sku_price_change", 3), config("promo_discount", 6), config("catalog_change", 24)];
    expect(fastestEnabledFrequency(configs)).toBe(3);
  });

  it("ignores disabled signals", () => {
    const configs = [config("sku_price_change", 1, false), config("promo_discount", 6)];
    expect(fastestEnabledFrequency(configs)).toBe(6);
  });

  it("ignores signals that are not yet live, even if enabled", () => {
    // ad_creative is not live per lib/signals.ts SIGNAL_AVAILABILITY.
    const configs = [config("ad_creative", 1), config("promo_discount", 8)];
    expect(fastestEnabledFrequency(configs)).toBe(8);
  });

  it("returns null when nothing qualifies", () => {
    expect(fastestEnabledFrequency([config("sku_price_change", 3, false)])).toBeNull();
    expect(fastestEnabledFrequency([])).toBeNull();
  });
});

describe("scheduleFor", () => {
  const liveConfigs = [config("sku_price_change", 6)];

  it("returns null for an inactive competitor regardless of its signals", () => {
    expect(scheduleFor(false, liveConfigs)).toBeNull();
  });

  it("returns the cron for an active competitor with a qualifying signal", () => {
    expect(scheduleFor(true, liveConfigs)).toEqual({ cron: "0 */6 * * *" });
  });

  it("returns null for an active competitor with nothing enabled", () => {
    expect(scheduleFor(true, [config("sku_price_change", 6, false)])).toBeNull();
  });
});
