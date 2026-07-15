#!/usr/bin/env node
/**
 * Backfill LA County Assessor parcel coordinates for every unique AIN
 * in runs/valids and optional web/data/properties.json.
 *
 * Writes state/coords-cache.json keyed by formatted AIN.
 * Polite rate-limit (~50-80ms) — public portal, no scraping of MLS media.
 *
 * Usage:
 *   node scripts/backfill-coords.mjs              # one pass (all pending)
 *   node scripts/backfill-coords.mjs --loop        # INDEFINITE — never exits until stop flag
 *   node scripts/backfill-coords.mjs --batch=100   # process at most N pending AINs then exit
 *   node scripts/backfill-coords.mjs --force
 *   node scripts/backfill-coords.mjs --limit=50    # alias of --batch for smoke tests
 *   node scripts/backfill-coords.mjs --no-build    # skip build:data after progress
 *
 * Stop indefinite loop:
 *   touch state/COORDS_BACKFILL_STOP
 *   or: .\scripts\backfill-coords.ps1 -Stop
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RUNS_DIR = path.join(ROOT, "runs");
const STATE_DIR = path.join(ROOT, "state");
const CACHE_PATH = path.join(STATE_DIR, "coords-cache.json");
const WEB_PROPS = path.join(ROOT, "web", "data", "properties.json");
const PID_PATH = path.join(STATE_DIR, "coords-backfill.pid");
const STOP_FLAG = path.join(STATE_DIR, "COORDS_BACKFILL_STOP");
const STATUS_PATH = path.join(STATE_DIR, "status", "COORDS-BACKFILL.md");

const BASE = "https://portal.assessor.lacounty.gov";
const DELAY_MS = 60;
const SAVE_EVERY = 25;
const RETRIES = 3;
const IDLE_SLEEP_SEC = 120;
const BLOCKED_SLEEP_SEC = 300;
const TRANSIENT_RETRY_MS = 6 * 60 * 60 * 1000; // re-try transient fails after 6h

const args = parseArgs(process.argv.slice(2));
const FORCE = Boolean(args.force);
const MODE_LOOP = Boolean(args.loop);
const DO_BUILD = !args["no-build"];
const BATCH = Number(
  args.batch ?? args.limit ?? 0
); // 0 = unlimited for one pass
const SLEEP_SEC = Number(args["sleep-sec"] ?? IDLE_SLEEP_SEC);

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    if (a === "--force") out.force = true;
    else if (a === "--loop") out.loop = true;
    else if (a === "--no-build") out["no-build"] = true;
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

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
}

function writeJson(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + "\n");
}

function ainDigits(ain) {
  return String(ain || "").replace(/\D/g, "");
}

function formatAin(ain) {
  const d = ainDigits(ain);
  if (d.length === 10) return `${d.slice(0, 4)}-${d.slice(4, 7)}-${d.slice(7, 10)}`;
  return String(ain || "").trim();
}

function stopRequested() {
  return fs.existsSync(STOP_FLAG);
}

function writePid() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(PID_PATH, `${process.pid}\n`);
}

function clearPid() {
  try {
    if (fs.existsSync(PID_PATH)) fs.unlinkSync(PID_PATH);
  } catch {
    /* ignore */
  }
}

function clearStopFlag() {
  try {
    if (fs.existsSync(STOP_FLAG)) fs.unlinkSync(STOP_FLAG);
  } catch {
    /* ignore */
  }
}

function loadValids(runDir) {
  const jsonPath = path.join(runDir, "valids.json");
  if (!fs.existsSync(jsonPath)) return [];
  const raw = readJson(jsonPath);
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw.valids)) return raw.valids;
  if (Array.isArray(raw.properties)) return raw.properties;
  return [];
}

