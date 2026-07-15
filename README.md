# APN Horizon Sweep

Perpetual Los Angeles County Assessor AIN walker for San Dimas / Calle Cristina area.

## Never-stop algorithm

See [ALGORITHM.md](./ALGORITHM.md).

- Walk AIN **+1**
- At **5** invalids → **probe horizon** (score future pages)
- At **12** invalids → **soft-jump** to densest queued page
- At **20** invalids → **hard-jump** (emergency). Never halt.
- Session only pauses at a check cap; cursor + queue saved in `state/cursor.json`

## Run archives

Each folder under `runs/` has `summary.md`, `valids.json`, `valids.csv`, `full.json`. Master index: `runs/INDEX.md`. Cursor / donePages: `state/cursor.json`.

## Web archive (GitHub Pages)

Static viewer under [`web/`](./web/) — every archived run, property table, and current cursor / LEFT_OFF summary.

### Rebuild data after new runs

```bash
npm run build:data
```

This reads `runs/*/valids.json` + summaries and `state/cursor.json` / `LEFT_OFF.md`, then writes:

- `web/data/runs-index.json`
- `web/data/properties.json`
- `web/data/state.json`
- `web/data/run-RUN-*.json` (per-run snapshots)

Only real archive rows are included (nothing invented). Local paths and obvious secret patterns are scrubbed.

### Redeploy

Push to `main` (or run the **Deploy Horizon Sweep to GitHub Pages** workflow). GitHub Actions rebuilds data and publishes `web/` to Pages.

```bash
git add runs state web
git commit -m "Archive new sweep runs"
git push
```

Local preview: open `web/index.html` via a static server after `npm run build:data`, e.g. `npx serve web`.

## Continue

Cursor: see `state/cursor.json` → `nextCursor`. Soft-jumps keep motion; never halt on empty pages.
