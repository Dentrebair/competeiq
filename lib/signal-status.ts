/**
 * Calculate signal status message based on when it last changed.
 * Shows pattern context: is this signal noisy, stable, or actively changing?
 */
export function getSignalStatus(
  lastChangeAt: string | null,
  alertCreatedAt: string,
): { message: string; isRecent: boolean } {
  if (!lastChangeAt) {
    return { message: "Never changed", isRecent: false };
  }

  const lastChange = new Date(lastChangeAt).getTime();
  const alertCreated = new Date(alertCreatedAt).getTime();
  const now = Date.now();

  // Time since the signal last changed (from now, not from alert time)
  const msAgo = now - lastChange;
  const minutesAgo = Math.floor(msAgo / 60_000);
  const hoursAgo = Math.floor(msAgo / 3_600_000);
  const daysAgo = Math.floor(msAgo / 86_400_000);
  const weeksAgo = Math.floor(msAgo / 604_800_000);

  let message: string;
  let isRecent: boolean;

  if (minutesAgo < 5) {
    message = "Just changed";
    isRecent = true;
  } else if (minutesAgo < 60) {
    message = `Changed ${minutesAgo}m ago`;
    isRecent = true;
  } else if (hoursAgo < 24) {
    message = `Changed ${hoursAgo}h ago`;
    isRecent = hoursAgo < 4;
  } else if (daysAgo < 7) {
    message = `Changed ${daysAgo}d ago`;
    isRecent = false;
  } else if (weeksAgo < 4) {
    message = `Changed ${weeksAgo}w ago`;
    isRecent = false;
  } else {
    message = `Stable for ${weeksAgo}w`;
    isRecent = false;
  }

  return { message, isRecent };
}

/**
 * Format signal status as a display string with emoji indicator.
 */
export function formatSignalStatus(lastChangeAt: string | null): string {
  const { message, isRecent } = getSignalStatus(lastChangeAt, new Date().toISOString());
  const icon = isRecent ? "🔴" : "🟢";
  return `${icon} ${message}`;
}
