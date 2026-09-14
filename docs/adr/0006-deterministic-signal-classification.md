---
status: accepted
---

# Code decides signal type and severity; Claude writes the words

Signal type comes from which diff branch fired. Severity comes from fixed bands on the size of the move. Both live in code ported faithfully from WF-02 (Diff Price, Diff Catalog, Diff Promo, and the bands in Normalize Alert). Claude writes only the summary, impact and action.

Letting the model classify was tried, and it failed. In n8n execution 4271, two identical −33% promos came back rated `low` and `medium`, and a −50% discount came back `low`.

## Consequences

- **Model.** The call starts on `claude-haiku-4-5` with the prompt WF-02 runs today, so the port changes one thing at a time. Changing the model is a later, separate step.
- **Failure.** Transient Claude failures retry with backoff. Once retries are exhausted, the Alert is still written with `ai_available = false`, and the UI keeps rendering it as Unclassified.
- **Pinned behaviour.** Tests pin the ported diff and severity behaviour before anything changes it.
