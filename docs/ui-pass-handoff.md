# UI pass handoff

A visual and hierarchy pass over the existing dashboard. Same data, same components,
same queries. Nothing here changes what the app fetches or how it authorises.

## Read first

- `AGENTS.md` — Next 16 has breaking changes from your training data. Read
  `node_modules/next/dist/docs/` before writing code.
- `CLAUDE.md` § Next 16 conventions and § Key rules.

## Do not touch

These are load-bearing and unrelated to how the page looks:

- **Realtime subscriptions** in `components/alert-feed.tsx` and
  `components/digest-panel.tsx`. Live updates are the product; a restructure that
  drops a subscription looks fine and is broken.
- **`requireUser()` in `app/page.tsx`** — `lib/dal.ts` is the authorization
  boundary, not `proxy.ts`.
- **The digest lock protocol** in `app/actions/digest.ts`. The conditional lock
  release is subtle and already correct.
- **`ai_available === false` renders "Unclassified", not a severity chip.** An
  unclassified alert is not a low-severity one. Keep that branch.
- **The severity token set.** `--sev-*` is deliberately not derived from
  `--accent`; urgency has to read on its own terms.

## What is already right — do not rebuild it

`app/globals.css` has a real design system: three-level elevation
(`--ground` / `--surface` / `--surface-sunken`), a three-step ink scale, one accent
with a wash, a four-step severity scale with washes, and full dark mode. The
rationale is written into the file.

**The palette is not the problem. Do not restyle the tokens.**

## The actual diagnosis

The page renders 39 cards of near-identical visual weight in a narrow column. Nothing
directs the eye. Specifically:

| Problem | Where | Now |
|---|---|---|
| Page is a thin column on any real display | `app/page.tsx` | `max-w-3xl` (768px) |
| The briefing headline — the single most valuable line — has no weight | `digest-panel.tsx` | `text-base`, same size as body copy |
| Severity is nearly invisible | `alert-feed.tsx` | rail is `w-1` (4px) |
| No type scale | everywhere | almost everything is `text-sm` or `text-xs` |
| 39 rows with no grouping | `alert-feed.tsx` | flat `gap-3` list |
| Signal type is easy to miss | `alert-feed.tsx` | `text-xs text-ink-faint`, text only |
| Briefing and feed read as equal-weight boxes | `page.tsx` | both bordered surfaces |

## 1. Layout — `app/page.tsx`

Widen the container. `max-w-3xl` was reasonable for a feed alone; it is too narrow
now that the briefing is the primary surface.

- Go to `max-w-5xl` (1024px), or `max-w-6xl` with a two-column feed at `lg:`.
- Keep the single column on mobile. Do not introduce a sidebar — there is one
  operator and two routes; navigation furniture would be noise.

## 2. The briefing — `components/digest-panel.tsx`

**This is the hero. It should own the fold.**

- `headline` → `text-2xl` (`text-3xl` at `md:`), `font-semibold`, `text-ink`,
  `leading-snug`. It is one sentence written to be read first; size it that way.
- The **Do this first** block should read as the strongest element after the
  headline. Give it the accent, not `--surface-sunken`: `border-accent`,
  `bg-accent-wash`, and keep the uppercase label. It is the one action the product
  exists to produce.
- **Patterns** stay secondary — the current `border-l-2` list is the right idea.
  Lift the pattern text to `text-[15px]` and keep the metadata at `text-xs`.
- The whole section wants more presence: a heavier border or a subtle shadow, and
  more internal padding than `px-5 py-4`.
- Keep every empty-state and error branch exactly as written. The `notice`-alongside-
  stale-digest case in particular is deliberate and easy to lose in a rewrite.

## 3. The feed — `components/alert-feed.tsx`

- **Rail `w-1` → `w-1.5`**, and drop `overflow-hidden` if it softens the colour.
  Severity should be legible peripherally, without reading the chip.
- **Group by day.** Insert a sticky `text-xs uppercase tracking-wide text-ink-faint`
  separator when the date changes — "Today", "Yesterday", then the date. This is the
  single biggest readability win on a 39-row feed.
- **Give `signal_type` an icon** so price / promo / catalogue are distinguishable at a
  glance. Inline SVG only; no icon library — it is three shapes.
- **Promote the price delta.** It is currently `text-xs` below the summary; it is
  often the most concrete fact in the row. Put `previous → current` and the percentage
  on the same line as the competitor name, at `text-sm`, `tabular`.
- Keep `opacity-60` for read rows. It works.
- Keep the summary at `text-sm leading-relaxed` — it is prose and reads well already.

## 4. Type scale

Establish and use four sizes. Right now nearly everything is `text-sm`/`text-xs`,
which is what actually reads as "unstyled":

```
display   text-2xl / md:text-3xl   digest headline only
body      text-[15px]              summaries, pattern text, priority action
meta      text-sm                  competitor names, prices
micro     text-xs                  timestamps, labels, alert ids
```

## Out of scope — deliberately

Do not start these in this pass. They are new surfaces and new queries, and the
existing screen should look right first.

- Price-history charts
- Competitor detail pages
- Filtering beyond the existing "Unread only" toggle
- Any change to `components/competitor-manager.tsx`

## Verify before calling it done

- `nvm use 22.21.1 && npm run build` — Turbopack build passes and type-checks.
- **Dark mode.** The palette supports it and it is easy to break; check both.
- **Realtime still works.** Insert a row via the smoke test in
  `docs/WF-03-handoff.md` and confirm it appears without a refresh.
- Narrow viewport — the wider container must still collapse cleanly.
- A `failed` digest and an empty feed both still render their states.
