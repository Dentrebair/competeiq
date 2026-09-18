/**
 * Database types, hand-authored to match the live Supabase schema.
 *
 * Baseline: supabase/00-existing-schema.reference.sql (owned by n8n)
 * Additions: supabase/01-app-layer.sql (read state, dedupe, digests)
 *
 * Once the Supabase CLI is linked, replace this file with generated output:
 *   npx supabase gen types typescript --project-id <ref> > lib/types/database.ts
 * Until then it is kept in step by hand — if you change the schema, change this.
 */

/**
 * `severity` is free text in the database, not an enum, so the app cannot assume
 * what arrives. These are the values the UI knows how to render; anything else
 * falls back rather than blanking a row over a string it has not seen.
 */
export type Severity = "critical" | "high" | "medium" | "low";

/**
 * How sure WF-02's interpretation was. Distinct from severity: a critical alert
 * can be low-confidence (the diff was ambiguous) and a low one can be certain.
 *
 * Null is a real and common value — every alert written before the column
 * existed has none — which is why there is no fallback member here. Unknown
 * confidence is not "medium confidence".
 */
export type Confidence = "high" | "medium" | "low";

/** Most to least urgent — drives sorting and the colour ramp. */
export const SEVERITY_ORDER: readonly Severity[] = [
  "critical",
  "high",
  "medium",
  "low",
] as const;

const KNOWN_SEVERITIES = new Set<string>(SEVERITY_ORDER);

// Signal-type helpers (isKnownSignalType, signalTypeLabel, SIGNAL_TYPE_LABELS)
// live in lib/signals.ts alongside the vocabulary itself. Import them from there.

/**
 * Coerce a raw database severity into one the UI can style.
 *
 * Accepts anything, including null/undefined. The column is NOT NULL in Postgres,
 * but this also runs against Realtime payloads, which are not guaranteed to carry
 * every column — an oversized or partially-authorised payload arrives with fields
 * missing. Typing the parameter as `string` was a promise the runtime could not
 * keep, and the result was a TypeError that took down the whole feed rather than
 * degrading one row.
 *
 * Falls back to "medium" rather than throwing: an unrecognised severity is a
 * prompt or workflow problem, and dropping the alert would hide a real signal
 * from the operator over a formatting detail.
 */
export function normalizeSeverity(raw: string | null | undefined): Severity {
  if (typeof raw !== "string") return "medium";
  const value = raw.trim().toLowerCase();
  return KNOWN_SEVERITIES.has(value) ? (value as Severity) : "medium";
}

/**
 * Coerce a raw confidence value into one the UI can style, or null.
 *
 * Deliberately returns null rather than falling back to a member, unlike
 * normalizeSeverity. Severity has to resolve to something because the alert must
 * be rendered somewhere on the ramp; confidence does not — "we do not know how
 * sure that was" is a truthful answer and the UI should simply omit the chip.
 * Substituting "medium" would assert a certainty rating nothing produced.
 */
export function normalizeConfidence(raw: string | null | undefined): Confidence | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  return value === "high" || value === "medium" || value === "low" ? value : null;
}

/**
 * Signal vocabulary comes from lib/signals.ts, which deliberately has no
 * `server-only` marker.
 *
 * This module is reachable from lib/supabase/client.ts, which is a Client
 * Component. Importing the vocabulary through a server-only module (like
 * lib/anthropic.ts) would pull `server-only` into the browser bundle and fail
 * the build.
 */
export type { SignalType } from "@/lib/signals";
import type { SignalType } from "@/lib/signals";

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export type DigestStatus = "generating" | "ready" | "failed";

/* ===========================================================================
 * Row shapes below are declared with `type`, NOT `interface`. Do not "tidy"
 * them into interfaces.
 *
 * supabase-js constrains every table to `GenericTable`, whose `Row` must extend
 * `Record<string, unknown>`. A type alias gets an implicit index signature and
 * satisfies that; an interface does not, because it can be reopened by
 * declaration merging and so TypeScript will not assume its key set is closed.
 *
 * The failure is silent and misleading: the table quietly stops satisfying the
 * constraint, the relation collapses, and every `.update()` / `.insert()` on it
 * resolves to `never`. The error then surfaces at the call site —
 * "Argument of type '{ is_read: boolean; ... }' is not assignable to parameter
 * of type 'never'" — pointing at app/actions/*.ts rather than at this file.
 * =========================================================================== */