function loadCoordsFromFull(runDir) {
  const out = [];
  for (const name of ["parcels.json", "full.json"]) {
    const fullPath = path.join(runDir, name);
    if (!fs.existsSync(fullPath)) continue;
    let raw;
    try {
      raw = readJson(fullPath);
    } catch {
      continue;
    }
    const list = Array.isArray(raw)
      ? raw
      : Array.isArray(raw?.parcelSnapshots)
        ? raw.parcelSnapshots
        : Array.isArray(raw?.parcels)
          ? raw.parcels
          : [];
    for (const entry of list) {
      const ain = formatAin(entry?.ain);
      const parcel = entry?.parcel || entry;
      if (!ain || !parcel) continue;
      const lat = Number(parcel.Latitude ?? parcel.latitude);
      const lon = Number(parcel.Longitude ?? parcel.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      if (lat === 0 && lon === 0) continue;
      out.push({ ain, latitude: lat, longitude: lon, source: name });
    }
  }
  // Also seed from valids that already carry lat/lon (always-on enrich)
  for (const v of loadValids(runDir)) {
    const ain = formatAin(v?.ain);
    if (!ain) continue;
    const lat = Number(v.latitude);
    const lon = Number(v.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (lat === 0 && lon === 0) continue;
    out.push({ ain, latitude: lat, longitude: lon, source: "valids.json" });
  }
  return out;
}

function collectUniqueAins() {
  const ains = new Set();

  if (fs.existsSync(RUNS_DIR)) {
    for (const folder of fs.readdirSync(RUNS_DIR)) {
      const runDir = path.join(RUNS_DIR, folder);
      if (!fs.statSync(runDir).isDirectory() || !folder.startsWith("RUN-")) continue;
      for (const v of loadValids(runDir)) {
        const ain = formatAin(v?.ain);
        if (ain) ains.add(ain);
      }
    }
  }

  if (fs.existsSync(WEB_PROPS)) {
    try {
      const bundle = readJson(WEB_PROPS);
      for (const p of bundle.properties || []) {
        const ain = formatAin(p?.ain);
        if (ain) ains.add(ain);
      }
    } catch {
      /* ignore */
    }
  }

  return [...ains].sort();
}

function loadCache() {
  if (!fs.existsSync(CACHE_PATH)) {
    return {
      updatedAt: null,
      source: "portal.assessor.lacounty.gov/api/parceldetail",
      coords: {},
    };
  }
  const raw = readJson(CACHE_PATH);
  if (raw && typeof raw === "object" && raw.coords && typeof raw.coords === "object") {
    return raw;
  }
  const coords = {};
  for (const [k, v] of Object.entries(raw || {})) {
    if (k.startsWith("_") || k === "updatedAt" || k === "source") continue;
    if (v && typeof v === "object") coords[formatAin(k)] = v;
  }
  return {
    updatedAt: raw.updatedAt || null,
    source: raw.source || "portal.assessor.lacounty.gov/api/parceldetail",
    coords,
  };
}

function saveCache(cache) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  cache.updatedAt = new Date().toISOString();
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2) + "\n");
}

function hasValidCoords(entry) {
  if (!entry || typeof entry !== "object") return false;
  const lat = Number(entry.latitude);
  const lon = Number(entry.longitude);
  return Number.isFinite(lat) && Number.isFinite(lon) && !(lat === 0 && lon === 0);
}

function isPermanentMiss(entry) {
  if (!entry || hasValidCoords(entry)) return false;
  return entry.error === "no_coords_on_parcel" || entry.error === "bad_ain";
}

function isRetryableMiss(entry) {
  if (!entry || hasValidCoords(entry) || isPermanentMiss(entry)) return false;
  const fetched = Date.parse(entry.fetchedAt || 0);
  if (!Number.isFinite(fetched)) return true;
  return Date.now() - fetched >= TRANSIENT_RETRY_MS;
}

async function fetchParcel(digits) {
  const url = `${BASE}/api/parceldetail?ain=${digits}`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "apn-horizon-sweep-coords-backfill/1.0",
    },
  });
  if (res.status === 429 || res.status === 403) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    err.blocked = true;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function extractCoords(data) {
  const parcel = data?.Parcel;
  if (!parcel) return null;
  const lat = Number(parcel.Latitude ?? parcel.latitude);
  const lon = Number(parcel.Longitude ?? parcel.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat === 0 && lon === 0) return null;
  return { latitude: lat, longitude: lon };
}

async function fetchWithRetry(digits) {
  let lastErr = null;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const data = await fetchParcel(digits);
      if (data?.Error) {
        return { ok: false, error: String(data.Error), blocked: false };
      }
      const coords = extractCoords(data);
      if (!coords) {
        return { ok: false, error: "no_coords_on_parcel", blocked: false };
      }
      return { ok: true, ...coords };
    } catch (e) {
      lastErr = e;
      if (e.blocked) {
        return { ok: false, error: e.message, blocked: true, status: e.status };
      }
      if (attempt < RETRIES) await sleep(DELAY_MS * attempt * 3);
    }
  }
  return {
    ok: false,
    error: lastErr?.message || "fetch_failed",
    blocked: Boolean(lastErr?.blocked),
    status: lastErr?.status,
  };
}

