const PAGE_SIZE = 40;

const state = {
  runs: [],
  properties: [],
  cities: [],
  cityFilter: "all",
  streamFilter: "all",
  runFilter: "all",
  search: "",
  uniqueOnly: false,
  page: 1,
  selectedRun: null,
  selectedPropKey: null,
};

const $ = (sel) => document.querySelector(sel);

function money(n) {
  if (n == null || n === "") return null;
  const num = typeof n === "string" ? Number(String(n).replace(/[^\d.-]/g, "")) : Number(n);
  if (Number.isNaN(num)) return null;
  return num;
}

function moneyFmt(n) {
  const num = money(n);
  if (num == null) return "Not in archive";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(num);
}

function numFmt(n) {
  if (n == null || n === "") return "Not in archive";
  const num = Number(n);
  if (Number.isNaN(num)) return String(n);
  return num.toLocaleString();
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function missing(text = "Not in archive") {
  return `<span class="muted">${escapeHtml(text)}</span>`;
}

/* —— Human-readable labels (always visible, not tooltip-only) —— */

function streamLabel(stream) {
  if (stream === "serial") return "Serial walk";
  if (stream === "parallel-A") return "Parallel fleet run";
  if (stream === "parallel-midnight-B") return "Midnight fleet (parallel B)";
  if (!stream || stream === "unknown" || stream === "other") return "Walk style not classified";
  return String(stream);
}

function streamClass(stream) {
  if (stream === "serial") return "stream-serial";
  if (stream === "parallel-A") return "stream-parallel-A";
  if (stream === "parallel-midnight-B") return "stream-parallel-midnight-B";
  return "stream-other";
}

function jumpReasonLabel(reason) {
  const r = String(reason || "").toUpperCase();
  if (r === "SOFT_JUMP") return "Soft jump — skipped ahead after empty-AIN streak";
  if (r === "JUMP" || r === "HARD_JUMP") return "Hard jump — cursor relocated";
  if (!r || r === "UNKNOWN") return "Jump reason not recorded";
  return reason;
}

function useLabel(useType) {
  if (!useType) return { label: "Use type not in archive", code: null };
  const u = String(useType).trim();
  const map = {
    "Single Family Residence": "SFR — single-family home",
    "Vacant Land": "Vacant land",
    Commercial: "Commercial property",
    Industrial: "Industrial property",
    Institutional: "Institutional property",
    "Multi-Family Residence": "Multi-family residence",
    "Other Property Type": "Other property type",
  };
  return { label: map[u] || u, code: u };
}

function taxLabel(taxStatus, yearDefaulted) {
  const t = String(taxStatus || "").toUpperCase().trim();
  if (!t) return { label: "Tax status not in archive", tone: "mute", code: null };
  if (t === "CURRENT") {
    return { label: "Tax current", tone: "ok", code: "CURRENT" };
  }
  if (t === "DELINQUENT") {
    const yd = yearDefaulted && String(yearDefaulted).trim() ? ` · year noted ${yearDefaulted}` : "";
    return { label: `Tax delinquent${yd}`, tone: "warn", code: "DELINQUENT" };
  }
  if (t === "DEFAULTED") {
    const yd = yearDefaulted && String(yearDefaulted).trim() ? ` · default year ${yearDefaulted}` : "";
    return { label: `Tax defaulted${yd}`, tone: "bad", code: "DEFAULTED" };
  }
  if (t === "EXEMPT") return { label: "Tax exempt", tone: "mute", code: "EXEMPT" };
  if (t === "UNKNOWN") return { label: "Tax status unknown (archive)", tone: "mute", code: "UNKNOWN" };
  return { label: `Tax: ${taxStatus}`, tone: "mute", code: taxStatus };
}

function parcelLabel(parcelStatus) {
  const p = String(parcelStatus || "").toUpperCase().trim();
  if (!p) return { label: "Parcel status not in archive", code: null };
  if (p === "ACTIVE") return { label: "Parcel active", code: "ACTIVE" };
  if (p === "DELETED") return { label: "Parcel deleted / inactive", code: "DELETED" };
  if (p === "UNKNOWN") return { label: "Parcel status unknown (archive)", code: "UNKNOWN" };
  return { label: `Parcel: ${parcelStatus}`, code: parcelStatus };
}

function marketLabel(market) {
  if (market == null || market === "") {
    return { label: "Market status not in archive", tone: "mute", code: null };
  }
  const m = String(market).trim();
  const upper = m.toUpperCase();
  if (upper === "OFF_MARKET") return { label: "Off market", tone: "mute", code: "OFF_MARKET" };
  if (upper === "FOR_SALE" || upper === "LISTED") return { label: "For sale / listed", tone: "warn", code: m };
  if (upper.startsWith("LISTED") || upper.includes("MLS")) {
    return { label: "Listed or recently off-market (MLS note)", tone: "warn", code: m };
  }
  if (upper === "UNKNOWN") return { label: "Market status unknown (archive)", tone: "mute", code: "UNKNOWN" };
  return { label: m, tone: "mute", code: m };
}

function foreclosureLabel(p) {
  if (p.hasForeclosureHist) {
    const note = p.fcNote ? String(p.fcNote) : null;
    return {
      label: "Past foreclosure history",
      detail: note,
      imminent: false,
      tone: "warn",
    };
  }
  // Only claim imminent if archive has an explicit field/signal (none present in current data)
  if (p.foreclosureImminent === true || p.imminentForeclosure === true) {
    return {
      label: "Imminent foreclosure signal in archive",
      detail: p.fcNote || null,
      imminent: true,
      tone: "bad",
    };
  }
  return {
    label: "No foreclosure history in archive",
    detail: null,
    imminent: false,
    tone: "mute",
  };
}

function assessorGap(p) {
  const assessed = money(p.assessed);
  const buy = money(p.lastBuy?.price);
  if (assessed == null || buy == null || buy === 0) {
    return { text: "Can't estimate", tip: "Need both assessed value and last-buy price" };
  }
  const gap = assessed - buy;
  const fmt = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
    signDisplay: "exceptZero",
  }).format(gap);
  return {
    text: fmt,
    tip: "Assessor gap (not true equity) — assessed − last buy price",
  };
}

