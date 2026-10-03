// Tree canopy along a route, measured in the browser.
//
// Samples the USFS NLCD Tree Canopy Cover ImageServer (getSamples) at 30 m and 60 m on both
// sides of the road. The service allows cross-origin requests, so no proxy is needed.
// Work is split into 30-mile chunks, two at a time, so results can fill in progressively.
// A failed request is retried once; miles that still fail come back as null so the page can
// fall back to its own estimate for those miles only.

// The one place to change if USFS moves the service again (it has moved once already).
const CANOPY_URL = 'https://imagery.geoplatform.gov/iipp/rest/services/Vegetation/USFS_EDW_NLCD_TCC_CONUS/ImageServer';

(function (root) {
  const POINTS_PER_MILE = 10;
  const CHUNK_MILES = 30;
  const BATCH = 1000;              // the service silently truncates getSamples beyond this
  const OFFSETS_M = [-60, -30, 30, 60]; // perpendicular, skipping the road surface
  const TIMEOUT_MS = 15000;
  const M_PER_DEG = 111320;
  const rad = d => d * Math.PI / 180;

  // Heading in degrees clockwise from north, from neighbouring points (index gaps over 2 are ignored).
  function headings(pts) {
    return pts.map((p, i) => {
      let a = pts[i - 1], b = pts[i + 1];
      if (a && p.idx - a.idx > 2) a = null;
      if (b && b.idx - p.idx > 2) b = null;
      a = a || p; b = b || p;
      if (a === b) return null;
      const dy = (b.lat - a.lat) * M_PER_DEG;
      const dx = (b.lon - a.lon) * M_PER_DEG * Math.cos(rad(p.lat));
      return (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
    });
  }

  function offsetPoint(p, headingDeg, meters) {
    const h = rad(headingDeg + 90); // right-hand perpendicular; negative meters = left
    return [
      p.lon + (meters * Math.sin(h)) / (M_PER_DEG * Math.cos(rad(p.lat))),
      p.lat + (meters * Math.cos(h)) / M_PER_DEG,
    ];
  }

  // POST a form to the service. Retries once, including on a 5xx or a timeout. Resolves to JSON or null.
  async function post(path, form, fetchImpl) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetchImpl(CANOPY_URL + path, { method: 'POST', body: new URLSearchParams(form), signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (res.ok) {
          const j = await res.json();
          if (!j.error) return j;
        }
      } catch { /* retry */ }
    }
    return null;
  }

  let yearPromise = null;
  function lookupYear(rasterId, fetchImpl) {
    if (!yearPromise) {
      yearPromise = post('/query', { objectIds: String(rasterId), outFields: 'endyear', returnGeometry: 'false', f: 'json' }, fetchImpl)
        .then(j => (j && j.features && j.features[0] && j.features[0].attributes.endyear) || null)
        .catch(() => null);
    }
    return yearPromise;
  }

  // Measure one chunk of points ([{lat, lon, idx}], consecutive). Resolves to per-mile results.
  async function measureChunk(pts, fetchImpl = (u, i) => fetch(u, i)) {
    const heads = headings(pts);
    const flat = [];
    pts.forEach((p, i) => {
      if (heads[i] === null) return; // can't tell which way is "sideways"
      for (const m of OFFSETS_M) flat.push({ i, xy: offsetPoint(p, heads[i], m) });
    });
    const sums = pts.map(() => ({ sum: 0, n: 0 }));
    let rasterId = null;
    const batches = [];
    for (let k = 0; k < flat.length; k += BATCH) batches.push(flat.slice(k, k + BATCH));
    const results = await Promise.all(batches.map(batch => post('/getSamples', {
      geometry: JSON.stringify({ points: batch.map(b => b.xy.map(v => +v.toFixed(6))), spatialReference: { wkid: 4326 } }),
      geometryType: 'esriGeometryMultipoint',
      returnFirstValueOnly: 'true',
      f: 'json',
    }, fetchImpl).then(j => ({ batch, j }))));
    for (const { batch, j } of results) {
      if (!j || !Array.isArray(j.samples)) continue; // this batch failed twice; its points stay unsampled
      for (const s of j.samples) {
        const b = batch[s.locationId];
        const v = Number(s.value);
        if (!b || s.value === '' || !Number.isFinite(v) || v < 0 || v > 100) continue; // 254/255 and NoData
        sums[b.i].sum += v; sums[b.i].n++;
        if (rasterId === null) rasterId = s.rasterId;
      }
    }
    const byMile = new Map();
    pts.forEach((p, i) => {
      const m = Math.floor(p.idx / POINTS_PER_MILE);
      const a = byMile.get(m) || byMile.set(m, { sum: 0, n: 0 }).get(m);
      a.sum += sums[i].sum; a.n += sums[i].n;
    });
    const year = rasterId !== null ? await lookupYear(rasterId, fetchImpl) : null;
    const miles = [...byMile].sort((a, b) => a[0] - b[0]).map(([mile, a]) => ({ mile, canopyPct: a.n ? Math.round(a.sum / a.n) : null }));
    // A chunk has failed when none of its miles could be measured.
    return { miles, year, failed: miles.every(m => m.canopyPct === null) };
  }

  // pts: [{lat, lon, idx}] sorted by idx. onChunk(miles) fires as each chunk finishes.
  // Resolves to { miles, year, chunks, failedChunks } with a null canopyPct for any mile that could not be measured.
  async function measureRoute(pts, { onChunk, fetchImpl = (u, i) => fetch(u, i), concurrency = 2 } = {}) {
    const size = CHUNK_MILES * POINTS_PER_MILE;
    const chunks = new Map();
    for (const p of pts) {
      const c = Math.floor(p.idx / size);
      if (!chunks.has(c)) chunks.set(c, []);
      chunks.get(c).push(p);
    }
    const list = [...chunks.values()];
    const all = [];
    let year = null, next = 0, failedChunks = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, async () => {
      while (next < list.length) {
        const r = await measureChunk(list[next++], fetchImpl);
        all.push(...r.miles);
        if (r.year) year = r.year;
        if (r.failed) failedChunks++;
        if (onChunk) onChunk(r.miles);
      }
    }));
    all.sort((a, b) => a.mile - b.mile);
    return { miles: all, year, chunks: list.length, failedChunks };
  }

  const api = { CHUNK_MILES, measureChunk, measureRoute };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Canopy = api;
})(typeof self !== 'undefined' ? self : globalThis);
