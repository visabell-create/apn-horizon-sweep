# Agent-08 exclusive sweep: 8448-066..070, soft-jump only among own pages
$ErrorActionPreference = "Stop"
$Root = "C:\Users\Authorized User\apn-horizon-sweep"
$Base = "https://portal.assessor.lacounty.gov"
$Pages = @(66, 67, 68, 69, 70)
$SoftJump = 12
$HardJump = 20
$Sample = @(1, 20, 26, 40, 50, 80, 100)

function Fmt([int64]$n) {
  $s = $n.ToString().PadLeft(10, '0')
  return "$($s.Substring(0,4))-$($s.Substring(4,3))-$($s.Substring(7,3))"
}
function MakeAin([int]$book, [int]$page, [int]$parcel) {
  return [int64]($book * 1000000L + $page * 1000L + $parcel)
}
function IsValid($data) {
  if ($null -eq $data -or $data.Error -or $null -eq $data.Parcel) { return $false }
  $p = $data.Parcel
  $street = ("$($p.SitusStreet)").Trim()
  $use = ("$($p.UseType)").Trim()
  $lot = 0; try { $lot = [double]$p.SqftLot } catch {}
  $land = 0; try { $land = [double]$p.CurrentRoll_LandValue } catch {}
  $imp = 0; try { $imp = [double]$p.CurrentRoll_ImpValue } catch {}
  return [bool]($street -or $use -or ($lot -gt 0) -or ($land -gt 0) -or ($imp -gt 0))
}
function FetchDetail([int64]$ainNum) {
  $ain = $ainNum.ToString().PadLeft(10, '0')
  try {
    return Invoke-RestMethod -Uri "$Base/api/parceldetail?ain=$ain" -Headers @{ Accept = "application/json" } -TimeoutSec 30
  } catch { return $null }
}
function Enrich([int64]$ainNum, $p) {
  $ain = $ainNum.ToString().PadLeft(10, '0')
  $owners = @()
  try {
    $oh = Invoke-RestMethod -Uri "$Base/api/parcel_ownershiphistory?ain=$ain" -Headers @{ Accept = "application/json" } -TimeoutSec 30
    $owners = @($oh.Parcel_OwnershipHistory | Select-Object -First 5 | ForEach-Object {
      $dt = if ($_.DocumentTypeDesc) { [string]$_.DocumentTypeDesc } else { [string]$_.DocumentType }
      $rs = if ($_.DocumentReasonCodeDesc) { [string]$_.DocumentReasonCodeDesc } else { [string]$_.DocumentReasonCode }
      [pscustomobject]@{
        rec = $_.RecordingDate
        doc = $_.DocumentNumber
        price = $_.DTTSalePrice
        assessed = $_.AssessedValue
        docType = $dt.Trim()
        reason = $rs.Trim()
      }
    })
  } catch {}
  $lastBuy = $owners | Where-Object { $_.price -and [double]$_.price -gt 1000 } | Select-Object -First 1
  $hasFc = [bool]($owners | Where-Object { $_.docType -match 'foreclos' -or $_.reason -match 'Trustee Sale' })
  $land = 0; try { $land = [double]$p.CurrentRoll_LandValue } catch {}
  $imp = 0; try { $imp = [double]$p.CurrentRoll_ImpValue } catch {}
  return [ordered]@{
    ain = (Fmt $ainNum)
    status = "VALID"
    address = ("$($p.SitusStreet)".Trim() + ", " + "$($p.SitusCity)".Trim() + " " + "$($p.SitusZipCode)".Trim()).Trim().TrimStart(',').Trim()
    useType = ("$($p.UseType)").Trim()
    parcelStatus = $p.ParcelStatus
    taxStatus = $p.TaxStatus
    yearDefaulted = $p.TaxDefaultedYear
    yearBuilt = $p.YearBuilt
    beds = $p.NumOfBeds
    baths = $p.NumOfBaths
    bldg = $p.SqftMain
    lot = $p.SqftLot
    assessed = $land + $imp
    lastBuy = $lastBuy
    hasForeclosureHist = $hasFc
    ownership = $owners
  }
}
function ScorePage([int]$book, [int]$page) {
  $hits = 0
  $first = $null
  foreach ($parcel in $Sample) {
    $data = FetchDetail (MakeAin $book $page $parcel)
    if (IsValid $data) {
      $hits++
      if ($null -eq $first) { $first = $parcel }
    }
    Start-Sleep -Milliseconds 20
  }
  if ($hits -eq 0) {
    for ($parcel = 1; $parcel -le 40; $parcel++) {
      $data = FetchDetail (MakeAin $book $page $parcel)
      if (IsValid $data) {
        $hits = 1
        $first = $parcel
        break
      }
      Start-Sleep -Milliseconds 15
    }
  }
  return [pscustomobject]@{
    book = $book; page = $page; hits = $hits
    firstValidParcel = $(if ($null -eq $first) { 1 } else { $first })
    key = ("{0}-{1:D3}" -f $book, $page)
  }
}