function ownerDisplay(p) {
  if (p.ownerKnown && String(p.ownerKnown).trim()) {
    return { text: String(p.ownerKnown).trim(), known: true };
  }
  return { text: "Owner not in public assessor archive", known: false };
}

function hasCoords(p) {
  const lat = Number(p.latitude);
  const lon = Number(p.longitude);
  return Number.isFinite(lat) && Number.isFinite(lon) && !(lat === 0 && lon === 0);
}

function ainDigits(ain) {
  return String(ain || "").replace(/\D/g, "");
}

function mapsAddressQuery(p) {
  const addr = p.address && p.address !== "," ? p.address.trim() : "";
  if (addr) return addr;
  if (p.city && p.city !== "Unlabeled situs") return `${p.city}, CA`;
  return "";
}

function googleMapsUrl(p) {
  if (hasCoords(p)) {
    return `https://www.google.com/maps/search/?api=1&query=${p.latitude},${p.longitude}`;
  }
  const q = mapsAddressQuery(p);
  if (q) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
  const ain = ainDigits(p.ain);
  if (ain) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(ain)}`;
  return null;
}

function streetViewEmbedUrl(p) {
  if (!hasCoords(p)) return null;
  return `https://www.google.com/maps?q=&layer=c&cbll=${p.latitude},${p.longitude}&cbp=11,0,0,0,0&output=svembed`;
}

function streetViewLinkUrl(p) {
  if (!hasCoords(p)) return null;
  return `https://www.google.com/maps?layer=c&cbll=${p.latitude},${p.longitude}`;
}

function latLonToTile(lat, lon, zoom) {
  const z = zoom;
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return { x, y, z };
}

function esriSatelliteTileUrl(lat, lon, zoom = 18) {
  const { x, y, z } = latLonToTile(lat, lon, zoom);
  return `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
}

function assessorParcelUrl(p) {
  const digits = ainDigits(p.ain);
  if (!digits) return "https://portal.assessor.lacounty.gov/";
  return `https://portal.assessor.lacounty.gov/parceldetail/${digits}`;
}

function recorderSearchUrl(p) {
  const doc = p.lastBuy?.doc && String(p.lastBuy.doc).trim();
  if (doc) {
    return `https://lavote.gov/home/records/property-document-recording/document-search?search=${encodeURIComponent(doc)}`;
  }
  return "https://lavote.gov/home/records/property-document-recording/document-search";
}

function zillowUrl(p) {
  const q = mapsAddressQuery(p);
  if (!q) return null;
  return `https://www.zillow.com/homes/${encodeURIComponent(q.replace(/\s+/g, "-"))}_rb/`;
}

function redfinUrl(p) {
  const q = mapsAddressQuery(p);
  if (!q) return null;
  return `https://www.redfin.com/stingray/do/location-search?location=${encodeURIComponent(q)}`;
}

function realtorUrl(p) {
  const q = mapsAddressQuery(p);
  if (!q) return null;
  return `https://www.realtor.com/realestateandhomes-search?search=${encodeURIComponent(q)}`;
}

/** Google Maps pin + Street View when coords exist; else address search. */
function publicSearchUrl(p) {
  if (hasCoords(p)) {
    return `https://www.google.com/maps?layer=c&cbll=${p.latitude},${p.longitude}&cbp=11,0,0,0,0`;
  }
  return googleMapsUrl(p);
}

function outreachChecklist(p) {
  const owner = ownerDisplay(p);
  const hasAddr = Boolean(p.address && p.address !== ",");
  const hasDoc = Boolean(p.lastBuy?.doc && String(p.lastBuy.doc).trim());
  return [
    { label: "Owner name", have: owner.known, note: owner.known ? owner.text : "Not in archive — use Assessor portal" },
    { label: "Situs address", have: hasAddr, note: hasAddr ? p.address : "Missing in archive" },
    { label: "APN / AIN", have: Boolean(p.ain), note: p.ain || "Missing" },
    { label: "Last deed document #", have: hasDoc, note: hasDoc ? p.lastBuy.doc : "Not in archive" },
    { label: "Mailing address", have: false, note: "Not in this archive — Assessor or deed lookup required" },
    { label: "Phone / email", have: false, note: "Never fabricated — obtain via licensed skip-trace or public records" },
  ];
}

const DRAWER_TABS = [
  { id: "overview", label: "Overview" },
  { id: "map", label: "Map & Location" },
  { id: "imagery", label: "Imagery" },
  { id: "ownership", label: "Ownership & Records" },
  { id: "tax", label: "Tax & Risk" },
  { id: "outreach", label: "Outreach links" },
];

let drawerMap = null;
let drawerMapMarker = null;
let drawerActiveTab = "overview";
let drawerCurrentProp = null;

function destroyDrawerMap() {
  if (drawerMap) {
    drawerMap.remove();
    drawerMap = null;
    drawerMapMarker = null;
  }
}

