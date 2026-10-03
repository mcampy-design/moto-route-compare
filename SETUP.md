# Route comparison: setup

The site is a static page on GitHub Pages. Google Maps links are routed
through a small Cloudflare Worker (`proxy/`) that holds the Google API key
as an encrypted secret. The key is never in this repo or in the browser.

## 1. Google key (Cloud Console)
1. Credentials > Create API key. This is a new key for the server.
2. Edit the key:
   - Application restrictions: None (server-to-server calls send no website referrer).
   - API restrictions: Restrict key > Routes API only.
3. Routes API > Quotas: set a low daily cap (for example 100 requests per day).
4. Delete the old key that was pasted into the browser.

## 2. Deploy the proxy (Cloudflare, free plan)
Run in Terminal, from this repo:

    cd proxy
    npx wrangler login
    npx wrangler secret put GOOGLE_MAPS_KEY
    npx wrangler deploy

Type the key only at the `secret put` prompt (input is hidden). Do not paste
it into chat or any file. `deploy` prints a URL like
`https://moto-route-proxy.<account>.workers.dev`.

## 3. Point the page at the proxy
In `index.html`, set:

    const ROUTE_PROXY_URL = 'https://moto-route-proxy.<account>.workers.dev/route';

Commit and push. GitHub Pages redeploys in about a minute.

## Changing which sites can use the proxy
Edit `ALLOWED_ORIGINS` in `proxy/wrangler.toml`, then `npx wrangler deploy`.
The origin check stops other websites from using the proxy, but anyone could
still call it directly with a script, so the Google quota cap is the real cost ceiling.

## Rotating the key
Create a new key in Google, run `npx wrangler secret put GOOGLE_MAPS_KEY`
again, then delete the old key. No code change needed.

## Traffic tiles (FHWA HPMS)
Traffic counts come from tiles in a public Cloudflare R2 bucket. The page downloads
the tiles a route crosses and matches them in the browser (`hpms.js`). Tree cover is
read straight from the USFS map service in the browser (`canopy.js`).

To rebuild the tiles (for example when FHWA publishes a new HPMS year):

    python3 -m venv tools/.venv && tools/.venv/bin/pip install pyogrio shapely numpy
    curl -L -o tools/data/hpms_2024.gdb.zip \
      https://www.arcgis.com/sharing/rest/content/items/5e6a977c2d7c4ec1bdc82e684d3384f2/data
    tools/.venv/bin/python tools/build_hpms_tiles.py      # about 3 minutes, writes tools/out/tiles
    cd proxy && npx wrangler r2 bucket create moto-hpms-tiles          # first time only
    npx wrangler r2 bucket cors set moto-hpms-tiles --file ../tools/r2-cors.json   # GET only, from the site origin
    npx wrangler r2 bucket dev-url enable moto-hpms-tiles              # first time only; prints the public URL
    cd .. && tools/upload_tiles.sh moto-hpms-tiles 12                  # about an hour; rerun to retry failures

Tiles live under a version folder (`hpms-2024/`). For a new year, set `DATA_VERSION` in
`hpms.js` to match. New URLs mean browsers and the service worker never serve stale tiles,
and the worker deletes old-version caches when it updates. Set `TILE_BASE` in `index.html`
and `TILE_ORIGIN` in `sw.js` to the bucket's public URL. The raw download and the
built tiles are git-ignored. The `r2.dev` address is rate limited by Cloudflare and meant
for development; a custom domain on the bucket is the production setup.