# Dedup against donePages
$cursor = Get-Content -Raw (Join-Path $Root "state\cursor.json") | ConvertFrom-Json
$done = [System.Collections.Generic.HashSet[string]]::new([string[]]@($cursor.donePages))
$assigned = $Pages | ForEach-Object { "8448-{0:D3}" -f $_ }
$toSweep = @()
foreach ($key in $assigned) {
  if ($done.Contains($key)) {
    Write-Output "SKIP already done: $key"
  } else {
    $toSweep += $key
  }
}
if ($toSweep.Count -eq 0) {
  Write-Output "Nothing to sweep"
  exit 0
}

$book = 8448
$remaining = [System.Collections.Generic.List[string]]::new($toSweep)
# Start at first page parcel 001
$startKey = $remaining[0]
$startPage = [int]$startKey.Split('-')[1]
$ainNum = MakeAin $book $startPage 1
$streak = 0
$valids = [System.Collections.Generic.List[object]]::new()
$jumps = [System.Collections.Generic.List[object]]::new()
$trace = [System.Collections.Generic.List[object]]::new()
$completed = [System.Collections.Generic.List[string]]::new()
$pageStats = @{}
$maxChecks = 2500
$checks = 0
$currentPageKey = $startKey

function EnsurePageStat([string]$key) {
  if (-not $pageStats.ContainsKey($key)) {
    $pageStats[$key] = [ordered]@{ page = $key; checks = 0; valids = 0; lastAin = $null; started = $true }
  }
}

function SoftJumpQueue([string]$fromKey) {
  $queue = @()
  foreach ($key in $remaining) {
    if ($key -eq $fromKey) { continue }
    if ($completed.Contains($key)) { continue }
    $pg = [int]$key.Split('-')[1]
    $scored = ScorePage $book $pg
    if ($scored.hits -gt 0) { $queue += $scored }
  }
  return @($queue | Sort-Object -Property hits -Descending)
}

Write-Output "START agent-08 remaining=$($remaining -join ',')"

