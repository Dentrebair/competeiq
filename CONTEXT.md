# REAL-LEAD

A competitor-intelligence context for collecting commercial changes, evaluating their significance, and presenting alerts and digests to an operator.

## Intelligence

**Collection Run**:
One Apify execution for one competitor, together with the observations it returns.
_Avoid_: Scrape, workflow run

**Signal Evaluation**:
The process of comparing a Collection Run with the current Baseline and deciding which monitored signal each change represents.
_Avoid_: Detection, workflow step

**Alert**:
An operator-facing record of a commercially meaningful change found by Signal Evaluation.
_Avoid_: Event, notification

**Digest**:
A Claude-generated briefing that summarizes recent Alerts and recommends the operator's next action.
_Avoid_: Report, email

**Baseline**:
The latest accepted competitor observations, used as the comparison point for the next Collection Run.
_Avoid_: Snapshot, cache

**Baseline History**:
The record of how each Collection Run changed the Baseline, precise enough to reverse a single run.
_Avoid_: Audit log, price log

## Processing

**Pipeline Mode**:
The server-side operating mode: `live` processes Collection Runs and starts scrapes; `paused` holds queued work without processing it.
_Avoid_: Feature flag, environment toggle

**Processing Job**:
A durable unit of background work claimed and leased by a worker.
_Avoid_: Task, workflow

**Authoritative Writer**:
The single pipeline permitted to create production Alerts and update the Baseline at a given time.
_Avoid_: Primary workflow, source of truth
