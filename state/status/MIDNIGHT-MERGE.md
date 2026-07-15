# MIDNIGHT MERGE — serial RUN-010 + parallel midnight-B

**When:** 2026-07-15 ~00:00+ local (post midnight stop)  
**Scope:** Coordination only — no new sweeps

## Inputs read

- `state/status/MIDNIGHT-STOP.md` (serial hard stop at `8448-033-063`; RUN-010 valids **64**)
- `state/status/agent-midnight-B.md` + `state/claims/agent-midnight-B.json` (pages 011/022/027; valids **86**)
- `state/cursor.json` (pre-merge already carried RUN-009/010 jumps; incorrectly had `8448-033` in `donePages`)
- `state/LEFT_OFF.md` (prior authoritative resume `8448-006-026` from STATE-MERGE-2330)
- `runs/RUN-010-2026-07-15-horizon/summary.md` + `runs/RUN-B-MIDNIGHT-*`

## Valid totals — keep separate (do not double-count)

| Stream | Valids | Notes |
|--------|-------:|-------|
| Serial RUN-010 (this midnight session) | **64** | Checks 96; soft jumps `006-071→027-020`, `027-048→033-026`; stop `MIDNIGHT_STOP` |
| Parallel agent-midnight-B | **86** | Vacant land counted valid: 24; exclusive 011/022/027 |
| Prior serial RUN-001..009 (approx) | ~1271 | 1112 (001–008) + 159 (009); separate historical stream |
| Prior parallel A01–A10 | 160 | Unchanged this merge |

**Do not** sum 64 + 86 as unique AINs without dedup. Serial walked parcels on **027** that midnight-B also covered (overlap possible on that page only).

## Merged `donePages` (59)

Prior 53 (STATE-MERGE-2330) **+** RUN-009 soft-jump completes **023, 031** **+** RUN-010 complete **006** **+** midnight-B **011, 022, 027**.

```
003–008, 010–011, 018–023, 025–027, 031, 038–039, 041–043, 045–080
```

**Not done:** `8448-033` — midnight stop mid-page; parcel-level resume required.

## nextCursor decision

| Candidate | Decision |
|-----------|----------|
| Soft-jump / queue head (e.g. `8448-037-020`) | **Rejected** — would abandon in-progress page 033 |
| Mark 033 done and advance | **Rejected** — page only partial (`last AIN` 033-062) |
| **`8448-033-063`** | **Selected** — serial MIDNIGHT-STOP resume; keep parcel-level cursor |

## Files updated this merge

1. `state/cursor.json` — `donePages` 59; removed premature `8448-033`; added 011/022; `nextCursor: 8448-033-063`; pruned 011/022 from `horizonQueue`
2. `state/LEFT_OFF.md` — authoritative resume + tallies
3. `state/status/MIDNIGHT-MERGE.md` — this document
4. `runs/INDEX.md` — light refresh

## Return value

- **final nextCursor:** `8448-033-063`
- **serial RUN-010 valids:** **64**
- **parallel midnight-B valids:** **86**