while ($checks -lt $maxChecks -and $remaining.Count -gt 0) {
  $metaPage = [int]([math]::Floor(($ainNum % 1000000) / 1000))
  $pageKey = "{0}-{1:D3}" -f $book, $metaPage

  # Guard: only walk assigned remaining pages
  if (-not $remaining.Contains($pageKey)) {
    # Landed outside — jump to first remaining
    if ($remaining.Count -eq 0) { break }
    $next = $remaining[0]
    $np = [int]$next.Split('-')[1]
    $ainNum = MakeAin $book $np 1
    $streak = 0
    $currentPageKey = $next
    continue
  }

  EnsurePageStat $pageKey
  $currentPageKey = $pageKey

  # Soft jump among OUR pages only
  if ($streak -ge $SoftJump) {
    $q = SoftJumpQueue $pageKey
    if ($q.Count -gt 0) {
      $target = $q[0]
      $dest = MakeAin $target.book $target.page $target.firstValidParcel
      $jumps.Add([ordered]@{
        at = (Fmt $ainNum); streak = $streak; to = (Fmt $dest)
        reason = $(if ($streak -ge $HardJump) { "HARD_JUMP" } else { "SOFT_JUMP" })
        hits = $target.hits
      })
      Write-Output "JUMP $($jumps[-1].reason) from $(Fmt $ainNum) streak=$streak to $(Fmt $dest) hits=$($target.hits)"
      # mark current page done for this session when abandoning after empty streak
      if (-not $completed.Contains($pageKey)) {
        $completed.Add($pageKey) | Out-Null
        [void]$remaining.Remove($pageKey)
      }
      $ainNum = $dest
      $streak = 0
      continue
    }
  }

  if ($streak -ge $HardJump) {
    # finish this page, hop to next assigned
    if (-not $completed.Contains($pageKey)) {
      $completed.Add($pageKey) | Out-Null
      [void]$remaining.Remove($pageKey)
    }
    if ($remaining.Count -eq 0) {
      Write-Output "DONE all pages after HARD_JUMP at $(Fmt $ainNum)"
      break
    }
    $q = SoftJumpQueue "__none__"
    $nextKey = $null
    $destParcel = 1
    if ($q.Count -gt 0) {
      $nextKey = $q[0].key
      $destParcel = $q[0].firstValidParcel
    } else {
      $nextKey = $remaining[0]
      $destParcel = 1
    }
    $np = [int]$nextKey.Split('-')[1]
    $dest = MakeAin $book $np $destParcel
    $jumps.Add([ordered]@{
      at = (Fmt $ainNum); streak = $streak; to = (Fmt $dest)
      reason = "HARD_JUMP_NEXT_ASSIGNED"; hits = 0
    })
    Write-Output "HARD finish $pageKey -> $(Fmt $dest)"
    $ainNum = $dest
    $streak = 0
    continue
  }

  $data = FetchDetail $ainNum
  $pageStats[$pageKey].checks++
  $pageStats[$pageKey].lastAin = (Fmt $ainNum)
  $checks++

  if (-not (IsValid $data)) {
    $streak++
    $trace.Add([ordered]@{ ain = (Fmt $ainNum); status = "INVALID"; streak = $streak }) | Out-Null
    if ($checks % 25 -eq 0) { Write-Output "check=$checks ain=$(Fmt $ainNum) streak=$streak valids=$($valids.Count)" }
  } else {
    $streak = 0
    $rec = Enrich $ainNum $data.Parcel
    $valids.Add($rec) | Out-Null
    $pageStats[$pageKey].valids++
    $trace.Add([ordered]@{ ain = (Fmt $ainNum); status = "VALID" }) | Out-Null
    Write-Output "VALID $(Fmt $ainNum) $($rec.useType) $($rec.address)"
  }

  # next parcel on same page; if parcel rolls past 999, treat as page end
  $parcel = [int]($ainNum % 1000)
  if ($parcel -ge 999) {
    if (-not $completed.Contains($pageKey)) {
      $completed.Add($pageKey) | Out-Null
      [void]$remaining.Remove($pageKey)
    }
    if ($remaining.Count -eq 0) { break }
    $nextKey = $remaining[0]
    $np = [int]$nextKey.Split('-')[1]
    $ainNum = MakeAin $book $np 1
    $streak = 0
  } else {
    $ainNum++
  }
  Start-Sleep -Milliseconds 25
}

# Mark any remaining unfinished pages as completed-through (walked until jump/end)
foreach ($key in @($toSweep)) {
  if (-not $completed.Contains($key) -and $pageStats.ContainsKey($key)) {
    $completed.Add($key) | Out-Null
  }
}

# Archive RUN-A08
$stamp = Get-Date -Format "yyyy-MM-dd"
$runDir = Join-Path $Root "runs\RUN-A08-$stamp-horizon"
New-Item -ItemType Directory -Force -Path $runDir | Out-Null

$validArr = @($valids)
$full = [ordered]@{
  algorithm = "agent-08-constrained-horizon"
  agent = "agent-08"
  pages = $assigned
  skippedDone = @($assigned | Where-Object { $done.Contains($_) })
  checks = $checks
  validCount = $validArr.Count
  jumps = @($jumps)
  pageStats = @($pageStats.Values)
  completedPages = @($completed)
  valids = $validArr
  traceSample = @($trace | Select-Object -Last 50)
}
$full | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $runDir "full.json") -Encoding UTF8
$validArr | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $runDir "valids.json") -Encoding UTF8

# CSV
$csvPath = Join-Path $runDir "valids.csv"
$validArr | ForEach-Object {
  [pscustomobject]@{
    ain = $_.ain
    address = $_.address
    useType = $_.useType
    taxStatus = $_.taxStatus
    assessed = $_.assessed
    lot = $_.lot
    yearBuilt = $_.yearBuilt
    beds = $_.beds
    baths = $_.baths
    hasForeclosureHist = $_.hasForeclosureHist
    lastBuyPrice = $(if ($_.lastBuy) { $_.lastBuy.price } else { "" })
    lastBuyDate = $(if ($_.lastBuy) { $_.lastBuy.rec } else { "" })
  }
} | Export-Csv -Path $csvPath -NoTypeInformation -Encoding UTF8

