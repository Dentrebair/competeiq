---
status: accepted
supersedes: ADR-0001
---

# Railway worker with pg-boss on Supabase

The intelligence pipeline moves out of n8n into this repository. It is deployed to Railway as two services built from one repo: the Next.js web app and a long-running worker (`npm run start:worker`). Railway was chosen over the Hostinger VPS for two reasons. It gives deploy-from-GitHub, restart-on-crash and health checks with nothing to build. It also keeps the new pipeline off the box that runs n8n during cutover.

The durable queue is pg-boss on the Supabase session pooler (`:5432`, IPv4 on every plan), with `useListenNotify` off. pg-boss was chosen over a hand-written jobs table because leases, backoff, dead-lettering, singleton keys and cron are exactly where a home-made queue picks up bugs.

The worker connects with plain `pg` as a scoped `pipeline_worker` Postgres role, never the service role key. One connection and one role let an Alert insert, its Baseline update and its Baseline History rows commit in a single transaction, which supabase-js cannot do.

## Consequences

- pg-boss 12 needs Node ≥ 22.12. Creating a queue runs DDL (each queue gets its own partition table), so the migration creates the `pgboss` schema owned by `pipeline_worker`, and the worker installs and upgrades pg-boss inside it (`migrate: true`). Owning that schema gives no rights on `public`.
- Custom logins connect through the Supabase pooler as `role.projectref`.
- Stay on the session pooler. pg-boss issue #773 (stale reads on the transaction pooler, `:6543`) is unresolved.
- All queue access goes through one `queue` module, so pg-boss can be replaced without touching business logic.
- Railway is a monthly, usage-based bill.