function initDrawerMap(p) {
  destroyDrawerMap();
  if (!hasCoords(p) || typeof L === "undefined") return;
  const el = document.getElementById("drawer-map");
  if (!el) return;

  drawerMap = L.map(el, {
    scrollWheelZoom: false,
    attributionControl: true,
  }).setView([p.latitude, p.longitude], 16);

  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(drawerMap);

  drawerMapMarker = L.marker([p.latitude, p.longitude]).addTo(drawerMap);
  drawerMapMarker.bindPopup(`<strong>${escapeHtml(p.ain)}</strong><br>${escapeHtml(p.address && p.address !== "," ? p.address : "Parcel pin")}`);

  requestAnimationFrame(() => drawerMap?.invalidateSize());
}

function externalLink(href, label, note = "") {
  if (!href) return `<p class="empty-msg">${missing("Link unavailable — need address or coordinates")}</p>`;
  const noteHtml = note ? `<span class="link-note">${escapeHtml(note)}</span>` : "";
  return `<a class="ext-link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}${noteHtml}</a>`;
}

function checklistHtml(items) {
  return `<ul class="checklist">${items
    .map(
      (item) => `<li class="${item.have ? "have" : "need"}">
        <span class="check-icon" aria-hidden="true">${item.have ? "✓" : "○"}</span>
        <div><strong>${escapeHtml(item.label)}</strong><span class="check-note">${escapeHtml(item.note)}</span></div>
      </li>`
    )
    .join("")}</ul>`;
}

function lastBuyShort(p) {
  if (!p.lastBuy) return "Not in archive";
  const rec = p.lastBuy.rec || "Date not in archive";
  const price = money(p.lastBuy.price);
  const priceTxt = price == null ? "price not in archive" : moneyFmt(price);
  return `${rec} · ${priceTxt}`;
}

function propKey(p) {
  return `${p.runId}::${p.ain}`;
}

async function loadJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
  return res.json();
}

function setHeroStats(index) {
  const map = {
    cities: (index.cities || state.cities || []).length,
    runs: index.runCount,
    props: index.propertyRowCount,
    unique: index.uniqueAinCount,
    done: index.donePageCount,
  };
  for (const [k, v] of Object.entries(map)) {
    const el = document.querySelector(`[data-k="${k}"]`);
    if (el) el.textContent = Number(v).toLocaleString();
  }
}

function renderCursor(stateBundle, index) {
  const cursor = stateBundle.cursor || {};
  $("#next-cursor").textContent = cursor.nextCursor || index.nextCursor || "—";
  const done = Array.isArray(cursor.donePages) ? cursor.donePages : [];
  $("#done-count").textContent = done.length.toLocaleString();

  const chips = $("#done-chips");
  chips.innerHTML = "";
  for (const page of done) {
    const span = document.createElement("span");
    span.className = "chip";
    span.title = `Map page ${page}`;
    span.textContent = page.replace(/^8448-/, "");
    chips.appendChild(span);
  }

  const jumps = Array.isArray(cursor.jumps) ? cursor.jumps : index.jumps || [];
  const jumpList = $("#jump-list");
  jumpList.innerHTML = "";
  if (!jumps.length) {
    jumpList.textContent = "None recorded.";
  } else {
    for (const j of jumps) {
      const div = document.createElement("div");
      div.className = "jump-item";
      div.innerHTML = `<div class="from-to">${escapeHtml(j.at || "?")} → ${escapeHtml(j.to || "?")}</div>
        <div class="meta">${escapeHtml(jumpReasonLabel(j.reason))} · empty streak ${j.streak ?? "—"} · hits ${j.hits ?? "—"}</div>`;
      jumpList.appendChild(div);
    }
  }

  $("#left-off-md").textContent = stateBundle.leftOffMarkdown || "(no LEFT_OFF.md)";
}

function renderCityBoard() {
  const board = $("#city-board");
  board.innerHTML = "";
  for (const [i, c] of state.cities.entries()) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `city-card${state.cityFilter === c.city ? " active" : ""}`;
    btn.style.animationDelay = `${Math.min(i, 12) * 0.04}s`;
    btn.setAttribute("role", "listitem");
    const areas = (c.areas || [])
      .map((a) => `<span class="area-tag">${escapeHtml(a.name)} cluster · ${a.count}</span>`)
      .join(" ");
    btn.innerHTML = `
      <h3>${escapeHtml(c.city)}</h3>
      <div class="city-meta">${Number(c.propertyRowCount).toLocaleString()} rows · ${Number(c.uniqueAinCount).toLocaleString()} unique AINs</div>
      ${areas}
    `;
    btn.addEventListener("click", () => {
      state.cityFilter = c.city;
      state.page = 1;
      syncCityControls();
      renderCityBoard();
      renderRuns();
      renderProperties();
      $("#properties").scrollIntoView({ behavior: "smooth", block: "start" });
    });
    board.appendChild(btn);
  }
}

function syncCityControls() {
  const citySel = $("#prop-city");
  if (citySel) citySel.value = state.cityFilter;

  document.querySelectorAll(".filters [data-city]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.city === state.cityFilter);
  });
}

function fillCityFilters() {
  const runCityFilters = document.querySelector(".filters[aria-label='Filter runs by city']");
  if (runCityFilters) {
    runCityFilters.innerHTML = `<button type="button" class="filter active" data-city="all">All cities</button>`;
    for (const c of state.cities) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "filter";
      btn.dataset.city = c.city;
      btn.textContent = `${c.city} (${c.propertyRowCount})`;
      runCityFilters.appendChild(btn);
    }
  }

  const sel = $("#prop-city");
  const current = state.cityFilter || "all";
  sel.innerHTML = `<option value="all">All cities</option>`;
  for (const c of state.cities) {
    const opt = document.createElement("option");
    opt.value = c.city;
    opt.textContent = `${c.city} (${c.propertyRowCount})`;
    sel.appendChild(opt);
  }
  sel.value = current;
}

