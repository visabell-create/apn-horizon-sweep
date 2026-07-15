/**
 * Fast horizon batch until local midnight. Node HTTPS (assessor portal APIs).
 */
const fs = require("fs");
const path = require("path");
const https = require("https");

const ROOT = path.resolve(__dirname, "..");
const CURSOR_PATH = path.join(ROOT, "state", "cursor.json");
const SOFT_JUMP = 12;
const HARD_JUMP = 20;
const LOOKAHEAD_TRIGGER = 5;
const HORIZON_PAGES = 16;
const MAX_CHECKS = 160;
const SAMPLE = [1, 20, 26, 40, 50, 80, 100];
const STOP_AT = new Date(); // will set hour to midnight of next calendar day if past; else tonight midnight
// Hard stop: midnight of 2026-07-15 local (session target)
const midnight = new Date(STOP_AT);
if (midnight.getHours() >= 0 && midnight.getMinutes() >= 0) {
  // If already past midnight on calendar day, stop immediately after this check;
  // else stop at next local midnight (tonight).
  midnight.setHours(24, 0, 0, 0); // next midnight
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fmt(n) {
  const s = String(n).padStart(10, "0");
  return `${s.slice(0, 4)}-${s.slice(4, 7)}-${s.slice(7, 10)}`;
}

function parseAin(n) {
  const s = String(n).padStart(10, "0");
  return { book: +s.slice(0, 4), page: +s.slice(4, 7), parcel: +s.slice(7, 10), raw: +s };
}

function makeAin(book, page, parcel) {
  return book * 1e6 + page * 1e3 + parcel;
}

function parseCursor(str) {
  const m = String(str).match(/(\d{4})-(\d{3})-(\d{3})/);
  if (!m) throw new Error("bad cursor " + str);
  return makeAin(+m[1], +m[2], +m[3]);
}

function fetchJson(urlPath) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      {
        hostname: "portal.assessor.lacounty.gov",
        path: urlPath,
        headers: {
          "User-Agent": "Mozilla/5.0 APN-Horizon-Sweep-Midnight",
          Accept: "application/json",
        },
        timeout: 20000,
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
    req.on("error", (e) => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
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
  return fetchJson(`/api/parceldetail?ain=${ain}`);
}

async function enrich(ainNum, p) {
  let owners = [];
  try {
    const oh = await fetchJson(`/api/parcel_ownershiphistory?ain=${String(ainNum).padStart(10, "0")}`);
    owners = (oh && oh.Parcel_OwnershipHistory ? oh.Parcel_OwnershipHistory : []).slice(0, 5).map((o) => ({
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

async function scorePage(book, page, donePages) {
  let hits = 0;
  let firstValidParcel = null;
  for (const parcel of SAMPLE) {
    if (Date.now() >= midnight.getTime()) break;
    const data = await fetchDetail(makeAin(book, page, parcel));
    if (isValidParcel(data)) {
      hits++;
      if (firstValidParcel == null) firstValidParcel = parcel;
    }
  }
  if (hits === 0) {
    for (let parcel = 1; parcel <= 40; parcel++) {
      if (Date.now() >= midnight.getTime()) break;
      const data = await fetchDetail(makeAin(book, page, parcel));
      if (isValidParcel(data)) {
        hits = 1;
        firstValidParcel = parcel;
        break;
      }
    }
  }
  return { book, page, hits, firstValidParcel, key: `${book}-${String(page).padStart(3, "0")}` };
}

async function probeHorizon(fromBook, fromPage, donePages) {
  const candidates = [];
  for (let d = 1; d <= HORIZON_PAGES; d++) {
    if (Date.now() >= midnight.getTime()) break;
    let book = fromBook;
    let page = fromPage + d;
    if (page > 999) {
      book += Math.floor(page / 1000);
      page = page % 1000;
    }
    const key = `${book}-${String(page).padStart(3, "0")}`;
    if (donePages.has(key)) continue;
    const scored = await scorePage(book, page, donePages);
    if (scored.hits > 0) candidates.push(scored);
  }
  candidates.sort((a, b) => b.hits - a.hits || a.page - b.page);
  return candidates;
}

function csvEscape(v) {
  const s = v == null ? "" : String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function main() {
  const startedAt = new Date();
  console.log(`START ${startedAt.toISOString()} local=${startedAt.toString()} midnight=${midnight.toString()}`);
  if (Date.now() >= midnight.getTime()) {
    console.log("Already at/past midnight — no batch");
    writeMidnightStop(null, [], [], startedAt);
    return;
  }

  const cursor = JSON.parse(fs.readFileSync(CURSOR_PATH, "utf8").replace(/^\uFEFF/, ""));
  // User wanted 8448-006-026; RUN-009 advanced to nextCursor — continue from cursor, skip donePages re-walks
  let ainNum = parseCursor(cursor.nextCursor || "8448-006-026");
  // If still on a done page with no remaining serial intent, jump to best horizon not done
  const donePages = new Set(cursor.donePages || []);
  let horizonQueue = (cursor.horizonQueue || []).filter((h) => !donePages.has(h.key));
  const jumps = [...(cursor.jumps || [])];
  const valids = [];
  const resultsTrace = [];
  let consecutiveInvalid = 0;
  let lastHorizonAtPage = null;
  const startFmt = fmt(ainNum);
  let checks = 0;
  let stopReason = "SESSION_CAP_KEEP_GOING";

  // If current page is fully donePages AND parcel high, prefer queue jump
  {
    const meta = parseAin(ainNum);
    const pageKey = `${meta.book}-${String(meta.page).padStart(3, "0")}`;
    // continue mid-page even if in donePages (serial soft-landed here); only skip if queue prefers and we're restarting at 026 on done page with user instruction
  }

  for (let i = 0; i < MAX_CHECKS; i++) {
    if (Date.now() >= midnight.getTime()) {
      stopReason = "MIDNIGHT_STOP";
      break;
    }
    checks++;
    const meta = parseAin(ainNum);
    const pageKey = `${meta.book}-${String(meta.page).padStart(3, "0")}`;

    // Skip entire pages already completed by parallel fleet IF we soft-landed at start of done page incorrectly
    // Exception: keep walking current serial mid-page (006) that we already partially swept

    if (consecutiveInvalid >= LOOKAHEAD_TRIGGER && lastHorizonAtPage !== pageKey) {
      const probed = await probeHorizon(meta.book, meta.page, donePages);
      const known = new Set(horizonQueue.map((h) => h.key));
      for (const c of probed) if (!known.has(c.key) && !donePages.has(c.key)) horizonQueue.push(c);
      horizonQueue.sort((a, b) => b.hits - a.hits);
      lastHorizonAtPage = pageKey;
    }

    if (consecutiveInvalid >= SOFT_JUMP && horizonQueue.length) {
      const target = horizonQueue.shift();
      if (donePages.has(target.key)) {
        consecutiveInvalid = SOFT_JUMP; // try next
        i--;
        continue;
      }
      const dest = makeAin(target.book, target.page, target.firstValidParcel || 1);
      jumps.push({
        at: fmt(ainNum),
        streak: consecutiveInvalid,
        to: fmt(dest),
        reason: consecutiveInvalid >= HARD_JUMP ? "HARD_JUMP" : "SOFT_JUMP",
        hits: target.hits,
      });
      donePages.add(pageKey);
      ainNum = dest;
      consecutiveInvalid = 0;
      lastHorizonAtPage = null;
      continue;
    }

    if (consecutiveInvalid >= HARD_JUMP) {
      if (!horizonQueue.length) {
        const emergency = await probeHorizon(meta.book, meta.page, donePages);
        horizonQueue = emergency.filter((h) => !donePages.has(h.key));
      }
      if (horizonQueue.length) {
        const target = horizonQueue.shift();
        const dest = makeAin(target.book, target.page, target.firstValidParcel || 1);
        jumps.push({
          at: fmt(ainNum),
          streak: consecutiveInvalid,
          to: fmt(dest),
          reason: "HARD_JUMP",
          hits: target.hits,
        });
        donePages.add(pageKey);
        ainNum = dest;
        consecutiveInvalid = 0;
        lastHorizonAtPage = null;
        continue;
      }
      const dest = makeAin(meta.book + 1, 1, 1);
      jumps.push({ at: fmt(ainNum), streak: consecutiveInvalid, to: fmt(dest), reason: "MAPBOOK_ROLLOVER" });
      donePages.add(pageKey);
      ainNum = dest;
      consecutiveInvalid = 0;
      continue;
    }

    const data = await fetchDetail(ainNum);
    if (!isValidParcel(data)) {
      consecutiveInvalid++;
      resultsTrace.push({ ain: fmt(ainNum), status: "INVALID", streak: consecutiveInvalid });
    } else {
      consecutiveInvalid = 0;
      const rec = await enrich(ainNum, data.Parcel);
      valids.push(rec);
      resultsTrace.push({ ain: fmt(ainNum), status: "VALID" });
      donePages.add(pageKey);
    }
    ainNum++;
  }

  const endedAt = new Date();
  const nextCursor = fmt(ainNum);
  const lastAin = fmt(ainNum - 1);
  const runId = "RUN-010";
  const stamp = endedAt.toISOString().slice(0, 10);
  const runDir = path.join(ROOT, "runs", `${runId}-${stamp}-horizon`);
  fs.mkdirSync(runDir, { recursive: true });

  const full = {
    algorithm: "perpetual-horizon-v1",
    start: startFmt,
    lastAinChecked: lastAin,
    nextCursor,
    stoppedReason: stopReason,
    validCount: valids.length,
    invalidCount: resultsTrace.filter((r) => r.status !== "VALID").length,
    checks,
    jumps: jumps.slice(-(jumps.length - (cursor.jumps || []).length) || jumps.length),
    allJumps: jumps,
    horizonQueue,
    donePages: [...donePages],
    valids,
    resultsTrace,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
  };

  fs.writeFileSync(path.join(runDir, "full.json"), JSON.stringify(full, null, 2));
  fs.writeFileSync(path.join(runDir, "valids.json"), JSON.stringify(valids, null, 2));
  const headers = ["ain", "address", "useType", "assessed", "yearBuilt", "beds", "baths", "bldg", "lot", "taxStatus"];
  const csvLines = [headers.join(",")];
  for (const v of valids) {
    csvLines.push(headers.map((h) => csvEscape(v[h])).join(","));
  }
  fs.writeFileSync(path.join(runDir, "valids.csv"), csvLines.join("\n"));
  const batchJumps = jumps.filter((j) => !(cursor.jumps || []).some((cj) => cj.at === j.at && cj.to === j.to));
  fs.writeFileSync(
    path.join(runDir, "summary.md"),
    `# ${runId} — perpetual horizon v1\n\n` +
      `- Start: ${startFmt}\n` +
      `- Last AIN: ${lastAin}\n` +
      `- Next cursor: ${nextCursor}\n` +
      `- Valid: ${valids.length}\n` +
      `- Checks: ${checks}\n` +
      `- Stop: ${stopReason}\n` +
      `- Jumps: ${JSON.stringify(batchJumps)}\n` +
      `- Started: ${startedAt.toString()}\n` +
      `- Ended: ${endedAt.toString()}\n`
  );

  const completed = new Set(cursor.completedRuns || []);
  completed.add(runId);
  const updated = {
    ...cursor,
    donePages: [...donePages].sort(),
    horizonQueue,
    nextCursor,
    jumps,
    completedRuns: [...completed],
    validCountRun010: valids.length,
    lastRunDir: runDir,
    indefinite: true,
  };
  fs.writeFileSync(CURSOR_PATH, JSON.stringify(updated, null, 4));

  writeMidnightStop(updated, valids, [runDir], endedAt, startFmt, checks, stopReason);
  console.log(`DONE valids=${valids.length} next=${nextCursor} checks=${checks} reason=${stopReason}`);
  console.log(`runDir=${runDir}`);
}

function writeMidnightStop(cursor, valids, runDirs, stoppedAt, startFmt, checks, stopReason) {
  const statusDir = path.join(ROOT, "state", "status");
  fs.mkdirSync(statusDir, { recursive: true });
  const lines = [
    `# MIDNIGHT-STOP`,
    ``,
    `- **Time stopped:** ${stoppedAt.toString()}`,
    `- **Final nextCursor:** ${(cursor && cursor.nextCursor) || "(none — already past midnight)"}`,
    `- **Valids collected this session (RUN-010):** ${(valids && valids.length) || 0}`,
    `- **Checks this batch:** ${checks || 0}`,
    `- **Stop reason:** ${stopReason || "PAST_MIDNIGHT"}`,
    `- **Session start AIN:** ${startFmt || "n/a"}`,
    `- **Run folders created:**`,
    ...(runDirs && runDirs.length ? runDirs.map((d) => `  - \`${d}\``) : ["  - (none)"]),
    `- **Valid AINs:**`,
    ...((valids && valids.length) ? valids.map((v) => `  - ${v.ain} — ${v.address || v.useType || ""}`) : ["  - (none)"]),
    ``,
  ];
  fs.writeFileSync(path.join(statusDir, "MIDNIGHT-STOP.md"), lines.join("\n"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
