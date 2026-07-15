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

**Live site:** [https://visabell-create.github.io/apn-horizon-sweep/](https://visabell-create.github.io/apn-horizon-sweep/)

### One-stop parcel drawer

Click any property row to open a tabbed detail drawer:

| Tab | What it shows |
|-----|----------------|
| **Overview** | Identity, use, values, run provenance |
| **Map & Location** | Leaflet + OpenStreetMap pin when assessor coords exist; otherwise address-based Google Maps link |
| **Imagery** | Street View embed + Esri satellite when coords exist; “Search free public listings” (Maps / Zillow / Redfin / Realtor.com / Assessor) — no hosted MLS photos |
| **Ownership & Records** | `ownerKnown` from archive only + LA County Assessor / Recorder lookup links |
| **Tax & Risk** | Tax, market, foreclosure from archive only |
| **Outreach links** | Have vs. need checklist (never fabricates phone/email) |

### Maps & imagery — API keys

| Feature | API key? | Source |
|---------|----------|--------|
| Interactive map pin | **No** | Leaflet + OpenStreetMap tiles |
| Parcel coordinates | **No** | LA County Assessor API (`Latitude` / `Longitude`) via `state/coords-cache.json` + run `full.json` |
| Google Maps external link | **No** | Official search URL (address or lat/lon query) |
| Street View iframe embed | **No** | Official Google Maps `output=svembed` URL (coords required) |
| Esri satellite thumbnail | **No** | Esri World Imagery tile (free tier; attribution shown) |
| Zillow / Redfin / Realtor.com | **No** | Outbound **search/listing page** URLs only — never scraped; we do not host MLS photos |

When coordinates are missing, the map tab shows an honest empty state and falls back to address-based external links.

### Why we don't host MLS house photos

MLS / brokerage photo feeds (Zillow, Redfin, Realtor.com image CDNs, Google Image Search results, etc.) are protected by terms of use and often by copyright. This archive:

- **Does not** scrape, download, or mirror listing photos into `web/` or `runs/`
- **Does** link out to official public search pages so you can view photos where they are hosted
- **Does** use free public pathways: LA County Assessor coordinates, Google Street View embeds/links, and Esri World Imagery tiles

Label in the Imagery tab: *Photos on MLS sites open on their pages — we don't host MLS photos.*

### Coordinate backfill

Most historical sweep `full.json` files omit `Latitude` / `Longitude`. Backfill from the public assessor API — **indefinitely** until essentially every archive AIN has coords (and forever rescanning for new valids):

```bash
# Background indefinite loop (recommended)
.\scripts\backfill-coords.ps1

# Or foreground / npm
npm run backfill:coords:loop

# One pass / smoke
npm run backfill:coords
npm run backfill:coords -- --batch=50

# Stop
.\scripts\backfill-coords.ps1 -Stop
```

`scripts/backfill-coords.mjs` walks every unique AIN in `runs/*/valids.json` (and `web/data/properties.json` if present), calls `https://portal.assessor.lacounty.gov/api/parceldetail?ain={digits}` with a polite ~60ms delay, and writes `state/coords-cache.json`. When caught up it **sleeps and rescans** — it does not exit. Status: `state/status/COORDS-BACKFILL.md`.

The **always-on sweep** also runs a `--batch=120` coords nudge after each cycle so new parcels and historic gaps keep filling while the walker runs. `build:data` merges the cache into property rows so Map, Street View, and satellite work for most parcels.

### Owner data — what we can and cannot provide

**In archive today:**

- `ownerKnown` — rare; only when explicitly captured during a sweep (e.g. RUN-001 notes)
- Ownership transfer snippets — recording dates, document numbers, prices, doc types (no grantee names unless `ownerKnown` is set)
- Tax status, assessed values, last buy, foreclosure history flags

**Not in archive (never invented):**

- Owner names from Google or web search
- Mailing address, phone, email
- Current listing price or MLS status beyond what the assessor archive captured

**Official lookup links** in the drawer point to the [LA County Assessor portal](https://portal.assessor.lacounty.gov/) and [Recorder deed search](https://lavote.gov/home/records/property-document-recording/document-search).

### Future enrichment options

Not implemented — documented for planning only:

- Paid deed / title APIs (grantee names, mailing address)
- Licensed skip-trace or contact enrichment vendors
- Geocoding beyond the assessor portal API (would require a documented service and ToS review)

Any future source must be wired explicitly in `scripts/build-web-data.mjs` and labeled in the UI — never silently merged from web scraping.

### Rebuild data after new runs

```bash
npm run backfill:coords   # refresh lat/lon cache when new valids appear
npm run build:data
```

This reads `runs/*/valids.json` + `full.json`, `state/coords-cache.json` (assessor lat/lon), and `state/cursor.json` / `LEFT_OFF.md`, then writes:

- `web/data/runs-index.json`
- `web/data/properties.json` (includes `latitude` / `longitude` when known)
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

## Always-on sweep (feeds the live site)

Two layers keep the archive moving after deploy:

| Layer | Role | Reliability |
|-------|------|-------------|
| **GitHub Actions cron** | Every **30** min runs a **bounded** Node cycle (`--max-checks=45`, ~7 min cap), archives under `runs/`, rebuilds `web/data`, commits to `main` → Pages redeploy | Best “since deployed on GitHub” path — but the assessor **often blocks datacenter IPs**. Failed runs report `ASSESSOR_BLOCKED` clearly and invent **no** data. |
| **Local always-on loop** | Same perpetual-horizon-v1 logic via Node HTTPS; sleeps ~90s between cycles; commits + pushes when it finds parcels | Best fetch success from a residential IP; only runs while this machine is on |

### Algorithm (unchanged)

`scripts/always-on-sweep.mjs` implements **perpetual-horizon-v1**: walk AIN +1, probe horizon at 5 invalids, soft-jump at 12, hard-jump at 20 (never hard-stop on empty pages). Reads/writes `state/cursor.json` (`nextCursor`, `donePages`, `horizonQueue`). Partial pages are **not** left in `donePages` while still walking them.

### Start / stop local loop

```powershell
# Background (writes state/always-on.pid + state/always-on.log)
.\scripts\always-on-sweep.ps1

# Foreground
.\scripts\always-on-sweep.ps1 -Foreground

# Single cycle (no loop)
.\scripts\always-on-sweep.ps1 -Once
# or: npm run sweep:once

# Stop
.\scripts\always-on-sweep.ps1 -Stop
```

Or Node directly:

```bash
npm run sweep:always-on          # loop
npm run sweep:once               # one cycle
```

Flags: `--max-checks=180`, `--sleep-sec=90`, `--no-git`, `--max-seconds=420` (CI time budget).

### Actions workflow

[`.github/workflows/always-on-sweep.yml`](./.github/workflows/always-on-sweep.yml) — schedule `*/30 * * * *` (forever) + `workflow_dispatch`. Needs `contents: write`. On assessor block, the job fails with an explicit error and docs point back to local always-on.

Stop local: `New-Item state\ALWAYS_ON_STOP` or `.\scripts\always-on-sweep.ps1 -Stop`. See [`state/status/INDEFINITE.md`](./state/status/INDEFINITE.md).

### Continue manually

Cursor: see `state/cursor.json` → `nextCursor`. Soft-jumps keep motion; never halt on empty pages.
