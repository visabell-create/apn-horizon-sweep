const PAGE_SIZE = 50;

const state = {
  runs: [],
  properties: [],
  streamFilter: "all",
  runFilter: "all",
  search: "",
  uniqueOnly: false,
  page: 1,
  selectedRun: null,
};

const $ = (sel) => document.querySelector(sel);

function money(n) {
  if (n == null || n === "") return "—";
  const num = typeof n === "string" ? Number(n.replace(/[^\d.]/g, "")) : Number(n);
  if (Number.isNaN(num)) return String(n);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(num);
}

function streamClass(stream) {
  if (stream === "serial") return "stream-serial";
  if (stream === "parallel-A") return "stream-parallel-A";
  if (stream === "parallel-midnight-B") return "stream-parallel-midnight-B";
  return "stream-other";
}

function streamLabel(stream) {
  if (stream === "serial") return "Serial";
  if (stream === "parallel-A") return "Parallel A";
  if (stream === "parallel-midnight-B") return "Midnight B";
  return stream;
}

async function loadJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
  return res.json();
}

function setHeroStats(index) {
  const map = {
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
        <div class="meta">${escapeHtml(j.reason || "JUMP")} · streak ${j.streak ?? "—"} · hits ${j.hits ?? "—"}</div>`;
      jumpList.appendChild(div);
    }
  }

  $("#left-off-md").textContent = stateBundle.leftOffMarkdown || "(no LEFT_OFF.md)";
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderRuns() {
  const el = $("#runs-timeline");
  el.innerHTML = "";
  const list = state.runs.filter(
    (r) => state.streamFilter === "all" || r.stream === state.streamFilter
  );

  if (!list.length) {
    el.innerHTML = `<p class="empty-msg">No runs in this stream.</p>`;
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
            .map((j) => `${j.at || "?"}→${j.to || "?"}`)
            .slice(0, 3)
            .join("; ")
        : "";

    card.innerHTML = `
      <span class="stream-tag ${streamClass(run.stream)}">${streamLabel(run.stream)}</span>
      <h3>${escapeHtml(run.id)}</h3>
      <div class="date">${escapeHtml(run.date || "date unknown")}${
        run.stop ? ` · ${escapeHtml(run.stop)}` : ""
      }${run.isAggregate ? " · aggregate" : ""}</div>
      <dl class="run-metrics">
        <div><dt>Valids</dt><dd>${Number(run.validCount || 0).toLocaleString()}</dd></div>
        <div><dt>Jumps</dt><dd>${jumpCount}</dd></div>
        ${run.checks != null ? `<div><dt>Checks</dt><dd>${run.checks}</dd></div>` : ""}
      </dl>
      <div class="run-range">
        ${run.start ? `Start ${escapeHtml(run.start)}` : "Start —"}
        ${run.end ? `<br/>End ${escapeHtml(run.end)}` : ""}
        ${run.nextCursor ? `<br/>Next ${escapeHtml(run.nextCursor)}` : ""}
      </div>
      ${jumpBits ? `<div class="run-jumps">${escapeHtml(jumpBits)}${jumpCount > 3 ? "…" : ""}</div>` : ""}
    `;

    card.addEventListener("click", () => {
      state.selectedRun = run.id;
      state.runFilter = run.id;
      $("#prop-run").value = run.id;
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
    if (state.runFilter !== "all" && p.runId !== state.runFilter) return false;
    if (state.uniqueOnly && p.duplicate) return false;
    if (!q) return true;
    const hay = [
      p.ain,
      p.address,
      p.useType,
      p.taxStatus,
      p.runId,
      p.parcelStatus,
    ]
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  });
}

function renderProperties() {
  const rows = filteredProperties();
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  if (state.page > totalPages) state.page = totalPages;
  const start = (state.page - 1) * PAGE_SIZE;
  const pageRows = rows.slice(start, start + PAGE_SIZE);

  $("#table-meta").textContent = `${rows.length.toLocaleString()} matching · page ${state.page} of ${totalPages}`;

  const tbody = $("#props-body");
  tbody.innerHTML = "";

  if (!pageRows.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty-msg">No properties match.</td></tr>`;
  } else {
    for (const p of pageRows) {
      const tr = document.createElement("tr");
      if (p.duplicate) tr.className = "dup";
      const lastBuy = p.lastBuy
        ? `${p.lastBuy.rec || "—"} · ${money(p.lastBuy.price)}`
        : "—";
      tr.innerHTML = `
        <td class="ain">${escapeHtml(p.ain)}</td>
        <td>${escapeHtml(p.address || "—")}</td>
        <td>${escapeHtml(p.useType || "—")}</td>
        <td>${escapeHtml(p.taxStatus || "—")}</td>
        <td>${money(p.assessed)}</td>
        <td>${escapeHtml(lastBuy)}</td>
        <td class="${p.hasForeclosureHist ? "fc-yes" : "fc-no"}">${
          p.hasForeclosureHist ? "Yes" : "No"
        }</td>
        <td><code>${escapeHtml((p.runId || "").replace(/^RUN-/, ""))}</code></td>
      `;
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

function fillRunSelect() {
  const sel = $("#prop-run");
  const current = sel.value || "all";
  sel.innerHTML = `<option value="all">All runs</option>`;
  for (const r of state.runs) {
    const opt = document.createElement("option");
    opt.value = r.id;
    opt.textContent = `${r.id} (${r.validCount})`;
    sel.appendChild(opt);
  }
  sel.value = current;
}

function wireControls() {
  document.querySelectorAll(".filter").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".filter").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.streamFilter = btn.dataset.stream;
      renderRuns();
    });
  });

  $("#prop-search").addEventListener("input", (e) => {
    state.search = e.target.value;
    state.page = 1;
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
}

async function main() {
  wireControls();
  try {
    const [index, stateBundle, propsBundle] = await Promise.all([
      loadJson("./data/runs-index.json"),
      loadJson("./data/state.json"),
      loadJson("./data/properties.json"),
    ]);

    state.runs = index.runs || [];
    // Prefer non-aggregate first in sort for display? Keep build order but put aggregates after?
    state.runs = [...state.runs].sort((a, b) => {
      // serial numbered first by date/name, then others
      return a.id.localeCompare(b.id, undefined, { numeric: true });
    });
    state.properties = propsBundle.properties || [];

    setHeroStats(index);
    renderCursor(stateBundle, index);
    fillRunSelect();
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