function seedFromRuns(cache) {
  let seeded = 0;
  if (!fs.existsSync(RUNS_DIR)) return 0;
  for (const folder of fs.readdirSync(RUNS_DIR)) {
    const runDir = path.join(RUNS_DIR, folder);
    if (!fs.statSync(runDir).isDirectory() || !folder.startsWith("RUN-")) continue;
    for (const row of loadCoordsFromFull(runDir)) {
      if (!FORCE && hasValidCoords(cache.coords[row.ain])) continue;
      if (!hasValidCoords(cache.coords[row.ain])) {
        cache.coords[row.ain] = {
          latitude: row.latitude,
          longitude: row.longitude,
          source: row.source,
          fetchedAt: new Date().toISOString(),
        };
        seeded += 1;
      }
    }
  }
  return seeded;
}

function pendingQueue(ains, cache) {
  return ains.filter((ain) => {
    if (FORCE) return true;
    const existing = cache.coords[ain];
    if (hasValidCoords(existing)) return false;
    if (isPermanentMiss(existing)) return false;
    if (!existing) return true;
    return isRetryableMiss(existing);
  });
}

function coverageStats(ains, cache) {
  let withCoords = 0;
  let permanentMiss = 0;
  let transient = 0;
  let unknown = 0;
  for (const ain of ains) {
    const e = cache.coords[ain];
    if (hasValidCoords(e)) withCoords += 1;
    else if (isPermanentMiss(e)) permanentMiss += 1;
    else if (e) transient += 1;
    else unknown += 1;
  }
  return { total: ains.length, withCoords, permanentMiss, transient, unknown };
}

function writeStatus(stats, passInfo) {
  const lines = [
    "# COORDS BACKFILL",
    "",
    `**Updated:** ${new Date().toISOString()}`,
    `**Mode:** ${MODE_LOOP ? "indefinite-loop" : BATCH > 0 ? `batch-${BATCH}` : "one-pass"}`,
    "",
    "## Coverage (unique archive AINs)",
    "",
    `| Metric | Count |`,
    `|---|---:|`,
    `| Unique AINs | ${stats.total} |`,
    `| With coords | ${stats.withCoords} |`,
    `| Permanent miss (no lat/lon on parcel) | ${stats.permanentMiss} |`,
    `| Transient / retry later | ${stats.transient} |`,
    `| Not yet fetched | ${stats.unknown} |`,
    "",
    passInfo ? `## Last pass\n\n${passInfo}\n` : "",
    "Stop: `state/COORDS_BACKFILL_STOP` or `.\scripts\\backfill-coords.ps1 -Stop`",
    "",
  ];
  fs.mkdirSync(path.dirname(STATUS_PATH), { recursive: true });
  fs.writeFileSync(STATUS_PATH, lines.join("\n"));
}

function runBuildData() {
  if (!DO_BUILD) return;
  console.log("build:data …");
  const b = spawnSync("npm", ["run", "build:data"], {
    cwd: ROOT,
    encoding: "utf8",
    shell: true,
  });
  if (b.status !== 0) {
    console.warn("build:data failed — cache still saved");
    if (b.stderr) console.warn(b.stderr.slice(0, 500));
  }
}

/**
 * One backfill pass. Returns { ok, miss, fail, blocked, done, remaining, stats }.
 */
