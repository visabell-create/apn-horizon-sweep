# LEFT OFF — agent coordination log

**Updated:** 2026-07-15T00:00+ local (MIDNIGHT-MERGE)

## Global cursor (serial chain)

**Authoritative next shared cursor:** `8448-033-063` (digits `8448033063`)

### nextCursor choice (documented)

Serial RUN-010 stopped at midnight with `nextCursor: 8448-033-063` after last checked `8448-033-062`. Page **033 is only partially walked** — do **not** put it in `donePages`; resume at parcel **063**.

Do not jump ahead to `horizonQueue` head (`8448-037`) until 033 is finished or soft-jumped. Do not use older freezes `8448-006-026` / `8448-054-012` / `8448-021-061`.

## Session tallies (separate streams)

| Stream | Valids |
|--------|-------:|
| Serial RUN-010 | **64** |
| Parallel midnight-B (011/022/027) | **86** |

Do **not** add these together as unique AINs without dedup (027 may overlap serial vs B).

## Merged donePages (59)

Prior serial+A* (53) + RUN-009 (**023, 031**) + RUN-010 (**006**) + midnight-B (**011, 022, 027**). **033 excluded** (partial).

```
003, 004, 005, 006, 007, 008, 010, 011, 018, 019, 020, 021, 022, 023,
025, 026, 027, 031, 038, 039, 041, 042, 043, 045, 046, 047, 048, 049, 050, 051, 052, 053, 054,
055, 056, 057, 058, 059, 060, 061, 062, 063, 064, 065, 066, 067, 068, 069, 070,
071, 072, 073, 074, 075, 076, 077, 078, 079, 080
```

## Midnight-B status

- Claim: `completed` (`state/claims/agent-midnight-B.json`)
- Pages: **011, 022, 027** — all `20_INVALID_STREAK`; folded into `donePages`
- Archives: `runs/RUN-B-MIDNIGHT-8448-011|022|027` + aggregate
- Valids: **86** (vacant 24)

## Serial RUN-010 status

- Archive: `runs/RUN-010-2026-07-15-horizon`
- Path: `006-042` → soft jump `027-020` → soft jump `033-026` → stop at **033-063**
- Valids: **64**; checks: 96; reason: `MIDNIGHT_STOP`

## See also

- `state/status/MIDNIGHT-MERGE.md`
- `state/status/MIDNIGHT-STOP.md`
- `state/status/STATE-MERGE-2330.md` (prior 23:30 merge)
