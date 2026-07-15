/**
 * Always-on perpetual-horizon-v1 sweep (Node HTTPS — no browser).
 *
 * Modes:
 *   node scripts/always-on-sweep.mjs --once          # single cycle (CI / manual)
 *   node scripts/always-on-sweep.mjs --loop           # durable local loop
 *
 * Env / flags:
 *   --max-checks=N       parcel checks per cycle (default 180 local / 50 CI)
 *   --max-seconds=N      wall-clock budget for one cycle (CI)
 *   --sleep-sec=N        pause between loop cycles (default 90)
 *   --no-git             skip commit/push after cycle
 *   --no-build           skip npm run build:data
 *   CI=true              tighter defaults + clear assessor-block failure
 */
import fs from "fs";
import path from "path";
import https from "https";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CURSOR_PATH = path.join(ROOT, "state", "cursor.json");
const PID_PATH = path.join(ROOT, "state", "always-on.pid");
const STOP_FLAG = path.join(ROOT, "state", "ALWAYS_ON_STOP");
const LEFT_OFF_PATH = path.join(ROOT, "state", "LEFT_OFF.md");
const STATUS_DIR = path.join(ROOT, "state", "status");
const ASSESSOR_HOST = "portal.assessor.lacounty.gov";
const PROBE_AIN = "8448008048"; // known Calle Cristina valid — connectivity canary

const SOFT_JUMP = 12;
const HARD_JUMP = 20;
const LOOKAHEAD_TRIGGER = 5;
const HORIZON_PAGES = 16;
const SAMPLE = [1, 20, 26, 40, 50, 80, 100];

const args = parseArgs(process.argv.slice(2));
const IS_CI = args.ci || process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
const MODE_LOOP = Boolean(args.loop) && !args.once;
const MAX_CHECKS = Number(args["max-checks"] ?? (IS_CI ? 50 : 180));
const MAX_SECONDS = Number(args["max-seconds"] ?? (IS_CI ? 420 : 0));
const SLEEP_SEC = Number(args["sleep-sec"] ?? 90);
const DO_GIT = !args["no-git"] && args.git !== false;
const DO_BUILD = !args["no-build"];

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    if (a === "--once") out.once = true;
    else if (a === "--loop") out.loop = true;
    else if (a === "--no-git") out["no-git"] = true;
    else if (a === "--no-build") out["no-build"] = true;
    else if (a === "--ci") out.ci = true;
    else if (a.startsWith("--")) {
      const [k, v] = a.replace(/^--/, "").split("=");
      out[k] = v === undefined ? true : v;
    }
  }
  return out;
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

function pageKeyOf(ainNum) {
  const m = parseAin(ainNum);
  return `${m.book}-${String(m.page).padStart(3, "0")}`;
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8").replace(/^\uFEFF/, ""));
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 4) + "\n");
}

