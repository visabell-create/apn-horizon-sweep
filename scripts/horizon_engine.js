/**
 * Perpetual Horizon Sweep — browser CDP Runtime.evaluate payload.
 * Never stops: at HARD_JUMP hops to densest horizon page.
 */
async function horizonSweep(opts) {
  const LOOKAHEAD_TRIGGER = opts.lookaheadTrigger ?? 5;
  const SOFT_JUMP = opts.softJump ?? 12;
  const HARD_JUMP = opts.hardJump ?? 20;
  const HORIZON_PAGES = opts.horizonPages ?? 16;
  const MAX_CHECKS = opts.maxChecks ?? 350;
  const SAMPLE = opts.sampleParcels ?? [1, 20, 26, 40, 50, 80, 100];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    const t = await (await fetch(`/api/parceldetail?ain=${ain}`)).text();
    try { return JSON.parse(t); } catch { return null; }
  }

  async function enrich(ainNum, p) {
    let owners = [];
    try {
      const oh = await (await fetch(`/api/parcel_ownershiphistory?ain=${String(ainNum).padStart(10, "0")}`)).json();
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

  async function scorePage(book, page) {
    let hits = 0;
    let firstValidParcel = null;
    for (const parcel of SAMPLE) {
      const ainNum = makeAin(book, page, parcel);
      const data = await fetchDetail(ainNum);
      if (isValidParcel(data)) {
        hits++;
        if (firstValidParcel == null) firstValidParcel = parcel;
      }
      await sleep(15);
    }
    // denser pages often start ~026 — also try walking 1..40 for first hit if samples miss
    if (hits === 0) {
      for (let parcel = 1; parcel <= 40; parcel++) {
        const data = await fetchDetail(makeAin(book, page, parcel));
        if (isValidParcel(data)) {
          hits = 1;
          firstValidParcel = parcel;
          break;
        }
        await sleep(10);
      }
    }
    return { book, page, hits, firstValidParcel, key: `${book}-${String(page).padStart(3, "0")}` };
  }

  async function probeHorizon(fromBook, fromPage, donePages) {
    const candidates = [];
    for (let d = 1; d <= HORIZON_PAGES; d++) {
      let book = fromBook;
      let page = fromPage + d;
      if (page > 999) {
        book += Math.floor(page / 1000);
        page = page % 1000;
      }
      const key = `${book}-${String(page).padStart(3, "0")}`;
      if (donePages.has(key)) continue;
      const scored = await scorePage(book, page);
      if (scored.hits > 0) candidates.push(scored);
    }
    candidates.sort((a, b) => b.hits - a.hits || a.page - b.page);
    return candidates;
  }

  let ainNum = opts.startAin;
  let consecutiveInvalid = 0;
  const valids = [];
  const jumps = [];
  const donePages = new Set(opts.donePages || []);
  let horizonQueue = opts.horizonQueue || [];
  let lastHorizonAtPage = null;
  const resultsTrace = [];

  for (let i = 0; i < MAX_CHECKS; i++) {
    const meta = parseAin(ainNum);
    const pageKey = `${meta.book}-${String(meta.page).padStart(3, "0")}`;

    // Horizon probe while approaching empty zone
    if (consecutiveInvalid >= LOOKAHEAD_TRIGGER && lastHorizonAtPage !== pageKey) {
      const probed = await probeHorizon(meta.book, meta.page, donePages);
      const known = new Set(horizonQueue.map((h) => h.key));
      for (const c of probed) if (!known.has(c.key)) horizonQueue.push(c);
      horizonQueue.sort((a, b) => b.hits - a.hits);
      lastHorizonAtPage = pageKey;
    }

    // Soft / hard jump — NEVER stop
    if (consecutiveInvalid >= SOFT_JUMP && horizonQueue.length) {
      const target = horizonQueue.shift();
      const destParcel = target.firstValidParcel || 1;
      const dest = makeAin(target.book, target.page, destParcel);
      jumps.push({
        at: fmt(ainNum),
        streak: consecutiveInvalid,
        to: fmt(dest),
        reason: consecutiveInvalid >= HARD_JUMP ? "HARD_JUMP" : "SOFT_JUMP",
        scoredHits: target.hits,
      });
      donePages.add(pageKey);
      ainNum = dest;
      consecutiveInvalid = 0;
      lastHorizonAtPage = null;
      continue;
    }

    if (consecutiveInvalid >= HARD_JUMP) {
      // Emergency: force-scan next pages even if queue empty
      if (!horizonQueue.length) {
        const emergency = await probeHorizon(meta.book, meta.page, donePages);
        horizonQueue = emergency;
      }
      if (horizonQueue.length) {
        const target = horizonQueue.shift();
        const dest = makeAin(target.book, target.page, target.firstValidParcel || 1);
        jumps.push({ at: fmt(ainNum), streak: consecutiveInvalid, to: fmt(dest), reason: "HARD_JUMP", scoredHits: target.hits });
        donePages.add(pageKey);
        ainNum = dest;
        consecutiveInvalid = 0;
        lastHorizonAtPage = null;
        continue;
      }
      // Last resort: next map book page 001
      const dest = makeAin(meta.book + 1, 1, 1);
      jumps.push({ at: fmt(ainNum), streak: consecutiveInvalid, to: fmt(dest), reason: "MAPBOOK_ROLLOVER" });
      donePages.add(pageKey);
      ainNum = dest;
      consecutiveInvalid = 0;
      continue;
    }

    // Walk +1
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
    await sleep(20);
  }

  return {
    algorithm: "perpetual-horizon-v1",
    start: fmt(opts.startAin),
    lastAinChecked: fmt(ainNum - 1),
    nextCursor: fmt(ainNum),
    stoppedReason: "SESSION_CAP_KEEP_GOING",
    validCount: valids.length,
    invalidCount: resultsTrace.filter((r) => r.status !== "VALID").length,
    jumps,
    horizonQueue,
    donePages: [...donePages],
    valids,
  };
}

// Export for Node; in browser, call horizonSweep({...})
if (typeof module !== "undefined") module.exports = { horizonSweep };
