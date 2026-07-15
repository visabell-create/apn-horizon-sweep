/**
 * Agent-05 exclusive sweep: 8448-059 only.
 * Walk +1; stop after 20 consecutive invalids past last valid.
 */
const fs = require("fs");
const path = require("path");

const BOOK = 8448;
const PAGE = 59;
const HARD_STOP = 20;
const MAX_PARCEL = 999;
const OUT = path.join(__dirname, "..", "runs", "RUN-A05-8448-059");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fmt(n) {
  const s = String(n).padStart(10, "0");
  return `${s.slice(0, 4)}-${s.slice(4, 7)}-${s.slice(7, 10)}`;
}
function makeAin(book, page, parcel) {
  return book * 1e6 + page * 1e3 + parcel;
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

async function fetchDetail(ainNum) {
  const ain = String(ainNum).padStart(10, "0");
  const t = await (await fetch(`https://portal.assessor.lacounty.gov/api/parceldetail?ain=${ain}`)).text();
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

async function enrich(ainNum, p) {
  let owners = [];
  try {
    const oh = await (
      await fetch(
        `https://portal.assessor.lacounty.gov/api/parcel_ownershiphistory?ain=${String(ainNum).padStart(10, "0")}`
      )
    ).json();
    owners = (oh.Parcel_OwnershipHistory || []).slice(0, 5).map((o) => ({
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
    (o) => /foreclos/i.test(o.docType || "") || /Trustee Sale/i.test(o.reason || "")
  );
  return {
    ain: fmt(ainNum),
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
    assessed: Number(p.CurrentRoll_LandValue || 0) + Number(p.CurrentRoll_ImpValue || 0),
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
    "lastBuyPrice",
    "lastBuyDate",
    "hasForeclosureHist",
  ];
  const lines = [headers.join(",")];
  for (const v of valids) {
    const row = [
      v.ain,
      `"${(v.address || "").replace(/"/g, '""')}"`,
      `"${(v.useType || "").replace(/"/g, '""')}"`,
      v.parcelStatus || "",
      v.taxStatus || "",
      v.yearBuilt || "",
      v.beds ?? "",
      v.baths ?? "",
      v.bldg ?? "",
      v.lot ?? "",
      v.assessed ?? "",
      v.lastBuy?.price ?? "",
      v.lastBuy?.rec ?? "",
      v.hasForeclosureHist ? "true" : "false",
    ];
    lines.push(row.join(","));
  }
  return lines.join("\n");
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const full = [];
  const valids = [];
  let invalidStreak = 0;
  let lastValidAin = null;
  let firstAin = null;
  let lastAin = null;
  let stoppedReason = "MAX_PARCEL";

  console.log(`START sweep 8448-059 → ${OUT}`);

  for (let parcel = 1; parcel <= MAX_PARCEL; parcel++) {
    const ainNum = makeAin(BOOK, PAGE, parcel);
    if (firstAin == null) firstAin = ainNum;
    lastAin = ainNum;
    let data = null;
    let attempts = 0;
    while (attempts < 3) {
      try {
        data = await fetchDetail(ainNum);
        break;
      } catch (e) {
        attempts++;
        console.error(`retry ${fmt(ainNum)} attempt ${attempts}: ${e.message}`);
        await sleep(500 * attempts);
      }
    }
    const valid = isValidParcel(data);
    const rec = {
      ain: fmt(ainNum),
      valid,
      error: data?.Error || null,
      parcel: data?.Parcel || null,
    };
    full.push(rec);

    if (valid) {
      invalidStreak = 0;
      lastValidAin = ainNum;
      const enriched = await enrich(ainNum, data.Parcel);
      valids.push(enriched);
      console.log(`VALID ${enriched.ain} ${enriched.useType} ${enriched.address}`);
    } else {
      invalidStreak++;
      if (invalidStreak % 5 === 0) {
        console.log(`INVALID streak=${invalidStreak} at ${fmt(ainNum)}`);
      }
      if (invalidStreak >= HARD_STOP) {
        stoppedReason = lastValidAin == null ? "20_INVALID_FROM_START" : "20_INVALID_STREAK";
        console.log(`STOP ${stoppedReason} at ${fmt(ainNum)}`);
        break;
      }
    }
    await sleep(40);
  }

  fs.writeFileSync(path.join(OUT, "full.json"), JSON.stringify(full, null, 2));
  fs.writeFileSync(path.join(OUT, "valids.json"), JSON.stringify(valids, null, 2));
  fs.writeFileSync(path.join(OUT, "valids.csv"), toCsv(valids));

  const vacantCount = valids.filter((v) => /vacant/i.test(v.useType || "")).length;
  const summary = `# RUN-A05 — map page 8448-059

- **Agent:** agent-05 (exclusive)
- **Mode:** +1 walk on page only; stop after 20 consecutive invalids
- **Range:** \`${fmt(firstAin)}\` → \`${fmt(lastAin)}\`
- **Valids:** ${valids.length} (vacant land: ${vacantCount})
- **Last valid:** ${lastValidAin ? fmt(lastValidAin) : "(none)"}
- **Stop:** ${stoppedReason}
- **Archive:** \`runs/RUN-A05-8448-059/\`
`;
  fs.writeFileSync(path.join(OUT, "summary.md"), summary);

  const meta = {
    runId: "RUN-A05",
    agent: "agent-05",
    date: "2026-07-14",
    page: "8448-059",
    algorithm: "page-exclusive-+1-until-20-invalids",
    start: fmt(firstAin),
    end: fmt(lastAin),
    lastValid: lastValidAin ? fmt(lastValidAin) : null,
    stoppedReason,
    validCount: valids.length,
    vacantCount,
    checks: full.length,
  };
  fs.writeFileSync(path.join(OUT, "meta.json"), JSON.stringify(meta, null, 2));

  console.log(JSON.stringify(meta, null, 2));
  console.log("DONE");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
