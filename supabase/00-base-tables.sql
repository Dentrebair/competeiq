-- ============================================================================
-- REAL-LEAD — base tables
--
-- Run FIRST on a new Supabase project, then 01 → 07 in order. Idempotent.
--
-- These three tables were created by hand for n8n before this repo had
-- migrations, and 01–06 were written on top of them. The project they lived in
-- is gone (2026-09-14), so this file recreates them exactly as they were, which
-- lets the rest of the chain apply unchanged.
--
-- If you change anything here, update lib/types/database.ts to match.
-- ============================================================================

create sequence if not exists public.alerts_id_seq;

create table if not exists public.competitors (
  id             uuid not null default gen_random_uuid(),
  name           text not null,
  domain         text not null unique,
  url            text not null,
  apify_task_id  text,
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  constraint competitors_pkey primary key (id)
);

create table if not exists public.alerts (
  id                  bigint not null default nextval('public.alerts_id_seq'::regclass),
  created_at          timestamptz not null default now(),
  workflow            text not null,
  execution_id        text,
  competitor_id       uuid,
  competitor_name     text not null,
  signal_type         text not null,
  severity            text not null,
  summary             text not null,
  recommended_action  text,
  product_title       text,
  product_handle      text,
  product_url         text,
  currency            text,
  previous_price      numeric,
  current_price       numeric,
  delta_pct           numeric,
  -- false when the Claude call failed, so an unclassified alert is
  -- distinguishable from one genuinely rated low
  ai_available        boolean not null default true,
  constraint alerts_pkey primary key (id),
  constraint alerts_competitor_fk foreign key (competitor_id)
    references public.competitors (id)
);

alter sequence public.alerts_id_seq owned by public.alerts.id;

-- Per-product last-known state: the Baseline. Signal Evaluation compares each
-- scraped product against last_price for its handle, so it can name the exact
-- SKU that moved.
create table if not exists public.competitor_products (
  competitor_id   uuid not null,
  product_handle  text not null,
  product_title   text,
  product_url     text,
  currency        text,
  last_price      numeric,
  last_seen_at    timestamptz not null default now(),
  constraint competitor_products_pkey primary key (competitor_id, product_handle),
  constraint competitor_products_competitor_id_fkey foreign key (competitor_id)
    references public.competitors (id)
);

-- Verify: expect three rows.
select table_name
from information_schema.tables
where table_schema = 'public'
  and table_name in ('competitors', 'alerts', 'competitor_products')
order by table_name;
