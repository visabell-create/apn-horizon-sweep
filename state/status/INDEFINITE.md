# INDEFINITE always-on — confirmed running

**Updated:** 2026-07-15T10:06:06Z

## Status: RUNNING INDEFINITELY

| Layer | Status | Details |
|-------|--------|---------|
| **Local loop** | **RUNNING** | PID **`28260`** in `state/always-on.pid` |
| **GitHub Actions cron** | **Enabled** after push of `.github/workflows/always-on-sweep.yml` | `*/30 * * * *` (every 30 min UTC, forever) |
| **nextCursor** | `8448-037-037` | from `state/cursor.json` at arm time (advances each cycle) |
| **Algorithm** | `perpetual-horizon-v1` | soft-jump @12 / hard-jump @20 — never hard-stops on empty pages |
| **End conditions** | **None** | no midnight stop, no run cap, no wall-clock end |

## Local process

- **Start:** `.\scripts\always-on-sweep.ps1` (or `npm run sweep:always-on`)
- **PID file:** `state/always-on.pid`
- **Stdout log:** `state/always-on.log`
- **Stderr log:** `state/always-on.err.log`
- Each cycle: archive `runs/RUN-NNN-…`, `npm run build:data`, **git commit+push when valids > 0**

## GitHub Actions (survives Cursor / machine sleep)

- Workflow: `.github/workflows/always-on-sweep.yml`
- Schedule: every **30 minutes** UTC, forever (`*/30 * * * *`) + `workflow_dispatch`
- Bounded per job (~45 checks / ~7 min) so Actions does not timeout — cron keeps firing forever
- If assessor blocks datacenter IPs, job fails clearly (`ASSESSOR_BLOCKED`); local loop remains the feeder

## How to STOP

**Soft stop (preferred):**

```powershell
New-Item -ItemType File -Force state\ALWAYS_ON_STOP
```

Loop exits cleanly between cycles (or mid-cycle check), then removes the flag and PID file.

**Or kill PID:**

```powershell
.\scripts\always-on-sweep.ps1 -Stop
# or:
Stop-Process -Id (Get-Content state\always-on.pid)
```

## Confirm still alive

```powershell
Get-Content state\always-on.pid
Get-Process -Id (Get-Content state\always-on.pid)
Get-Content state\always-on.log -Tail 30
```
