// Map editor for a built Timeline route. The route becomes a list of control points joined by road segments.
// Drag a point onto the road you rode, tap the route to add a point, tap a point to remove it. Each change
// re-routes only the stretch next to it. Needs Leaflet (window.L) and Timeline (timeline.js).
const TimelineEditor = (() => {
  const T = Timeline;
  const SPACING_M = 6000;        // control points start about this far apart
  const STRAIGHT_AVG_M = 1200;   // a segment whose vertices average farther apart than this was never snapped to a road

  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const same = (a, b) => a[0] === b[0] && a[1] === b[1];
  function dedupe(pts) { const out = []; for (const p of pts) if (!out.length || !same(out[out.length - 1], p)) out.push(p); return out; }
  const isRoad = pts => pts.length > 2 && T.length(pts) / (pts.length - 1) <= STRAIGHT_AVG_M;

  // Start state: thin the logged points into control points, and cut the built line between them
  function initial(built) {
    const raw = built.lines.flatMap(l => l.raw), line = dedupe(built.lines.flatMap(l => l.line));
    const picked = [raw[0]];
    for (const p of raw) if (T.dist(picked[picked.length - 1], p) >= SPACING_M) picked.push(p);
    // the true ends are the built line's ends
    picked[0] = line[0];
    if (T.dist(picked[picked.length - 1], line[line.length - 1]) > 100) picked.push(line[line.length - 1]); else picked[picked.length - 1] = line[line.length - 1];
    const idx = [0];
    for (let k = 1; k < picked.length - 1; k++) {
      let best = idx[k - 1], bd = Infinity;
      const to = Math.min(line.length, idx[k - 1] + 4000);
      for (let i = idx[k - 1]; i < to; i++) { const d = T.dist(line[i], picked[k]); if (d < bd) { bd = d; best = i; } }
      idx.push(best);
    }
    idx.push(line.length - 1);
    for (let k = idx.length - 2; k > 0; k--) if (idx[k] <= idx[k - 1] || idx[k] >= idx[k + 1]) idx.splice(k, 1); // keep indexes strictly increasing
    const ctrl = idx.map((ix, k) => ({ ll: k === 0 ? line[0] : k === idx.length - 1 ? line[line.length - 1] : line[ix] }));
    const segs = [];
    for (let k = 0; k < ctrl.length - 1; k++) {
      let pts = line.slice(idx[k], idx[k + 1] + 1);
      if (pts.length < 2) pts = [ctrl[k].ll, ctrl[k + 1].ll];
      segs.push({ pts, road: isRoad(pts) });
    }
    return { ctrl, segs };
  }

  // opts: { el, built, fetch, base, setStatus(text), onChange() }
  function create(opts) {
    const L = window.L;
    let { ctrl, segs } = initial(opts.built);
    const start = JSON.stringify({ ctrl, segs });
    let undoStack = [], edited = false, chain = Promise.resolve();

    const map = L.map(opts.el, { zoomControl: true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).addTo(map);
    const g = L.layerGroup().addTo(map);
    map.fitBounds(L.latLngBounds(segs.flatMap(s => s.pts)), { padding: [20, 20] });

    const status = t => opts.setStatus && opts.setStatus(t);
    const changed = () => { edited = JSON.stringify({ ctrl, segs }) !== start; opts.onChange && opts.onChange(); hint(); };
    const snapshot = () => { undoStack.push(JSON.stringify({ ctrl, segs })); if (undoStack.length > 40) undoStack.shift(); };
    function hint() {
      const n = segs.filter(s => !s.road).length;
      status(n ? n + ' dashed stretch' + (n === 1 ? '' : 'es') + ' could not be snapped to a road. Drag a point onto the road you rode, or tap a dashed stretch to add a point.' :
        'Every stretch follows a road. Drag, add or remove points to match what you rode.');
    }
    const queue = fn => { chain = chain.then(fn).catch(e => status(e.message || 'Something went wrong.')); return chain; };

    function render() {
      g.clearLayers();
      const red = css('--a'), blue = css('--b');
      segs.forEach((s, i) => {
        L.polyline(s.pts, { color: s.road ? red : blue, weight: 4, opacity: .95, dashArray: s.road ? null : '6 8', interactive: false }).addTo(g);
        L.polyline(s.pts, { weight: 24, opacity: 0, interactive: true, bubblingMouseEvents: false }).addTo(g)
          .on('click', e => addVia(i, e.latlng));
      });
      ctrl.forEach((c, i) => {
        const end = i === 0 || i === ctrl.length - 1;
        const m = L.marker(c.ll, { draggable: true, icon: L.divIcon({ className: 'cp' + (end ? ' end' : ''), html: '<span></span>', iconSize: [28, 28] }), keyboard: false }).addTo(g);
        m.on('dragend', () => move(i, m.getLatLng()));
        m.on('click', () => {
          const box = document.createElement('div');
          box.style.cssText = 'display:grid;gap:6px;font:14px system-ui';
          box.textContent = i === 0 ? 'Start of the route' : end ? 'End of the route' : 'Route point';
          if (!end) { const b = document.createElement('button'); b.type = 'button'; b.textContent = 'Remove this point'; b.style.cssText = 'padding:6px 10px;cursor:pointer'; b.onclick = () => { map.closePopup(); removeAt(i); }; box.appendChild(b); }
          L.popup({ closeButton: false }).setLatLng(c.ll).setContent(box).openOn(map);
        });
      });
    }

    const toLL = ll => [ll.lat, ll.lng];
    const straight = (a, b) => ({ pts: [a, b], road: false });

    function move(i, latlng) {
      return queue(async () => {
        snapshot(); status('Finding the road…');
        const prev = ctrl[i - 1], next = ctrl[i + 1], pts = [];
        if (prev) pts.push(prev.ll); pts.push(toLL(latlng)); if (next) pts.push(next.ll);
        const r = await T.routeVia(pts, opts);
        if (r) {
          ctrl[i].ll = r.locs[prev ? 1 : 0] || toLL(latlng);
          let k = 0;
          if (prev) segs[i - 1] = { pts: r.segs[k++], road: true };
          if (next) segs[i] = { pts: r.segs[k], road: true };
        } else {
          ctrl[i].ll = toLL(latlng);
          if (prev) segs[i - 1] = straight(prev.ll, ctrl[i].ll);
          if (next) segs[i] = straight(ctrl[i].ll, next.ll);
        }
        render(); changed();
        if (!r) status('No road found near that spot, so that stretch is a straight line.');
      });
    }

    function addVia(i, latlng) {
      return queue(async () => {
        snapshot(); status('Finding the road…');
        const here = toLL(latlng), r = await T.routeVia([ctrl[i].ll, here, ctrl[i + 1].ll], opts);
        if (r) { ctrl.splice(i + 1, 0, { ll: r.locs[1] || here }); segs.splice(i, 1, { pts: r.segs[0], road: true }, { pts: r.segs[1], road: true }); }
        else { ctrl.splice(i + 1, 0, { ll: here }); segs.splice(i, 1, straight(ctrl[i].ll, here), straight(here, ctrl[i + 2].ll)); }
        render(); changed();
        if (!r) status('No road found near that spot, so that stretch is a straight line.');
      });
    }

    function removeAt(i) {
      return queue(async () => {
        snapshot(); status('Finding the road…');
        const a = ctrl[i - 1].ll, b = ctrl[i + 1].ll, r = await T.routeVia([a, b], opts);
        segs.splice(i - 1, 2, r ? { pts: r.segs[0], road: true } : straight(a, b));
        ctrl.splice(i, 1);
        render(); changed();
        if (!r) status('No road found between those points, so that stretch is a straight line.');
      });
    }

    function undo() {
      return queue(async () => {
        const s = undoStack.pop(); if (!s) return;
        ({ ctrl, segs } = JSON.parse(s)); render(); changed();
      });
    }
    function reset() {
      return queue(async () => { snapshot(); ({ ctrl, segs } = JSON.parse(start)); render(); changed(); });
    }

    render(); hint();
    return {
      undo, reset,
      isEdited: () => edited,
      getLine: () => dedupe(segs.flatMap(s => s.pts)),
      refresh: render,       // after a light/dark switch
      invalidate: () => map.invalidateSize(),
      destroy: () => map.remove(),
    };
  }
  return { create };
})();
