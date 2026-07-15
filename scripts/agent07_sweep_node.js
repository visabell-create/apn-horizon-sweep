/**
 * Agent-07 exclusive page walk (v2): 8448-062..065
 * Probe page for first valid, then +1 walk; end after 20 consecutive
 * invalids past last valid. Jump to next assigned page (never leave the 4).
 */
const fs = require("fs");
const path = require("path");
const https = require("https");

const HARD_JUMP = 20;
const ROOT = path.resolve(__dirname, "..");
const ASSIGNED = [
  { book: 8448, page: 62, key: "8448-062" },
  { book: 8448, page: 63, key: "8448-063" },
  { book: 8448, page: 64, key: "8448-064" },
  { book: 8448, page: 65, key: "8448-065" },
];
// Broad probe covering early + mid + late parcels (map books can park fillers at 900+)
const PROBE = [
  1, 2, 5, 10, 15, 20, 26, 30, 40, 50, 60, 70, 80, 90, 100, 120, 150, 175, 200, 250, 300, 400, 500,
  600, 700, 750, 800, 850, 875, 890, 900, 910, 920, 930, 940, 950, 960, 970, 980, 990, 999,
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fmt(n) {
  const s = String(n).padStart(10, "0");
  return `${s.slice(0, 4)}-${s.slice(4, 7)}-${s.slice(7, 10)}`;
}

function make(b, p, c) {
  return b * 1e6 + p * 1e3 + c;
}

function parse(n) {
  const s = String(n).padStart(10, "0");
  return { book: +s.slice(0, 4), page: +s.slice(4, 7), parcel: +s.slice(7, 10) };
}

function fetchJson(urlPath) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      {
        hostname: "portal.assessor.lacounty.gov",
        path: urlPath,
        headers: {
          "User-Agent": "Mozilla/5.0 APN-Horizon-Sweep-Agent07",
          Accept: "application/json",
        },
        timeout: 30000,
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

function isValid(data) {
  if (!data || data.Error || !data.Parcel) return false;
  const p = data.Parcel;
  const street = (p.SitusStreet || "").trim();
  const use = (p.UseType || "").trim();
  return !!(
    street ||
    use ||
    Number(p.SqftLot || 0) > 0 ||
    Number(p.CurrentRoll_LandValue || 0) > 0 ||
    Number(p.CurrentRoll_ImpValue || 0) > 0
  );
}

async function detail(ainNum) {
  const ain = String(ainNum).padStart(10, "0");
  return fetchJson(`/api/parceldetail?ain=${ain}`);
}

async function enrich(ainNum, p) {
  let owners = [];
  try {
    const oh = await fetchJson(
      `/api/parcel_ownershiphistory?ain=${String(ainNum).padStart(10, "0")}`
    );
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

function loadDonePages() {
  try {
    const raw = fs.readFileSync(path.join(ROOT, "state", "cursor.json"), "utf8");
    const cursor = JSON.parse(raw);
    return new Set(cursor.donePages || []);
  } catch (e) {
    process.stderr.write(`cursor.json read failed: ${e.message}\n`);
    return new Set();
  }
}

function toCsv(valids) {
  const header =
    "ain,address,useType,taxStatus,parcelStatus,yearBuilt,beds,baths,bldg,lot,assessed,lastBuyRec,lastBuyPrice,lastBuyDoc,hasFcHist";
  const rows = valids.map((v) => {
    const esc = (x) => `"${String(x ?? "").replace(/"/g, '""')}"`;
    return [
      esc(v.ain),
      esc(v.address),
      esc(v.useType),
      esc(v.taxStatus),
      esc(v.parcelStatus),
      esc(v.yearBuilt),
      esc(v.beds),
      esc(v.baths),
      esc(v.bldg),
      esc(v.lot),
      esc(v.assessed),
      esc(v.lastBuy && v.lastBuy.rec),
      esc(v.lastBuy && v.lastBuy.price),
      esc(v.lastBuy && v.lastBuy.doc),
      esc(v.hasForeclosureHist),
    ].join(",");
  });
  return [header, ...rows].join("\n") + "\n";
}

async function probePage(pg) {
  let firstValidParcel = null;
  let hits = 0;
  const hitParcels = [];
  for (const parcel of PROBE) {
    const data = await detail(make(pg.book, pg.page, parcel));
    if (isValid(data)) {
      hits++;
      hitParcels.push(parcel);
      if (firstValidParcel == null) firstValidParcel = parcel;
    }
    await sleep(25);
  }
  // If mid/late hit but nothing early, also binary-ish scan back for true first
  if (firstValidParcel != null && firstValidParcel > 1) {
    const startScan = Math.max(1, firstValidParcel - 50);
    for (let parcel = startScan; parcel < firstValidParcel; parcel++) {
      const data = await detail(make(pg.book, pg.page, parcel));
      if (isValid(data)) {
        hits++;
        hitParcels.push(parcel);
        firstValidParcel = parcel;
        break;
      }
      await sleep(20);
    }
  }
  return { hits, firstValidParcel, hitParcels: [...new Set(hitParcels)].sort((a, b) => a - b) };
}

async function walkFrom(pg, startParcel) {
  let ainNum = make(pg.book, pg.page, startParcel);
  let consecutiveInvalid = 0;
  const valids = [];
  const resultsTrace = [];
  let lastValidParcel = null;
  let checks = 0;
  let stoppedReason = "UNKNOWN";
  const MAX_PER_PAGE = 500;

  process.stderr.write(`  walk +1 from ${pg.key}-${String(startParcel).padStart(3, "0")}\n`);

  while (checks < MAX_PER_PAGE) {
    const meta = parse(ainNum);
    if (meta.page !== pg.page || meta.book !== pg.book) {
      stoppedReason = "PAGE_BOUNDARY";
      break;
    }
    let data;
    try {
      data = await detail(ainNum);
    } catch (e) {
      await sleep(400);
      try {
        data = await detail(ainNum);
      } catch {
        data = null;
      }
    }
    checks++;
    if (!isValid(data)) {
      consecutiveInvalid++;
      resultsTrace.push({ ain: fmt(ainNum), status: "INVALID", streak: consecutiveInvalid });
      if (checks % 40 === 0) {
        process.stderr.write(
          `  ${pg.key} checks=${checks} valids=${valids.length} streak=${consecutiveInvalid} at=${fmt(ainNum)}\n`
        );
      }
      // Only hard-stop after we have seen >=1 valid (or walked off page)
      if (lastValidParcel != null && consecutiveInvalid >= HARD_JUMP) {
        stoppedReason = "20_INVALID_STREAK_PAST_LAST_VALID";
        break;
      }
    } else {
      consecutiveInvalid = 0;
      lastValidParcel = meta.parcel;
      const rec = await enrich(ainNum, data.Parcel);
      valids.push(rec);
      resultsTrace.push({ ain: fmt(ainNum), status: "VALID" });
      process.stderr.write(`  VALID ${fmt(ainNum)} ${rec.address} | ${rec.useType}\n`);
    }
    ainNum++;
    await sleep(35);
  }
  if (checks >= MAX_PER_PAGE && stoppedReason === "UNKNOWN") stoppedReason = "MAX_CHECKS";
  if (lastValidParcel == null && stoppedReason === "UNKNOWN") stoppedReason = "NO_VALIDS_IN_WALK";

  return {
    start: `${pg.key}-${String(startParcel).padStart(3, "0")}`,
    lastAinChecked: resultsTrace.length ? resultsTrace[resultsTrace.length - 1].ain : null,
    nextCursor: fmt(ainNum),
    validCount: valids.length,
    invalidCount: resultsTrace.filter((r) => r.status !== "VALID").length,
    checks,
    lastValidParcel,
    stoppedReason,
    valids,
    resultsTrace,
  };
}

async function walkPage(pg) {
  process.stderr.write(`\n=== ${pg.key}: probing ===\n`);
  const probe = await probePage(pg);
  process.stderr.write(
    `  probe hits=${probe.hits} first=${probe.firstValidParcel} parcels=[${probe.hitParcels.join(",")}]\n`
  );

  if (probe.firstValidParcel == null) {
    return {
      start: `${pg.key}-001`,
      lastAinChecked: null,
      nextCursor: `${pg.key}-001`,
      validCount: 0,
      invalidCount: 0,
      checks: PROBE.length,
      lastValidParcel: null,
      stoppedReason: "EMPTY_PAGE_PROBED",
      probe,
      valids: [],
      resultsTrace: [],
    };
  }

  // Walk from a small lookback so we don't miss cluster start
  const startParcel = Math.max(1, probe.firstValidParcel - 5);
  const result = await walkFrom(pg, startParcel);
  result.probe = probe;
  return result;
}

function archivePage(pg, result, jump) {
  const dir = path.join(ROOT, "runs", `RUN-A07-${pg.key}`);
  fs.mkdirSync(dir, { recursive: true });
  const full = {
    agent: "agent-07",
    algorithm: "exclusive-page-walk-v2-probe-then-plus1",
    page: pg.key,
    start: result.start,
    lastAinChecked: result.lastAinChecked,
    nextCursor: result.nextCursor,
    stoppedReason: result.stoppedReason,
    validCount: result.validCount,
    invalidCount: result.invalidCount,
    checks: result.checks,
    lastValidParcel: result.lastValidParcel,
    probe: result.probe,
    jump,
    valids: result.valids,
    resultsTrace: result.resultsTrace,
  };
  fs.writeFileSync(path.join(dir, "full.json"), JSON.stringify(full, null, 2));
  fs.writeFileSync(path.join(dir, "valids.json"), JSON.stringify(result.valids, null, 2));
  fs.writeFileSync(path.join(dir, "valids.csv"), toCsv(result.valids));
  const summary = `# RUN-A07-${pg.key}

- Agent: agent-07
- Page: ${pg.key}
- Algorithm: probe-then-+1 (stop after 20 invalids past last valid)
- Start: ${result.start}
- Last AIN: ${result.lastAinChecked}
- Next cursor: ${result.nextCursor}
- Valid: ${result.validCount}
- Invalid: ${result.invalidCount}
- Checks: ${result.checks}
- Probe hits: ${result.probe ? result.probe.hits : "n/a"} (first parcel ${result.probe ? result.probe.firstValidParcel : "n/a"})
- Last valid parcel: ${result.lastValidParcel ?? "none"}
- StoppedReason: ${result.stoppedReason}
- Jump: ${jump ? JSON.stringify(jump) : "n/a"}
`;
  fs.writeFileSync(path.join(dir, "summary.md"), summary);
  process.stderr.write(`Archived ${dir} (${result.validCount} valids)\n`);
  return dir;
}

async function main() {
  const donePages = loadDonePages();
  process.stderr.write(`donePages (${donePages.size}): ${[...donePages].join(", ")}\n`);
  const jumps = [];
  const pageResults = {};
  const archived = [];

  for (let pi = 0; pi < ASSIGNED.length; pi++) {
    const pg = ASSIGNED[pi];
    if (donePages.has(pg.key)) {
      process.stderr.write(`SKIP ${pg.key} — already in donePages\n`);
      pageResults[pg.key] = { skipped: true, reason: "already_in_donePages" };
      continue;
    }
    const result = await walkPage(pg);
    const next = ASSIGNED[pi + 1];
    let jump = null;
    if (
      result.stoppedReason === "20_INVALID_STREAK_PAST_LAST_VALID" ||
      result.stoppedReason === "EMPTY_PAGE_PROBED" ||
      result.stoppedReason === "PAGE_BOUNDARY" ||
      result.stoppedReason === "NO_VALIDS_IN_WALK"
    ) {
      jump = {
        at: result.lastAinChecked,
        streak: HARD_JUMP,
        from: pg.key,
        to: next ? `${next.key}-001` : null,
        reason: "HARD_JUMP_NEXT_ASSIGNED",
      };
      jumps.push(jump);
    }
    pageResults[pg.key] = result;
    archived.push(archivePage(pg, result, jump));
  }

  const summaryAll = {
    agent: "agent-07",
    algorithm: "exclusive-page-walk-v2-probe-then-plus1",
    pages: ASSIGNED.map((a) => a.key),
    jumps,
    pageResults: Object.fromEntries(
      Object.entries(pageResults).map(([k, v]) => [
        k,
        v.skipped
          ? v
          : {
              start: v.start,
              lastAinChecked: v.lastAinChecked,
              validCount: v.validCount,
              invalidCount: v.invalidCount,
              checks: v.checks,
              stoppedReason: v.stoppedReason,
              lastValidParcel: v.lastValidParcel,
              probe: v.probe,
            },
      ])
    ),
    validCountTotal: Object.values(pageResults).reduce((s, p) => s + (p.validCount || 0), 0),
    archived,
  };
  fs.writeFileSync(path.join(ROOT, "runs", "RUN-A07-summary.json"), JSON.stringify(summaryAll, null, 2));
  console.log(JSON.stringify(summaryAll, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
