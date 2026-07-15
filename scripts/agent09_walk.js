/**
 * Agent-09 exclusive walk: pages 8448-071..075
 * Vacant land counts as VALID. Stop after 20 consecutive invalids past last valid per page.
 */
const https = require("https");
const fs = require("fs");
const path = require("path");

const ROOT = "C:\\Users\\Authorized User\\apn-horizon-sweep";
const PAGES = [71, 72, 73, 74, 75];
const HARD_STREAK = 20;
const CONCURRENCY = 6;

const agent = new https.Agent({ keepAlive: true, maxSockets: CONCURRENCY * PAGES.length });

function fmt(book, page, parcel) {
  return `${book}-${String(page).padStart(3, "0")}-${String(parcel).padStart(3, "0")}`;
}
function ainDigits(book, page, parcel) {
  return `${book}${String(page).padStart(3, "0")}${String(parcel).padStart(3, "0")}`;
}

function fetchJson(urlPath) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "portal.assessor.lacounty.gov",
        path: urlPath,
        method: "GET",
        agent,
        headers: {
          Accept: "application/json",
          "User-Agent": "apn-horizon-sweep-agent09/1.0",
        },
        timeout: 60000,
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
    req.end();
  });
}

async function withRetry(fn, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw last;
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

async function enrich(book, page, parcel, p) {
  let owners = [];
  try {
    const oh = await withRetry(() =>
      fetchJson(`/api/parcel_ownershiphistory?ain=${ainDigits(book, page, parcel)}`)
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
    (o) => /foreclos/i.test(o.docType || "") || /Trustee Sale/i.test(o.reason || "")
  );
  return {
    ain: fmt(book, page, parcel),
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
    baseYearLand: p.BaseYear_Land,
    baseYearImp: p.BaseYear_Imp,
    lastBuy,
    hasForeclosureHist,
    ownership: owners,
  };
}

async function mapPool(items, limit, worker) {
  const results = new Array(items.length);
  let idx = 0;
  async function run() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()));
  return results;
}