function fetchJson(urlPath) {
  return new Promise((resolve) => {
    const req = https.get(
      {
        hostname: ASSESSOR_HOST,
        path: urlPath,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 APN-Horizon-AlwaysOn",
          Accept: "application/json",
          Referer: "https://portal.assessor.lacounty.gov/",
        },
        timeout: 25000,
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          if (res.statusCode === 403 || res.statusCode === 429) {
            resolve({ __httpError: res.statusCode, __blocked: true, body: body.slice(0, 200) });
            return;
          }
          if (res.statusCode && res.statusCode >= 500) {
            resolve({ __httpError: res.statusCode, body: body.slice(0, 200) });
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on("error", (e) => resolve({ __networkError: e.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ __networkError: "timeout" });
    });
  });
}

function isBlocked(data) {
  return Boolean(data && (data.__blocked || data.__networkError || data.__httpError >= 500));
}

function isValidParcel(data) {
  if (!data || data.Error || data.__httpError || data.__networkError) return false;
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
    const oh = await fetchJson(
      `/api/parcel_ownershiphistory?ain=${String(ainNum).padStart(10, "0")}`
    );
    if (!isBlocked(oh)) {
      owners = (oh && oh.Parcel_OwnershipHistory ? oh.Parcel_OwnershipHistory : [])
        .slice(0, 5)
        .map((o) => ({
          rec: o.RecordingDate,
          doc: o.DocumentNumber,
          price: o.DTTSalePrice,
          assessed: o.AssessedValue,
          docType: (o.DocumentTypeDesc || "").trim() || o.DocumentType,
          reason: (o.DocumentReasonCodeDesc || "").trim() || o.DocumentReasonCode,
        }));
    }
  } catch {
    /* keep owners empty */
  }
  const lastBuy = owners.find((o) => o.price && Number(o.price) > 1000) || null;
  const hasForeclosureHist = owners.some(
    (o) => /foreclos/i.test(o.docType || "") || /Trustee Sale/i.test(o.reason || "")
  );
  const lat = p.Latitude != null && p.Latitude !== "" ? Number(p.Latitude) : null;
  const lon = p.Longitude != null && p.Longitude !== "" ? Number(p.Longitude) : null;
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
    units: p.NumUnits ?? null,
    land: p.CurrentRoll_LandValue != null ? Number(p.CurrentRoll_LandValue) : null,
    imp: p.CurrentRoll_ImpValue != null ? Number(p.CurrentRoll_ImpValue) : null,
    assessed: Number(p.CurrentRoll_LandValue || 0) + Number(p.CurrentRoll_ImpValue || 0),
    latitude: Number.isFinite(lat) && lat !== 0 ? lat : null,
    longitude: Number.isFinite(lon) && lon !== 0 ? lon : null,
    lastBuy,
    hasForeclosureHist,
    ownership: owners,
  };
}

function slimParcel(p) {
  if (!p) return null;
  return {
    AIN: p.AIN,
    Latitude: p.Latitude ?? null,
    Longitude: p.Longitude ?? null,
    SitusStreet: p.SitusStreet,
    SitusCity: p.SitusCity,
    SitusZipCode: p.SitusZipCode,
    UseType: p.UseType,
    ParcelStatus: p.ParcelStatus,
    TaxStatus: p.TaxStatus,
    YearBuilt: p.YearBuilt,
    SqftLot: p.SqftLot,
    SqftMain: p.SqftMain,
    NumOfBeds: p.NumOfBeds,
    NumOfBaths: p.NumOfBaths,
    CurrentRoll_LandValue: p.CurrentRoll_LandValue,
    CurrentRoll_ImpValue: p.CurrentRoll_ImpValue,
  };
}

async function scorePage(book, page, deadline) {
  let hits = 0;
  let firstValidParcel = null;
  for (const parcel of SAMPLE) {
    if (deadline && Date.now() >= deadline) break;
    const data = await fetchDetail(makeAin(book, page, parcel));
    if (isBlocked(data)) return { blocked: true };
    if (isValidParcel(data)) {
      hits++;
      if (firstValidParcel == null) firstValidParcel = parcel;
    }
  }
  if (hits === 0) {
    for (let parcel = 1; parcel <= 40; parcel++) {
      if (deadline && Date.now() >= deadline) break;
      const data = await fetchDetail(makeAin(book, page, parcel));
      if (isBlocked(data)) return { blocked: true };
      if (isValidParcel(data)) {
        hits = 1;
        firstValidParcel = parcel;
        break;
      }
    }
  }
  return {
    book,
    page,
    hits,
    firstValidParcel,
    key: `${book}-${String(page).padStart(3, "0")}`,
  };
}

async function probeHorizon(fromBook, fromPage, donePages, deadline) {
  const candidates = [];
  for (let d = 1; d <= HORIZON_PAGES; d++) {
    if (deadline && Date.now() >= deadline) break;
    let book = fromBook;
    let page = fromPage + d;
    if (page > 999) {
      book += Math.floor(page / 1000);
      page = page % 1000;
    }
    const key = `${book}-${String(page).padStart(3, "0")}`;
    if (donePages.has(key)) continue;
    const scored = await scorePage(book, page, deadline);
    if (scored.blocked) return { blocked: true, candidates };
    if (scored.hits > 0) candidates.push(scored);
  }
  candidates.sort((a, b) => b.hits - a.hits || a.page - b.page);
  return { blocked: false, candidates };
}