function renderRuns() {
  const el = $("#runs-timeline");
  el.innerHTML = "";
  const list = state.runs.filter((r) => {
    if (state.streamFilter !== "all" && r.stream !== state.streamFilter) return false;
    if (state.cityFilter !== "all") {
      const cities = (r.cities || []).map((c) => c.city);
      if (!cities.includes(state.cityFilter) && r.primaryCity !== state.cityFilter) return false;
    }
    return true;
  });

  if (!list.length) {
    el.innerHTML = `<p class="empty-msg">No runs match this city / walk filter.</p>`;
    return;
  }

  list.forEach((run, i) => {
    const card = document.createElement("article");
    card.className = `run-card${run.validCount === 0 ? " zero" : ""}${
      state.selectedRun === run.id ? " selected" : ""
    }`;
    card.style.animationDelay = `${Math.min(i, 24) * 0.03}s`;
    card.dataset.runId = run.id;

    const jumpCount = Array.isArray(run.jumps) ? run.jumps.length : 0;
    const jumpBits =
      jumpCount > 0
        ? run.jumps
            .map((j) => `${j.at || "?"}→${j.to || "?"} (${jumpReasonLabel(j.reason)})`)
            .slice(0, 2)
            .join("; ")
        : "";

    const cityLine = (run.cities || [])
      .slice(0, 3)
      .map((c) => `${c.city} (${c.count})`)
      .join(" · ");

    card.innerHTML = `
      <p class="city-primary">${escapeHtml(run.primaryCity || "Unlabeled situs")}</p>
      <span class="stream-tag ${streamClass(run.stream)}">${escapeHtml(streamLabel(run.stream))}</span>
      <h3>${escapeHtml(run.id)}</h3>
      <div class="date">${escapeHtml(run.date || "Date not in archive")}${
        run.stop ? ` · ${escapeHtml(run.stop)}` : ""
      }${run.isAggregate ? " · Aggregate rollup" : ""}</div>
      ${cityLine ? `<div class="date">Cities in run: ${escapeHtml(cityLine)}</div>` : ""}
      <dl class="run-metrics">
        <div><dt>Valid parcels</dt><dd>${Number(run.validCount || 0).toLocaleString()}</dd></div>
        <div><dt>Soft jumps</dt><dd>${jumpCount}</dd></div>
        ${run.checks != null ? `<div><dt>Checks</dt><dd>${run.checks}</dd></div>` : ""}
      </dl>
      <div class="run-range">
        ${run.start ? `Start ${escapeHtml(run.start)}` : "Start not in archive"}
        ${run.end ? `<br/>End ${escapeHtml(run.end)}` : ""}
        ${run.nextCursor ? `<br/>Next ${escapeHtml(run.nextCursor)}` : ""}
      </div>
      ${jumpBits ? `<div class="run-jumps">${escapeHtml(jumpBits)}${jumpCount > 2 ? "…" : ""}</div>` : ""}
    `;

    card.addEventListener("click", () => {
      state.selectedRun = run.id;
      state.runFilter = run.id;
      $("#prop-run").value = run.id;
      if (run.primaryCity) {
        state.cityFilter = run.primaryCity;
        syncCityControls();
        renderCityBoard();
      }
      state.page = 1;
      renderRuns();
      renderProperties();
      $("#properties").scrollIntoView({ behavior: "smooth", block: "start" });
    });

    el.appendChild(card);
  });
}

