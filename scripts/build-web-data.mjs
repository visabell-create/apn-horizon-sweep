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
const BY_CITY_DIR = path.join(OUT_DIR, "by-city");

const SECRET_RE =
  /(api[_-]?key|access[_-]?token|bearer\s+[a-z0-9._-]{20,}|sk-[a-z0-9]{20,}|ghp_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|xox[baprs]-[a-z0-9-]{20,})/i;

function scrubString(value) {
  if (typeof value !== "string") return value;
  if (SECRET_RE.test(value)) return "[redacted]";
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
  return fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
}

function readJson(filePath) {
  return JSON.parse(readText(filePath));
}

function titleCaseCity(raw) {
  return String(raw)
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Derive city / neighborhood area from situs address text.
 * Prefer explicit city tokens; never invent a city from APN alone.
 */
function extractPlace(address) {
  const addr = String(address || "").trim();
  if (!addr || addr === "," || /^vacant\s+land$/i.test(addr)) {
    return { city: "Unlabeled situs", area: null };
  }

  const upper = addr.toUpperCase();
  let area = null;
  if (/\bCOVINA\s+HILLS\b/.test(upper)) area = "Covina Hills";

  let m = addr.match(
    /,\s*([A-Za-z][A-Za-z.'\s]+?)\s+(?:CA|CALIF)(?:\s+\d{5}(?:-\d{4})?)?\s*$/i
  );
  if (m) return { city: titleCaseCity(m[1]), area };

  m = addr.match(/,\s*([A-Za-z][A-Za-z.'\s]+?)\s+\d{5}(?:-\d{4})?\s*$/i);
  if (m) return { city: titleCaseCity(m[1]), area };

  m = addr.match(/,\s*([A-Za-z][A-Za-z.'\s]{1,40}?)\s*$/);
  if (m) {
    const candidate = m[1].trim();
    if (!/^(RD|ST|AVE|DR|LN|CT|BLVD|WAY)$/i.test(candidate)) {
      return { city: titleCaseCity(candidate), area };
    }
  }

  m = addr.match(/\b(SAN DIMAS|COVINA|LA VERNE|GLENDORA|POMONA|CLAREMONT)\b/i);
  if (m) return { city: titleCaseCity(m[1]), area };

  return { city: "Unlabeled situs", area };
}

function citySlug(city) {
  return String(city)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "unlabeled";
}

function slimOwnership(entries) {
  if (!Array.isArray(entries) || !entries.length) return [];
  return entries.slice(0, 12).map((e) =>
    scrubDeep({
      rec: e.rec ?? "",
      doc: e.doc ?? "",
      price: e.price ?? "",
      assessed: e.assessed ?? "",
      docType: e.docType ?? "",
      reason: e.reason ?? "",
    })
  );
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

/** Load assessor parcel coords from full.json (Longitude/Latitude on Parcel). */
function loadCoordsFromFull(runDir) {
  const fullPath = path.join(runDir, "full.json");
  if (!fs.existsSync(fullPath)) return new Map();
  let raw;
  try {
    raw = readJson(fullPath);
  } catch {
    return new Map();
  }
  const list = Array.isArray(raw) ? raw : [];
  const map = new Map();
  for (const entry of list) {
    const ain = entry?.ain;
    const parcel = entry?.parcel;
    if (!ain || !parcel) continue;
    const lat = parcel.Latitude ?? parcel.latitude ?? null;
    const lon = parcel.Longitude ?? parcel.longitude ?? null;
    const latN = lat != null && lat !== "" ? Number(lat) : NaN;
    const lonN = lon != null && lon !== "" ? Number(lon) : NaN;
    if (!Number.isFinite(latN) || !Number.isFinite(lonN)) continue;
    if (latN === 0 && lonN === 0) continue;
    map.set(ain, { latitude: latN, longitude: lonN });
  }
  return map;
}

function slimProperty(rec, runId, coords = null) {
  const lastBuy = rec.lastBuy
    ? {
        rec: rec.lastBuy.rec ?? "",
        price: rec.lastBuy.price ?? "",
        doc: rec.lastBuy.doc ?? "",
        docType: rec.lastBuy.docType ?? "",
        reason: rec.lastBuy.reason ?? "",
        assessed: rec.lastBuy.assessed ?? "",
      }
    : null;

  const { city, area } = extractPlace(rec.address);
  const ownerKnown =
    typeof rec.ownerKnown === "string" && rec.ownerKnown.trim()
      ? rec.ownerKnown.trim()
      : null;

  return scrubDeep({
    ain: rec.ain ?? "",
    address: rec.address ?? "",
    city,
    area,
    useType: rec.useType ?? "",
    parcelStatus: rec.parcelStatus ?? "",
    taxStatus: rec.taxStatus ?? "",
    yearDefaulted: rec.yearDefaulted ?? "",
    yearBuilt: rec.yearBuilt ?? "",
    beds: rec.beds ?? null,
    baths: rec.baths ?? null,
    bldg: rec.bldg ?? null,
    lot: rec.lot ?? null,
    units: rec.units ?? null,
    assessed: rec.assessed ?? null,
    land: rec.land ?? null,
    imp: rec.imp ?? null,
    baseYearLand: rec.baseYearLand ?? null,
    baseYearImp: rec.baseYearImp ?? null,
    ownerKnown,
    latitude: coords?.latitude ?? null,
    longitude: coords?.longitude ?? null,
    ownership: slimOwnership(rec.ownership),
    lastBuy,
    market: rec.market ?? null,
    hasForeclosureHist: Boolean(rec.hasForeclosureHist),
    fcNote: rec.fcNote ?? null,
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

function dominantCities(props) {
  const counts = new Map();
  for (const p of props) {
    const c = p.city || "Unlabeled situs";
    counts.set(c, (counts.get(c) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([city, count]) => ({ city, count, slug: citySlug(city) }));
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(BY_CITY_DIR, { recursive: true });

  const runFolders = fs
    .readdirSync(RUNS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith("RUN-"))
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  /** Global AIN → coords from any run's full.json (latest folder wins on conflict). */
  const globalCoordIndex = new Map();
  for (const folder of runFolders) {
    const idx = loadCoordsFromFull(path.join(RUNS_DIR, folder));
    for (const [ain, coords] of idx) globalCoordIndex.set(ain, coords);
  }

  const runs = [];
  const properties = [];
  const seenAin = new Map();
  const cityBucket = new Map(); // city -> property rows

  for (const folder of runFolders) {
    const runDir = path.join(RUNS_DIR, folder);
    const summaryPath = path.join(runDir, "summary.md");
    const summary = fs.existsSync(summaryPath)
      ? parseSummary(readText(summaryPath))
      : {};

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
    const slim = valids.map((v) => slimProperty(v, folder, globalCoordIndex.get(v.ain) || null));
    const range = parseRange(summary, valids);
    const jumps = Array.isArray(summary.jumps) ? summary.jumps : [];
    const cities = dominantCities(slim);

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
      cities,
      primaryCity: cities[0]?.city || "Unlabeled situs",
    });

    runs.push(runMeta);

    for (const p of slim) {
      if (!p.ain) continue;
      const dup = seenAin.has(p.ain);
      if (!dup) seenAin.set(p.ain, folder);
      const row = {
        ...p,
        duplicate: dup,
        firstSeenIn: seenAin.get(p.ain),
      };
      properties.push(row);

      const key = p.city || "Unlabeled situs";
      if (!cityBucket.has(key)) cityBucket.set(key, []);
      cityBucket.get(key).push(row);
    }

    fs.writeFileSync(
      path.join(OUT_DIR, `run-${folder}.json`),
      JSON.stringify({ run: runMeta, properties: slim }, null, 0)
    );
  }

  let cursor = null;
  const cursorPath = path.join(STATE_DIR, "cursor.json");
  if (fs.existsSync(cursorPath)) {
    cursor = scrubDeep(readJson(cursorPath));
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
  const withCoords = properties.filter((p) => p.latitude != null && p.longitude != null).length;
  const builtAt = new Date().toISOString();

  const citiesIndex = [...cityBucket.entries()]
    .map(([city, rows]) => {
      const unique = new Set(rows.map((r) => r.ain)).size;
      const areas = new Map();
      for (const r of rows) {
        if (r.area) areas.set(r.area, (areas.get(r.area) || 0) + 1);
      }
      return {
        city,
        slug: citySlug(city),
        propertyRowCount: rows.length,
        uniqueAinCount: unique,
        areas: [...areas.entries()].map(([name, count]) => ({ name, count })),
      };
    })
    .sort((a, b) => b.propertyRowCount - a.propertyRowCount);

  // Clear and rewrite by-city indexes (index layer only — original runs/ untouched)
  for (const f of fs.readdirSync(BY_CITY_DIR)) {
    fs.unlinkSync(path.join(BY_CITY_DIR, f));
  }

  for (const cityInfo of citiesIndex) {
    const rows = cityBucket.get(cityInfo.city) || [];
    fs.writeFileSync(
      path.join(BY_CITY_DIR, `${cityInfo.slug}.json`),
      JSON.stringify(
        {
          builtAt,
          city: cityInfo.city,
          slug: cityInfo.slug,
          count: rows.length,
          uniqueAinCount: cityInfo.uniqueAinCount,
          areas: cityInfo.areas,
          properties: rows,
        },
        null,
        0
      )
    );
  }

  fs.writeFileSync(
    path.join(BY_CITY_DIR, "index.json"),
    JSON.stringify({ builtAt, cities: citiesIndex }, null, 2)
  );

  const runsIndex = {
    builtAt,
    runCount: runs.length,
    propertyRowCount: properties.length,
    uniqueAinCount: uniqueValids,
    propertyWithCoordsCount: withCoords,
    nextCursor: cursor?.nextCursor ?? null,
    donePageCount: Array.isArray(cursor?.donePages) ? cursor.donePages.length : 0,
    jumps: cursor?.jumps ?? [],
    cities: citiesIndex,
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

  const propertiesBundle = {
    builtAt,
    count: properties.length,
    uniqueAinCount: uniqueValids,
    propertyWithCoordsCount: withCoords,
    cities: citiesIndex,
    properties,
  };

  fs.writeFileSync(path.join(OUT_DIR, "runs-index.json"), JSON.stringify(runsIndex, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, "state.json"), JSON.stringify(stateBundle, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, "properties.json"), JSON.stringify(propertiesBundle, null, 0));

  for (const f of fs.readdirSync(OUT_DIR)) {
    if (!f.startsWith("run-") || !f.endsWith(".json")) continue;
    const id = f.slice(4, -5);
    if (!runFolders.includes(id)) fs.unlinkSync(path.join(OUT_DIR, f));
  }

  console.log(`Built web/data/ from ${runs.length} runs`);
  console.log(`  property rows: ${properties.length} (${uniqueValids} unique AINs, ${withCoords} with coords)`);
  console.log(`  cities: ${citiesIndex.map((c) => `${c.city}=${c.propertyRowCount}`).join(", ")}`);
  console.log(`  nextCursor: ${runsIndex.nextCursor}`);
  console.log(`  donePages: ${runsIndex.donePageCount}`);
  console.log(`  output: ${OUT_DIR}`);
}

main();