/** digests.priority_action — mirrors the WF-03 JSON schema. */
export type PriorityAction = {
  action: string;
  why_now: string;
  competitor: string;
  related_alert_ids: string[];
}

/** One entry in digests.patterns. */
export type DigestPattern = {
  pattern: string;
  competitors_involved: string[];
  evidence_alert_ids: string[];
}

/** Token accounting written by the worker from the Claude response. */
export type ClaudeUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export type Competitor = {
  id: string;
  name: string;
  domain: string;
  url: string;
  active: boolean;
  created_at: string;
}

export type ScrapeRunStatus = "running" | "processing" | "succeeded" | "failed";

/**
 * One row per Apify run start_scrape started. Not a long-lived table (see
 * supabase/08-scrape-runs.sql) — this is "what is Run Now doing right now",
 * not a run history. The browser reads it read-only (added in
 * supabase/11-run-progress-and-delete.sql) purely to show progress; only the
 * worker writes it.
 */
export type ScrapeRun = {
  run_id: string;
  competitor_id: string;
  started_at: string;
  status: ScrapeRunStatus;
  error: string | null;
  updated_at: string;
  /**
   * Apify's own literal terminal word (SUCCEEDED/FAILED/TIMED_OUT/ABORTED),
   * or one of two synthetic values for a failure Apify never confirmed
   * (UNREACHABLE, HUNG — see supabase/18). Null when the pipeline's own
   * processing failed after Apify itself succeeded — that fault is ours,
   * not Apify's, and this column correctly has nothing to say about it.
   */
  apify_status: string | null;
  dataset_id: string | null;
  completed_at: string | null;
  retry_count: number;
}

/**
 * The live/paused switch (supabase/07-pipeline-worker.sql). A singleton row —
 * `mode` is flipped by hand in the SQL editor, never by app or worker code.
 * The app reads it read-only, to decide whether free-tier guardrails
 * (competitor cap, forced cadence, Run Now cooldown) are active yet: they stay
 * off during `paused` so testing is never throttled, and switch on the same
 * moment the operator flips this to `live` for the unrelated reason of
 * letting competitors' own schedules start firing unattended.
 */
export type PipelineState = {
  mode: "live" | "paused";
  heartbeat_at: string | null;
}

export type Alert = {
  /** bigint sequence, not uuid. Arrives as a JS number. */
  id: number;
  created_at: string;
  /** Which pipeline produced this — "worker" now; "WF-02" on rows from before cutover. */
  workflow: string;
  execution_id: string | null;
  competitor_id: string | null;
  /** Denormalised, so the alert survives the competitor being deleted. */
  competitor_name: string;
  /**
   * One vocabulary across the whole system: the value here is the same string as
   * the `signal_configs` row that triggered the monitoring. There is no
   * translation between "what we monitor" and "what happened".
   *
   * Still `text` in the database rather than an enum, so this type is a promise
   * the app makes, not one Postgres enforces. Guard with `isKnownSignalType()`
   * before using it as a lookup key.
   */
  signal_type: SignalType;
  severity: string;
  summary: string;
  recommended_action: string | null;

  // Pricing-surface detail. Null for non-product signals.
  product_title: string | null;
  product_handle: string | null;
  product_url: string | null;
  currency: string | null;
  previous_price: number | null;
  current_price: number | null;
  delta_pct: number | null;

  /**
   * false when the Claude call failed or was skipped. Such an alert is
   * unclassified, not low-priority — the UI must not present it as graded.
   */
  ai_available: boolean;

  // Added by 05-intelligence-layer.sql. Both owned by the worker.

  /**
   * Two or three sentences on what this change does to the operator's position.
   * Null on every alert written before WF-02 gained the field, and on any alert
   * where the Claude call failed — so treat absence as "not available", never as
   * "no impact".
   */
  impact: string | null;

  /**
   * How sure the interpretation was: "high" | "medium" | "low", or null.
   *
   * Constrained by a CHECK in 05, but still typed loosely here because this also
   * describes Realtime payloads, which are not guaranteed to carry every column.
   * Pass it through normalizeConfidence() rather than indexing a style map with
   * it directly.
   */
  confidence: string | null;

  // Added by 01-app-layer.sql
  is_read: boolean;
  read_at: string | null;
  dedupe_key: string | null;
}

