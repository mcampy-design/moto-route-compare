// moto-route-proxy
// Turns a Google Maps directions link (short or full) into road geometry
// using the Google Routes API. The API key lives only here, as an
// encrypted Worker secret, and is never sent to the browser.

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
