async function walkPagesA10(pageList) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fmt = (n) => {
    const s = String(n).padStart(10, "0");
    return s.slice(0, 4) + "-" + s.slice(4, 7) + "-" + s.slice(7, 10);
  };
  const make = (b, p, c) => b * 1e6 + p * 1e3 + c;
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
  async function detail(ainNum) {
    const ain = String(ainNum).padStart(10, "0");
    try {
      const t = await (await fetch("/api/parceldetail?ain=" + ain)).text();
      return JSON.parse(t);
    } catch (e) {
      return null;
    }
  }
  async function enrich(ainNum, p) {
    let owners = [];
    try {
      const oh = await (
        await fetch(
          "/api/parcel_ownershiphistory?ain=" + String(ainNum).padStart(10, "0")
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
    } catch (e) {}
    const lastBuy =
      owners.find((o) => o.price && Number(o.price) > 1000) || null;
    const hasForeclosureHist = owners.some(
      (o) =>
        /foreclos/i.test(o.docType || "") || /Trustee Sale/i.test(o.reason || "")
    );
    return {
      ain: fmt(ainNum),
      status: "VALID",
      address: (
        (p.SitusStreet || "").trim() +
        ", " +
        (p.SitusCity || "").trim() +
        " " +
        (p.SitusZipCode || "").trim()
      ).trim(),
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
      land: Number(p.CurrentRoll_LandValue || 0),
      imp: Number(p.CurrentRoll_ImpValue || 0),
      lastBuy,
      hasForeclosureHist,
      ownership: owners,
    };
  }
  async function walkPage(page) {
    const book = 8448;
    let parcel = 1;
    let streak = 0;
    let seenValid = false;
    const valids = [];
    const trace = [];
    let firstValid = null;
    let lastValid = null;
    let lastChecked = null;
    while (parcel <= 999) {
      const ainNum = make(book, page, parcel);
      lastChecked = fmt(ainNum);
      const data = await detail(ainNum);
      if (!isValid(data)) {
        streak++;
        trace.push({ ain: fmt(ainNum), status: "INVALID", streak: streak });
        if (seenValid && streak >= 20) break;
        if (!seenValid && parcel >= 120) break;
      } else {
        streak = 0;
        seenValid = true;
        if (!firstValid) firstValid = fmt(ainNum);
        lastValid = fmt(ainNum);
        valids.push(await enrich(ainNum, data.Parcel));
        trace.push({ ain: fmt(ainNum), status: "VALID" });
      }
      parcel++;
      await sleep(18);
    }
    return {
      page: "8448-" + String(page).padStart(3, "0"),
      start: "8448-" + String(page).padStart(3, "0") + "-001",
      firstValid: firstValid,
      lastValid: lastValid,
      lastChecked: lastChecked,
      validCount: valids.length,
      invalidCount: trace.filter((t) => t.status !== "VALID").length,
      checks: trace.length,
      stoppedReason:
        !seenValid && parcel >= 120
          ? "EMPTY_OR_SPARSE_NO_VALID_BY_120"
          : seenValid && streak >= 20
            ? "20_INVALID_STREAK"
            : "PAGE_END",
      valids: valids,
      trace: trace,
    };
  }
  const results = [];
  for (const p of pageList) {
    results.push(await walkPage(p));
  }
  return {
    agent: "agent-10",
    algorithm: "page-walk-v1",
    pages: results.map((r) => ({
      page: r.page,
      validCount: r.validCount,
      invalidCount: r.invalidCount,
      checks: r.checks,
      firstValid: r.firstValid,
      lastValid: r.lastValid,
      lastChecked: r.lastChecked,
      stoppedReason: r.stoppedReason,
    })),
    totalValids: results.reduce((a, r) => a + r.validCount, 0),
    results: results,
  };
}
walkPagesA10
