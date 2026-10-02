// moto-route-proxy
// /route  Turns a Google Maps directions link (short or full) into road
//         geometry using the Google Routes API. The API key lives only here,
//         as an encrypted Worker secret, and is never sent to the browser.
// /enrich Looks up measured tree canopy (USFS NLCD TCC) and traffic (FHWA
//         HPMS) along a route. Both are public services and need no key.

const MAX_LINK_LENGTH = 8000;
const MAX_STOPS = 27; // origin + 25 intermediates + destination

export default {
  async fetch(request, env) {
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    const origin = request.headers.get('Origin') || '';
    const originOk = allowed.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': originOk ? origin : (allowed[0] || ''),
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    };

    if (request.method === 'OPTIONS') return new Response(null, { status: originOk ? 204 : 403, headers: cors });
    if (!originOk) return json({ error: 'This site is not allowed to use the route service.' }, 403, cors);

    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/enrich') return handleEnrich(request, env, cors);
    if (request.method !== 'POST' || url.pathname !== '/route') return json({ error: 'Not found.' }, 404, cors);
    if (!env.GOOGLE_MAPS_KEY) return json({ error: 'The route service is missing its Google key.' }, 500, cors);

    let body;
    try { body = await request.json(); } catch { return json({ error: 'Invalid request.' }, 400, cors); }
    const link = String((body && body.link) || '').trim();
    if (!link) return json({ error: 'Paste a Google Maps directions link first.' }, 400, cors);
    if (link.length > MAX_LINK_LENGTH) return json({ error: 'That link is too long.' }, 400, cors);

    try {
      const fullUrl = await expandLink(link);
      const plan = parseGoogleUrl(fullUrl);
      const route = await computeRoute(plan, env.GOOGLE_MAPS_KEY);
      return json({
        stops: plan.stops,
        avoidHighways: plan.avoidHighways,
        avoidTolls: plan.avoidTolls,
        avoidFerries: plan.avoidFerries,
        distanceMeters: route.distanceMeters,
        encodedPolyline: route.encodedPolyline,
      }, 200, cors);
    } catch (e) {
      return json({ error: e.message || 'Something went wrong.' }, e.status || 400, cors);
    }
  },
};

function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
}

function fail(message, status = 400) {
  const e = new Error(message); e.status = status; return e;
}

const isGoogleHost = h => /(^|\.)google\.[a-z]{2,3}(\.[a-z]{2})?$/.test(h);
const isShortHost = h => h === 'maps.app.goo.gl' || h === 'goo.gl';

