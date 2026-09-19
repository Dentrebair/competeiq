/**
 * Signal status with pattern detection and color coding.
 * Detects: fresh changes, repeated changes, stability, noise.
 */

export type SignalStatusColor = "red" | "yellow" | "green" | "gray";

export interface SignalStatus {
  message: string;
  color: SignalStatusColor;
}

/**
 * Analyze signal behavior based on:
 * - last_change_at: when signal last changed
 * - change_count_30d: how many times it changed in 30 days
 * - alert.created_at: when this alert was first detected
 */
export function getSignalStatus(
  lastChangeAt: string | null,
  change_count_30d: number,
  alertCreatedAt: string,
): SignalStatus {
  const now = Date.now();
  const alertCreated = new Date(alertCreatedAt).getTime();

  // No change history yet
  if (!lastChangeAt) {
    const msAgo = now - alertCreated;
    const hoursAgo = Math.floor(msAgo / 3_600_000);
    const minutesAgo = Math.floor(msAgo / 60_000);
    const daysAgo = Math.floor(msAgo / 86_400_000);
    const weeksAgo = Math.floor(msAgo / 604_800_000);

    if (hoursAgo < 24) {
      // Fresh detection: < 24h
      const msg =
        minutesAgo < 60 ? `New signal ${minutesAgo}m ago` : `New signal ${hoursAgo}h ago`;
      return { message: msg, color: "red" };
    } else if (daysAgo < 7) {
      // Older signal, no history tracked
      return { message: `Signal since ${daysAgo}d ago`, color: "gray" };
    } else {
      // Very old, no history
      return { message: `Signal since ${weeksAgo}w ago`, color: "gray" };
    }
  }

  // Has change history
  const lastChange = new Date(lastChangeAt).getTime();
  const msSinceChange = now - lastChange;
  const minutesSince = Math.floor(msSinceChange / 60_000);
  const hoursSince = Math.floor(msSinceChange / 3_600_000);
  const daysSince = Math.floor(msSinceChange / 86_400_000);
  const weeksSince = Math.floor(msSinceChange / 604_800_000);

  // Check for "noise" pattern: too many changes in 30 days
  const NOISE_THRESHOLD = 5; // 5+ changes = noisy
  if (change_count_30d >= NOISE_THRESHOLD) {
    return {
      message: `Noise: ${change_count_30d} changes this month`,
      color: "red",
    };
  }

  // Check for "changed again" pattern: alert is old but signal changed recently
  const msSinceAlert = now - alertCreated;
  const daysSinceAlert = Math.floor(msSinceAlert / 86_400_000);
  if (daysSinceAlert >= 2 && daysSince < daysSinceAlert) {
    // Alert is at least 2 days old, but signal changed after it
    const msg =
      daysSince === 0
        ? "Changed again today"
        : daysSince === 1
          ? "Changed again yesterday"
          : `Changed again ${daysSince}d ago`;
    return { message: msg, color: "yellow" };
  }

  // Normal patterns: just changed or stable
  if (minutesSince < 5) {
    return { message: "Just changed", color: "red" };
  } else if (minutesSince < 60) {
    return { message: `Changed ${minutesSince}m ago`, color: "red" };
  } else if (hoursSince < 4) {
    return { message: `Changed ${hoursSince}h ago`, color: "red" };
  } else if (hoursSince < 24) {
    return { message: `Changed ${hoursSince}h ago`, color: "gray" };
  } else if (daysSince < 7) {
    return { message: `Changed ${daysSince}d ago`, color: "gray" };
  } else {
    return { message: `Stable for ${weeksSince}w`, color: "green" };
  }
}