export type Digest = {
  id: string;
  status: DigestStatus;
  headline: string | null;
  priority_action: PriorityAction | null;
  patterns: DigestPattern[];
  quiet_competitors: string[];
  /** bigint[] — matches alerts.id */
  alert_ids: number[];
  alert_count: number | null;
  period_start: string | null;
  period_end: string | null;
  claude_usage: ClaudeUsage | null;
  error: string | null;
  requested_at: string;
  generated_at: string | null;
  created_at: string;
}

/**
 * Per-signal monitoring config. Added by supabase/02-signal-configs.sql.
 *
 * `signal_type` is typed from SignalType in lib/signals.ts rather than
 * redeclared, so a rename cannot drift between that vocabulary and this table.
 */
export type SignalConfig = {
  id: string;
  competitor_id: string;
  signal_type: SignalType;
  /** Hours between runs; converted to a pg-boss cron via lib/scheduling.ts. 1–168. */
  frequency_hours: number;
  enabled: boolean;
  last_run_at: string | null;
  last_error: string | null;
  /** When this signal last detected a change (alert generated). null = never changed. */
  last_change_at: string | null;
  /** When this signal was last checked in any run (regardless of result). */
  last_checked_at: string | null;
  created_at: string;
  updated_at: string;
}

/* ===========================================================================
 * Added by 05-intelligence-layer.sql.
 *
 * Ownership inverts here. In everything above, the worker produces and the app
 * reads; these five are produced by the APP, because chat and on-demand analysis are
 * its own Claude calls. The Insert/Update shapes below mirror the column grants
 * in 05 exactly — anything absent from them is absent from the grant too, and
 * writing it fails at the database rather than in review.
 * =========================================================================== */

/**
 * How the operator's catalogue was read during onboarding.
 *
 * `confirmed`  — the platform handed over a product feed. Fact.
 * `page_data`  — sitemap plus the structured product markup storefronts publish
 *                for search engines. Sampled, but real.
 * `inferred`   — neither available; the site was read and interpreted. A guess.
 *
 * The UI must surface this. At `confirmed` the review step is a formality; at
 * `inferred` it is the entire point of the screen.
 */
export type CatalogueSource = "confirmed" | "page_data" | "inferred" | "described";

/**
 * The operator's own business. Exactly one row, enforced by a unique constraint
 * on `singleton` rather than by convention.
 *
 * Every field here exists to stop Claude reasoning about the operator's position
 * from competitor data alone. generate_digest reads it as context (process_apify_run
 * never has — WF-02's real deployed prompt never gained that block either, see
 * docs/n8n-claude-calls.md), and so do the app's chat and analysis calls.
 *
 * `audience` and `positioning` are always inferred, at every catalogue_source
 * tier — no storefront publishes machine-readable positioning. Do not render
 * them with the same certainty as the catalogue figures.
 */
export type BrandProfile = {
  id: string;
  singleton: boolean;
  /** Null when the operator described their business instead of reading a site — see catalogue_source 'described'. */
  url: string | null;
  name: string | null;
  platform: string | null;
  catalogue_source: CatalogueSource | null;
  categories: string[];
  product_count: number | null;
  price_min: number | null;
  price_max: number | null;
  currency: string | null;
  audience: string | null;
  positioning: string | null;
  /** The operator's own words. A re-read of the store never overwrites these. */
  priorities: string | null;
  notes: string | null;
  last_read_at: string | null;
  created_at: string;
  updated_at: string;
}

/** What a verification fetch actually found on a suggested competitor's site. */
export type SuggestionEvidence = {
  platform?: string;
  product_count?: number;
  price_min?: number;
  price_max?: number;
  currency?: string;
  overlapping_categories?: string[];
}

/**
 * A competitor onboarding proposed.
 *
 * `verified` is the load-bearing field: a model will happily invent a plausible
 * domain that does not resolve, or one that resolves to a blog with nothing to
 * scrape. Only verified rows should reach the review screen — an unmonitorable
 * competitor is worse than no suggestion, because it fails days later in
 * silence.
 *
 * Rows persist after dismissal so the same site is not proposed again.
 */