async function walkPage(book, page) {
  const pageKey = `${book}-${String(page).padStart(3, "0")}`;
  console.log(`[${pageKey}] start`);
  const valids = [];
  const vacants = [];
  const trace = [];
  let consecutiveInvalid = 0;
  let lastValidParcel = null;
  let parcel = 1;
  let lastChecked = 0;

  // Prefetch batches of CONCURRENCY; evaluate in order for streak logic
  while (parcel <= 999 && consecutiveInvalid < HARD_STREAK) {
    const batchSize = Math.min(CONCURRENCY, 999 - parcel + 1);
    const batch = [];
    for (let i = 0; i < batchSize; i++) batch.push(parcel + i);

    const details = await mapPool(batch, CONCURRENCY, async (pnum) => {
      const ain = ainDigits(book, page, pnum);
      try {
        const data = await withRetry(() => fetchJson(`/api/parceldetail?ain=${ain}`));
        return { pnum, data };
      } catch (e) {
        return { pnum, data: null, error: String(e.message || e) };
      }
    });

    let stop = false;
    for (const { pnum, data } of details) {
      lastChecked = pnum;
      if (!isValidParcel(data)) {
        consecutiveInvalid++;
        trace.push({ ain: fmt(book, page, pnum), status: "INVALID", streak: consecutiveInvalid });
        if (consecutiveInvalid >= HARD_STREAK) {
          stop = true;
          break;
        }
      } else {
        consecutiveInvalid = 0;
        lastValidParcel = pnum;
        const rec = await enrich(book, page, pnum, data.Parcel);
        valids.push(rec);
        if (/vacant/i.test(rec.useType)) vacants.push(rec);
        trace.push({ ain: fmt(book, page, pnum), status: "VALID", useType: rec.useType });
        console.log(`[${pageKey}] VALID ${rec.ain} ${rec.useType} ${rec.address}`);
      }
    }
    parcel += batchSize;
    if (stop) break;
  }

  const result = {
    agent: "agent-09",
    page: pageKey,
    algorithm: "page-walk-20-invalid-streak",
    start: fmt(book, page, 1),
    lastAinChecked: fmt(book, page, lastChecked),
    lastValidParcel,
    stoppedReason: consecutiveInvalid >= HARD_STREAK ? "20_INVALID_STREAK" : "PAGE_END",
    validCount: valids.length,
    vacantCount: vacants.length,
    invalidCount: trace.filter((t) => t.status === "INVALID").length,
    valids,
    vacants,
    resultsTrace: trace,
  };

  const dest = path.join(ROOT, "runs", `RUN-A09-${pageKey}`);
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, "full.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(dest, "valids.json"), JSON.stringify(valids, null, 2));
  fs.writeFileSync(path.join(dest, "vacant-land.json"), JSON.stringify(vacants, null, 2));

  const csvHeader =
    "ain,address,useType,taxStatus,parcelStatus,yearBuilt,beds,baths,bldg,lot,assessed,lastBuyRec,lastBuyPrice,lastBuyDoc,hasFcHist";
  const csvRows = valids.map((v) =>
    [
      v.ain,
      `"${(v.address || "").replace(/"/g, '""')}"`,
      `"${(v.useType || "").replace(/"/g, '""')}"`,
      v.taxStatus,
      v.parcelStatus,
      v.yearBuilt,
      v.beds,
      v.baths,
      v.bldg,
      v.lot,
      v.assessed,
      v.lastBuy?.rec || "",
      v.lastBuy?.price || "",
      v.lastBuy?.doc || "",
      v.hasForeclosureHist,
    ].join(",")
  );
  fs.writeFileSync(path.join(dest, "valids.csv"), [csvHeader, ...csvRows].join("\n"));

  const summary = `# RUN-A09-${pageKey}

- Agent: agent-09
- Page: ${pageKey}
- Start: ${result.start}
- Last AIN: ${result.lastAinChecked}
- Last valid parcel: ${lastValidParcel ?? "none"}
- Valid: ${valids.length} (vacant land: ${vacants.length})
- Invalid in walk: ${result.invalidCount}
- StoppedReason: ${result.stoppedReason}
`;
  fs.writeFileSync(path.join(dest, "summary.md"), summary);
  console.log(`[${pageKey}] done valids=${valids.length} vacants=${vacants.length} stop=${result.stoppedReason}`);
  return result;
}

async function main() {
  const started = new Date().toISOString();
  // Parallel page walks (exclusive pages, no overlap)
  const results = await Promise.all(PAGES.map((p) => walkPage(8448, p)));
  const aggregate = {
    agent: "agent-09",
    pages: PAGES.map((p) => `8448-${String(p).padStart(3, "0")}`),
    startedAt: started,
    finishedAt: new Date().toISOString(),
    totalValids: results.reduce((s, r) => s + r.validCount, 0),
    totalVacants: results.reduce((s, r) => s + r.vacantCount, 0),
    byPage: results.map((r) => ({
      page: r.page,
      validCount: r.validCount,
      vacantCount: r.vacantCount,
      lastAinChecked: r.lastAinChecked,
      stoppedReason: r.stoppedReason,
    })),
  };
  const aggDir = path.join(ROOT, "runs", "RUN-A09-aggregate");
  fs.mkdirSync(aggDir, { recursive: true });
  fs.writeFileSync(path.join(aggDir, "summary.json"), JSON.stringify(aggregate, null, 2));
  fs.writeFileSync(
    path.join(aggDir, "summary.md"),
    `# RUN-A09 aggregate (8448-071..075)

- Total valids: ${aggregate.totalValids}
- Total vacant land: ${aggregate.totalVacants}
- Finished: ${aggregate.finishedAt}

| Page | Valids | Vacants | Last AIN | Stop |
|------|--------|---------|----------|------|
${aggregate.byPage
  .map(
    (p) =>
      `| ${p.page} | ${p.validCount} | ${p.vacantCount} | ${p.lastAinChecked} | ${p.stoppedReason} |`
  )
  .join("\n")}
`
  );
  console.log(JSON.stringify(aggregate, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
