param(
  [Parameter(Mandatory = $true)][string]$RunId,
  [Parameter(Mandatory = $true)][string]$JsonPath,
  [string]$Root = (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent)
)

# Resolve project root: script lives in <root>/scripts
$ProjectRoot = Split-Path $PSScriptRoot -Parent
if (-not (Test-Path (Join-Path $ProjectRoot "runs"))) {
  $ProjectRoot = "C:\Users\Authorized User\apn-horizon-sweep"
}

$stamp = Get-Date -Format "yyyy-MM-dd_HHmmss"
$dest = Join-Path $ProjectRoot "runs" "$RunId-$stamp"
New-Item -ItemType Directory -Force -Path $dest | Out-Null

$data = Get-Content -Raw -Path $JsonPath | ConvertFrom-Json
$data | ConvertTo-Json -Depth 20 | Set-Content -Path (Join-Path $dest "full.json") -Encoding UTF8

$valids = @()
if ($data.valids) { $valids = $data.valids }
elseif ($data.results) { $valids = @($data.results | Where-Object { $_.status -eq "VALID" }) }

$valids | ConvertTo-Json -Depth 20 | Set-Content -Path (Join-Path $dest "valids.json") -Encoding UTF8

# CSV flatten
$rows = foreach ($v in $valids) {
  [pscustomobject]@{
    ain          = $v.ain
    address      = $v.address
    useType      = $v.useType
    taxStatus    = $v.taxStatus
    parcelStatus = $v.parcelStatus
    yearBuilt    = $v.yearBuilt
    beds         = $v.beds
    baths        = $v.baths
    bldg         = $v.bldg
    lot          = $v.lot
    assessed     = $v.assessed
    lastBuyRec   = $v.lastBuy.rec
    lastBuyPrice = $v.lastBuy.price
    lastBuyDoc   = $v.lastBuy.doc
    hasFcHist    = $v.hasForeclosureHist
  }
}
$rows | Export-Csv -NoTypeInformation -Path (Join-Path $dest "valids.csv") -Encoding UTF8

$summary = @"
# $RunId

- Saved: $stamp
- Start: $($data.start)
- StoppedReason: $($data.stoppedReason)
- Last AIN: $($data.lastAinChecked)
- Valid count: $($valids.Count)
- Invalid count: $($data.invalidCount)
- Jumps: $(($data.jumps | ConvertTo-Json -Compress))

## Horizon queue after run
``````
$(($data.horizonQueue | ConvertTo-Json -Depth 5))
``````
"@
Set-Content -Path (Join-Path $dest "summary.md") -Value $summary -Encoding UTF8

# Update state pointer to latest run
$stateDir = Join-Path $ProjectRoot "state"
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
@{
  latestRunDir = $dest
  runId        = $RunId
  savedAt      = $stamp
  validCount   = $valids.Count
} | ConvertTo-Json | Set-Content (Join-Path $stateDir "latest_run.json") -Encoding UTF8

Write-Output $dest