async function runPass() {
  const ains = collectUniqueAins();
  const cache = loadCache();
  if (!cache.coords) cache.coords = {};

  const seeded = seedFromRuns(cache);
  if (seeded) {
    saveCache(cache);
    console.log(`Seeded ${seeded} AINs from runs (full/parcels/valids)`);
  }

  let toFetch = pendingQueue(ains, cache);
  if (BATCH > 0) toFetch = toFetch.slice(0, BATCH);

  const before = coverageStats(ains, cache);
  console.log(
    `Unique AINs: ${ains.length} · with coords: ${before.withCoords} · pending this pass: ${toFetch.length}`
  );

  let ok = 0;
  let miss = 0;
  let fail = 0;
  let blocked = 0;
  let done = 0;

  for (const ain of toFetch) {
    if (stopRequested()) {
      console.log("\nStop flag seen — ending pass.");
      break;
    }

    const digits = ainDigits(ain);
    if (digits.length !== 10) {
      cache.coords[ain] = {
        latitude: null,
        longitude: null,
        error: "bad_ain",
        fetchedAt: new Date().toISOString(),
      };
      miss += 1;
      done += 1;
      continue;
    }

    const result = await fetchWithRetry(digits);
    const fetchedAt = new Date().toISOString();

    if (result.ok) {
      cache.coords[ain] = {
        latitude: result.latitude,
        longitude: result.longitude,
        source: "assessor-api",
        fetchedAt,
      };
      ok += 1;
    } else if (result.blocked) {
      blocked += 1;
      fail += 1;
      console.warn(`\nBLOCKED ${ain}: ${result.error} — backing off.`);
      saveCache(cache);
      break;
    } else {
      cache.coords[ain] = {
        latitude: null,
        longitude: null,
        error: result.error || "unknown",
        fetchedAt,
      };
      if (result.error === "no_coords_on_parcel") miss += 1;
      else fail += 1;
    }

    done += 1;
    if (done % SAVE_EVERY === 0) {
      saveCache(cache);
      process.stdout.write(
        `\r  progress ${done}/${toFetch.length} · ok=${ok} miss=${miss} fail=${fail} blocked=${blocked}   `
      );
    }

    await sleep(DELAY_MS);
  }

  saveCache(cache);
  const afterAins = collectUniqueAins();
  const stats = coverageStats(afterAins, cache);
  const remaining = pendingQueue(afterAins, cache).length;
  const passInfo =
    `fetched_ok=${ok} no_coords=${miss} fail=${fail} blocked=${blocked} remaining_pending=${remaining}`;
  writeStatus(stats, passInfo);

  console.log(`\nPass done. ${passInfo}`);
  console.log(
    `Coverage: ${stats.withCoords}/${stats.total} with coords` +
      ` (${stats.permanentMiss} permanent miss, ${stats.transient + stats.unknown} still open)`
  );

  if (ok > 0 || seeded > 0) runBuildData();

  return { ok, miss, fail, blocked, done, remaining, stats, seeded };
}

async function main() {
  if (MODE_LOOP) {
    writePid();
    clearStopFlag();
    const cleanup = () => {
      clearPid();
    };
    process.on("exit", cleanup);
    process.on("SIGINT", () => {
      cleanup();
      process.exit(0);
    });
    process.on("SIGTERM", () => {
      cleanup();
      process.exit(0);
    });

    console.log(
      `COORDS BACKFILL indefinite loop pid=${process.pid} sleepSec=${SLEEP_SEC} delay=${DELAY_MS}ms`
    );
    console.log(`Stop: create ${STOP_FLAG} or .\\scripts\\backfill-coords.ps1 -Stop`);

    while (true) {
      if (stopRequested()) {
        console.log("Stop flag present — exiting indefinite loop.");
        clearStopFlag();
        clearPid();
        break;
      }

      let result;
      try {
        result = await runPass();
      } catch (e) {
        console.error("Pass error:", e);
        result = { blocked: 0, remaining: 1, ok: 0 };
      }

      if (stopRequested()) {
        console.log("Stop flag after pass — exiting.");
        clearStopFlag();
        clearPid();
        break;
      }

      // Indefinite: never exit because coverage is "done" — sleep and rescan
      // for new run AINs forever.
      let wait = SLEEP_SEC;
      if (result.blocked) wait = BLOCKED_SLEEP_SEC;
      else if (result.remaining === 0) {
        console.log(
          "Caught up on known AINs — sleeping then rescanning for new archive parcels (indefinite)."
        );
        wait = SLEEP_SEC;
      } else {
        // More pending: short pause then continue immediately
        wait = Math.min(15, SLEEP_SEC);
      }

      console.log(`sleep ${wait}s …`);
      await sleep(wait * 1000);
    }
    return;
  }

  // One-shot / batch mode
  const result = await runPass();
  if (result.blocked) process.exitCode = 2;
}

main().catch((e) => {
  console.error(e);
  clearPid();
  process.exit(1);
});