function filteredProperties() {
  const q = state.search.trim().toLowerCase();
  return state.properties.filter((p) => {
    if (state.cityFilter !== "all" && p.city !== state.cityFilter) return false;
    if (state.runFilter !== "all" && p.runId !== state.runFilter) return false;
    if (state.uniqueOnly && p.duplicate) return false;
    if (!q) return true;
    const owner = ownerDisplay(p);
    const use = useLabel(p.useType);
    const tax = taxLabel(p.taxStatus, p.yearDefaulted);
    const market = marketLabel(p.market);
    const fc = foreclosureLabel(p);
    const hay = [
      p.ain,
      p.address,
      p.city,
      p.area,
      owner.text,
      p.ownerKnown,
      p.useType,
      use.label,
      p.taxStatus,
      tax.label,
      p.parcelStatus,
      p.market,
      market.label,
      fc.label,
      p.runId,
      p.yearBuilt,
      p.lastBuy?.rec,
      p.lastBuy?.doc,
      p.lastBuy?.price,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  });
}

function tagHtml(text, tone) {
  return `<span class="tag tag-${tone || "mute"}">${escapeHtml(text)}</span>`;
}

function labeledCell(plain, code) {
  if (code) {
    return `<div class="cell-stack"><span>${escapeHtml(plain)}</span><span class="cell-code">${escapeHtml(code)}</span></div>`;
  }
  return escapeHtml(plain);
}

function renderProperties() {
  const rows = filteredProperties();
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  if (state.page > totalPages) state.page = totalPages;
  const start = (state.page - 1) * PAGE_SIZE;
  const pageRows = rows.slice(start, start + PAGE_SIZE);

  const cityNote = state.cityFilter === "all" ? "all cities" : state.cityFilter;
  $("#table-meta").textContent = `${rows.length.toLocaleString()} matching (${cityNote}) · page ${state.page} of ${totalPages} · click a row for full archive detail`;

  const tbody = $("#props-body");
  tbody.innerHTML = "";

  if (!pageRows.length) {
    tbody.innerHTML = `<tr><td colspan="13" class="empty-msg">No properties match.</td></tr>`;
  } else {
    for (const p of pageRows) {
      const tr = document.createElement("tr");
      tr.tabIndex = 0;
      tr.dataset.key = propKey(p);
      if (p.duplicate) tr.classList.add("dup");
      if (state.selectedPropKey === propKey(p)) tr.classList.add("active-row");

      const owner = ownerDisplay(p);
      const use = useLabel(p.useType);
      const tax = taxLabel(p.taxStatus, p.yearDefaulted);
      const market = marketLabel(p.market);
      const fc = foreclosureLabel(p);
      const gap = assessorGap(p);
      const beds =
        p.yearBuilt || p.beds != null || p.baths != null
          ? `${p.yearBuilt || "—"} · ${p.beds ?? "—"}bd / ${p.baths ?? "—"}ba`
          : "Not in archive";

      const areaBit = p.area ? ` · ${p.area}` : "";
      const pubUrl = publicSearchUrl(p);
      const pubTitle = hasCoords(p)
        ? "Open Google Maps Street View (public)"
        : "Open Google Maps search (public)";

      tr.innerHTML = `
        <td class="ain">${escapeHtml(p.ain)}</td>
        <td>
          <span class="addr-main">${escapeHtml(p.address && p.address !== "," ? p.address : "Address not in archive")}</span>
          <span class="addr-city">${escapeHtml(p.city || "Unlabeled situs")}${escapeHtml(areaBit)}</span>
        </td>
        <td>${owner.known ? escapeHtml(owner.text) : missing(owner.text)}</td>
        <td>${labeledCell(use.label, use.code)}</td>
        <td>${tagHtml(tax.label, tax.tone)}${tax.code ? `<div class="cell-code">${escapeHtml(tax.code)}</div>` : ""}</td>
        <td>${p.lastBuy ? escapeHtml(lastBuyShort(p)) : missing()}</td>
        <td>${money(p.assessed) != null ? escapeHtml(moneyFmt(p.assessed)) : missing()}</td>
        <td title="${escapeHtml(gap.tip)}"><div class="cell-stack"><span>${escapeHtml(gap.text)}</span><span class="cell-code">Assessor gap (not true equity)</span></div></td>
        <td>${tagHtml(market.label, market.tone)}</td>
        <td>${tagHtml(fc.label, fc.tone)}</td>
        <td>${escapeHtml(beds)}</td>
        <td class="pub-search">
          ${
            pubUrl
              ? `<a class="pub-search-link" href="${escapeHtml(pubUrl)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(pubTitle)}" aria-label="${escapeHtml(pubTitle)}">Map</a>`
              : `<span class="muted" title="Need address or coordinates">—</span>`
          }
        </td>
        <td><code>${escapeHtml((p.runId || "").replace(/^RUN-/, ""))}</code></td>
      `;

      const pubLink = tr.querySelector(".pub-search-link");
      if (pubLink) {
        pubLink.addEventListener("click", (e) => e.stopPropagation());
      }

      const open = () => openDrawer(p);
      tr.addEventListener("click", open);
      tr.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      });
      tbody.appendChild(tr);
    }
  }

  const pager = $("#pager");
  pager.innerHTML = "";
  const prev = document.createElement("button");
  prev.type = "button";
  prev.textContent = "← Previous";
  prev.disabled = state.page <= 1;
  prev.addEventListener("click", () => {
    state.page -= 1;
    renderProperties();
  });
  const next = document.createElement("button");
  next.type = "button";
  next.textContent = "Next →";
  next.disabled = state.page >= totalPages;
  next.addEventListener("click", () => {
    state.page += 1;
    renderProperties();
  });
  const mid = document.createElement("span");
  mid.textContent = `Showing ${pageRows.length ? start + 1 : 0}–${start + pageRows.length}`;
  pager.append(prev, mid, next);
}

function field(label, valueHtml, wide = false) {
  return `<div class="detail-field${wide ? " wide" : ""}"><dt>${escapeHtml(label)}</dt><dd>${valueHtml}</dd></div>`;
}

function valOrMissing(v, emptyText = "Not in archive") {
  if (v == null || v === "" || v === ",") return missing(emptyText);
  return escapeHtml(String(v));
}

