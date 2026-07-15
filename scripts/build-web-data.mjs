#!/usr/bin/env node
/**
 * Build static JSON for the Horizon Sweep web app from runs/ + state/.
 * Usage: npm run build:data
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RUNS_DIR = path.join(ROOT, "runs");
const STATE_DIR = path.join(ROOT, "state");
const OUT_DIR = path.join(ROOT, "web", "data");

const SECRET_RE =
  /(api[_-]?key|access[_-]?token|bearer\s+[a-z0-9._-]{20,}|sk-[a-z0-9]{20,}|ghp_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|xox[baprs]-[a-z0-9-]{20,})/i;

function scrubString(value) {
  if (typeof value !== "string") return value;
  if (SECRET_RE.test(value)) return "[redacted]";
  // Strip absolute local paths that leak usernames
  return value.replace(/[A-Za-z]:\\Users\\[^\\]+\\/gi, "~/");
}

function scrubDeep(value) {
  if (value == null) return value;
  if (typeof value === "string") return scrubString(value);
  if (Array.isArray(value)) return value.map(scrubDeep);
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (/token|password|secret|authorization/i.test(k) && typeof v === "string") {
        out[k] = "[redacted]";
      } else {
        out[k] = scrubDeep(v);
      }
    }
    return out;
  }
  return value;
}

function readText(filePath) {
  // Strip UTF-8 BOM if present (some archived valids.json files include it)
  return fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
}

function readJson(filePath) {
  return JSON.parse(readText(filePath));
}

function parseSummary(md) {
  const meta = {};
  const lines = md.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^-?\s*\*?\*?([^:]+)\*?\*?:\s*(.+)$/);
    if (!m) continue;
    const key = m[1].trim().toLowerCase();
    const val = m[2].trim();
    if (key === "start" || key.startsWith("start")) meta.start = val;
    else if (key.startsWith("last ain") || key === "last ain") meta.lastAin = val;
    else if (key.startsWith("next cursor") || key === "next cursor") meta.nextCursor = val;
    else if (key === "valid" || key.startsWith("valid")) {
      const n = parseInt(val.replace(/[^\d]/g, ""), 10);
      if (!Number.isNaN(n)) meta.validCount = n;
    } else if (key === "checks" || key.startsWith("checks")) {
      const n = parseInt(val.replace(/[^\d]/g, ""), 10);
      if (!Number.isNaN(n)) meta.checks = n;
    } else if (key === "stop" || key.startsWith("stop")) meta.stop = val;
    else if (key === "jumps" || key.startsWith("jumps")) {
      try {
        meta.jumps = JSON.parse(val);
      } catch {
        meta.jumpsRaw = val;
      }
    } else if (key === "started" || key.startsWith("started")) meta.started = val;
    else if (key === "ended" || key === "finished" || key.startsWith("ended") || key.startsWith("finished")) {
      meta.ended = val;
    } else if (key.startsWith("total valids")) {
      const n = parseInt(val.replace(/[^\d]/g, ""), 10);
      if (!Number.isNaN(n)) meta.validCount = n;
    }
  }
  // Title from first heading
  const title = lines.find((l) => l.startsWith("# "));
  if (title) meta.title = title.replace(/^#\s+/, "").trim();
  return meta;
}

function classifyStream(folderName) {
  if (/^RUN-B-/i.test(folderName)) return "parallel-midnight-B";
  if (/^RUN-A/i.test(folderName)) return "parallel-A";
  if (/^RUN-\d+/i.test(folderName)) return "serial";
  return "other";
}

function extractDate(folderName, summary) {
  const m = folderName.match(/(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  if (summary.started) {
    const d = Date.parse(summary.started);
    if (!Number.isNaN(d)) return new Date(d).toISOString().slice(0, 10);
  }
  if (summary.ended) {
    const d = Date.parse(summary.ended);
    if (!Number.isNaN(d)) return new Date(d).toISOString().slice(0, 10);
  }
  return null;
}

function slimProperty(rec, runId) {
  const lastBuy = rec.lastBuy
    ? {
        rec: rec.lastBuy.rec ?? "",
        price: rec.lastBuy.price ?? "",
        doc: rec.lastBuy.doc ?? "",
      }
    : null;

  return scrubDeep({
    ain: rec.ain ?? "",
    address: rec.address ?? "",
    useType: rec.useType ?? "",
    parcelStatus: rec.parcelStatus ?? "",
    taxStatus: rec.taxStatus ?? "",
    yearBuilt: rec.yearBuilt ?? "",
    beds: rec.beds ?? null,
    baths: rec.baths ?? null,
    assessed: rec.assessed ?? null,
    lastBuy,
    hasForeclosureHist: Boolean(rec.hasForeclosureHist),
    status: rec.status ?? "VALID",
    runId,
  });
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

function parseRange(summary, valids) {
  let start = summary.start || null;
  let end = summary.lastAin || null;
  if (!start && valids.length) start = valids[0].ain || null;
  if (!end && valids.length) end = valids[valids.length - 1].ain || null;
  return { start, end };
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const runFolders = fs
    .readdirSync(RUNS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith("RUN-"))
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  const runs = [];
  const properties = [];
  const seenAin = new Map(); // ain -> first runId (for dedup note)

  for (const folder of runFolders) {
    const runDir = path.join(RUNS_DIR, folder);
    const summaryPath = path.join(runDir, "summary.md");
    const summary = fs.existsSync(summaryPath)
      ? parseSummary(readText(summaryPath))
      : {};

    // Prefer summary.json if present
    const summaryJsonPath = path.join(runDir, "summary.json");
    if (fs.existsSync(summaryJsonPath)) {
      try {
        const sj = readJson(summaryJsonPath);
        if (sj.validCount != null) summary.validCount = sj.validCount;
        if (sj.nextCursor) summary.nextCursor = sj.nextCursor;
        if (sj.start) summary.start = sj.start;
        if (sj.lastAin) summary.lastAin = sj.lastAin;
        if (sj.jumps) summary.jumps = sj.jumps;
        if (sj.stop) summary.stop = sj.stop;
      } catch {
        /* ignore */
      }
    }

    const valids = loadValids(runDir);
    const slim = valids.map((v) => slimProperty(v, folder));
    const range = parseRange(summary, valids);
    const jumps = Array.isArray(summary.jumps) ? summary.jumps : [];

    const runMeta = scrubDeep({
      id: folder,
      title: summary.title || folder,
      stream: classifyStream(folder),
      date: extractDate(folder, summary),
      validCount: summary.validCount ?? slim.length,
      checks: summary.checks ?? null,
      start: range.start,
      end: range.end,
      nextCursor: summary.nextCursor || null,
      stop: summary.stop || null,
      jumps: jumps.map((j) => scrubDeep(j)),
      started: summary.started || null,
      ended: summary.ended || null,
      isAggregate: /aggregate/i.test(folder),
    });

    runs.push(runMeta);

    for (const p of slim) {
      if (!p.ain) continue;
      const dup = seenAin.has(p.ain);
      if (!dup) seenAin.set(p.ain, folder);
      properties.push({
        ...p,
        duplicate: dup,
        firstSeenIn: seenAin.get(p.ain),
      });
    }

    // Per-run properties file for optional lazy load (also used as backup)
    fs.writeFileSync(
      path.join(OUT_DIR, `run-${folder}.json`),
      JSON.stringify({ run: runMeta, properties: slim }, null, 0)
    );
  }

  // State
  let cursor = null;
  const cursorPath = path.join(STATE_DIR, "cursor.json");
  if (fs.existsSync(cursorPath)) {
    cursor = scrubDeep(readJson(cursorPath));
    // Remove local absolute paths
    if (cursor.lastRunDir) cursor.lastRunDir = scrubString(String(cursor.lastRunDir));
  }

  let leftOff = null;
  const leftOffPath = path.join(STATE_DIR, "LEFT_OFF.md");
  if (fs.existsSync(leftOffPath)) {
    leftOff = scrubString(readText(leftOffPath));
  }

  const statusNotes = [];
  const statusDir = path.join(STATE_DIR, "status");
  if (fs.existsSync(statusDir)) {
    for (const f of fs.readdirSync(statusDir).sort()) {
      if (!/\.(md|txt)$/i.test(f)) continue;
      // Prefer merge/stop highlights; cap size
      const full = path.join(statusDir, f);
      const text = scrubString(readText(full));
      statusNotes.push({
        id: f,
        excerpt: text.slice(0, 2500),
      });
    }
  }

  let indexMd = null;
  const indexPath = path.join(RUNS_DIR, "INDEX.md");
  if (fs.existsSync(indexPath)) indexMd = scrubString(readText(indexPath));

  const uniqueValids = [...seenAin.keys()].length;
  const builtAt = new Date().toISOString();

  const runsIndex = {
    builtAt,
    runCount: runs.length,
    propertyRowCount: properties.length,
    uniqueAinCount: uniqueValids,
    nextCursor: cursor?.nextCursor ?? null,
    donePageCount: Array.isArray(cursor?.donePages) ? cursor.donePages.length : 0,
    jumps: cursor?.jumps ?? [],
    runs,
    indexMarkdown: indexMd,
  };

  const stateBundle = {
    builtAt,
    cursor,
    leftOffMarkdown: leftOff,
    statusNotes: statusNotes.filter((n) =>
      /MIDNIGHT|MERGE|LEFT|CURSOR|STOP/i.test(n.id)
    ),
  };

  // Combined properties (slim) — ~manageable for static hosting
  const propertiesBundle = {
    builtAt,
    count: properties.length,
    uniqueAinCount: uniqueValids,
    properties,
  };

  fs.writeFileSync(path.join(OUT_DIR, "runs-index.json"), JSON.stringify(runsIndex, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, "state.json"), JSON.stringify(stateBundle, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, "properties.json"), JSON.stringify(propertiesBundle, null, 0));

  // Clean stale per-run files for deleted runs
  for (const f of fs.readdirSync(OUT_DIR)) {
    if (!f.startsWith("run-") || !f.endsWith(".json")) continue;
    const id = f.slice(4, -5);
    if (!runFolders.includes(id)) fs.unlinkSync(path.join(OUT_DIR, f));
  }

  console.log(`Built web/data/ from ${runs.length} runs`);
  console.log(`  property rows: ${properties.length} (${uniqueValids} unique AINs)`);
  console.log(`  nextCursor: ${runsIndex.nextCursor}`);
  console.log(`  donePages: ${runsIndex.donePageCount}`);
  console.log(`  output: ${OUT_DIR}`);
}

main();