export type CompetitorSuggestion = {
  id: string;
  domain: string;
  name: string;
  url: string;
  platform: string | null;
  verified: boolean;
  evidence: SuggestionEvidence;
  rationale: string | null;
  status: "suggested" | "accepted" | "dismissed";
  created_at: string;
  updated_at: string;
}

/** One alternative course of action. The tradeoff is what makes it choosable. */
export type AlertAlternative = {
  approach: string;
  action: string;
  tradeoff: string;
}

/**
 * The second pass over one alert: alternatives and a fuller impact reading,
 * generated only when the operator asks.
 *
 * A row exists or it does not — which is cleaner than a nullable column that
 * could equally mean "not requested" or "the call failed". One per alert;
 * regenerating replaces it via upsert on alert_id.
 */
export type AlertAnalysis = {
  id: string;
  alert_id: number;
  alternatives: AlertAlternative[];
  deeper_impact: string | null;
  model: string | null;
  usage: ClaudeUsage | null;
  created_at: string;
}

/**
 * A chat thread, anchored to an alert or a briefing.
 *
 * The anchor is required by a CHECK constraint, not just by convention: a
 * conversation attached to nothing has no evidence to reason from, which is the
 * exact failure mode scoped chat exists to avoid.
 */
export type Conversation = {
  id: string;
  alert_id: number | null;
  digest_id: string | null;
  /** Where on the screen it was opened from — 'impact', 'recommendation', … */
  anchor: string | null;
  title: string | null;
  created_at: string;
  updated_at: string;
}

export type Message = {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  /**
   * True when the reply was cut short. Without this a dropped stream is
   * indistinguishable from Claude trailing off mid-thought, and the transcript
   * stops being trustworthy as a record.
   */
  truncated: boolean;
  created_at: string;
}

/**
 * `competitor_products` is deliberately absent. RLS grants the app's roles no
 * policy on it, so the app cannot read it — it is the worker's price-diffing
 * state (the Baseline), and the app gets product detail from the denormalised
 * product_* columns on alerts.
 * Adding a type here would imply the app has access it does not have.
 */

/**
 * The shape here must structurally satisfy supabase-js's `GenericSchema`, which
 * requires `Relationships` on every table and `Views` / `Enums` /
 * `CompositeTypes` on the schema — the keys `supabase gen types` always emits.
 *
 * Omitting any of them does not produce a helpful error. The schema silently
 * fails the generic constraint, supabase-js falls back, and every `.insert()` /
 * `.update()` argument resolves to `never` — surfacing far away as
 * "Argument of type '{...}' is not assignable to parameter of type 'never'".
 *
 * `Relationships: []` is honest here: we never use PostgREST's embedded-resource
 * syntax (`select("*, competitors(name)")`), because `competitor_name` is
 * denormalised onto alerts.
 */
