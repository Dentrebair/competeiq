---
status: accepted
---

# The worker owns the scrape clock

The worker starts every scrape from a pg-boss cron per competitor. It runs the Shopify scraper Actor directly, with input built from `competitors.url`. Apify tasks and Apify Schedules are no longer used.

The trade-off:

- **When Apify owned the clock**, scrapes continued while the app was down. But every schedule and task was an external object to keep in sync with the database, and an orphaned schedule kept scraping and billing with nothing referencing it.
- **With the worker owning the clock**, `signal_configs` is the only source of truth for what runs when. The failure mode becomes a stopped worker, and that is made visible rather than left silent.

## Consequences

- **Cadence.** Each competitor is scraped once per interval, at the fastest `frequency_hours` among its enabled live signals. One Shopify scrape yields price, catalog and promo changes together.
- **Liveness.** A stopped worker means no scrapes, so it has to be noticed:
  - the worker writes a heartbeat every minute;
  - it also writes `signal_configs.last_run_at` and `last_error`;
  - the Alerts page health bar turns red when the heartbeat is more than 5 minutes old, or when a competitor misses its cadence.
- **Completion.** Each run gets an ad-hoc webhook pointing at `/api/webhooks/apify`, with its secret in a header set through `headersTemplate` (never in the URL). A check job about 30 minutes after start backs it up.
  - Both paths enqueue `process_apify_run` with `singletonKey` set to the run ID, so whichever arrives first wins.
  - The route enqueues only the run ID. The worker refetches the run and its dataset from Apify and never trusts the webhook body.
- **An inbound endpoint now exists**, reversing the old "no inbound endpoint" rule. Apify retries non-2xx deliveries for about 32 hours, so a redeploy loses nothing as long as the route fails with an error rather than a fake success.
- **Apify leftovers are removed after cutover.** Once the Apify console shows no schedules or tasks, a migration drops `competitors.apify_task_id`, `signal_configs.apify_schedule_id` and the delete-order trigger. The trigger goes last, because it is what blocks an orphaned schedule until then.
