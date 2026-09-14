---
status: superseded by ADR-0003
---

# Next.js and worker runtime

The app will use Next.js for the UI, authenticated operator actions, and webhook intake, plus a continuously running background worker on the Hostinger VPS for Collection Run processing, retries, digests, and external side effects. Supabase/Postgres will provide the initial durable job queue because it avoids another paid infrastructure service while supporting leases, idempotency, and recovery; the worker's business logic remains independent of the queue implementation so a managed queue can be introduced later if needed.

## Consequences

Long-running and unattended work does not depend on an HTTP request or a logged-in browser session. The VPS must run and monitor two processes, and deployment must provide worker health checks and restart behavior.
