---
status: accepted
supersedes: ADR-0002
---

# Direct cutover, gated on parity with WF-02's own code

The replacement pipeline takes over from n8n in one step instead of first running in shadow beside it. Shadow mode needed a separate shadow Baseline, run-by-run comparison against n8n's Alerts, and a validation gate. That is a second pipeline to build, for a single operator with one real competitor.

n8n was undeployed on 2026-09-14, and Apify last ran on 2026-08-23. So the reference is not a live n8n: it is WF-02's exported code.

- **The reference.** The Code nodes that decide output (Build Context, Diff Price, Diff Catalog, Diff Promo, Build Claude Prompt, Parse Claude, Normalize Alert, Build Price Rows) are pure JavaScript. They are vendored verbatim and executed inside the test suite with a small `$input` / `$()` shim.
- **The gate.** For every fixture, the port must produce the same output as that reference. Fixtures are real Apify datasets paired with hand-built Baselines that exercise each branch: first run, price move, promo, products added and removed, no change, and an empty dataset.
- **Per-run undo.** Baseline History makes any single bad run reversible.
- **An emergency stop.** Pipeline Mode `paused` stops processing without losing queued work.

## Consequences

- Parity compares the deterministic output: signal type, severity, product, prices, delta, dedupe key, the Claude request, and the Baseline rows. Claude's reply is canned in tests.
- Rollback is pause, fix, then reverse the bad run from Baseline History. n8n is not coming back.
- The Supabase project n8n wrote to was deleted (discovered 2026-09-14), so the new project starts with an empty Baseline. Nothing needs backing up, and each competitor's first run captures a Baseline and reports only promos.
- The cutover order is:
  1. Parity passes.
  2. Deploy the worker, which starts paused.
  3. Set `pipeline_state.mode = 'live'`.
  4. Watch the first runs.
  5. Drop the Apify leftovers (see ADR-0005).
