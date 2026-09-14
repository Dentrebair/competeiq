-- ============================================================================
-- REAL-LEAD — intelligence layer
--
-- Run AFTER 04-revoke-default-grants.sql. Additive, idempotent.
--
-- Everything here supports four things the app is gaining:
--
--   1. A record of the operator's OWN business, so Claude stops reasoning about
--      their position from competitor data alone.
--   2. An impact reading and a confidence rating on every alert.
--   3. Deeper analysis of a single alert, generated on demand.
--   4. Chat, anchored to one alert or one briefing.
--
-- A note on who writes what, because it differs from every earlier file. In
-- 01–04 the rule was "n8n produces, the app reads". Three of the five tables
-- below are produced by the APP — it now makes its own Claude calls for chat and
-- on-demand analysis, which n8n cannot do because n8n cannot stream tokens to a
-- browser. So the app holds insert/update rights here that it deliberately does
-- not hold on `alerts` or `digests`.
--
-- The two new alerts columns are the exception and follow the old rule: n8n
-- writes them, the app only reads.
-- ============================================================================


-- ============================================================================
-- 1. alerts — impact and confidence
--
-- `confidence` is not new information. WF-02's Claude call has always returned
-- it (see docs/n8n-claude-calls.md — it is in the response schema and the parse
-- node already spreads it), and it has always been discarded on insert because
-- there was no column to receive it. Postgres drops unknown keys silently, so
-- nothing ever errored; the value was simply computed and thrown away on every
-- signal since the workflow went live.
--
-- `impact` is new, and needs a matching addition to WF-02's response schema and
-- system prompt before it will ever be non-null.
--
-- No grants are added for either. Table-level SELECT already covers columns
-- added later, so the feed can read them immediately; UPDATE was revoked in 01
-- and re-granted only on (is_read, read_at), so the app still cannot write to
-- them. That is the intent: these are n8n's to produce.
-- ============================================================================

alter table public.alerts add column if not exists impact     text;
alter table public.alerts add column if not exists confidence text;

-- Safe to add unconditionally: the column is new, so every existing row is NULL
-- and NULL passes. Unlike severity, this one IS constrained — it comes from a
-- three-value enum in the Claude response schema, so anything else means the
-- workflow drifted and should fail loudly rather than render as a blank chip.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'alerts_confidence_check') then
    alter table public.alerts
      add constraint alerts_confidence_check
      check (confidence is null or confidence in ('high', 'medium', 'low'));
  end if;
end $$;


-- ============================================================================
-- 2. brand_profile — the operator's own business
--
-- Exactly one row, enforced by the database rather than by convention: a
-- `singleton` column that is always true and carries a unique constraint, so a
-- second insert fails instead of quietly creating a rival profile that half the
-- code reads and half ignores.
--
-- The distinction that matters here is `catalogue_source`. Onboarding reads the
-- operator's store through whichever of three routes it can:
--
--   confirmed  — the platform handed over a product feed. Real SKUs, real
--                prices. Fact.
--   page_data  — no feed, so the sitemap plus the structured product markup
--                most storefronts publish for search engines. Very good, but
--                sampled.
--   inferred   — neither available, so the site was read and interpreted.
--                A guess.
--
-- The UI has to show which one it got, because the review step is a formality at
-- `confirmed` and the entire point of the screen at `inferred`. Storing it means
-- that distinction survives past onboarding into every later screen.
--
-- `audience` and `positioning` are ALWAYS inferred, at every tier — no
-- storefront publishes machine-readable positioning. Do not present them with
-- the same certainty as the catalogue figures.
-- ============================================================================

