import type { Digest } from "@/lib/types/database";

/**
 * Digest staleness — owned by the app, deliberately.
 *
 * WF-03 ignores `last_digest_at` and `force_refresh` entirely: if the webhook
 * fires, it generates. That decision lives here instead, because the app is the
 * only side that knows whether an operator is actually looking at the page, and
 * because WF-03 is the Opus 5 call — the expensive one. See CLAUDE.md § Decisions.
 *
 * Type-only import, so this module stays free of runtime imports and can be
 * reached from both the browser panel and the server action.
 */
export const DIGEST_STALE_AFTER_HOURS = 6;
export const DIGEST_STALE_AFTER_MS = DIGEST_STALE_AFTER_HOURS * 60 * 60 * 1000;

/**
 * When the digest's content was produced.
 *
 * `generated_at` is written by WF-03 when it PATCHes the row to 'ready'. A row
 * that never got there has none, so fall back to `created_at` — a lock row that
 * failed is still evidence of *when* we last tried.
 */
export function digestTimestamp(digest: Digest): string {
  return digest.generated_at ?? digest.created_at;
}

/**
 * Whether a new digest is due.
 *
 * Null (never generated) counts as stale — the first login of a fresh install
 * should produce a digest. An unparseable timestamp also counts as stale rather
 * than throwing: the cost of one extra run is far lower than a panel wedged on a
 * date the browser could not read.
 */
export function isDigestStale(digest: Digest | null, now: number = Date.now()): boolean {
  if (!digest || digest.status !== "ready") return true;

  const at = new Date(digestTimestamp(digest)).getTime();
  if (Number.isNaN(at)) return true;

  return now - at >= DIGEST_STALE_AFTER_MS;
}
