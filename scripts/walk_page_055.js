/**
 * Single-page walk for 8448-055.
 * Stop after 20 consecutive invalids past last valid on this page.
 */
const fs = require("fs");
const path = require("path");
const https = require("https");

const ROOT = "C:\\Users\\Authorized User\\apn-horizon-sweep";
const OUT = path.join(ROOT, "runs", "RUN-A02-8448-055");
const BOOK = 8448;
const PAGE = 55;
const HARD = 20;
const START_PARCEL = 1;
const MAX_PARCEL = 999;

function fmt(parcel) {
  return `${BOOK}-${String(PAGE).padStart(3, "0")}-${String(parcel).padStart(3, "0")}`;
}
function digits(parcel) {
  return `${BOOK}${String(PAGE).padStart(3, "0")}${String(parcel).padStart(3, "0")}`;
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          Accept: "application/json",
          "User-Agent": "apn-horizon-sweep-agent-02",
        },
        timeout: 45000,
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

async function fetchDetail(parcel) {
  const ain = digits(parcel);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fetchJson(
        `https://portal.assessor.lacounty.gov/api/parceldetail?ain=${ain}`
      );
    } catch (e) {
      if (attempt === 2) return null;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  return null;
}

async function fetchOwners(parcel) {
  const ain = digits(parcel);
  try {
    return await fetchJson(
      `https://portal.assessor.lacounty.gov/api/parcel_ownershiphistory?ain=${ain}`
    );
  } catch {
    return null;
  }
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

function enrich(parcel, p, oh) {
  const owners = ((oh && oh.Parcel_OwnershipHistory) || []).slice(0, 5).map((o) => ({
    rec: o.RecordingDate,
    doc: o.DocumentNumber,
    price: o.DTTSalePrice,
    assessed: o.AssessedValue,
    docType: (o.DocumentTypeDesc || "").trim() || o.DocumentType,
    reason: (o.DocumentReasonCodeDesc || "").trim() || o.DocumentReasonCode,
  }));
  const lastBuy = owners.find((o) => o.price && Number(o.price) > 1000) || null;
  const hasForeclosureHist = owners.some(
    (o) => /foreclos/i.test(o.docType || "") || /Trustee Sale/i.test(o.reason || "")
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
    units: p.NumOfUnits,
    assessed: Number(p.CurrentRoll_LandValue || 0) + Number(p.CurrentRoll_ImpValue || 0),
    land: Number(p.CurrentRoll_LandValue || 0),
    imp: Number(p.CurrentRoll_ImpValue || 0),
    lastBuy,
    hasForeclosureHist,
    ownership: owners,
  };
}

function csvEscape(v) {
  const s = v == null ? "" : String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const valids = [];
  const trace = [];
  let consecutiveInvalid = 0;
  let lastValidParcel = null;
  let lastChecked = START_PARCEL - 1;
  const startedAt = new Date().toISOString();

  console.log(`START walk 8448-055 from parcel ${START_PARCEL}`);

  for (let parcel = START_PARCEL; parcel <= MAX_PARCEL; parcel++) {
    lastChecked = parcel;
    const data = await fetchDetail(parcel);
    if (!isValidParcel(data)) {
      consecutiveInvalid++;
      trace.push({ ain: fmt(parcel), status: "INVALID", streak: consecutiveInvalid });
      process.stdout.write(`I ${fmt(parcel)} streak=${consecutiveInvalid}\n`);
      if (lastValidParcel != null && consecutiveInvalid >= HARD) {
        console.log(`STOP: ${HARD} consecutive invalids past last valid ${fmt(lastValidParcel)}`);
        break;
      }
      // If we never found a valid and streak hits HARD from start, also stop
      if (lastValidParcel == null && consecutiveInvalid >= HARD) {
        console.log(`STOP: ${HARD} consecutive invalids with no valid found`);
        break;
      }
    } else {
      consecutiveInvalid = 0;
      lastValidParcel = parcel;
      const oh = await fetchOwners(parcel);
      const rec = enrich(parcel, data.Parcel, oh);
      valids.push(rec);
      trace.push({ ain: fmt(parcel), status: "VALID" });
      process.stdout.write(`V ${rec.ain} ${rec.useType} ${rec.address}\n`);
    }
    await new Promise((r) => setTimeout(r, 40));
  }

  const endedAt = new Date().toISOString();
  const full = {
    runId: "RUN-A02-8448-055",
    agent: "agent-02",
    page: "8448-055",
    algorithm: "page-walk-hard20",
    startedAt,
    endedAt,
    start: fmt(START_PARCEL),
    lastAinChecked: fmt(lastChecked),
    lastValid: lastValidParcel != null ? fmt(lastValidParcel) : null,
    stoppedReason: "HARD_20_INVALIDS_PAST_LAST_VALID",
    validCount: valids.length,
    invalidCount: trace.filter((t) => t.status !== "VALID").length,
    checks: trace.length,
    valids,
    trace,
  };

  fs.writeFileSync(path.join(OUT, "full.json"), JSON.stringify(full, null, 2));
  fs.writeFileSync(path.join(OUT, "valids.json"), JSON.stringify(valids, null, 2));

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
  const rows = [headers.join(",")];
  for (const v of valids) {
    rows.push(
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
        v.lastBuy ? v.lastBuy.price : "",
        v.lastBuy ? v.lastBuy.rec : "",
        v.hasForeclosureHist,
      ]
        .map(csvEscape)
        .join(",")
    );
  }
  fs.writeFileSync(path.join(OUT, "valids.csv"), rows.join("\n") + "\n");

  const summary = `# RUN-A02-8448-055 — agent-02 page walk

- Agent: agent-02
- Page: 8448-055 (exclusive)
- Start: ${fmt(START_PARCEL)}
- Last AIN checked: ${fmt(lastChecked)}
- Last valid: ${lastValidParcel != null ? fmt(lastValidParcel) : "(none)"}
- Valid count: ${valids.length}
- Invalid count: ${full.invalidCount}
- Checks: ${full.checks}
- StoppedReason: ${full.stoppedReason}
- Started: ${startedAt}
- Ended: ${endedAt}
`;
  fs.writeFileSync(path.join(OUT, "summary.md"), summary);

  console.log(JSON.stringify({ validCount: valids.length, lastChecked: fmt(lastChecked), lastValid: full.lastValid }, null, 2));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