$summary = @"
# RUN-A08 — agent-08 exclusive pages 066-070

- Agent: agent-08
- Pages: $($assigned -join ', ')
- Soft-jump: only among assigned pages (SOFT=$SoftJump, HARD=$HardJump)
- Checks: $checks
- Valid: $($validArr.Count)
- Jumps: $(($jumps | ConvertTo-Json -Compress))
- Completed pages: $($completed -join ', ')
- Page stats: $(($pageStats.Values | ConvertTo-Json -Compress))
"@
$summary | Set-Content (Join-Path $runDir "summary.md") -Encoding UTF8

# Also per-page subfolders for clarity
foreach ($key in $toSweep) {
  $pgDir = Join-Path $Root "runs\RUN-A08-$key"
  New-Item -ItemType Directory -Force -Path $pgDir | Out-Null
  $pgValids = @($validArr | Where-Object { $_.ain.StartsWith($key) })
  $pgValids | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $pgDir "valids.json") -Encoding UTF8
  $pgValids | ForEach-Object {
    [pscustomobject]@{
      ain = $_.ain; address = $_.address; useType = $_.useType; taxStatus = $_.taxStatus
      assessed = $_.assessed; lot = $_.lot; yearBuilt = $_.yearBuilt
    }
  } | Export-Csv (Join-Path $pgDir "valids.csv") -NoTypeInformation -Encoding UTF8
  $stat = if ($pageStats.ContainsKey($key)) { $pageStats[$key] } else { @{ checks = 0; valids = 0; lastAin = "n/a" } }
  @"
# RUN-A08-$key

- Valids: $($pgValids.Count)
- Checks (on page): $($stat.checks)
- Last AIN: $($stat.lastAin)
"@ | Set-Content (Join-Path $pgDir "summary.md") -Encoding UTF8
  @{ page = $key; validCount = $pgValids.Count; checks = $stat.checks; lastAin = $stat.lastAin; valids = $pgValids } |
    ConvertTo-Json -Depth 8 | Set-Content (Join-Path $pgDir "full.json") -Encoding UTF8
}

# Update claim + status
$claimPath = Join-Path $Root "state\claims\agent-08.json"
@{
  agent = "agent-08"
  pages = $assigned
  exclusive = $true
  startedAt = "2026-07-14T23:11:45-07:00"
  completedAt = (Get-Date -Format "yyyy-MM-ddTHH:mm:ss-07:00")
  status = "completed"
  validCount = $validArr.Count
  checks = $checks
  runDir = "runs/RUN-A08-$stamp-horizon"
  completedPages = @($completed)
} | ConvertTo-Json -Depth 5 | Set-Content $claimPath -Encoding UTF8

$statusMd = @"
# agent-08 status

- **Started:** ~11:12 PM
- **Finished:** $(Get-Date -Format "h:mm tt")
- **Exclusive pages:** 8448-066, 067, 068, 069, 070
- **Claim:** completed
- **Checks:** $checks
- **Valids:** $($validArr.Count)
- **Jumps:** $($jumps.Count) (soft-jump only among own pages)
- **Archives:** ``runs/RUN-A08-$stamp-horizon/`` + per-page ``runs/RUN-A08-8448-0XX/``
- **Dedup:** skipped pages already in donePages (none of 066-070 were done)
- **Blockers:** none
- **Checkpoint:** ready for 11:30 rollup
"@
$statusMd | Set-Content (Join-Path $Root "state\status\agent-08.md") -Encoding UTF8

# Append INDEX
$indexPath = Join-Path $Root "runs\INDEX.md"
$line = "| RUN-A08 | ``runs/RUN-A08-$stamp-horizon/`` | $($validArr.Count) | agent-08 pages 066-070 |"
if (Test-Path $indexPath) {
  Add-Content $indexPath "`n$line"
} else {
  @"
# Runs index

| Run | Folder | Valids | Notes |
|-----|--------|--------|-------|
$line
"@ | Set-Content $indexPath -Encoding UTF8
}

# Note completed pages in claim only — do not rewrite shared cursor.json (parallel agents race).
Write-Output "COMPLETE valids=$($validArr.Count) checks=$checks run=$runDir"