create table if not exists public.brand_profile (
  id                uuid primary key default gen_random_uuid(),

  -- Enforces one row. `unique` on a column that is only ever true means a second
  -- insert collides; the check stops anyone "fixing" that by writing false.
  singleton         boolean not null default true unique check (singleton),

  url               text not null,
  name              text,

  -- 'shopify' | 'woocommerce' | 'bigcommerce' | 'other' | 'unknown'.
  -- Free text on purpose: platform detection will meet things this list has not
  -- heard of, and an unrecognised platform should degrade to a lower tier, not
  -- fail an insert.
  platform          text,

  catalogue_source  text check (catalogue_source in ('confirmed', 'page_data', 'inferred')),

  -- Catalogue facts. Certainty varies by catalogue_source above.
  categories        text[] not null default '{}',
  product_count     integer,
  price_min         numeric,
  price_max         numeric,
  currency          text,

  -- Always inferred, at every tier.
  audience          text,
  positioning       text,

  -- The operator's own words. Never overwritten by a re-read of the store.
  priorities        text,
  notes             text,

  -- When the store was last read. Drives the "refresh from my store" action —
  -- a catalogue moves, and a profile captured once goes stale silently.
  last_read_at      timestamptz,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

drop trigger if exists brand_profile_touch on public.brand_profile;
create trigger brand_profile_touch
  before update on public.brand_profile
  for each row execute function public.touch_updated_at();


-- ============================================================================
-- 3. competitor_suggestions — onboarding's proposals
--
-- Persisted rather than held in memory for one reason: a suggestion the operator
-- rejected must not come back next time. Without this table, re-running
-- onboarding or adding a competitor later re-proposes the same three sites that
-- were already dismissed, which reads as the product not listening.
--
-- `verified` is the load-bearing column. A language model will happily invent a
-- plausible competitor domain that does not resolve, or that resolves to a blog
-- with nothing to scrape. Only rows that survived an actual fetch should ever
-- reach the review screen — an unmonitorable competitor is worse than no
-- suggestion, because it fails three days later and silently.
--
-- `evidence` holds what that fetch found: {platform, product_count, price_min,
-- price_max, currency, overlapping_categories}. It is what the UI shows under
-- each suggestion, and it is what makes a wrong suggestion cheap to reject.
-- ============================================================================

create table if not exists public.competitor_suggestions (
  id           uuid primary key default gen_random_uuid(),

  -- Same shape as competitors.domain, and unique for the same reason: two rows
  -- for one domain means the dismissal does not stick.
  domain       text not null unique,
  name         text not null,
  url          text not null,

  platform     text,

  -- Proven reachable and readable by an actual request, not asserted by a model.
  verified     boolean not null default false,
  evidence     jsonb   not null default '{}'::jsonb,

  -- Why this site was proposed. Shown to the operator; a suggestion without a
  -- stated reason costs trust when it is wrong.
  rationale    text,

  status       text not null default 'suggested'
                 check (status in ('suggested', 'accepted', 'dismissed')),

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists competitor_suggestions_open_idx
  on public.competitor_suggestions (created_at desc)
  where status = 'suggested';

drop trigger if exists competitor_suggestions_touch on public.competitor_suggestions;
create trigger competitor_suggestions_touch
  before update on public.competitor_suggestions
  for each row execute function public.touch_updated_at();


-- ============================================================================
-- 4. alert_analyses — depth, on request
--
-- Every alert already carries one recommended action, written by WF-02 as the
-- signal arrives. This table holds the *second* pass: alternatives and a fuller
-- impact reading, generated only when the operator opens an alert and asks.
--
-- Deliberately not columns on `alerts`. Two reasons, and both matter:
--
--   * The app writes this, n8n writes alerts. Keeping them apart means the app
--     never needs write access to a table n8n owns — the boundary 03 and 04 went
--     to some trouble to draw stays intact.
--   * It is generated for a handful of alerts a day, not all of them. A separate
--     table makes "has this been analysed" a row that exists or does not, rather
--     than a nullable column that could also mean "the workflow failed".
--
-- One analysis per alert. Re-running replaces it, so `unique (alert_id)` gives
-- the app a clean upsert target: on_conflict=alert_id.
-- ============================================================================

create table if not exists public.alert_analyses (
  id             uuid primary key default gen_random_uuid(),

  alert_id       bigint not null unique
                   references public.alerts (id) on delete cascade,

  -- [{ approach, action, tradeoff }]. The tradeoff is what makes an alternative
  -- choosable rather than just another suggestion — see the UI brief.
  alternatives   jsonb not null default '[]'::jsonb,

  deeper_impact  text,

  -- Which model produced this, and what it cost. Worth keeping: this is the one
  -- surface whose spend scales with how often the operator clicks, so it needs
  -- to be attributable after the fact.
  model          text,
  usage          jsonb,

  created_at     timestamptz not null default now()
);


-- ============================================================================
-- 5. conversations + messages — chat, anchored
--
-- Chat is scoped to a specific alert or briefing and its branches. There is no
-- general assistant, on purpose: an unanchored chat has no evidence to reason
-- from and drifts into generic advice, which is exactly what this product exists
-- to replace.
--
-- The anchor is enforced here rather than trusted to the route handler — a
-- conversation attached to nothing has no context to send to Claude, so it
-- cannot be answered well and should not be storable.
-- ============================================================================

create table if not exists public.conversations (
  id           uuid primary key default gen_random_uuid(),

  alert_id     bigint references public.alerts (id)   on delete cascade,
  digest_id    uuid   references public.digests (id)  on delete cascade,

  -- Which point on the screen this was opened from: 'alert', 'impact',
  -- 'recommendation', 'alternative', 'priority_action'. Free text — new anchor
  -- points will appear as the UI grows, and an unknown one should degrade to a
  -- generic header rather than block the insert.
  anchor       text,

  -- First user message, truncated. Cheap, and it is what makes a list of past
  -- conversations readable.
  title        text,

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint conversations_anchored
    check (alert_id is not null or digest_id is not null)
);

create index if not exists conversations_alert_idx
  on public.conversations (alert_id, created_at desc)
  where alert_id is not null;

drop trigger if exists conversations_touch on public.conversations;
create trigger conversations_touch
  before update on public.conversations
  for each row execute function public.touch_updated_at();

create table if not exists public.messages (
  id               uuid primary key default gen_random_uuid(),

  conversation_id  uuid not null
                     references public.conversations (id) on delete cascade,

  role             text not null check (role in ('user', 'assistant')),
  content          text not null,

  -- Set on assistant rows when a reply was cut short — a stream that dropped
  -- mid-sentence must be distinguishable from one that finished, or the
  -- transcript reads as Claude trailing off mid-thought for no reason.
  truncated        boolean not null default false,

  created_at       timestamptz not null default now()
);

-- Replaying a conversation is always "every message, oldest first".
create index if not exists messages_thread_idx
  on public.messages (conversation_id, created_at);


-- ============================================================================
-- 6. RLS
--
-- Same reasoning as 01: the anon key ships to every browser, so RLS is what
-- decides what that key can reach, and deny-by-default is the starting point.
--
-- Single operator, so every policy here is `to authenticated using (true)`.
-- These are not multi-tenant policies and should not be mistaken for a
-- foundation for multi-tenancy — that would need an owner column on every table
-- and a rewrite of all of them.
--
-- Chat is the one place worth pausing on. `messages` holds whatever the operator
-- typed while thinking through a competitive decision, which is easily the most
-- sensitive text in the database. It gets the same treatment as everything else,
-- and `anon` gets nothing.
-- ============================================================================

alter table public.brand_profile           enable row level security;
alter table public.competitor_suggestions  enable row level security;
alter table public.alert_analyses          enable row level security;
alter table public.conversations           enable row level security;
alter table public.messages                enable row level security;

-- --- brand_profile ---------------------------------------------------------
drop policy if exists "operator reads brand profile"   on public.brand_profile;
drop policy if exists "operator inserts brand profile" on public.brand_profile;
drop policy if exists "operator updates brand profile" on public.brand_profile;

create policy "operator reads brand profile" on public.brand_profile
  for select to authenticated using (true);
create policy "operator inserts brand profile" on public.brand_profile
  for insert to authenticated with check (true);
create policy "operator updates brand profile" on public.brand_profile
  for update to authenticated using (true) with check (true);

-- No delete policy. There is one profile and it is edited, never removed;
-- deleting it would leave every later Claude call reasoning blind again.

-- --- competitor_suggestions ------------------------------------------------
drop policy if exists "operator reads suggestions"   on public.competitor_suggestions;
drop policy if exists "operator inserts suggestions" on public.competitor_suggestions;
drop policy if exists "operator updates suggestions" on public.competitor_suggestions;
drop policy if exists "operator deletes suggestions" on public.competitor_suggestions;

create policy "operator reads suggestions" on public.competitor_suggestions
  for select to authenticated using (true);
create policy "operator inserts suggestions" on public.competitor_suggestions
  for insert to authenticated with check (true);
create policy "operator updates suggestions" on public.competitor_suggestions
  for update to authenticated using (true) with check (true);
create policy "operator deletes suggestions" on public.competitor_suggestions
  for delete to authenticated using (true);

-- --- alert_analyses --------------------------------------------------------
drop policy if exists "operator reads analyses"   on public.alert_analyses;
drop policy if exists "operator inserts analyses" on public.alert_analyses;
drop policy if exists "operator updates analyses" on public.alert_analyses;

create policy "operator reads analyses" on public.alert_analyses
  for select to authenticated using (true);
create policy "operator inserts analyses" on public.alert_analyses
  for insert to authenticated with check (true);
create policy "operator updates analyses" on public.alert_analyses
  for update to authenticated using (true) with check (true);

-- --- conversations + messages ----------------------------------------------
drop policy if exists "operator reads conversations"   on public.conversations;
drop policy if exists "operator inserts conversations" on public.conversations;
drop policy if exists "operator updates conversations" on public.conversations;
drop policy if exists "operator deletes conversations" on public.conversations;

create policy "operator reads conversations" on public.conversations
  for select to authenticated using (true);
create policy "operator inserts conversations" on public.conversations
  for insert to authenticated with check (true);
create policy "operator updates conversations" on public.conversations
  for update to authenticated using (true) with check (true);
create policy "operator deletes conversations" on public.conversations
  for delete to authenticated using (true);

drop policy if exists "operator reads messages"   on public.messages;
drop policy if exists "operator inserts messages" on public.messages;
drop policy if exists "operator deletes messages" on public.messages;

create policy "operator reads messages" on public.messages
  for select to authenticated using (true);
create policy "operator inserts messages" on public.messages
  for insert to authenticated with check (true);
create policy "operator deletes messages" on public.messages
  for delete to authenticated using (true);

-- Deliberately no UPDATE policy on messages. A transcript is a record of what
-- was actually said; editing it after the fact would make it worthless as the
-- "why did I decide this" trail that is half the reason for storing it.


-- ============================================================================
-- 7. Grants
--
-- 04 established the pattern: RLS and privileges should both have to be wrong
-- before anything leaks. Supabase's default blanket grants on new tables are
-- revoked and replaced with column-scoped ones.
--
-- The app genuinely produces the content of these tables, so unlike `alerts` it
-- gets real write access — but still not to the bookkeeping columns. `id`,
-- `created_at` and `updated_at` are left to their defaults and the trigger; the
-- app has no reason to set them and every reason not to be able to backdate a
-- conversation.
-- ============================================================================

revoke all on public.brand_profile          from anon, authenticated;
revoke all on public.competitor_suggestions from anon, authenticated;
revoke all on public.alert_analyses         from anon, authenticated;
revoke all on public.conversations          from anon, authenticated;
revoke all on public.messages               from anon, authenticated;

-- brand_profile — the operator edits every field. `singleton` is excluded: it
-- exists solely to enforce the one-row rule and defaults correctly.
grant select on public.brand_profile to authenticated;
grant insert (url, name, platform, catalogue_source, categories, product_count,
              price_min, price_max, currency, audience, positioning, priorities,
              notes, last_read_at)
  on public.brand_profile to authenticated;
grant update (url, name, platform, catalogue_source, categories, product_count,
              price_min, price_max, currency, audience, positioning, priorities,
              notes, last_read_at)
  on public.brand_profile to authenticated;

-- competitor_suggestions — written by onboarding, then accepted or dismissed.
grant select, delete on public.competitor_suggestions to authenticated;
grant insert (domain, name, url, platform, verified, evidence, rationale, status)
  on public.competitor_suggestions to authenticated;
grant update (name, url, platform, verified, evidence, rationale, status)
  on public.competitor_suggestions to authenticated;

-- alert_analyses — upserted on alert_id, so UPDATE covers the same columns.
grant select on public.alert_analyses to authenticated;
grant insert (alert_id, alternatives, deeper_impact, model, usage)
  on public.alert_analyses to authenticated;
grant update (alternatives, deeper_impact, model, usage)
  on public.alert_analyses to authenticated;

-- conversations — the anchor is set once at creation and never moved.
grant select, delete on public.conversations to authenticated;
grant insert (alert_id, digest_id, anchor, title)
  on public.conversations to authenticated;
grant update (title) on public.conversations to authenticated;

-- messages — append only, matching the absence of an UPDATE policy above.
grant select, delete on public.messages to authenticated;
grant insert (conversation_id, role, content, truncated)
  on public.messages to authenticated;


-- ============================================================================
-- 8. Realtime — deliberately not extended
--
-- `alerts` and `digests` are in the publication because n8n writes them from
-- outside the browser's session; Realtime is the only way the app finds out.
--
-- Nothing added in this file has that property. The app writes all five tables
-- itself, in the same session that then re-reads them, so a subscription would
-- only tell the browser about changes it just made. Chat in particular must NOT
-- go through Realtime: the reply streams token by token over the route handler's
-- response, and a second delivery path for the same text is a race, not a
-- feature.
-- ============================================================================


-- ============================================================================
-- VERIFY — one query
--
-- The Supabase SQL Editor shows only the last statement's result, so everything
-- worth checking is folded into this one.
--
-- Expected:
--   alert_analyses          rls=t  policies=3  table=SELECT           cols=INSERT(5)/UPDATE(4)
--   alerts                  rls=t  policies=2  table=SELECT           cols=UPDATE(is_read,read_at)
--   brand_profile           rls=t  policies=3  table=SELECT           cols=INSERT(14)/UPDATE(14)
--   competitor_suggestions  rls=t  policies=4  table=SELECT,DELETE    cols=INSERT(8)/UPDATE(7)
--   conversations           rls=t  policies=4  table=SELECT,DELETE    cols=INSERT(4)/UPDATE(title)
--   messages                rls=t  policies=3  table=SELECT,DELETE    cols=INSERT(4)
--
-- Check hardest:
--   * every rls_enabled is true
--   * anon_grants is '—' on every row
--   * alerts still shows only UPDATE(is_read, read_at) — adding impact and
--     confidence must not have widened what the browser can write
--   * new_alert_columns reports both columns present
-- ============================================================================

select
  c.relname as table_name,
  c.relrowsecurity as rls_enabled,

  (select count(*) from pg_policies p
    where p.schemaname = 'public' and p.tablename = c.relname) as policies,

  coalesce((
    select string_agg(distinct tp.privilege_type, ', ' order by tp.privilege_type)
      from information_schema.table_privileges tp
     where tp.grantee = 'authenticated'
       and tp.table_schema = 'public' and tp.table_name = c.relname
  ), '—') as table_grants,

  coalesce((
    select string_agg(x.entry, ' | ' order by x.entry)
      from (
        select cp.privilege_type || '(' ||
               string_agg(cp.column_name, ',' order by cp.column_name) || ')' as entry
          from information_schema.column_privileges cp
         where cp.grantee = 'authenticated'
           and cp.table_schema = 'public' and cp.table_name = c.relname
         group by cp.privilege_type
      ) x
  ), '—') as column_grants,

  coalesce((
    select string_agg(distinct tp.privilege_type, ', ' order by tp.privilege_type)
      from information_schema.table_privileges tp
     where tp.grantee = 'anon'
       and tp.table_schema = 'public' and tp.table_name = c.relname
  ), '—') as anon_grants,

  (select string_agg(a.column_name, ', ' order by a.column_name)
     from information_schema.columns a
    where a.table_schema = 'public'
      and a.table_name = c.relname
      and a.column_name in ('impact', 'confidence')) as new_alert_columns

from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'r'
  and c.relname in ('alerts', 'brand_profile', 'competitor_suggestions',
                    'alert_analyses', 'conversations', 'messages')
order by c.relname;