function csvEscape(v) {
  const s = v == null ? "" : String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function nextRunId(cursor) {
  let max = 0;
  for (const r of cursor.completedRuns || []) {
    const m = String(r).match(/^RUN-(\d+)$/i);
    if (m) max = Math.max(max, +m[1]);
  }
  const runsDir = path.join(ROOT, "runs");
  if (fs.existsSync(runsDir)) {
    for (const name of fs.readdirSync(runsDir)) {
      const m = name.match(/^RUN-(\d+)/i);
      if (m) max = Math.max(max, +m[1]);
    }
  }
  return `RUN-${String(max + 1).padStart(3, "0")}`;
}

async function probeConnectivity() {
  const data = await fetchDetail(+PROBE_AIN);
  if (isBlocked(data) || !isValidParcel(data)) {
    const detail =
      (data && (data.__httpError || data.__networkError || data.__blocked)) ||
      "unexpected empty/invalid canary response";
    return {
      ok: false,
      detail: String(detail),
      message:
        `Assessor API unreachable or blocked (canary AIN ${fmt(+PROBE_AIN)}). ` +
        `Datacenter / GitHub Actions IPs are often blocked by portal.assessor.lacounty.gov. ` +
        `Fall back to local always-on: node scripts/always-on-sweep.mjs --loop ` +
        `(or scripts/always-on-sweep.ps1). Do not invent parcel data.`,
    };
  }
  return { ok: true };
}

function writePid() {
  fs.mkdirSync(path.dirname(PID_PATH), { recursive: true });
  fs.writeFileSync(PID_PATH, String(process.pid) + "\n");
}

function clearPid() {
  try {
    if (fs.existsSync(PID_PATH)) {
      const existing = fs.readFileSync(PID_PATH, "utf8").trim();
      if (existing === String(process.pid)) fs.unlinkSync(PID_PATH);
    }
  } catch {
    /* ignore */
  }
}

function updateLeftOff(nextCursor, runId, valids, checks, stopReason) {
  const lines = [
    `# LEFT OFF — agent coordination log`,
    ``,
    `**Updated:** ${new Date().toISOString()} (always-on cycle ${runId})`,
    ``,
    `## Global cursor (serial chain)`,
    ``,
    `**Authoritative next shared cursor:** \`${nextCursor}\``,
    ``,
    `- Last cycle: **${runId}** — valids **${valids}**, checks **${checks}**, stop \`${stopReason}\``,
    `- Algorithm: perpetual-horizon-v1 (Node HTTPS always-on)`,
    `- See \`state/cursor.json\` for donePages + horizonQueue`,
    ``,
  ];
  fs.writeFileSync(LEFT_OFF_PATH, lines.join("\n"));
}

function appendStatus(runId, summary) {
  fs.mkdirSync(STATUS_DIR, { recursive: true });
  const p = path.join(STATUS_DIR, "ALWAYS-ON.md");
  const block = [
    `# ALWAYS-ON cycle — ${runId}`,
    ``,
    `- **When:** ${new Date().toISOString()}`,
    `- **nextCursor:** ${summary.nextCursor}`,
    `- **valids:** ${summary.valids}`,
    `- **checks:** ${summary.checks}`,
    `- **stop:** ${summary.stopReason}`,
    `- **runDir:** \`${summary.runDir}\``,
    `- **mode:** ${IS_CI ? "ci" : MODE_LOOP ? "local-loop" : "once"}`,
    ``,
  ].join("\n");
  fs.writeFileSync(p, block);
}

function runCmd(cmd, cmdArgs, env = process.env) {
  const isWin = process.platform === "win32";
  const r = spawnSync(cmd, cmdArgs, {
    cwd: ROOT,
    encoding: "utf8",
    shell: isWin && (cmd === "npm" || cmd === "git"),
    env,
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  return r;
}

function shouldStopIndefinite() {
  return fs.existsSync(STOP_FLAG);
}

function gitCommitAndPush(runId, nextCursor, validCount) {
  // Prefer commit+push when cycle found new valids (feeds Pages without empty spam).
  if (validCount <= 0) {
    console.log("git: skip commit (0 new valids this cycle; archive still on disk)");
    return false;
  }
  // Identity via env only (never mutate git config)
  const authorName = process.env.GIT_AUTHOR_NAME || "visabell-create";
  const authorEmail =
    process.env.GIT_AUTHOR_EMAIL || "visabell-create@users.noreply.github.com";
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: authorName,
    GIT_AUTHOR_EMAIL: authorEmail,
    GIT_COMMITTER_NAME: authorName,
    GIT_COMMITTER_EMAIL: authorEmail,
  };
  runCmd("git", ["add", "runs", "state", "web"], env);
  const st = runCmd("git", ["status", "--porcelain"], env);
  if (!st.stdout || !st.stdout.trim()) {
    console.log("git: nothing to commit");
    return false;
  }
  const msg = `Always-on sweep ${runId}: ${validCount} valids → ${nextCursor}`;
  const commit = runCmd("git", ["commit", "-m", msg], env);
  if (commit.status !== 0) {
    console.warn("git commit failed (exit " + commit.status + ")");
    return false;
  }
  const push = runCmd("git", ["push", "origin", "HEAD"], env);
  if (push.status !== 0) {
    console.warn("git push failed (exit " + push.status + ") — will retry next cycle");
    return false;
  }
  console.log("git: pushed to origin");
  return true;
}

async function runCycle() {
  const startedAt = new Date();
  const deadline = MAX_SECONDS > 0 ? Date.now() + MAX_SECONDS * 1000 : 0;
  console.log(
    `CYCLE start ${startedAt.toISOString()} maxChecks=${MAX_CHECKS} maxSeconds=${MAX_SECONDS || "∞"} ci=${IS_CI}`
  );

  const conn = await probeConnectivity();
  if (!conn.ok) {
    console.error("ASSESSOR_BLOCKED: " + conn.message);
    console.error("detail: " + conn.detail);
    fs.mkdirSync(STATUS_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(STATUS_DIR, "ALWAYS-ON-BLOCKED.md"),
      `# Assessor API blocked\n\n${conn.message}\n\nDetail: ${conn.detail}\n\nAt: ${new Date().toISOString()}\n`
    );
    const err = new Error(conn.message);
    err.code = "ASSESSOR_BLOCKED";
    throw err;
  }

  const cursor = readJson(CURSOR_PATH);
  let ainNum = parseCursor(cursor.nextCursor);
  const donePages = new Set(cursor.donePages || []);
  let horizonQueue = (cursor.horizonQueue || []).filter((h) => !donePages.has(h.key));
  const jumps = [...(cursor.jumps || [])];
  const priorJumpKeys = new Set(jumps.map((j) => `${j.at}->${j.to}`));
  const valids = [];
  const resultsTrace = [];
  const parcelSnapshots = [];
  let consecutiveInvalid = 0;
  let lastHorizonAtPage = null;
  const startFmt = fmt(ainNum);
  let checks = 0;
  let stopReason = "SESSION_CAP_KEEP_GOING";

  for (let i = 0; i < MAX_CHECKS; i++) {
    if (shouldStopIndefinite()) {
      stopReason = "ALWAYS_ON_STOP_FLAG";
      break;
    }
    if (deadline && Date.now() >= deadline) {
      stopReason = "TIME_BUDGET";
      break;
    }
    checks++;
    const meta = parseAin(ainNum);
    const pageKey = `${meta.book}-${String(meta.page).padStart(3, "0")}`;

    if (consecutiveInvalid >= LOOKAHEAD_TRIGGER && lastHorizonAtPage !== pageKey) {
      const probed = await probeHorizon(meta.book, meta.page, donePages, deadline);
      if (probed.blocked) {
        stopReason = "ASSESSOR_BLOCKED_MID_CYCLE";
        break;
      }
      const known = new Set(horizonQueue.map((h) => h.key));
      for (const c of probed.candidates) {
        if (!known.has(c.key) && !donePages.has(c.key)) horizonQueue.push(c);
      }
      horizonQueue.sort((a, b) => b.hits - a.hits);
      lastHorizonAtPage = pageKey;
    }

    if (consecutiveInvalid >= SOFT_JUMP && horizonQueue.length) {
      const target = horizonQueue.shift();
      if (donePages.has(target.key)) {
        consecutiveInvalid = SOFT_JUMP;
        i--;
        checks--;
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
        const emergency = await probeHorizon(meta.book, meta.page, donePages, deadline);
        if (emergency.blocked) {
          stopReason = "ASSESSOR_BLOCKED_MID_CYCLE";
          break;
        }
        horizonQueue = emergency.candidates.filter((h) => !donePages.has(h.key));
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
      jumps.push({
        at: fmt(ainNum),
        streak: consecutiveInvalid,
        to: fmt(dest),
        reason: "MAPBOOK_ROLLOVER",
      });
      donePages.add(pageKey);
      ainNum = dest;
      consecutiveInvalid = 0;
      continue;
    }

    const data = await fetchDetail(ainNum);
    if (isBlocked(data)) {
      stopReason = "ASSESSOR_BLOCKED_MID_CYCLE";
      break;
    }
    if (!isValidParcel(data)) {
      consecutiveInvalid++;
      resultsTrace.push({ ain: fmt(ainNum), status: "INVALID", streak: consecutiveInvalid });
    } else {
      consecutiveInvalid = 0;
      const rec = await enrich(ainNum, data.Parcel);
      valids.push(rec);
      parcelSnapshots.push({ ain: fmt(ainNum), parcel: slimParcel(data.Parcel) });
      resultsTrace.push({ ain: fmt(ainNum), status: "VALID" });
    }
    ainNum++;
  }

  // Never mark the page we are still walking as done
  donePages.delete(pageKeyOf(ainNum));

  const endedAt = new Date();
  const nextCursor = fmt(ainNum);
  const lastAin = checks > 0 ? fmt(ainNum - 1) : startFmt;
  const runId = nextRunId(cursor);
  const stamp = endedAt.toISOString().slice(0, 10);
  const runDirName = `${runId}-${stamp}-horizon`;
  const runDir = path.join(ROOT, "runs", runDirName);
  fs.mkdirSync(runDir, { recursive: true });

  const batchJumps = jumps.filter((j) => !priorJumpKeys.has(`${j.at}->${j.to}`));
  const full = {
    algorithm: "perpetual-horizon-v1",
    mode: IS_CI ? "ci-always-on" : "always-on",
    start: startFmt,
    lastAinChecked: lastAin,
    nextCursor,
    stoppedReason: stopReason,
    validCount: valids.length,
    invalidCount: resultsTrace.filter((r) => r.status !== "VALID").length,
    checks,
    jumps: batchJumps,
    allJumps: jumps,
    horizonQueue,
    donePages: [...donePages].sort(),
    valids,
    parcelSnapshots,
    resultsTrace,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
  };

  fs.writeFileSync(path.join(runDir, "full.json"), JSON.stringify(full, null, 2));
  fs.writeFileSync(path.join(runDir, "valids.json"), JSON.stringify(valids, null, 2));
  // Array companion for build-web-data coord loader
  fs.writeFileSync(
    path.join(runDir, "parcels.json"),
    JSON.stringify(parcelSnapshots, null, 2)
  );
  const headers = [
    "ain",
    "address",
    "useType",
    "assessed",
    "yearBuilt",
    "beds",
    "baths",
    "bldg",
    "lot",
    "taxStatus",
    "latitude",
    "longitude",
  ];
  const csvLines = [headers.join(",")];
  for (const v of valids) {
    csvLines.push(headers.map((h) => csvEscape(v[h])).join(","));
  }
  fs.writeFileSync(path.join(runDir, "valids.csv"), csvLines.join("\n"));
  fs.writeFileSync(
    path.join(runDir, "summary.md"),
    `# ${runId} — perpetual horizon v1 (always-on)\n\n` +
      `- Start: ${startFmt}\n` +
      `- Last AIN: ${lastAin}\n` +
      `- Next cursor: ${nextCursor}\n` +
      `- Valid: ${valids.length}\n` +
      `- Checks: ${checks}\n` +
      `- Stop: ${stopReason}\n` +
      `- Jumps: ${JSON.stringify(batchJumps)}\n` +
      `- Started: ${startedAt.toISOString()}\n` +
      `- Ended: ${endedAt.toISOString()}\n`
  );

  const completed = new Set(cursor.completedRuns || []);
  completed.add(runId);
  const updated = {
    ...cursor,
    donePages: [...donePages].sort(),
    horizonQueue,
    nextCursor,
    algorithm: "perpetual-horizon-v1",
    jumps,
    completedRuns: [...completed],
    [`validCount${runId.replace(/-/g, "")}`]: valids.length,
    lastRunDir: runDir,
    indefinite: true,
    lastAlwaysOnAt: endedAt.toISOString(),
    lastAlwaysOnStop: stopReason,
  };
  writeJson(CURSOR_PATH, updated);
  updateLeftOff(nextCursor, runId, valids.length, checks, stopReason);
  appendStatus(runId, {
    nextCursor,
    valids: valids.length,
    checks,
    stopReason,
    runDir: runDirName,
  });

  if (DO_BUILD) {
    console.log("build:data …");
    const b = runCmd("npm", ["run", "build:data"]);
    if (b.status !== 0) {
      console.warn("build:data failed — archive still saved");
    }
  }

  // Nudge indefinite coords coverage: new valids already carry lat/lon in enrich;
  // also backfill a polite batch of historic AINs still missing coords.
  console.log("coords backfill batch …");
  const cb = runCmd("node", ["scripts/backfill-coords.mjs", "--batch=120", "--no-build"]);
  if (cb.status !== 0 && cb.status !== 2) {
    console.warn("coords backfill batch exited", cb.status);
  } else if (DO_BUILD) {
    // Rebuild again if cache grew (backfill may have skipped build via --no-build)
    const b2 = runCmd("npm", ["run", "build:data"]);
    if (b2.status !== 0) console.warn("build:data (post-coords) failed");
  }

  if (DO_GIT) {
    gitCommitAndPush(runId, nextCursor, valids.length);
  }

  console.log(
    `CYCLE done ${runId} valids=${valids.length} next=${nextCursor} checks=${checks} reason=${stopReason}`
  );
  return {
    runId,
    nextCursor,
    valids: valids.length,
    checks,
    stopReason,
    runDir: runDirName,
  };
}

async function main() {
  if (MODE_LOOP) {
    // Clear stale stop flag so starting always means INDEFINITE resume.
    try {
      if (fs.existsSync(STOP_FLAG)) fs.unlinkSync(STOP_FLAG);
    } catch {
      /* ignore */
    }
    writePid();
    process.on("exit", clearPid);
    process.on("SIGINT", () => {
      clearPid();
      process.exit(0);
    });
    process.on("SIGTERM", () => {
      clearPid();
      process.exit(0);
    });
    console.log(
      `INDEFINITE always-on pid=${process.pid} sleepSec=${SLEEP_SEC} maxChecks=${MAX_CHECKS} ` +
        `(no end time / no midnight / no run cap). Stop: create ${STOP_FLAG} or kill PID.`
    );
    // Literally never exits unless stop flag or process kill.
    for (;;) {
      if (shouldStopIndefinite()) {
        console.log("ALWAYS_ON_STOP flag present — exiting indefinite loop cleanly");
        clearPid();
        try {
          fs.unlinkSync(STOP_FLAG);
        } catch {
          /* ignore */
        }
        process.exit(0);
      }
      try {
        await runCycle();
      } catch (e) {
        if (e && e.code === "ASSESSOR_BLOCKED") {
          console.error("Assessor blocked — sleeping then retrying (INDEFINITE loop never hard-stops)");
        } else {
          console.error("Cycle error (will continue indefinitely):", e);
        }
      }
      if (shouldStopIndefinite()) continue;
      console.log(`sleep ${SLEEP_SEC}s … (indefinite)`);
      // Interruptible sleep — wake early if stop flag appears
      const until = Date.now() + SLEEP_SEC * 1000;
      while (Date.now() < until) {
        if (shouldStopIndefinite()) break;
        await sleep(Math.min(5000, until - Date.now()));
      }
    }
  }

  try {
    const result = await runCycle();
    console.log(JSON.stringify({ ok: true, ...result }));
  } catch (e) {
    if (e && e.code === "ASSESSOR_BLOCKED") {
      console.error(e.message);
      process.exit(2);
    }
    throw e;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
