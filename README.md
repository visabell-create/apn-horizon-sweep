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
| **Imagery** | Google Street View embed (coords only), Esri satellite tile thumbnail, third-party listing links |
| **Ownership & Records** | `ownerKnown` from archive only + LA County Assessor / Recorder lookup links |
| **Tax & Risk** | Tax, market, foreclosure from archive only |
| **Outreach links** | Have vs. need checklist (never fabricates phone/email) |

### Maps & imagery — API keys

| Feature | API key? | Source |
|---------|----------|--------|
| Interactive map pin | **No** | Leaflet + OpenStreetMap tiles |
| Parcel coordinates | **No** | LA County Assessor `Latitude` / `Longitude` from run `full.json` |
| Google Maps external link | **No** | Official search URL (address or lat/lon query) |
| Street View iframe embed | **No** | Official Google Maps `output=svembed` URL (coords required) |
| Esri satellite thumbnail | **No** | Esri World Imagery tile (free tier; attribution shown) |
| Zillow / Redfin links | **No** | External search URLs only — not scraped |

When `full.json` has no coordinates, the map tab shows an honest empty state and falls back to address-based external links.

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
- Geocoding service for parcels missing assessor coords (would require a documented API and ToS review)

Any future source must be wired explicitly in `scripts/build-web-data.mjs` and labeled in the UI — never silently merged from web scraping.

### Rebuild data after new runs

```bash
npm run build:data
```

This reads `runs/*/valids.json` + `full.json` (for parcel coordinates) and summaries and `state/cursor.json` / `LEFT_OFF.md`, then writes:

- `web/data/runs-index.json`
- `web/data/properties.json` (includes `latitude` / `longitude` when present in `full.json`)
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
