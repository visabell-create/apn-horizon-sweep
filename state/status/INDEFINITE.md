# INDEFINITE always-on — confirmed running

**Updated:** 2026-07-15T10:13:00Z

## Status: RUNNING INDEFINITELY

| Layer | Status | Details |
|-------|--------|---------|
| **Local loop** | **RUNNING** | PID **`28216`** in `state/always-on.pid` |
| **GitHub Actions cron** | **LIVE on `main`** | `*/30 * * * *` every 30 min UTC forever |
| **Workflow** | `.github/workflows/always-on-sweep.yml` | pushed; survives Cursor chat exit |
| **nextCursor** | advances each cycle | see `state/cursor.json` (was `8448-017-042` after RUN-012; mid-cycle now past that) |
| **End conditions** | **None** | no midnight, no run cap, no wall-clock end — only stop flag or PID kill |

## Local process

- Log: `state/always-on.log` / `state/always-on.err.log`
- Each cycle: archive `runs/`, `build:data`, commit+push when valids > 0
- Soft/hard jump forever (perpetual-horizon-v1)

## How to STOP

```powershell
New-Item -ItemType File -Force state\ALWAYS_ON_STOP
# or
.\scripts\always-on-sweep.ps1 -Stop
```

## Confirm alive

```powershell
Get-Content state\always-on.pid
Get-Process -Id (Get-Content state\always-on.pid)
Get-Content state\always-on.log -Tail 30
```
