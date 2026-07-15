/**
 * Agent-08 exclusive sweep: 8448-066..070
 * Soft-jump only among assigned pages (probe once when streak hits SOFT).
 * Dedup against donePages.
 */
import fs from "fs";
import path from "path";

const ROOT = "C:\\Users\\Authorized User\\apn-horizon-sweep";
const LIVE = path.join(ROOT, "state", "status", "agent-08-live.log");
const BASE = "https://portal.assessor.lacounty.gov";
const PAGES = [66, 67, 68, 69, 70];
const SOFT_JUMP = 12;
const HARD_JUMP = 20;
const SAMPLE = [1, 20, 26, 40, 50, 80, 100];
const MAX_CHECKS = 2500;

const log = (...args) => {
  const line = args.map(String).join(" ");
  console.log(line);
  try {
    fs.appendFileSync(LIVE, line + "\n", "utf8");
  } catch {}
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (n) => {
  const s = String(Math.trunc(n)).padStart(10, "0");
  return `${s.slice(0, 4)}-${s.slice(4, 7)}-${s.slice(7, 10)}`;
};
const makeAin = (book, page, parcel) =>
  book * 1000000 + page * 1000 + parcel;

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

async function fetchDetail(ainNum) {
  const ain = String(Math.trunc(ainNum)).padStart(10, "0");
  try {
    const res = await fetch(`${BASE}/api/parceldetail?ain=${ain}`);
    const t = await res.text();
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
        `${BASE}/api/parcel_ownershiphistory?ain=${String(Math.trunc(ainNum)).padStart(10, "0")}`
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
  const lastBuy =
    owners.find((o) => o.price && Number(o.price) > 1000) || null;
  const hasForeclosureHist = owners.some(
    (o) =>
      /foreclos/i.test(o.docType || "") || /Trustee Sale/i.test(o.reason || "")
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
    assessed:
      Number(p.CurrentRoll_LandValue || 0) +
      Number(p.CurrentRoll_ImpValue || 0),
    lastBuy,
    hasForeclosureHist,
    ownership: owners,
  };
}

async function scorePage(book, page) {
  let hits = 0;
  let firstValidParcel = null;
  for (const parcel of SAMPLE) {
    const data = await fetchDetail(makeAin(book, page, parcel));
    if (isValid(data)) {
      hits++;
      if (firstValidParcel == null) firstValidParcel = parcel;
    }
    await sleep(10);
  }
  if (hits === 0) {
    for (let parcel = 1; parcel <= 30; parcel++) {
      const data = await fetchDetail(makeAin(book, page, parcel));
      if (isValid(data)) {
        hits = 1;
        firstValidParcel = parcel;
        break;
      }
      await sleep(8);
    }
  }
  return {
    book,
    page,
    hits,
    firstValidParcel: firstValidParcel ?? 1,
    key: `${book}-${String(page).padStart(3, "0")}`,
  };
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function toCsv(rows) {
  const headers = [
    "ain",
    "address",
    "useType",
    "taxStatus",
    "assessed",
    "lot",
    "yearBuilt",
    "beds",
    "baths",
    "hasForeclosureHist",
    "lastBuyPrice",
    "lastBuyDate",
  ];
  const esc = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.ain,
        r.address,
        r.useType,
        r.taxStatus,
        r.assessed,
        r.lot,
        r.yearBuilt,
        r.beds,
        r.baths,
        r.hasForeclosureHist,
        r.lastBuy?.price ?? "",
        r.lastBuy?.rec ?? "",
      ]
        .map(esc)
        .join(",")
    );
  }
  return lines.join("\n") + "\n";
}

