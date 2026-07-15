/**
 * Single-page walker for agent-01 exclusive claim: 8448-043.
 * Soft-jump disabled. Vacant land without situs = VALID.
 * Stop: 20 consecutive invalids after last valid, or parcel 999.
 */
const fs = require("fs");
const path = require("path");

const BOOK = 8448;
const PAGE = 43;
const HARD = 20;
const BASE = "https://portal.assessor.lacounty.gov";
const OUT = path.join(__dirname, "..", "runs", "RUN-A01-8448-043");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fmt(parcel) {
  return `${BOOK}-${String(PAGE).padStart(3, "0")}-${String(parcel).padStart(3, "0")}`;
}
function ainDigits(parcel) {
  return String(BOOK * 1e6 + PAGE * 1e3 + parcel).padStart(10, "0");
}

function isValidParcel(data) {
  if (!data || data.Error) return false;
  const p = data.Parcel;
  if (!p || !p.AIN) return false;
  const street = (p.SitusStreet || "").trim();
  const use = (p.UseType || "").trim();
  const lot = Number(p.SqftLot || 0);
  const land = Number(p.CurrentRoll_LandValue || 0);
  const imp = Number(p.CurrentRoll_ImpValue || 0);
  return !!(street || use || lot > 0 || land > 0 || imp > 0);
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      Accept: "application/json,text/plain,*/*",
      "User-Agent": "apn-horizon-sweep-agent-01/1.0",
    },
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function fetchDetail(parcel) {
  return fetchJson(`${BASE}/api/parceldetail?ain=${ainDigits(parcel)}`);
}

async function enrich(parcel, p) {
  let owners = [];
  try {
    const oh = await fetchJson(
      `${BASE}/api/parcel_ownershiphistory?ain=${ainDigits(parcel)}`
    );
    owners = (oh?.Parcel_OwnershipHistory || []).slice(0, 5).map((o) => ({
      rec: o.RecordingDate,
      doc: o.DocumentNumber,
      price: o.DTTSalePrice,
      assessed: o.AssessedValue,
      docType: (o.DocumentTypeDesc || "").trim() || o.DocumentType,
      reason: (o.DocumentReasonCodeDesc || "").trim() || o.DocumentReasonCode,
    }));
  } catch {}
  const lastBuy = owners.find((o) => o.price && Number(o.price) > 1000) || null;
  const hasForeclosureHist = owners.some(
    (o) =>
      /foreclos/i.test(o.docType || "") || /Trustee Sale/i.test(o.reason || "")
  );
  return {
    ain: fmt(parcel),
    status: "VALID",
    address: `${(p.SitusStreet || "").trim()}, ${(p.SitusCity || "").trim()} ${(p.SitusZipCode || "").trim()}`.trim(),
    useType: (p.UseType || "").trim(),
    parcelStatus: p.ParcelStatus,
    taxStatus: p.TaxStatus,
    yearDefaulted: p.TaxDefaultedYear || "",
    yearBuilt: p.YearBuilt,
    beds: p.NumOfBeds,
    baths: p.NumOfBaths,
    bldg: p.SqftMain,
    lot: p.SqftLot,
    units: p.NumUnits,
    assessed:
      Number(p.CurrentRoll_LandValue || 0) + Number(p.CurrentRoll_ImpValue || 0),
    land: Number(p.CurrentRoll_LandValue || 0),
    imp: Number(p.CurrentRoll_ImpValue || 0),
    baseYearLand: p.BaseYear_Land || p.CurrentRoll_BaseYearLand,
    baseYearImp: p.BaseYear_Imp || p.CurrentRoll_BaseYearImp,
    lastBuy,
    hasForeclosureHist,
    ownership: owners,
  };
}