// Follow a short link's redirects. Only Google hosts are ever fetched,
// so the proxy can't be pointed at arbitrary URLs.
async function expandLink(link) {
  let current;
  try { current = new URL(link); } catch { throw fail("That doesn't look like a link."); }
  if (isGoogleHost(current.hostname)) return current.toString();
  if (!isShortHost(current.hostname)) throw fail('Only Google Maps links are supported.');
  if (current.hostname === 'goo.gl' && !current.pathname.startsWith('/maps')) throw fail('Only Google Maps links are supported.');

  for (let hop = 0; hop < 5; hop++) {
    const res = await fetch(current.toString(), { redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0 (route-compare proxy)' } });
    const location = res.headers.get('Location');
    if (!location) break;
    current = new URL(location, current);
    if (isGoogleHost(current.hostname)) return current.toString();
    if (!isShortHost(current.hostname)) throw fail('That short link points somewhere other than Google Maps.');
  }
  throw fail("Couldn't open that short link. Try opening it and copying the full address instead.");
}

function parseGoogleUrl(raw) {
  const url = new URL(raw);
  const m = url.pathname.match(/\/maps\/dir\/(.*)$/);
  if (!m) throw fail("This isn't a directions link. In Google Maps, open Directions, then share or copy that link.");
  const segs = m[1].split('/');
  if (segs[0] === '') throw fail('This route starts at "Your location". Set a real starting address in Google Maps, then copy the link again.');
  const stops = [];
  for (const seg of segs) {
    if (seg.startsWith('@') || seg.startsWith('data=')) break;
    const t = decodeURIComponent(seg.replace(/\+/g, ' ')).trim();
    if (t) stops.push(t);
  }
  if (stops.length < 2) throw fail('The link needs at least a start and an end.');
  if (stops.length > MAX_STOPS) throw fail('That route has too many stops (27 max).');
  const dm = raw.match(/data=([^?&#]*)/);
  const data = dm ? dm[1] : '';
  const am = data.match(/!2m\d+((?:!\db[01])+)/);
  const flags = am ? am[1] : '';
  return { stops, avoidHighways: /!1b1/.test(flags), avoidTolls: /!2b1/.test(flags), avoidFerries: /!3b1/.test(flags) };
}

function toWaypoint(s) {
  const c = s.match(/^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)$/);
  return c ? { location: { latLng: { latitude: +c[1], longitude: +c[2] } } } : { address: s };
}

async function computeRoute(plan, key) {
  const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': 'routes.polyline.encodedPolyline,routes.distanceMeters',
    },
    body: JSON.stringify({
      origin: toWaypoint(plan.stops[0]),
      destination: toWaypoint(plan.stops[plan.stops.length - 1]),
      intermediates: plan.stops.slice(1, -1).map(toWaypoint),
      travelMode: 'DRIVE',
      polylineQuality: 'HIGH_QUALITY',
      routeModifiers: { avoidHighways: plan.avoidHighways, avoidTolls: plan.avoidTolls, avoidFerries: plan.avoidFerries },
    }),
  });
  const j = await res.json().catch(() => ({}));
  if (res.status === 429) throw fail('The route service is busy or over its daily limit. Try again later.', 429);
  if (!res.ok) throw fail('Google could not route that link.', 502);
  if (!j.routes || !j.routes.length) throw fail('Google found no drivable route for those stops.', 422);
  return { encodedPolyline: j.routes[0].polyline.encodedPolyline, distanceMeters: j.routes[0].distanceMeters };
}

// ───────────────────────── /enrich ─────────────────────────

const MAX_POINTS = 4000;
const POINTS_PER_MILE = 10;
const CANOPY_URL = 'https://imagery.geoplatform.gov/iipp/rest/services/Vegetation/USFS_EDW_NLCD_TCC_CONUS/ImageServer';
const CANOPY_BATCH = 1000;          // the service silently truncates getSamples beyond this
const CANOPY_OFFSETS_M = [-60, -30, 30, 60]; // perpendicular, skipping the road surface
const HPMS_BASE = 'https://geo.dot.gov/server/rest/services/Hosted';
const HPMS_YEARS = [2024, 2023, 2022, 2021, 2020, 2019]; // newest first; first one that exists wins
const HPMS_TILE_DEG = 0.1;
const SNAP_M = 30;
const DIRECTION_TOLERANCE_DEG = 35;
const DIRECTION_PENALTY_M = 20;
const CACHE_TTL = 60 * 60 * 24 * 30;
const SERVICE_TTL = 60 * 60 * 24 * 7;
const FETCH_TIMEOUT_MS = 8000;
const TOTAL_BUDGET_MS = 24000;
const CONCURRENCY = 6;
const DEFAULT_SUBREQUEST_BUDGET = 45; // Workers Free allows 50; set SUBREQUEST_BUDGET to ~900 on a paid plan

// Typical AADT by FHWA functional system, used only when a matched segment has no AADT.
const TYPICAL_AADT = { 1: 30000, 2: 20000, 3: 10000, 4: 4500, 5: 1500, 6: 500, 7: 150 };

// Padded [south, west, north, east] boxes. Over-inclusion only costs an empty query.
const STATE_BOXES = {
  AL: [30.15, -88.55, 35.05, -84.85], AR: [32.95, -94.65, 36.55, -89.60], AZ: [31.30, -114.85, 37.05, -109.00],
  CA: [32.50, -124.50, 42.05, -114.10], CO: [36.95, -109.10, 41.05, -102.00], CT: [40.95, -73.75, 42.10, -71.75],
  DE: [38.40, -75.80, 39.85, -75.04], FL: [24.35, -87.65, 31.05, -79.95], GA: [30.30, -85.65, 35.05, -80.80],
  IA: [40.35, -96.70, 43.55, -90.10], ID: [41.95, -117.30, 49.05, -111.00], IL: [36.95, -91.55, 42.55, -87.45],
  IN: [37.75, -88.15, 41.80, -84.75], KS: [36.95, -102.10, 40.05, -94.55], KY: [36.45, -89.60, 39.20, -81.90],
  LA: [28.90, -94.10, 33.05, -88.80], MA: [41.20, -73.55, 42.90, -69.90], MD: [37.85, -79.50, 39.75, -75.00],
  ME: [43.05, -71.15, 47.50, -66.90], MI: [41.65, -90.45, 48.30, -82.10], MN: [43.45, -97.25, 49.40, -89.45],
  MO: [35.95, -95.80, 40.65, -89.05], MS: [30.15, -91.70, 35.05, -88.05], MT: [44.35, -116.10, 49.05, -104.00],
  NC: [33.80, -84.35, 36.60, -75.40], ND: [45.90, -104.10, 49.05, -96.55], NE: [39.95, -104.10, 43.05, -95.30],
  NH: [42.65, -72.60, 45.35, -70.60], NJ: [38.90, -75.60, 41.40, -73.85], NM: [31.30, -109.10, 37.05, -103.00],
  NV: [34.95, -120.05, 42.05, -114.00], NY: [40.45, -79.80, 45.05, -71.80], OH: [38.40, -84.85, 42.00, -80.50],
  OK: [33.60, -103.05, 37.05, -94.40], OR: [41.95, -124.60, 46.30, -116.45], PA: [39.70, -80.55, 42.30, -74.65],
  RI: [41.05, -71.90, 42.05, -71.10], SC: [32.00, -83.40, 35.25, -78.50], SD: [42.45, -104.10, 45.95, -96.40],
  TN: [34.95, -90.35, 36.70, -81.60], TX: [25.80, -106.70, 36.55, -93.50], UT: [36.95, -114.10, 42.05, -109.00],
  VA: [36.50, -83.70, 39.50, -75.20], VT: [42.70, -73.45, 45.05, -71.45], WA: [45.50, -124.80, 49.05, -116.90],
  WI: [42.45, -92.90, 47.10, -86.75], WV: [37.15, -82.65, 40.65, -77.70], WY: [40.95, -111.10, 45.05, -104.00],
  DC: [38.78, -77.13, 39.00, -76.90],
};

async function handleEnrich(request, env, cors) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request.' }, 400, cors); }
  const raw = body && body.points;
  if (!Array.isArray(raw) || !raw.length) return json({ error: 'No points to look up.' }, 400, cors);
  if (raw.length > MAX_POINTS) return json({ error: `Too many points (${MAX_POINTS} max).` }, 413, cors);
  // Each point is [lat, lon, index]; index is the point's 0.1-mile position along the full route.
  const pts = [];
  for (const p of raw) {
    if (!Array.isArray(p) || p.length < 3) return json({ error: 'Invalid point.' }, 400, cors);
    const lat = +p[0], lon = +p[1], idx = Math.round(+p[2]);
    if (!(lat > 15 && lat < 72 && lon > -180 && lon < -60) || !(idx >= 0)) return json({ error: 'Invalid point.' }, 400, cors);
    pts.push({ lat, lon, idx });
  }
  pts.sort((a, b) => a.idx - b.idx);

  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const key = new Request('https://enrich.cache.invalid/' + await sha256(pts.map(p => `${p.lat.toFixed(4)},${p.lon.toFixed(4)},${p.idx}`).join(';')));
  if (cache) {
    const hit = await cache.match(key);
    if (hit) return new Response(hit.body, { status: 200, headers: { ...cors, 'Content-Type': 'application/json', 'X-Enrich-Cache': 'hit' } });
  }

  const ctx = makeContext(env);
  const result = await enrich(pts, ctx);
  const out = JSON.stringify(result);
  if (cache && !ctx.degraded) {
    await cache.put(key, new Response(out, { headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${CACHE_TTL}` } }));
  }
  return new Response(out, { status: 200, headers: { ...cors, 'Content-Type': 'application/json', 'X-Enrich-Cache': 'miss' } });
}

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Shared per-request state: a subrequest budget, a time budget, and a small
// worker pool so government servers never see more than CONCURRENCY calls at once.
function makeContext(env) {
  const started = Date.now();
  const budget = +(env && env.SUBREQUEST_BUDGET) || DEFAULT_SUBREQUEST_BUDGET;
  const ctx = {
    degraded: false,
    used: 0,
    budget,
    fetchImpl: (env && env.fetchImpl) || ((u, i) => fetch(u, i)), // wrapped: a bare fetch called as a method throws in Workers
    timeLeft: () => TOTAL_BUDGET_MS - (Date.now() - started),
    // Resolves to parsed JSON, or null on timeout/error/over-budget. Never throws.
    async getJSON(url, form, probe = false) {
      const miss = () => { if (!probe) ctx.degraded = true; return null; }; // a probe for a missing year is expected to fail
      if (ctx.used >= ctx.budget || ctx.timeLeft() < 1000) { ctx.degraded = true; return null; }
      ctx.used++;
      try {
        const init = { signal: AbortSignal.timeout(Math.min(FETCH_TIMEOUT_MS, ctx.timeLeft())), headers: { 'User-Agent': 'moto-route-proxy' } };
        if (form) {
          init.method = 'POST';
          init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
          init.body = new URLSearchParams(form).toString();
        }
        const res = await ctx.fetchImpl(url, init);
        if (!res.ok) return miss();
        const j = await res.json();
        if (j && j.error) return miss();
        return j;
      } catch { return miss(); }
    },
  };
  return ctx;
}

async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; results[i] = await fn(items[i], i); }
  }));
  return results;
}

async function enrich(pts, ctx) {
  const [canopy, traffic] = await Promise.all([sampleCanopy(pts, ctx), matchTraffic(pts, ctx)]);

  const byMile = new Map();
  pts.forEach((p, i) => {
    const m = Math.floor(p.idx / POINTS_PER_MILE);
    if (!byMile.has(m)) byMile.set(m, []);
    byMile.get(m).push(i);
  });

  const miles = [];
  let canopyN = 0, trafficN = 0, trafficMeasured = 0;
  for (const [mile, idxs] of [...byMile].sort((a, b) => a[0] - b[0])) {
    // Canopy: mean of every valid sample across the mile's points.
    let sum = 0, n = 0;
    for (const i of idxs) for (const v of canopy.values[i]) { sum += v; n++; }
    const canopyPct = n ? Math.round(sum / n) : null;

    // Traffic: median AADT of matched points; real values beat class defaults.
    const real = [], typical = [], classes = {};
    for (const i of idxs) {
      const t = traffic.matches[i];
      if (!t) continue;
      classes[t.fsystem] = (classes[t.fsystem] || 0) + 1;
      if (t.aadt > 0) real.push(t.aadt); else if (TYPICAL_AADT[t.fsystem]) typical.push(TYPICAL_AADT[t.fsystem]);
    }
    let aadt = null, aadtSrc = 'none', fsystem = null;
    if (real.length) { aadt = median(real); aadtSrc = 'hpms'; }
    else if (typical.length) { aadt = median(typical); aadtSrc = 'class'; }
    const cls = Object.entries(classes).sort((a, b) => b[1] - a[1])[0];
    if (cls) fsystem = +cls[0];

    if (canopyPct !== null) canopyN++;
    if (aadtSrc !== 'none') trafficN++;
    if (aadtSrc === 'hpms') trafficMeasured++;
    miles.push({ mile, canopyPct, aadt, fsystem, aadtSrc, canopySrc: canopyPct !== null ? 'nlcd' : 'none' });
  }
  const total = miles.length || 1;
  return {
    miles,
    coverage: { canopy: canopyN / total, traffic: trafficN / total, trafficMeasured: trafficMeasured / total },
    sources: { canopy: canopy.source, traffic: traffic.sources },
    degraded: ctx.degraded,
  };
}

function median(a) {
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return Math.round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
}

// ── geometry helpers ──

const M_PER_DEG_LAT = 111320;
const toRad = d => d * Math.PI / 180;

// Heading in degrees clockwise from north, from neighbouring points.
function headings(pts) {
  return pts.map((p, i) => {
    let a = pts[i - 1], b = pts[i + 1];
    if (a && p.idx - a.idx > 2) a = null;
    if (b && b.idx - p.idx > 2) b = null;
    a = a || p; b = b || p;
    if (a === b) return null;
    const dy = (b.lat - a.lat) * M_PER_DEG_LAT;
    const dx = (b.lon - a.lon) * M_PER_DEG_LAT * Math.cos(toRad(p.lat));
    return (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
  });
}

function offsetPoint(p, headingDeg, meters) {
  const h = toRad(headingDeg + 90); // right-hand perpendicular; negative meters = left
  return [
    p.lon + (meters * Math.sin(h)) / (M_PER_DEG_LAT * Math.cos(toRad(p.lat))),
    p.lat + (meters * Math.cos(h)) / M_PER_DEG_LAT,
  ];
}

// ── tree canopy ──

async function sampleCanopy(pts, ctx) {
  const heads = headings(pts);
  const flat = []; // {i, xy}
  pts.forEach((p, i) => {
    if (heads[i] === null) return; // can't tell which way is "sideways"
    for (const m of CANOPY_OFFSETS_M) flat.push({ i, xy: offsetPoint(p, heads[i], m) });
  });
  const values = pts.map(() => []);
  let year = null, rasterId = null;

  const batches = [];
  for (let k = 0; k < flat.length; k += CANOPY_BATCH) batches.push(flat.slice(k, k + CANOPY_BATCH));
  await pool(batches, CONCURRENCY, async batch => {
    const j = await ctx.getJSON(CANOPY_URL + '/getSamples', {
      geometry: JSON.stringify({ points: batch.map(b => b.xy.map(v => +v.toFixed(6))), spatialReference: { wkid: 4326 } }),
      geometryType: 'esriGeometryMultipoint',
      returnFirstValueOnly: 'true',
      f: 'json',
    });
    if (!j || !Array.isArray(j.samples)) return;
    for (const s of j.samples) {
      const b = batch[s.locationId];
      const v = Number(s.value);
      if (!b || s.value === '' || !Number.isFinite(v) || v < 0 || v > 100) continue; // 254/255 and NoData
      values[b.i].push(v);
      if (rasterId === null) rasterId = s.rasterId;
    }
  });

  if (rasterId !== null) {
    const info = await ctx.getJSON(CANOPY_URL + '/query', { objectIds: String(rasterId), outFields: 'endyear', returnGeometry: 'false', f: 'json' });
    const f = info && info.features && info.features[0];
    if (f) year = f.attributes.endyear;
  }
  return { values, source: { name: 'USFS NLCD Tree Canopy Cover', year } };
}

// ── traffic ──

const tileKey = (lat, lon) => `${Math.floor(lat / HPMS_TILE_DEG)}_${Math.floor(lon / HPMS_TILE_DEG)}`;

function statesFor(lat, lon) {
  const out = [];
  for (const [st, [s, w, n, e]] of Object.entries(STATE_BOXES)) if (lat >= s && lat <= n && lon >= w && lon <= e) out.push(st);
  return out;
}

// Find the newest HPMS service for a state and its polyline layer. Cached for a week.
async function resolveHpms(state, ctx) {
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const key = new Request('https://hpms.cache.invalid/service/' + state);
  if (cache) {
    const hit = await cache.match(key);
    if (hit) return (await hit.json()) || null;
  }
  let found = null;
  for (const year of HPMS_YEARS) {
    const base = `${HPMS_BASE}/HPMS_FULL_${state}_${year}/FeatureServer`;
    const info = await ctx.getJSON(base + '?f=json', null, true);
    if (!info) continue; // not published for that year: try the next one
    const layer = (info.layers || []).find(l => /hpms|full/i.test(l.name)) || (info.layers || [])[0];
    if (layer) { found = { base, layerId: layer.id, year }; break; }
  }
  if (cache && found) {
    await cache.put(key, new Response(JSON.stringify(found), { headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${SERVICE_TTL}` } }));
  }
  return found;
}

