// Timeline to GPX: pure logic (no DOM). Loaded by timeline.html, and by Node for tests.
// Reads a Google Maps Timeline export (iPhone "segments" array or Android "semanticSegments"),
// pulls one day's rides, snaps the sparse GPS points to roads with a map-matching service,
// and writes a GPX file.
const Timeline = (() => {
  const OSRM_URL = 'https://router.project-osrm.org';
  const CHUNK = 80;          // points per match request (the public server allows 100)
  const OVERLAP = 3;         // shared points between chunks so the pieces join cleanly
  const RADIUS_M = 75;       // how far from a logged point the matcher may look for a road
  const MODES = {
    moto: { label: 'Motorcycle rides only', test: t => /motorcycl/i.test(t) },
    vehicle: { label: 'Motorcycle and car trips', test: t => /motorcycl|vehicle|driving|car\b/i.test(t) },
    all: { label: 'Everything that moved', test: () => true },
  };

  // ── Geometry ──
  const rad = d => d * Math.PI / 180;
  function dist(a, b) { // metres between [lat,lng] pairs
    const dLa = rad(b[0] - a[0]), dLo = rad(b[1] - a[1]);
    const h = Math.sin(dLa / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLo / 2) ** 2;
    return 12742000 * Math.asin(Math.sqrt(h));
  }
  function length(pts) { let s = 0; for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1], pts[i]); return s; }
  const miles = m => m / 1609.344;

  // ── Parsing ──
  const PAIR = /(-?\d+(?:\.\d+)?)[^-\d]+(-?\d+(?:\.\d+)?)/;
  function latlng(v) { // "geo:38.25,-85.67", "38.25°, -85.67°", or {latLng:"..."}
    if (v && typeof v === 'object') v = v.latLng || v.point || v.placeLocation;
    if (v && typeof v === 'object') v = v.latLng;
    const m = PAIR.exec(String(v || ''));
    if (!m) return null;
    const la = +m[1], lo = +m[2];
    return Math.abs(la) <= 90 && Math.abs(lo) <= 180 ? [la, lo] : null;
  }

  // Returns { acts: [{s,e,day,type}], visits: [{s,e,ll}], points: [{t,ll}] } sorted by time
  function parse(data) {
    let segs;
    if (Array.isArray(data)) segs = data;                       // iPhone export
    else if (data && Array.isArray(data.semanticSegments)) segs = data.semanticSegments; // Android export
    else throw new Error("That doesn't look like a Timeline export. Export it from Google Maps on your phone (Timeline, then settings, then Export Timeline data).");
    const acts = [], visits = [], points = [];
    for (const g of segs) {
      const s = Date.parse(g.startTime), e = Date.parse(g.endTime);
      if (!(s <= e)) continue;
      if (g.timelinePath) {
        for (const p of g.timelinePath) {
          const ll = latlng(p.point);
          if (!ll) continue;
          const t = p.time ? Date.parse(p.time) : s + (+p.durationMinutesOffsetFromStartTime || 0) * 60000;
          if (t >= 0) points.push({ t, ll });
        }
      } else if (g.activity) {
        const type = (g.activity.topCandidate && g.activity.topCandidate.type) || 'unknown';
        acts.push({ s, e, day: String(g.startTime).slice(0, 10), type });
      } else if (g.visit) {
        const ll = latlng(g.visit.topCandidate && g.visit.topCandidate.placeLocation);
        if (ll) visits.push({ s, e, ll });
      }
    }
    points.sort((a, b) => a.t - b.t);
    acts.sort((a, b) => a.s - b.s);
    return { acts, visits, points };
  }

  // Days that have at least one matching activity, newest first
  function listDays(tl, mode) {
    const test = MODES[mode].test, days = new Map();
    for (const a of tl.acts) {
      if (!test(a.type)) continue;
      const d = days.get(a.day) || { day: a.day, legs: 0, ms: 0 };
      d.legs++; d.ms += a.e - a.s;
      days.set(a.day, d);
    }
    return [...days.values()].sort((a, b) => (a.day < b.day ? 1 : -1));
  }

  // Each activity on the day becomes a leg with its logged points (tiny duplicates removed)
  function legsFor(tl, day, mode) {
    const test = MODES[mode].test, legs = [];
    const SLACK = 30000;
    for (const a of tl.acts) {
      if (a.day !== day || !test(a.type)) continue;
      const pts = [];
      for (const p of tl.points) { // points are time-sorted; windows are small, so a plain scan is fine
        if (p.t < a.s - SLACK) continue;
        if (p.t > a.e + SLACK) break;
        if (!pts.length || dist(pts[pts.length - 1].ll, p.ll) > 5) pts.push(p);
      }
      legs.push({ s: a.s, e: a.e, type: a.type, raw: pts });
    }
    return legs;
  }

  function stopsFor(tl, legs) { // places where the bike sat 10+ minutes between the day's first and last leg
    if (!legs.length) return [];
    const from = legs[0].s, to = legs[legs.length - 1].e;
    return tl.visits.filter(v => v.s >= from - 60000 && v.e <= to + 60000 && v.e - v.s >= 600000);
  }

  // ── Snapping ──
  async function matchChunk(pts, fetchFn, base) {
    const coords = pts.map(p => p.ll[1].toFixed(6) + ',' + p.ll[0].toFixed(6)).join(';');
    const url = base + '/match/v1/driving/' + coords +
      '?geometries=geojson&overview=full&gaps=ignore&tidy=true&radiuses=' + pts.map(() => RADIUS_M).join(';');
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetchFn(url);
      if (res.status === 429 || res.status >= 500) { await new Promise(r => setTimeout(r, 1500 * (attempt + 1))); continue; }
      const j = await res.json();
      if (j.code !== 'Ok' || !j.matchings || !j.matchings.length) return null;
      const matched = (j.tracepoints || []).filter(Boolean).length;
      if (matched < pts.length * 0.8) return null;
      const line = [];
      for (const m of j.matchings) for (const c of m.geometry.coordinates) line.push([c[1], c[0]]);
      const ratio = length(line) / Math.max(1, length(pts.map(p => p.ll)));
      if (ratio > 1.8 || ratio < 0.7) return null; // took a big detour or dropped part of the route
      return line;
    }
    throw new Error('The map-matching service is busy or unreachable. Try again in a minute.');
  }

  function join(acc, next) { // glue two snapped pieces that share OVERLAP points
    if (!acc.length) return next.slice();
    const end = acc[acc.length - 1];
    let best = 0, bd = Infinity;
    for (let i = 0; i < Math.min(next.length, 60); i++) { const d = dist(end, next[i]); if (d < bd) { bd = d; best = i; } }
    return acc.concat(next.slice(bd < 300 ? best + 1 : 0));
  }

  // Returns { line: [[lat,lng]...], pieces, fallbacks }
  async function snapLeg(raw, opts) {
    const fetchFn = (opts && opts.fetch) || fetch, base = (opts && opts.base) || OSRM_URL;
    const onProgress = (opts && opts.onProgress) || (() => {});
    let line = [], pieces = 0, fallbacks = 0;
    for (let i = 0; i < raw.length - 1; i += CHUNK - OVERLAP) {
      const chunk = raw.slice(i, i + CHUNK);
      if (chunk.length < 2) break;
      let piece = await matchChunk(chunk, fetchFn, base);
      pieces++;
      if (!piece) { piece = chunk.map(p => p.ll); fallbacks++; }
      line = join(line, piece);
      onProgress();
      if (i + CHUNK >= raw.length) break;
      await new Promise(r => setTimeout(r, 250)); // be polite to the free public server
    }
    return { line, pieces, fallbacks };
  }

  // ── GPX ──
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const iso = t => new Date(t).toISOString().replace(/\.\d+Z$/, 'Z');

  // lines: [{ s, e, line }] ; stops: [{ s, ll }]
  function toGPX(name, lines, stops) {
    const out = ['<?xml version="1.0" encoding="UTF-8"?>',
      '<gpx version="1.1" creator="Route Compare Timeline to GPX" xmlns="http://www.topografix.com/GPX/1/1">',
      '<metadata><name>' + esc(name) + '</name></metadata>'];
    stops.forEach((v, i) => out.push('<wpt lat="' + v.ll[0] + '" lon="' + v.ll[1] + '"><time>' + iso(v.s) + '</time><name>Stop ' + (i + 1) + '</name></wpt>'));
    out.push('<trk><name>' + esc(name) + '</name>');
    for (const l of lines) {
      const total = length(l.line) || 1;
      let run = 0;
      out.push('<trkseg>');
      l.line.forEach((p, i) => { // time is spread along the leg by distance; Timeline has no exact fix times on snapped roads
        if (i) run += dist(l.line[i - 1], p);
        out.push('<trkpt lat="' + p[0].toFixed(6) + '" lon="' + p[1].toFixed(6) + '"><time>' + iso(l.s + (l.e - l.s) * run / total) + '</time></trkpt>');
      });
      out.push('</trkseg>');
    }
    out.push('</trk></gpx>');
    return out.join('\n');
  }

  return { MODES, parse, listDays, legsFor, stopsFor, snapLeg, toGPX, dist, length, miles, latlng };
})();
if (typeof module !== 'undefined') module.exports = Timeline;
