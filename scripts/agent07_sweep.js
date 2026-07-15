async function agent07Sweep() {
  const HARD_JUMP = 20;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fmt = (n) => {
    const s = String(n).padStart(10, "0");
    return `${s.slice(0, 4)}-${s.slice(4, 7)}-${s.slice(7, 10)}`;
  };
  const make = (b, p, c) => b * 1e6 + p * 1e3 + c;
  const parse = (n) => {
    const s = String(n).padStart(10, "0");
    return { book: +s.slice(0, 4), page: +s.slice(4, 7), parcel: +s.slice(7, 10) };
  };
  const assigned = [
    { book: 8448, page: 62, key: "8448-062" },
    { book: 8448, page: 63, key: "8448-063" },
    { book: 8448, page: 64, key: "8448-064" },
    { book: 8448, page: 65, key: "8448-065" },
  ];

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
    const t = await (await fetch(`/api/parceldetail?ain=${ain}`)).text();
    try {
      return JSON.parse(t);
    } catch {
      return null;
    }
  }

  async function enrich(ainNum, p) {
    let owners = [];
    try {
      const oh = await (
        await fetch(`/api/parcel_ownershiphistory?ain=${String(ainNum).padStart(10, "0")}`)
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

  const pageResults = {};
  const jumps = [];

  for (let pi = 0; pi < assigned.length; pi++) {
    const pg = assigned[pi];
    let ainNum = make(pg.book, pg.page, 1);
    let consecutiveInvalid = 0;
    const valids = [];
    const resultsTrace = [];
    let lastValidParcel = null;
    let checks = 0;
    let stoppedReason = "UNKNOWN";
    const MAX_PER_PAGE = 400;

    while (checks < MAX_PER_PAGE) {
      const meta = parse(ainNum);
      if (meta.page !== pg.page || meta.book !== pg.book) {
        stoppedReason = "PAGE_BOUNDARY";
        break;
      }
      const data = await detail(ainNum);
      checks++;
      if (!isValid(data)) {
        consecutiveInvalid++;
        resultsTrace.push({ ain: fmt(ainNum), status: "INVALID", streak: consecutiveInvalid });
        if (consecutiveInvalid >= HARD_JUMP) {
          const next = assigned[pi + 1];
          jumps.push({
            at: fmt(ainNum),
            streak: consecutiveInvalid,
            from: pg.key,
            to: next ? next.key + "-001" : null,
            reason: "HARD_JUMP_NEXT_ASSIGNED",
          });
          stoppedReason = "20_INVALID_STREAK";
          break;
        }
      } else {
        consecutiveInvalid = 0;
        lastValidParcel = meta.parcel;
        valids.push(await enrich(ainNum, data.Parcel));
        resultsTrace.push({ ain: fmt(ainNum), status: "VALID" });
      }
      ainNum++;
      await sleep(20);
    }
    if (checks >= MAX_PER_PAGE && stoppedReason === "UNKNOWN") stoppedReason = "MAX_CHECKS";

    pageResults[pg.key] = {
      start: pg.key + "-001",
      lastAinChecked: resultsTrace.length ? resultsTrace[resultsTrace.length - 1].ain : null,
      nextCursor: fmt(ainNum),
      validCount: valids.length,
      invalidCount: resultsTrace.filter((r) => r.status !== "VALID").length,
      checks,
      lastValidParcel,
      stoppedReason,
      valids,
      resultsTrace,
    };
  }

  return {
    agent: "agent-07",
    algorithm: "exclusive-page-walk-v1",
    pages: assigned.map((a) => a.key),
    jumps,
    pageResults,
    validCountTotal: Object.values(pageResults).reduce((s, p) => s + (p.validCount || 0), 0),
  };
}
agent07Sweep();
