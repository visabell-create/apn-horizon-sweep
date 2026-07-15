# STATE MERGE 23:30 — serial + parallel fleet coordination

**When:** 2026-07-14 ~23:30 local  
**Scope:** Coordination only — no new long sweep

## Inputs read

- `state/cursor.json` (serial walker left `nextCursor: 8448-021-061`, `mainChainTotalApprox: 1112`, RUN-001..008)
- `state/LEFT_OFF.md` (had frozen `8448-054-012` after STATUS-1130)
- `state/status/CURSOR-RECONCILE.md` (restored 054-012; A08 then still open)
- `state/status/STATUS-1130.md` (parallel rollup: 160 valids; A08 unknown)
- `state/claims/agent-01.json` … `agent-10.json` (+ manifest)
- `runs/INDEX.md` + all `runs/RUN-*` folders (36 total at merge)

## Archived run folders

| Category | Count | Folders |
|----------|------:|---------|
| Serial horizon / page | **8** | RUN-001 … RUN-008 |
| Parallel exclusive | **26** | RUN-A01…A07, A08 (6), A09 (6 incl aggregate), A10 (6 incl aggregate) |
| **Total archived run dirs** | **36** | |

## Valid totals — keep separate (do not double-count)

| Stream | Approx valids | Notes |
|--------|--------------:|-------|
| Serial main chain (sum of RUN-001..008 `valids.json`) | **~1112** | 2+26+241+207+202+159+141+134; `cursor.mainChainTotalApprox` |
| Parallel A01–A07, A09–A10 | **160** | From claims / STATUS-1130 |
| Parallel A08 | **0** | Empty pages 066–070 |
| **Naive sum 1112+160** | **1272** | **NOT unique AIN count** — report only as separate stream totals |

**Caution:** Serial and parallel may overlap in *accounting* if anyone merges CSV dumps without AIN dedup. Exclusive parallel ranges (043, 055–056, 058–059, 061–080) were partitioned away from the main serial dense path that finished RUN-003..005 in 039–060, so geographical overlap risk is low — but do not treat 1272 as unique inventory.

## Merged `donePages` (53)

All pages actually archived by serial RUN-001..008 **plus** all completed A* pages (including A08):

```
003–005, 007–008, 010, 018–021, 025–026, 038–039, 041–043,
045–080
```

(Missing interior examples still unfinished: 001–002, 006, 009, 011–017, 022–024, 027–037, 040, 044, …)

## nextCursor decision

| Candidate | Decision |
|-----------|----------|
| `8448-021-061` (serial RUN-008 resume) | **Rejected** — `8448-021` already in `donePages`; resume would re-walk finished page |
| `8448-054-012` (LEFT_OFF / CURSOR-RECONCILE freeze) | **Superseded** — page 054 done; freeze was anti-drift only |
| **`8448-006-026`** | **Selected** — lowest unfinished dense `horizonQueue` entry not in `donePages` (`hits=2`, `firstValidParcel=26`) |

## A08 status

| Field | Value |
|-------|--------|
| Claim file | `status: completed` |
| Valids | 0 |
| Checks | 100 |
| Archives present | yes (`RUN-A08-*`) |
| `donePages` | **066–070 included** (claim no longer `in_progress`) |

At STATUS-1130, A08 was still `in_progress` with no archive. By merge time the claim flipped to completed and archives appeared; pages were therefore **not** protected-out — they were merged in.

## Duplicate risk remaining

| Risk | Level | Notes |
|------|-------|-------|
| Parallel vs parallel range overlap | **Low** | Exclusive claims disjoint |
| Serial resume into A* pages | **Low** after merge | All A01–A10 pages now in `donePages` |
| Serial re-entry of own `donePages` if walker ignores list | **Medium** | Indefinite loop still armed (`indefinite: true`); operators should skip `donePages` |
| Unique valid double-count if CSVs concatenated | **Elevated if naïve** | Keep serial ~1112 and parallel 160 separate until AIN-level dedup |
| Unfinished dense pages (006, 011, 022–024, 027–037, …) | Normal backlog | Horizon queue still lists them |

## Files updated this merge

1. `state/cursor.json` — merged `donePages` (53), `nextCursor: 8448-006-026`
2. `state/LEFT_OFF.md` — authoritative resume + A08 completed
3. `state/status/STATE-MERGE-2330.md` — this document
4. `runs/INDEX.md` — refreshed inventory

## Return value

- **final nextCursor:** `8448-006-026`
- **A08 status:** **completed** (0 valids; 066–070 in `donePages`)
