---
status: superseded by ADR-0004
---

# Shadow-to-live intelligence cutover

The replacement pipeline will first run in `shadow` mode, beginning with one competitor and requiring three successful Shadow Runs before expanding validation. Shadow processing writes dedicated validation records and never changes production Alerts or the Baseline; after every active competitor has completed validation, n8n alert writing is disabled and the server-side Pipeline Mode changes to `live`, making the app the sole Authoritative Writer.

## Consequences

The cutover avoids duplicate Alerts and conflicting Baselines while preserving a measurable rollback path: new processing can be paused and queued work replayed without re-enabling n8n as a second writer. The deployment needs explicit mode checks, idempotency by Apify run, and a pre-flight gate before entering `live`.
