# INDEFINITE always-on — confirmed running

**Updated:** 2026-07-15T03:11:32.5589086-07:00

## Status: RUNNING INDEFINITELY

| Layer | Status | Details |
|-------|--------|---------|
| **Local loop** | **RUNNING** | PID **`28260`** in `state/always-on.pid` |
| **GitHub Actions cron** | **LIVE on main** | `*/30 * * * *` every 30 min UTC forever (`.github/workflows/always-on-sweep.yml`) |
| **nextCursor** | `8448-017-042` | advances each cycle — soft/hard jump forever |
| **Last local cycle** | RUN-012 | 99 valids, 180 checks, SESSION_CAP_KEEP_GOING then sleep 90s |
| **End conditions** | **None** | no midnight, no run cap, no wall-clock end |

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
