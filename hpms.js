// HPMS traffic tiles: decode and snap in the browser.
//
// Tiles are built by tools/build_hpms_tiles.py and served gzipped from a public
// R2 bucket (Content-Encoding: gzip, so fetch() hands back plain bytes).
// Each tile covers 0.1 degree and holds road segments clipped to the tile plus
// a small margin, so a point near an edge still finds the road next to it.
//
// Tile layout (little-endian):
//   header   16 bytes: "HPT1", year u16, maxH u16 (tallest segment, grid units), nSeg u32, reserved u32
//   minY     u16[nSeg]   segment bottom edge, ascending (lets a lookup binary-search by latitude)
//   offsets  u32[nSeg]   byte offset of each segment's record, from the start of the tile
//   records  aadt u32 (0 = none), fsystem u8 (0 = unknown), aadtYear u8 (years since 2000, 0 = unknown),
//            nPts u16, then nPts x (x u16, y u16) in grid units
// Grid unit = (0.1 + 2 * MARGIN) / 65535 degrees, origin at the tile corner minus MARGIN.

(function (root) {
  const TILE_DEG = 0.1;
  const MARGIN = 0.001;
  const SPAN = TILE_DEG + 2 * MARGIN;
  const UNIT = SPAN / 65535;
  const M_PER_DEG = 111320;
  const SNAP_M = 30;
  const DIRECTION_TOLERANCE_DEG = 35;
  const DIRECTION_PENALTY_M = 20;
  const HEADER = 16;
  const POINTS_PER_MILE = 10;

  // Typical AADT by FHWA functional system, used only when a matched segment has no AADT.
  const TYPICAL_AADT = { 1: 30000, 2: 20000, 3: 10000, 4: 4500, 5: 1500, 6: 500, 7: 150 };

  const rad = d => d * Math.PI / 180;
  const tileRow = lat => Math.floor(lat * 10);
  const tileCol = lon => Math.floor(lon * 10);
  // Bump this when the tiles are rebuilt from a new HPMS year: it is part of every tile URL, so old
  // copies can never be served for new data (the service worker caches by this name too).
  const DATA_VERSION = 'hpms-2024';
  const tileKey = (row, col) => `${DATA_VERSION}/${row}_${col}.bin.gz`;

  class HpmsTile {
    constructor(buf, row, col) {
      this.view = new DataView(buf);
      if (buf.byteLength < HEADER || this.view.getUint32(0, true) !== 0x31545048) throw new Error('Not an HPMS tile');
      this.year = this.view.getUint16(4, true);
      this.maxH = this.view.getUint16(6, true);
      this.n = this.view.getUint32(8, true);
      this.minYAt = HEADER;
      this.offAt = HEADER + this.n * 2;
      this.x0 = col / 10 - MARGIN;
      this.y0 = row / 10 - MARGIN;
    }

    // Best segment within SNAP_M of the point, preferring ones that run the same way as the route.
    // heading is degrees clockwise from north, or null when unknown.
    query(lat, lon, heading) {
      const v = this.view;
      const py = (lat - this.y0) / UNIT, px = (lon - this.x0) / UNIT;
      const kx = M_PER_DEG * Math.cos(rad(lat)), ky = M_PER_DEG;
      const reach = SNAP_M / (M_PER_DEG * UNIT) + 2; // grid units, generous on both axes
      // First segment whose bottom edge could still reach the point.
      const lowY = py - reach - this.maxH;
      let lo = 0, hi = this.n;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (v.getUint16(this.minYAt + mid * 2, true) < lowY) lo = mid + 1; else hi = mid; }
      let best = null;
      for (let i = lo; i < this.n; i++) {
        if (v.getUint16(this.minYAt + i * 2, true) > py + reach) break;
        const at = v.getUint32(this.offAt + i * 4, true);
        const nPts = v.getUint16(at + 6, true);
        let ax = 0, ay = 0, p = at + 8;
        for (let k = 0; k < nPts; k++, p += 4) {
          const bx = v.getUint16(p, true), by = v.getUint16(p + 2, true);
          if (k > 0) {
            // work in metres around the point
            const ux = (ax - px) * UNIT * kx, uy = (ay - py) * UNIT * ky;
            const wx = (bx - px) * UNIT * kx, wy = (by - py) * UNIT * ky;
            const dx = wx - ux, dy = wy - uy, len2 = dx * dx + dy * dy;
            const t = len2 ? Math.max(0, Math.min(1, -(ux * dx + uy * dy) / len2)) : 0;
            const dist = Math.hypot(ux + t * dx, uy + t * dy);
            if (dist <= SNAP_M) {
              let penalty = 0;
              if (heading !== null && len2 > 1) {
                const segHead = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
                let diff = Math.abs(segHead - heading) % 180;
                if (diff > 90) diff = 180 - diff; // roads are undirected
                if (diff > DIRECTION_TOLERANCE_DEG) penalty = DIRECTION_PENALTY_M;
              }
              const score = dist + penalty;
              if (!best || score < best.score) best = { score, seg: i };
            }
          }
          ax = bx; ay = by;
        }
      }
      if (!best) return null;
      const at = v.getUint32(this.offAt + best.seg * 4, true);
      const yr = v.getUint8(at + 5);
      return { score: best.score, aadt: v.getUint32(at, true), fsystem: v.getUint8(at + 4) || null, aadtYear: yr ? 2000 + yr : null };
    }
  }

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

  const median = a => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return Math.round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2); };

  // pts: [{lat, lon, idx}]. loadTile(row, col) resolves to an ArrayBuffer, or null when there is no tile.
  // exclude(pt) returns true for points whose matches should be ignored (their miles stay estimated).
  // Returns per-mile {mile, aadt, fsystem, aadtSrc: 'hpms' | 'class' | 'none', aadtYear} plus the tile year.
  async function matchRoute(pts, loadTile, { concurrency = 4, exclude = null } = {}) {
    const heads = headings(pts);
    const groups = new Map();
    pts.forEach((p, i) => {
      const row = tileRow(p.lat), col = tileCol(p.lon), k = row + '_' + col;
      if (!groups.has(k)) groups.set(k, { row, col, idx: [] });
      groups.get(k).idx.push(i);
    });
    const matches = pts.map(() => null);
    let year = null, failed = 0;
    const list = [...groups.values()];
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, async () => {
      while (next < list.length) {
        const g = list[next++];
        let tile = null;
        try { const buf = await loadTile(g.row, g.col); if (buf) tile = new HpmsTile(buf, g.row, g.col); } catch { failed++; }
        if (!tile) continue;
        year = tile.year;
        for (const i of g.idx) if (!exclude || !exclude(pts[i])) matches[i] = tile.query(pts[i].lat, pts[i].lon, heads[i]);
      }
    }));
    return { miles: summarizeMiles(pts, matches), year, failedTiles: failed };
  }

  function summarizeMiles(pts, matches) {
    const byMile = new Map();
    pts.forEach((p, i) => {
      const m = Math.floor(p.idx / POINTS_PER_MILE);
      if (!byMile.has(m)) byMile.set(m, []);
      byMile.get(m).push(i);
    });
    const miles = [];
    for (const [mile, idxs] of [...byMile].sort((a, b) => a[0] - b[0])) {
      // Median AADT of matched points; real values beat class defaults.
      const real = [], typical = [], classes = {}, years = [];
      for (const i of idxs) {
        const t = matches[i];
        if (!t) continue;
        if (t.fsystem) classes[t.fsystem] = (classes[t.fsystem] || 0) + 1;
        if (t.aadt > 0) { real.push(t.aadt); if (t.aadtYear) years.push(t.aadtYear); }
        else if (TYPICAL_AADT[t.fsystem]) typical.push(TYPICAL_AADT[t.fsystem]);
      }
      let aadt = null, aadtSrc = 'none';
      if (real.length) { aadt = median(real); aadtSrc = 'hpms'; }
      else if (typical.length) { aadt = median(typical); aadtSrc = 'class'; }
      const cls = Object.entries(classes).sort((a, b) => b[1] - a[1])[0];
      miles.push({ mile, aadt, aadtSrc, fsystem: cls ? +cls[0] : null, aadtYear: years.length ? median(years) : null });
    }
    return miles;
  }

  const api = { DATA_VERSION, TILE_DEG, MARGIN, UNIT, TYPICAL_AADT, tileRow, tileCol, tileKey, HpmsTile, headings, matchRoute, summarizeMiles };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Hpms = api;
})(typeof self !== 'undefined' ? self : globalThis);