function toCsv(valids) {
  const headers = [
    "ain",
    "address",
    "useType",
    "parcelStatus",
    "taxStatus",
    "yearBuilt",
    "beds",
    "baths",
    "bldg",
    "lot",
    "assessed",
    "land",
    "imp",
    "lastBuyPrice",
    "lastBuyDate",
    "hasForeclosureHist",
  ];
  const esc = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = valids.map((v) =>
    [
      v.ain,
      v.address,
      v.useType,
      v.parcelStatus,
      v.taxStatus,
      v.yearBuilt,
      v.beds,
      v.baths,
      v.bldg,
      v.lot,
      v.assessed,
      v.land,
      v.imp,
      v.lastBuy?.price || "",
      v.lastBuy?.rec || "",
      v.hasForeclosureHist,
    ]
      .map(esc)
      .join(",")
  );
  return [headers.join(","), ...rows].join("\n") + "\n";
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const valids = [];
  const trace = [];
  let consecutiveInvalid = 0;
  let foundValid = false;
  let lastValidParcel = null;
  let lastChecked = 0;
  let stoppedReason = "PARCEL_999";
  const startedAt = new Date().toISOString();

  console.log(`[agent-01] start page 8448-043 @ ${startedAt}`);

  for (let parcel = 1; parcel <= 999; parcel++) {
    lastChecked = parcel;
    let data = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        data = await fetchDetail(parcel);
        break;
      } catch (e) {
        console.warn(`fetch fail ${fmt(parcel)} attempt ${attempt + 1}: ${e.message}`);
        await sleep(400 * (attempt + 1));
      }
    }

    if (!isValidParcel(data)) {
      consecutiveInvalid++;
      trace.push({ ain: fmt(parcel), status: "INVALID", streak: consecutiveInvalid });
      if (foundValid && consecutiveInvalid >= HARD) {
        stoppedReason = "20_INVALID_STREAK_AFTER_LAST_VALID";
        break;
      }
    } else {
      consecutiveInvalid = 0;
      foundValid = true;
      lastValidParcel = parcel;
      const rec = await enrich(parcel, data.Parcel);
      valids.push(rec);
      trace.push({ ain: fmt(parcel), status: "VALID" });
      console.log(`VALID ${rec.ain} ${rec.useType} ${rec.address}`);
    }

    if (parcel % 25 === 0) {
      console.log(
        `… checked ${parcel}/999 valids=${valids.length} streak=${consecutiveInvalid}`
      );
    }
    await sleep(40);
  }

  const full = {
    agent: "agent-01",
    page: "8448-043",
    algorithm: "single-page-full-walk-v1",
    start: "8448-043-001",
    lastAinChecked: fmt(lastChecked),
    lastValidParcel: lastValidParcel != null ? fmt(lastValidParcel) : null,
    stoppedReason,
    validCount: valids.length,
    invalidCount: trace.filter((r) => r.status !== "VALID").length,
    checks: trace.length,
    startedAt,
    finishedAt: new Date().toISOString(),
    valids,
    trace,
  };

  fs.writeFileSync(path.join(OUT, "full.json"), JSON.stringify(full, null, 2));
  fs.writeFileSync(path.join(OUT, "valids.json"), JSON.stringify(valids, null, 2));
  fs.writeFileSync(path.join(OUT, "valids.csv"), toCsv(valids));

  const summary = `# RUN-A01 — map page 8448-043 (agent-01 exclusive)

- Agent: agent-01
- Start: 8448-043-001
- Last AIN checked: ${fmt(lastChecked)}
- Last valid: ${lastValidParcel != null ? fmt(lastValidParcel) : "(none)"}
- Valid: ${valids.length}
- Invalid (this walk): ${full.invalidCount}
- Checks: ${full.checks}
- StoppedReason: ${stoppedReason}
- Soft-jump: not used (single-page claim)
- Vacant land without situs: counted VALID
- Started: ${startedAt}
- Finished: ${full.finishedAt}
`;
  fs.writeFileSync(path.join(OUT, "summary.md"), summary);
  console.log(summary);
  console.log(`[agent-01] archived → ${OUT}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