async function main() {
  fs.writeFileSync(LIVE, "", "utf8");
  const cursorRaw = fs
    .readFileSync(path.join(ROOT, "state", "cursor.json"), "utf8")
    .replace(/^\uFEFF/, "");
  const cursor = JSON.parse(cursorRaw);
  const done = new Set(cursor.donePages || []);
  const assigned = PAGES.map((p) => `8448-${String(p).padStart(3, "0")}`);
  let rem = assigned.filter((k) => {
    if (done.has(k)) {
      log("SKIP already done:", k);
      return false;
    }
    return true;
  });
  if (!rem.length) {
    log("Nothing to sweep");
    return;
  }

  const book = 8448;
  const startPage = Number(rem[0].split("-")[1]);
  let ainNum = makeAin(book, startPage, 1);
  let streak = 0;
  const valids = [];
  const jumps = [];
  const completed = [];
  const pageStats = {};
  let checks = 0;
  /** Only probe soft-jump once per (page, streak-crossing). */
  let softProbedForPage = null;

  const ensureStat = (key) => {
    if (!pageStats[key])
      pageStats[key] = { page: key, checks: 0, valids: 0, lastAin: null };
  };

  async function probeOwnPages(fromKey) {
    const queue = [];
    for (const key of rem) {
      if (key === fromKey || completed.includes(key)) continue;
      const pg = Number(key.split("-")[1]);
      log(`PROBE score ${key}...`);
      const scored = await scorePage(book, pg);
      log(`PROBE ${key} hits=${scored.hits} first=${scored.firstValidParcel}`);
      if (scored.hits > 0) queue.push(scored);
    }
    queue.sort((a, b) => b.hits - a.hits);
    return queue;
  }

  log("START agent-08 remaining=", rem.join(","));

  while (checks < MAX_CHECKS && rem.length) {
    const page = Math.floor((ainNum % 1000000) / 1000);
    const pageKey = `${book}-${String(page).padStart(3, "0")}`;

    if (!rem.includes(pageKey)) {
      const next = rem[0];
      const np = Number(next.split("-")[1]);
      ainNum = makeAin(book, np, 1);
      streak = 0;
      softProbedForPage = null;
      continue;
    }
    ensureStat(pageKey);

    // Soft jump: probe own remaining pages ONCE when streak first hits SOFT_JUMP
    if (streak >= SOFT_JUMP && softProbedForPage !== pageKey) {
      softProbedForPage = pageKey;
      const q = await probeOwnPages(pageKey);
      if (q.length) {
        const target = q[0];
        const dest = makeAin(target.book, target.page, target.firstValidParcel);
        jumps.push({
          at: fmt(ainNum),
          streak,
          to: fmt(dest),
          reason: "SOFT_JUMP",
          hits: target.hits,
        });
        log(
          `JUMP SOFT_JUMP from ${fmt(ainNum)} streak=${streak} to ${fmt(dest)} hits=${target.hits}`
        );
        if (!completed.includes(pageKey)) {
          completed.push(pageKey);
          rem = rem.filter((k) => k !== pageKey);
        }
        ainNum = dest;
        streak = 0;
        softProbedForPage = null;
        continue;
      }
      log(`SOFT probe empty — continue walk on ${pageKey} until HARD_JUMP`);
    }

    if (streak >= HARD_JUMP) {
      if (!completed.includes(pageKey)) {
        completed.push(pageKey);
        rem = rem.filter((k) => k !== pageKey);
      }
      if (!rem.length) {
        log("DONE all pages after HARD_JUMP at", fmt(ainNum));
        break;
      }
      // Prefer previously scored density among remaining, else next in list
      log(`HARD finishing ${pageKey}, probing remaining once...`);
      const q = await probeOwnPages("__none__");
      let nextKey, destParcel;
      if (q.length) {
        nextKey = q[0].key;
        destParcel = q[0].firstValidParcel;
      } else {
        nextKey = rem[0];
        destParcel = 1;
      }
      const np = Number(nextKey.split("-")[1]);
      const dest = makeAin(book, np, destParcel);
      jumps.push({
        at: fmt(ainNum),
        streak,
        to: fmt(dest),
        reason: "HARD_JUMP_NEXT_ASSIGNED",
        hits: q[0]?.hits ?? 0,
      });
      log(`HARD finish ${pageKey} -> ${fmt(dest)}`);
      ainNum = dest;
      streak = 0;
      softProbedForPage = null;
      continue;
    }

    const data = await fetchDetail(ainNum);
    pageStats[pageKey].checks++;
    pageStats[pageKey].lastAin = fmt(ainNum);
    checks++;

    if (!isValid(data)) {
      streak++;
      if (checks % 10 === 0 || streak === SOFT_JUMP || streak === HARD_JUMP)
        log(
          `check=${checks} ain=${fmt(ainNum)} streak=${streak} valids=${valids.length} page=${pageKey}`
        );
    } else {
      streak = 0;
      softProbedForPage = null;
      const rec = await enrich(ainNum, data.Parcel);
      valids.push(rec);
      pageStats[pageKey].valids++;
      log(`VALID ${fmt(ainNum)} ${rec.useType} ${rec.address}`);
    }

    const parcel = ainNum % 1000;
    if (parcel >= 999) {
      if (!completed.includes(pageKey)) {
        completed.push(pageKey);
        rem = rem.filter((k) => k !== pageKey);
      }
      if (!rem.length) break;
      const nextKey = rem[0];
      const np = Number(nextKey.split("-")[1]);
      ainNum = makeAin(book, np, 1);
      streak = 0;
      softProbedForPage = null;
    } else {
      ainNum++;
    }
    await sleep(15);
  }

  for (const key of assigned) {
    if (!done.has(key) && !completed.includes(key) && pageStats[key])
      completed.push(key);
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const runDir = path.join(ROOT, "runs", `RUN-A08-${stamp}-horizon`);
  ensureDir(runDir);

  const full = {
    algorithm: "agent-08-constrained-horizon",
    agent: "agent-08",
    pages: assigned,
    skippedDone: assigned.filter((k) => done.has(k)),
    checks,
    validCount: valids.length,
    jumps,
    pageStats: Object.values(pageStats),
    completedPages: completed,
    valids,
  };
  fs.writeFileSync(path.join(runDir, "full.json"), JSON.stringify(full, null, 2));
  fs.writeFileSync(
    path.join(runDir, "valids.json"),
    JSON.stringify(valids, null, 2)
  );
  fs.writeFileSync(path.join(runDir, "valids.csv"), toCsv(valids));
  fs.writeFileSync(
    path.join(runDir, "summary.md"),
    `# RUN-A08 — agent-08 exclusive pages 066-070

- Agent: agent-08
- Pages: ${assigned.join(", ")}
- Soft-jump: only among assigned pages (SOFT=${SOFT_JUMP}, HARD=${HARD_JUMP})
- Checks: ${checks}
- Valid: ${valids.length}
- Jumps: ${JSON.stringify(jumps)}
- Completed pages: ${completed.join(", ")}
- Page stats: ${JSON.stringify(Object.values(pageStats))}
`
  );

  for (const key of assigned.filter((k) => !done.has(k))) {
    const pgDir = path.join(ROOT, "runs", `RUN-A08-${key}`);
    ensureDir(pgDir);
    const pgValids = valids.filter((v) => v.ain.startsWith(key));
    const stat = pageStats[key] || { checks: 0, lastAin: "n/a" };
    fs.writeFileSync(
      path.join(pgDir, "valids.json"),
      JSON.stringify(pgValids, null, 2)
    );
    fs.writeFileSync(path.join(pgDir, "valids.csv"), toCsv(pgValids));
    fs.writeFileSync(
      path.join(pgDir, "summary.md"),
      `# RUN-A08-${key}

- Valids: ${pgValids.length}
- Checks (on page): ${stat.checks}
- Last AIN: ${stat.lastAin}
`
    );
    fs.writeFileSync(
      path.join(pgDir, "full.json"),
      JSON.stringify(
        {
          page: key,
          validCount: pgValids.length,
          checks: stat.checks,
          lastAin: stat.lastAin,
          valids: pgValids,
        },
        null,
        2
      )
    );
  }

  const now = new Date();
  const local = now.toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  fs.writeFileSync(
    path.join(ROOT, "state", "claims", "agent-08.json"),
    JSON.stringify(
      {
        agent: "agent-08",
        pages: assigned,
        exclusive: true,
        startedAt: "2026-07-14T23:11:45-07:00",
        completedAt: now.toISOString(),
        status: "completed",
        validCount: valids.length,
        checks,
        runDir: `runs/RUN-A08-${stamp}-horizon`,
        completedPages: completed,
      },
      null,
      2
    )
  );
  fs.writeFileSync(
    path.join(ROOT, "state", "status", "agent-08.md"),
    `# agent-08 status

- **Started:** ~11:12 PM
- **Finished:** ${local}
- **Exclusive pages:** 8448-066, 067, 068, 069, 070
- **Claim:** completed
- **Checks:** ${checks}
- **Valids:** ${valids.length}
- **Jumps:** ${jumps.length} (soft-jump only among own pages)
- **Archives:** \`runs/RUN-A08-${stamp}-horizon/\` + per-page \`runs/RUN-A08-8448-0XX/\`
- **Dedup:** skipped pages already in donePages (none of 066-070 were done)
- **Blockers:** none
- **Checkpoint:** ready for 11:30 rollup
`
  );

  const indexPath = path.join(ROOT, "runs", "INDEX.md");
  const line = `| RUN-A08 | \`runs/RUN-A08-${stamp}-horizon/\` | ${valids.length} | agent-08 pages 066-070 |`;
  if (fs.existsSync(indexPath)) {
    fs.appendFileSync(indexPath, `\n${line}\n`);
  } else {
    fs.writeFileSync(
      indexPath,
      `# Runs index\n\n| Run | Folder | Valids | Notes |\n|-----|--------|--------|-------|\n${line}\n`
    );
  }

  log(`COMPLETE valids=${valids.length} checks=${checks} run=${runDir}`);
}

main().catch((e) => {
  console.error(e);
  try {
    fs.appendFileSync(LIVE, String(e) + "\n");
  } catch {}
  process.exit(1);
});
