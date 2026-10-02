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