function renderDrawerTabContent(p, tabId) {
  const owner = ownerDisplay(p);
  const use = useLabel(p.useType);
  const tax = taxLabel(p.taxStatus, p.yearDefaulted);
  const parcel = parcelLabel(p.parcelStatus);
  const market = marketLabel(p.market);
  const fc = foreclosureLabel(p);
  const gap = assessorGap(p);
  const run = state.runs.find((r) => r.id === p.runId);
  const gmaps = googleMapsUrl(p);
  const coords = hasCoords(p);

  const buyBits = p.lastBuy
    ? `
      ${field("When bought (recording date)", valOrMissing(p.lastBuy.rec, "Date not in archive"))}
      ${field("Last buy price", money(p.lastBuy.price) != null ? escapeHtml(moneyFmt(p.lastBuy.price)) : missing("Price not in archive"))}
      ${field("Document number", valOrMissing(p.lastBuy.doc, "Doc not in archive"))}
      ${field("Document type", valOrMissing(p.lastBuy.docType))}
      ${field("Transfer reason", valOrMissing(p.lastBuy.reason), true)}
    `
    : field("Last buy", missing("Last buy not in archive"), true);

  const ownershipHtml =
    Array.isArray(p.ownership) && p.ownership.length
      ? `<ul class="ownership-list">${p.ownership
          .map((o) => {
            const price = money(o.price) != null ? moneyFmt(o.price) : "price not in archive";
            return `<li>
              <div class="own-top">${escapeHtml(o.rec || "—")} · doc ${escapeHtml(o.doc || "—")} · ${escapeHtml(price)}</div>
              <div class="own-meta">${escapeHtml(o.docType || "Doc type not in archive")}${
                o.reason ? ` · ${escapeHtml(o.reason)}` : ""
              }</div>
            </li>`;
          })
          .join("")}</ul>
        <p class="note-box" style="margin-top:0.65rem">Transfer history from the assessor archive — grantee names appear only when <code>ownerKnown</code> was captured separately (rare).</p>`
      : `<p class="note-box">Ownership transfer history not in archive for this parcel.</p>`;

  if (tabId === "overview") {
    return `
      <div class="detail-section">
        <h3>Identity</h3>
        <div class="detail-grid">
          ${field("APN (Assessor ID Number)", `<code class="mono">${escapeHtml(p.ain)}</code>`)}
          ${field("City / area", `${escapeHtml(p.city || "Unlabeled situs")}${p.area ? ` · ${escapeHtml(p.area)}` : ""}`)}
          ${field("Owner / people names", owner.known ? escapeHtml(owner.text) : missing(owner.text), true)}
          ${field("Situs address", valOrMissing(p.address, "Address not in archive"), true)}
          ${field("Coordinates", coords ? `${p.latitude.toFixed(6)}, ${p.longitude.toFixed(6)}` : missing("Not in assessor archive"), true)}
          ${field("Archive status", valOrMissing(p.status, "VALID assumed"))}
          ${field(
            "Duplicate row?",
            p.duplicate
              ? `Yes — also seen earlier in ${escapeHtml(p.firstSeenIn || "another run")}`
              : "No — first occurrence in build"
          )}
        </div>
      </div>
      <div class="detail-section">
        <h3>Use &amp; parcel</h3>
        <div class="detail-grid">
          ${field("Use", `${escapeHtml(use.label)}${use.code ? `<span class="code-hint">${escapeHtml(use.code)}</span>` : ""}`)}
          ${field("Parcel status", `${escapeHtml(parcel.label)}${parcel.code ? `<span class="code-hint">${escapeHtml(parcel.code)}</span>` : ""}`)}
          ${field("Year built", valOrMissing(p.yearBuilt))}
          ${field("Beds / baths", p.beds != null || p.baths != null ? `${p.beds ?? "—"} / ${p.baths ?? "—"}` : missing())}
          ${field("Building sq ft", p.bldg != null && p.bldg !== "" ? escapeHtml(numFmt(p.bldg)) : missing())}
          ${field("Lot sq ft", p.lot != null && p.lot !== "" ? escapeHtml(numFmt(p.lot)) : missing())}
        </div>
      </div>
      <div class="detail-section">
        <h3>Values snapshot</h3>
        <div class="detail-grid">
          ${field("Assessed value", money(p.assessed) != null ? escapeHtml(moneyFmt(p.assessed)) : missing())}
          ${field(
            "Assessor gap (not true equity)",
            `<strong>${escapeHtml(gap.text)}</strong><span class="code-hint">${escapeHtml(gap.tip)}</span>`,
            true
          )}
        </div>
      </div>
      <div class="detail-section">
        <h3>Run provenance</h3>
        <div class="detail-grid">
          ${field("Source run", escapeHtml(p.runId || "Not in archive"), true)}
          ${field("Walk style", escapeHtml(streamLabel(run?.stream)), true)}
          ${field("Run primary city", escapeHtml(run?.primaryCity || p.city || "Unlabeled situs"))}
        </div>
      </div>
    `;
  }

  if (tabId === "map") {
    const mapBlock = coords
      ? `<div id="drawer-map" class="map-canvas" role="img" aria-label="Map pin for parcel ${escapeHtml(p.ain)}"></div>
         <p class="map-attrib">OpenStreetMap tiles · no API key required · pin from LA County Assessor parcel coordinates</p>`
      : `<div class="empty-state">
           <p><strong>No coordinates in archive</strong></p>
           <p class="muted">This parcel's <code>full.json</code> snapshot had no assessor Latitude/Longitude. Use the external map link below with the situs address.</p>
         </div>`;

    return `
      <div class="detail-section">
        <h3>Interactive map</h3>
        ${mapBlock}
        <div class="link-row">
          ${externalLink(gmaps, coords ? "Open in Google Maps (coordinates)" : "Open in Google Maps (address search)", "External · third-party")}
        </div>
      </div>
      <div class="detail-section">
        <h3>Location details</h3>
        <div class="detail-grid">
          ${field("Situs address", valOrMissing(p.address, "Address not in archive"), true)}
          ${field("City / area", `${escapeHtml(p.city || "Unlabeled situs")}${p.area ? ` · ${escapeHtml(p.area)}` : ""}`)}
          ${field("Latitude", coords ? escapeHtml(String(p.latitude)) : missing("Not in archive"))}
          ${field("Longitude", coords ? escapeHtml(String(p.longitude)) : missing("Not in archive"))}
        </div>
      </div>
    `;
  }

  if (tabId === "imagery") {
    const svEmbed = streetViewEmbedUrl(p);
    const svLink = streetViewLinkUrl(p);
    const satUrl = coords ? esriSatelliteTileUrl(p.latitude, p.longitude) : null;

    const streetBlock = coords
      ? `<div class="imagery-frame">
           <iframe title="Google Street View embed" src="${escapeHtml(svEmbed)}" loading="lazy" referrerpolicy="no-referrer-when-downgrade" allowfullscreen></iframe>
         </div>
         <div class="link-row">${externalLink(svLink, "View Street View on Google Maps", "External · third-party")}</div>`
      : `<div class="empty-state">
           <p><strong>Street View needs coordinates</strong></p>
           <p class="muted">No assessor lat/lon yet — run <code>npm run backfill:coords</code> then rebuild, or use public listing search links below.</p>
         </div>`;

    const satBlock = coords
      ? `<figure class="sat-thumb">
           <img src="${escapeHtml(satUrl)}" alt="Esri World Imagery tile near parcel coordinates" loading="lazy" width="256" height="256" />
           <figcaption>Esri World Imagery tile (zoom 18) · free tier · not verified by this archive</figcaption>
         </figure>`
      : `<div class="empty-state"><p class="muted">Satellite thumbnail needs coordinates from the assessor portal.</p></div>`;

    const publicSearchLinks = `
      <div class="link-stack">
        ${externalLink(gmaps, "Google Maps", coords ? "Coordinates · third-party" : "Address search · third-party")}
        ${externalLink(zillowUrl(p), "Zillow address search", "Opens Zillow — we don't host MLS photos")}
        ${externalLink(redfinUrl(p), "Redfin address search", "Opens Redfin — we don't host MLS photos")}
        ${externalLink(realtorUrl(p), "Realtor.com address search", "Opens Realtor.com — we don't host MLS photos")}
        ${externalLink(assessorParcelUrl(p), "LA Assessor portal", `AIN ${escapeHtml(p.ain)} · official`)}
      </div>`;

    return `
      <p class="note-box imagery-disclaimer"><strong>Photos on MLS sites open on their pages — we don't host MLS photos.</strong> Street View / Esri use free public map tiles; listing buttons are outbound search links only.</p>
      <div class="detail-section">
        <h3>Street-level view</h3>
        ${streetBlock}
      </div>
      <div class="detail-section">
        <h3>Satellite thumbnail</h3>
        ${satBlock}
      </div>
      <div class="detail-section">
        <h3>Search free public listings</h3>
        <p class="section-hint muted">Official search / listing pages when an address exists. Never invented listing status or owners.</p>
        ${publicSearchLinks}
      </div>
    `;
  }

  if (tabId === "ownership") {
    return `
      <div class="detail-section">
        <h3>Owner (archive only)</h3>
        <div class="detail-grid">
          ${field(
            "Owner name",
            owner.known ? escapeHtml(owner.text) : missing("Owner not in public assessor archive"),
            true
          )}
        </div>
        <p class="note-box">We do not discover owners from Google or other web search. Names appear only when explicitly captured in the sweep archive (<code>ownerKnown</code> field).</p>
      </div>
      <div class="detail-section">
        <h3>How to look up owner (LA County)</h3>
        <div class="link-stack">
          ${externalLink(assessorParcelUrl(p), "LA County Assessor — parcel detail", `Search AIN ${escapeHtml(p.ain)}`)}
          ${externalLink(recorderSearchUrl(p), p.lastBuy?.doc ? `LA County Recorder — doc # ${escapeHtml(p.lastBuy.doc)}` : "LA County Recorder — deed search", "Official public records")}
          ${externalLink("https://lavote.gov/home/records/property-document-recording", "Recorder property document info", "County portal")}
        </div>
      </div>
      <div class="detail-section">
        <h3>Last buy</h3>
        <div class="detail-grid">${buyBits}</div>
      </div>
      <div class="detail-section">
        <h3>Ownership history snippets</h3>
        ${ownershipHtml}
      </div>
    `;
  }

  if (tabId === "tax") {
    return `
      <div class="detail-section">
        <h3>Tax &amp; legal status (archive only)</h3>
        <div class="detail-grid">
          ${field("Tax status", `${tagHtml(tax.label, tax.tone)}${tax.code ? `<span class="code-hint">${escapeHtml(tax.code)}</span>` : ""}`)}
          ${field("Year defaulted", valOrMissing(p.yearDefaulted && String(p.yearDefaulted).trim() ? p.yearDefaulted : null, "Not in archive"))}
          ${field("Market", `${tagHtml(market.label, market.tone)}${market.code ? `<span class="code-hint">${escapeHtml(market.code)}</span>` : ""}`, true)}
          ${field("Foreclosure", `${tagHtml(fc.label, fc.tone)}${fc.detail ? `<span class="code-hint">${escapeHtml(fc.detail)}</span>` : ""}`, true)}
          ${field("Parcel status", `${escapeHtml(parcel.label)}${parcel.code ? `<span class="code-hint">${escapeHtml(parcel.code)}</span>` : ""}`)}
        </div>
        <p class="note-box" style="margin-top:0.65rem">Foreclosure “imminent” is only shown when the archive has an explicit signal — never invented from web search.</p>
      </div>
      <div class="detail-section">
        <h3>Values</h3>
        <div class="detail-grid">
          ${field("Assessed value", money(p.assessed) != null ? escapeHtml(moneyFmt(p.assessed)) : missing())}
          ${field("Land assessed", money(p.land) != null ? escapeHtml(moneyFmt(p.land)) : missing())}
          ${field("Improvement assessed", money(p.imp) != null ? escapeHtml(moneyFmt(p.imp)) : missing())}
          ${field("Base year (land)", valOrMissing(p.baseYearLand))}
          ${field("Base year (imp)", valOrMissing(p.baseYearImp))}
          ${field(
            "Assessor gap (not true equity)",
            `<strong>${escapeHtml(gap.text)}</strong><span class="code-hint">${escapeHtml(gap.tip)}</span>`,
            true
          )}
        </div>
      </div>
    `;
  }

  if (tabId === "outreach") {
    const checks = outreachChecklist(p);
    return `
      <div class="detail-section">
        <h3>Outreach readiness</h3>
        <p class="section-sub inline">What this archive has vs. what you still need for contact — phone and email are never fabricated.</p>
        ${checklistHtml(checks)}
      </div>
      <div class="detail-section">
        <h3>Official lookup links</h3>
        <div class="link-stack">
          ${externalLink(assessorParcelUrl(p), "Assessor parcel portal", "Owner of record, roll values, situs")}
          ${externalLink(recorderSearchUrl(p), "Recorder deed search", p.lastBuy?.doc ? `Doc ${escapeHtml(p.lastBuy.doc)}` : "Search by APN or party name")}
          ${externalLink(gmaps, "Google Maps", "Verify situs / drive-by planning")}
        </div>
      </div>
      <div class="detail-section">
        <h3>Future enrichment (not implemented)</h3>
        <p class="note-box">Paid deed APIs, skip-trace services, or licensed data vendors could add mailing address and phone — none are wired in yet. This viewer stays archive-honest until a documented source is integrated.</p>
      </div>
    `;
  }

  return `<p class="empty-msg">Section not found.</p>`;
}

function renderDrawerTabs(p) {
  const tabsEl = $("#drawer-tabs");
  tabsEl.innerHTML = "";
  for (const tab of DRAWER_TABS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `drawer-tab${drawerActiveTab === tab.id ? " active" : ""}`;
    btn.role = "tab";
    btn.id = `tab-${tab.id}`;
    btn.setAttribute("aria-selected", drawerActiveTab === tab.id ? "true" : "false");
    btn.setAttribute("aria-controls", "drawer-panel");
    btn.textContent = tab.label;
    btn.addEventListener("click", () => {
      drawerActiveTab = tab.id;
      showDrawerTab(p);
    });
    tabsEl.appendChild(btn);
  }
}

function showDrawerTab(p) {
  destroyDrawerMap();
  renderDrawerTabs(p);
  const panel = $("#drawer-body");
  panel.id = "drawer-panel";
  panel.role = "tabpanel";
  panel.setAttribute("aria-labelledby", `tab-${drawerActiveTab}`);
  panel.innerHTML = renderDrawerTabContent(p, drawerActiveTab);
  if (drawerActiveTab === "map" && hasCoords(p)) {
    requestAnimationFrame(() => initDrawerMap(p));
  }
}

function openDrawer(p) {
  state.selectedPropKey = propKey(p);
  renderProperties();

  drawerCurrentProp = p;
  drawerActiveTab = "overview";

  const drawer = $("#prop-drawer");
  const backdrop = $("#drawer-backdrop");

  $("#drawer-title").textContent = p.ain || "Parcel";
  $("#drawer-addr").textContent =
    p.address && p.address !== "," ? p.address : "Address not in archive";

  showDrawerTab(p);

  drawer.hidden = false;
  backdrop.hidden = false;
  document.body.classList.add("drawer-open");
  $("#drawer-close").focus();
}

function closeDrawer() {
  destroyDrawerMap();
  drawerCurrentProp = null;
  $("#prop-drawer").hidden = true;
  $("#drawer-backdrop").hidden = true;
  document.body.classList.remove("drawer-open");
  state.selectedPropKey = null;
}

function fillRunSelect() {
  const sel = $("#prop-run");
  const current = sel.value || "all";
  sel.innerHTML = `<option value="all">All runs</option>`;
  for (const r of state.runs) {
    const opt = document.createElement("option");
    opt.value = r.id;
    opt.textContent = `${r.primaryCity || "?"} · ${r.id} (${r.validCount})`;
    sel.appendChild(opt);
  }
  sel.value = current;
}

function wireControls() {
  document.querySelector(".filters[aria-label='Filter runs by city']")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-city]");
    if (!btn) return;
    state.cityFilter = btn.dataset.city;
    state.page = 1;
    syncCityControls();
    renderCityBoard();
    renderRuns();
    renderProperties();
  });

  document.querySelector(".filters.secondary")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-stream]");
    if (!btn) return;
    document.querySelectorAll(".filters.secondary .filter").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.streamFilter = btn.dataset.stream;
    renderRuns();
  });

  $("#prop-search").addEventListener("input", (e) => {
    state.search = e.target.value;
    state.page = 1;
    renderProperties();
  });

  $("#prop-city").addEventListener("change", (e) => {
    state.cityFilter = e.target.value;
    state.page = 1;
    syncCityControls();
    renderCityBoard();
    renderRuns();
    renderProperties();
  });

  $("#prop-run").addEventListener("change", (e) => {
    state.runFilter = e.target.value;
    state.selectedRun = e.target.value === "all" ? null : e.target.value;
    state.page = 1;
    renderRuns();
    renderProperties();
  });

  $("#unique-only").addEventListener("change", (e) => {
    state.uniqueOnly = e.target.checked;
    state.page = 1;
    renderProperties();
  });

  $("#drawer-close").addEventListener("click", closeDrawer);
  $("#drawer-backdrop").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#prop-drawer").hidden) closeDrawer();
  });
}

async function main() {
  wireControls();
  try {
    const [index, stateBundle, propsBundle] = await Promise.all([
      loadJson("./data/runs-index.json"),
      loadJson("./data/state.json"),
      loadJson("./data/properties.json"),
    ]);

    state.runs = [...(index.runs || [])].sort((a, b) =>
      a.id.localeCompare(b.id, undefined, { numeric: true })
    );
    state.properties = propsBundle.properties || [];
    state.cities = index.cities || propsBundle.cities || [];

    setHeroStats(index);
    renderCursor(stateBundle, index);
    fillCityFilters();
    fillRunSelect();
    renderCityBoard();
    renderRuns();
    renderProperties();

    const built = index.builtAt || propsBundle.builtAt;
    if (built) {
      const t = $("#built-at");
      t.dateTime = built;
      t.textContent = new Date(built).toLocaleString();
    }
  } catch (err) {
    console.error(err);
    $("#runs-timeline").innerHTML = `<p class="empty-msg">Could not load data. Run <code>npm run build:data</code> first.</p>`;
  }
}

main();