async function fetchTile(svc, tile, ctx) {
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const key = new Request(`https://hpms.cache.invalid/tile/${svc.base.split('/Hosted/')[1]}/${tile.k}`);
  if (cache) {
    const hit = await cache.match(key);
    if (hit) return hit.json();
  }
  const segs = [];
  let complete = true;
  for (let page = 0; page < 5; page++) {
    const j = await ctx.getJSON(`${svc.base}/${svc.layerId}/query`, {
      geometry: `${tile.w},${tile.s},${tile.e},${tile.n}`,
      geometryType: 'esriGeometryEnvelope',
      inSR: '4326', outSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      outFields: 'AADT,F_SYSTEM',
      returnGeometry: 'true',
      maxAllowableOffset: '0.00004',
      geometryPrecision: '5',
      resultOffset: String(page * 1000),
      resultRecordCount: '1000',
      f: 'json',
    });
    if (!j || !Array.isArray(j.features)) { complete = false; break; }
    for (const f of j.features) {
      const a = f.attributes || {};
      // Field names are case-insensitive in practice but some services upper/lower them.
      const aadt = pick(a, 'AADT'), fs = pick(a, 'F_SYSTEM');
      for (const path of (f.geometry && f.geometry.paths) || []) segs.push({ aadt: aadt > 0 ? aadt : 0, fsystem: fs, path });
    }
    if (!j.exceededTransferLimit) break;
    if (page === 4) complete = false;
  }
  if (cache && complete) {
    await cache.put(key, new Response(JSON.stringify(segs), { headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${CACHE_TTL}` } }));
  }
  return segs;
}

function pick(attrs, name) {
  const k = Object.keys(attrs).find(x => x.toUpperCase() === name);
  const v = k === undefined ? null : attrs[k];
  return v === null || v === undefined ? null : Number(v);
}

async function matchTraffic(pts, ctx) {
  const matches = pts.map(() => null);
  const sources = {};

  // Group points by (state, tile) so each tile is queried once per state.
  const groups = new Map();
  pts.forEach((p, i) => {
    for (const st of statesFor(p.lat, p.lon)) {
      const k = tileKey(p.lat, p.lon);
      const gk = st + '|' + k;
      if (!groups.has(gk)) {
        const [r, c] = k.split('_').map(Number);
        groups.set(gk, { st, tile: { k, s: r * HPMS_TILE_DEG, w: c * HPMS_TILE_DEG, n: (r + 1) * HPMS_TILE_DEG, e: (c + 1) * HPMS_TILE_DEG }, idx: [] });
      }
      groups.get(gk).idx.push(i);
    }
  });

  const states = [...new Set([...groups.values()].map(g => g.st))];
  const services = {};
  await pool(states, CONCURRENCY, async st => { services[st] = await resolveHpms(st, ctx); });
  for (const st of states) if (services[st]) sources[st] = services[st].year;

  const heads = headings(pts);
  await pool([...groups.values()], CONCURRENCY, async g => {
    const svc = services[g.st];
    if (!svc) return;
    const segs = await fetchTile(svc, g.tile, ctx);
    if (!segs.length) return;
    const index = buildIndex(segs);
    for (const i of g.idx) {
      const hit = snap(pts[i], heads[i], index);
      if (hit && (!matches[i] || hit.score < matches[i].score)) matches[i] = hit;
    }
  });
  return { matches, sources };
}

// Spatial hash over sub-segments: cells are ~55 m so a 3x3 neighbourhood covers 30 m.
const CELL = 0.0005;
function buildIndex(segs) {
  const cells = new Map();
  const add = (cx, cy, rec) => { const k = cx + '_' + cy; (cells.get(k) || cells.set(k, []).get(k)).push(rec); };
  for (const seg of segs) {
    const p = seg.path;
    for (let i = 1; i < p.length; i++) {
      const rec = { seg, a: p[i - 1], b: p[i] };
      const x0 = Math.floor(Math.min(rec.a[0], rec.b[0]) / CELL), x1 = Math.floor(Math.max(rec.a[0], rec.b[0]) / CELL);
      const y0 = Math.floor(Math.min(rec.a[1], rec.b[1]) / CELL), y1 = Math.floor(Math.max(rec.a[1], rec.b[1]) / CELL);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) add(x, y, rec);
    }
  }
  return cells;
}

function snap(p, heading, cells) {
  const cx = Math.floor(p.lon / CELL), cy = Math.floor(p.lat / CELL);
  const kx = M_PER_DEG_LAT * Math.cos(toRad(p.lat)), ky = M_PER_DEG_LAT;
  let best = null;
  const seen = new Set();
  for (let x = cx - 1; x <= cx + 1; x++) for (let y = cy - 1; y <= cy + 1; y++) {
    for (const rec of cells.get(x + '_' + y) || []) {
      if (seen.has(rec)) continue;
      seen.add(rec);
      const ax = (rec.a[0] - p.lon) * kx, ay = (rec.a[1] - p.lat) * ky;
      const bx = (rec.b[0] - p.lon) * kx, by = (rec.b[1] - p.lat) * ky;
      const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
      const dist = Math.hypot(ax + t * dx, ay + t * dy);
      if (dist > SNAP_M) continue;
      let penalty = 0;
      if (heading !== null && len2 > 1) {
        const segHead = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
        let diff = Math.abs(segHead - heading) % 180;
        if (diff > 90) diff = 180 - diff; // roads are undirected
        if (diff > DIRECTION_TOLERANCE_DEG) penalty = DIRECTION_PENALTY_M;
      }
      const score = dist + penalty;
      if (!best || score < best.score) best = { score, aadt: rec.seg.aadt, fsystem: rec.seg.fsystem };
    }
  }
  return best;
}

export { enrich, makeContext };
