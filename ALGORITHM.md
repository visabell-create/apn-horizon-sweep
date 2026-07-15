# Perpetual APN Horizon Sweep

Never stop the motion. Always keep work queued ahead of the cursor.

## Core ideas

1. **Primary motion** — walk AIN +1 (mapbook-page-parcel as a 10-digit integer).
2. **Horizon probe** — when invalids cluster, look *ahead* at future map pages and score density before the streak dies.
3. **Jump, don't stop** — at a soft threshold, hop to the densest queued page. Hard "20 invalids" only triggers an emergency jump, never a halt.
4. **Run copies** — every run flushes a full snapshot under `runs/` (JSON + CSV + summary). State survives in `state/`.

## Thresholds

| Name | Default | Meaning |
|------|---------|---------|
| `LOOKAHEAD_TRIGGER` | 5 | Start probing horizon while still walking |
| `SOFT_JUMP` | 12 | Jump to best queued dense page |
| `HARD_JUMP` | 20 | Emergency jump even if queue empty |
| `HORIZON_PAGES` | 20 | How many pages ahead to sample |
| `SAMPLE_PARCELS` | 001, 020, 026, 040, 050, 080, 100 | Probe points per page |

## Horizon scoring

For each candidate page `BBBB-PPP`:

- Hit each sample parcel via `/api/parceldetail?ain=`
- Count **VALID** = has Parcel and (situs street OR UseType set OR assessed land/imp > 0)
- Score = valid samples × 10 + bonus if any Calle / high-value / vacant-land cluster
- Push top scores into `state/horizon_queue.json` (deduped, already-done pages skipped)

## Validity rule (include vacant lots)

A parcel is **VALID** if API returns a Parcel object and ANY of:

- non-empty `SitusStreet`
- `UseType` present (incl. Vacant Land)
- `SqftLot` > 0 or roll land/imp values > 0

Empty shell / `Parcel not found` = INVALID.

## Motion plan

```
while true:
  if invalid_streak >= LOOKAHEAD_TRIGGER:
      probe_horizon(cursor_page, HORIZON_PAGES)  # async-ish / same tick
      refresh_queue()

  if invalid_streak >= SOFT_JUMP and queue_not_empty:
      jump(best_queued_page_start())
      archive_run_checkpoint()
      continue

  if invalid_streak >= HARD_JUMP:
      if queue_not_empty: jump(best)
      else: emergency_probe(page+1..page+50) or next_mapbook()
      archive_run_checkpoint()
      continue

  fetch(cursor_ain)
  record(valid|invalid)
  cursor_ain += 1
  periodically flush_run_copy()
```

## Run copy layout

```
runs/
  RUN-001-2026-07-11-page-008/
    summary.md
    valids.json
    valids.csv
    meta.json
  RUN-002-2026-07-14-page-038/
    ...
  RUN-003-.../
```

`state/cursor.json` holds: last AIN, streak, queue, completed pages, master valid count.
