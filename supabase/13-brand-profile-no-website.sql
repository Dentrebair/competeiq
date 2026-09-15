-- ============================================================================
-- REAL-LEAD — brand_profile without a website
--
-- Run AFTER 12-inventory-signal.sql. Idempotent.
--
-- Onboarding assumed every business has a site to read (05-intelligence-layer.sql:
-- `url text not null`). Some don't yet — this lets the operator describe their
-- business in their own words instead, tagged with a fourth catalogue_source
-- ('described') distinct from 'inferred' (which still means "we read a real
-- site, but had to guess at the soft parts"). A business with no site has no
-- catalogue to be uncertain about — there is simply none.
-- ============================================================================

alter table public.brand_profile
  alter column url drop not null;

do $$
declare
  existing_name text;
begin
  select conname into existing_name
    from pg_constraint
   where conrelid = 'public.brand_profile'::regclass
     and contype = 'c'
     and pg_get_constraintdef(oid) ilike '%catalogue_source%';

  if existing_name is not null then
    execute format('alter table public.brand_profile drop constraint %I', existing_name);
  end if;

  alter table public.brand_profile
    add constraint brand_profile_catalogue_source_check
    check (catalogue_source in ('confirmed', 'page_data', 'inferred', 'described'));
end $$;


-- ============================================================================
-- VERIFY — one result set. Every row should say ok = true.
-- ============================================================================

select check_name, ok
from (values
  ('brand_profile.url is nullable',
     (select is_nullable = 'YES' from information_schema.columns
       where table_schema = 'public' and table_name = 'brand_profile' and column_name = 'url')),
  ('brand_profile.catalogue_source accepts described',
     (select pg_get_constraintdef(oid) ilike '%described%'
        from pg_constraint
       where conrelid = 'public.brand_profile'::regclass
         and contype = 'c' and pg_get_constraintdef(oid) ilike '%catalogue_source%'))
) as checks (check_name, ok)
order by ok, check_name;