export interface Database {
  public: {
    Tables: {
      competitors: {
        Row: Competitor;
        Insert: Pick<Competitor, "name" | "domain" | "url"> &
          Partial<Pick<Competitor, "id" | "active">>;
        Update: Partial<Pick<Competitor, "name" | "domain" | "url" | "active">>;
        Relationships: [];
      };
      alerts: {
        Row: Alert;
        /**
         * The app never inserts alerts — the worker does, as pipeline_worker.
         *
         * `Record<string, never>` rather than `never`: supabase-js requires each
         * table to satisfy `GenericTable`, whose `Insert` must extend
         * `Record<string, unknown>`. A bare `never` fails that constraint, the
         * whole relation collapses, and *every* operation on the table — update
         * included — resolves to `never` with an error that points at the call
         * site rather than at this file.
         *
         * This type still rejects any real insert payload, and the database
         * grants are the actual enforcement.
         */
        Insert: Record<string, never>;
        /** Column privileges restrict authenticated updates to these two. */
        Update: Partial<Pick<Alert, "is_read" | "read_at">>;
        Relationships: [];
      };
      signal_configs: {
        Row: SignalConfig;
        /**
         * `last_run_at` and `last_error` are absent on purpose — the worker owns
         * them. The app declares desired state (which signals, how often); the
         * worker reconciles the pg-boss schedule and writes run status back.
         * Column grants in 03-ownership-hardening.sql enforce this at the
         * database, so a mistake here fails rather than silently clobbering
         * status the worker's health bar depends on.
         */
        Insert: Pick<SignalConfig, "competitor_id" | "signal_type"> &
          Partial<Pick<SignalConfig, "id" | "frequency_hours" | "enabled">>;
        Update: Partial<Pick<SignalConfig, "frequency_hours" | "enabled">>;
        Relationships: [];
      };
      digests: {
        Row: Digest;
        /** The app inserts only the lock row; the worker fills in the content. */
        Insert: { status?: "generating" };
        /** The worker owns digest content. Same GenericTable reason as alerts.Insert. */
        Update: Record<string, never>;
        Relationships: [];
      };
      /** Read-only for the app (supabase/11) — the worker owns every write. */
      scrape_runs: {
        Row: ScrapeRun;
        Insert: Record<string, never>;
        Update: Record<string, never>;
        Relationships: [];
      };

      /** Read-only for the app (supabase/07) — flipped by hand in the SQL editor. */
      pipeline_state: {
        Row: PipelineState;
        Insert: Record<string, never>;
        Update: Record<string, never>;
        Relationships: [];
      };

      /* --- Added by 05-intelligence-layer.sql -------------------------------
       * Each Insert/Update below mirrors a column grant in 05. `id`,
       * `created_at`, `updated_at` and `singleton` are absent throughout: they
       * are set by defaults and the touch_updated_at trigger, and the app is not
       * granted them. Adding one here would type-check and then fail at runtime.
       * -------------------------------------------------------------------- */

      brand_profile: {
        Row: BrandProfile;
        Insert: Pick<BrandProfile, "url"> &
          Partial<
            Pick<
              BrandProfile,
              | "name" | "platform" | "catalogue_source" | "categories"
              | "product_count" | "price_min" | "price_max" | "currency"
              | "audience" | "positioning" | "priorities" | "notes"
              | "last_read_at"
            >
          >;
        Update: Partial<
          Pick<
            BrandProfile,
            | "url" | "name" | "platform" | "catalogue_source" | "categories"
            | "product_count" | "price_min" | "price_max" | "currency"
            | "audience" | "positioning" | "priorities" | "notes"
            | "last_read_at"
          >
        >;
        Relationships: [];
      };

      competitor_suggestions: {
        Row: CompetitorSuggestion;
        Insert: Pick<CompetitorSuggestion, "domain" | "name" | "url"> &
          Partial<
            Pick<
              CompetitorSuggestion,
              "platform" | "verified" | "evidence" | "rationale" | "status"
            >
          >;
        /** `domain` is deliberately not updatable — it is the dedupe key. */
        Update: Partial<
          Pick<
            CompetitorSuggestion,
            "name" | "url" | "platform" | "verified" | "evidence" | "rationale" | "status"
          >
        >;
        Relationships: [];
      };

      alert_analyses: {
        Row: AlertAnalysis;
        Insert: Pick<AlertAnalysis, "alert_id"> &
          Partial<Pick<AlertAnalysis, "alternatives" | "deeper_impact" | "model" | "usage">>;
        Update: Partial<
          Pick<AlertAnalysis, "alternatives" | "deeper_impact" | "model" | "usage">
        >;
        Relationships: [];
      };

      conversations: {
        Row: Conversation;
        /**
         * A CHECK requires alert_id or digest_id. Both are optional here because
         * TypeScript cannot express "at least one of these" without a union that
         * makes every call site awkward — the database is the enforcement.
         */
        Insert: Partial<Pick<Conversation, "alert_id" | "digest_id" | "anchor" | "title">>;
        /** The anchor is set once and never moved; only the title is editable. */
        Update: Partial<Pick<Conversation, "title">>;
        Relationships: [];
      };

      messages: {
        Row: Message;
        Insert: Pick<Message, "conversation_id" | "role" | "content"> &
          Partial<Pick<Message, "truncated">>;
        /**
         * Append-only, matching the absent UPDATE policy in 05. A transcript
         * that can be edited afterwards is worthless as a record of what was
         * actually said.
         */
        Update: Record<string, never>;
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      reap_stale_digests: {
        Args: { max_age?: string };
        Returns: number;
      };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
}
