# agweather: a personal weather radar MCP server

A small, private **Remote MCP server** on **Cloudflare Workers**. It lets an AI client (Claude, ChatGPT, …) look at
**real observed weather-radar frames** and short-term precipitation data, and answer questions like *"Is it raining in
Minsk right now?"*, *"When will this rain stop?"* or *"Is another cell coming?"*. It works well from a phone.

```text
Claude / ChatGPT / any MCP client
        │  Streamable HTTP  /mcp  (OAuth 2.1, owner only)
        ▼
Cloudflare Worker ──► RainViewer   observed radar frames (+ coverage mask)
        │          ──► Open-Meteo   model precipitation / wind (no key), geocoding
        │          ──► meteoblue    optional, when METEOBLUE_API_KEY is set
        ▼
Cloudflare Access for SaaS (OIDC) = the login
```

- **Stateless MCP**: `createMcpHandler` from `agents/mcp/server` with an MCP SDK v2 server factory. No Durable Object.
- **Auth**: `@cloudflare/workers-oauth-provider` acts as the OAuth server for MCP clients. Sign-in is delegated to
  Cloudflare Access for SaaS, and only the email(s) in `OWNER_EMAIL` get a token. Nothing uses query-string keys.
- **Provenance**: every block says what it is (`observation`, `radar_nowcast`, `numerical_forecast`,
  `model_analysis`), where it came from (`source`) and when (`observed_at`, `issued_at`, `retrieved_at`, step times).
  Observations and forecasts are never merged.

## Tools

| Tool | What it returns |
|---|---|
| `radar` | The latest *observed* radar frames around a point, oldest first. Each frame is a 512 px PNG image with its timestamp and URL, plus geometry (zoom, km per pixel, span, north up, point at centre) and a coverage check. |
| `weather_now` | The radar observation at the point (dBZ, precipitation detected yes/no/unknown), the Open-Meteo model estimate for now (precipitation, wind, gusts, temperature) and meteoblue's current hour if configured, as separate blocks. |
| `precipitation_nowcast` | Separate blocks for `observation` (radar now), `radar_nowcast` (none available today; see below) and `numerical_forecast` series (Open-Meteo hourly and 15-min, meteoblue hourly), with their provenance. |
| `rain_eta` | Structured data for "when will it stop or start": the observed state now, plus the first dry and next wet step of a native-resolution forecast series. Returns `status: "insufficient_data"` rather than guessing. It gives no motion-based ETA yet (`motion.available: false`). |

All tools take `location` (a name: `"Minsk"`, `"Barcelona"`, `"Houston, Texas"`, …) **or** `lat` + `lon`. With
neither, they use `DEFAULT_LOCATION`.

What the data can and cannot say:

- RainViewer frames are **past observations** in 10-minute steps. RainViewer no longer publishes nowcast frames, so
  `radar_nowcast` is unavailable unless a meteoblue *nowcast* package is configured. The AI client judges motion by
  comparing frames.
- The point reading inverts the pixel colour to reflectivity using RainViewer's published "Universal Blue" colour
  table. We checked that live tiles match the table exactly. "Precipitation detected" means ≥ 10 dBZ, a stated heuristic.
  Outside radar coverage the answer is `null` (unknown), never "dry".
- Open-Meteo does not publish its model run time, so `issued_at` is `null` with a reason. Its 15-minute series is
  interpolated from hourly models outside Central Europe and North America (Minsk included) and is labelled
  `possibly_interpolated`. `rain_eta` only uses native-resolution series (hourly), and says so.

## Local development

Requirements: Node.js 22+, a Cloudflare account (the free plan is enough).

```bash
npm ci
npm run typecheck
npm test                      # vitest, Node environment, no network (all upstreams are mocked)
cp .dev.vars.example .dev.vars   # then fill it in; see "Secrets"
npm run dev                   # wrangler dev on http://localhost:8788
```

For `wrangler dev`, put `PUBLIC_BASE_URL=http://localhost:8788` in `.dev.vars` (it overrides the var in
`wrangler.jsonc`) and add `http://localhost:8788/callback` as a second redirect URL in the Access application.

`npm run build` (`wrangler deploy --dry-run --outdir dist`) bundles without deploying. The bundle is about 280 KB
gzipped.

## Cloudflare deployment

1. `npx wrangler login`
2. Create the KV namespace for OAuth state and paste its id into `wrangler.jsonc`:
   `npx wrangler kv namespace create OAUTH_KV`
3. In `wrangler.jsonc` → `vars`, set `PUBLIC_BASE_URL` (the Worker's URL, e.g. `https://agweather.<you>.workers.dev`,
   no trailing slash) and `OWNER_EMAIL`.
4. Create the Access application (next section) and set the secrets (the section after that).
5. `npm run deploy`

If you use a custom domain, set `PUBLIC_BASE_URL` to it; its host name is accepted automatically. `/mcp` also accepts
the Worker's own `*.workers.dev` host and loopback names. Only list *additional* host names in `MCP_ALLOWED_HOSTNAMES`.

## Cloudflare Access / OAuth configuration

MCP clients talk OAuth 2.1 to the Worker (`/authorize`, `/token`, `/register` for dynamic client registration, and
`/.well-known/oauth-protected-resource/mcp`). The Worker sends the human to **Cloudflare Access for SaaS** to log in.

1. Zero Trust dashboard → **Access → Applications → Add an application → SaaS**.
2. Choose **OIDC** as the authentication protocol and give it a name (e.g. `agweather`).
3. **Redirect URL**: `https://<your-worker>/callback` (plus `http://localhost:8788/callback` for local dev).
4. Scopes: `openid`, `email`, `profile`.
5. Add an **Access policy** that allows only your identity (e.g. *Include → Emails → you@example.com*).
6. Copy the **Client ID**, **Client secret**, **Token endpoint**, **Authorization endpoint** and **Key endpoint
   (JWKS)**. They become the `ACCESS_*` secrets below.

The Worker verifies the returned `id_token` itself: RS256 signature by a key from the JWKS, matching `kid`,
`aud` = client id, `iss` = your Access OIDC issuer (the token URL without `/token`; override with the var
`ACCESS_ISSUER` if needed) and not expired. It then checks the email against `OWNER_EMAIL` (case-insensitive,
comma-separated). Anyone else gets a 403 and no token. The check runs again on every `/mcp` request, so even a
misconfigured Access policy cannot open the server. The login is also bound to the browser that approved the client
(an `__Host-OAUTH_STATE` cookie that `/callback` requires), so a link carrying someone else's approval cannot be
replayed in your browser.

Do **not** also put a self-hosted Access application in front of the Worker's hostname. Access for SaaS is only the
login here, and a self-hosted app in front would block the MCP client's API calls.

## Secrets

Set them with `npx wrangler secret put <NAME>` (or in `.dev.vars` for local dev). Names are listed in `.env.example`.
Nothing secret goes into `wrangler.jsonc` or git.

| Name | What |
|---|---|
| `ACCESS_CLIENT_ID`, `ACCESS_CLIENT_SECRET` | From the Access for SaaS application |
| `ACCESS_TOKEN_URL`, `ACCESS_AUTHORIZATION_URL`, `ACCESS_JWKS_URL` | Its token, authorization and key (JWKS) endpoints |
| `COOKIE_ENCRYPTION_KEY` | Random, e.g. `openssl rand -hex 32`. HMAC key for the "approved clients" cookie and the OAuth `state` sent to Access. (The `__Host-OAUTH_STATE` cookie that binds a login to your browser is a SHA-256 of the state id and needs no key.) |
| `METEOBLUE_API_KEY` | Optional; enables meteoblue |

Logs never contain tokens or keys: every log line goes through a redactor, and the meteoblue URL (which carries the
key) is never logged.

## Connecting an MCP client

The server URL is `https://<your-worker>/mcp` (Streamable HTTP).

- **Claude** (web, desktop, mobile): Settings → Connectors → *Add custom connector* → paste the URL → *Connect*. You
  are sent to Cloudflare Access to log in. The connector then shows up on your phone too.
- **ChatGPT**: Settings → Connectors (developer mode) → add a custom MCP server with the URL, authentication *OAuth*.
- Any other client that supports remote MCP with OAuth works the same way: it discovers the auth server from the 401
  response and registers itself dynamically.

## Default location

`DEFAULT_LOCATION` in `wrangler.jsonc` (default `"Minsk, Belarus"`) is used whenever a tool is called without
`location` or `lat`/`lon`. It accepts anything `location` accepts: `"City"`, `"City, Country"`, `"City, Region"` or
`"City, Region, Country"`, including US state codes and common country short forms (`"Houston, TX"`, `"Paris, Texas, USA"`).
Qualifiers rank the geocoder's matches. If none match, the top match is used, and `location.match_note` says that the
qualifier was not confirmed.
Minsk, Barcelona and Houston are built-in presets and resolve without a network call. Other names go through Open-Meteo
geocoding and are cached. The resolved name, region and country are always echoed back in `location`.

## Enabling meteoblue

1. `npx wrangler secret put METEOBLUE_API_KEY`
2. Optionally set `METEOBLUE_PACKAGE` (var, default `basic-1h`). Free-trial keys can only use the free-trial packages
   (`basic-1h`, `basic-3h`, `basic-day`). A package the key is not entitled to comes back as a structured
   `provider_not_configured` error naming the package, and the other providers are unaffected.
3. With meteoblue enabled, its series appears in `precipitation_nowcast.numerical_forecast` with a real `issued_at`
   (`modelrun_utc`), its current hour in `weather_now.meteoblue`, and `rain_eta` prefers it. A package whose name
   starts with `nowcast` is reported as `radar_nowcast` instead.

Without a key, everything else works and the meteoblue blocks say `provider_not_configured`.

## Testing with MCP Inspector

```bash
npx @modelcontextprotocol/inspector
```

Choose transport **Streamable HTTP**, URL `https://<your-worker>/mcp` (or `http://localhost:8788/mcp` under
`wrangler dev`), and *Connect*. The Inspector goes through the same OAuth flow (Access login) as a real client, then
lists the four tools so you can call them.

## Example tool calls

```jsonc
// radar(): Minsk, 150 km radius, 6 frames
{ "name": "radar", "arguments": {} }

// Another place, tighter view, more frames
{ "name": "radar", "arguments": { "location": "Barcelona", "radius_km": 80, "frames": 12 } }

// Coordinates, metadata only (no images)
{ "name": "radar", "arguments": { "lat": 29.76, "lon": -95.36, "include_images": false } }

{ "name": "weather_now", "arguments": { "location": "Houston" } }
{ "name": "precipitation_nowcast", "arguments": {} }
{ "name": "rain_eta", "arguments": { "location": "Minsk", "threshold_mm": 0.2 } }
```

Abridged `radar()` result (the images follow as MCP `image` blocks, each preceded by a caption):

```json
{
  "location": { "name": "Minsk, Minsk City, Belarus", "lat": 53.9, "lon": 27.5667, "resolved_by": "preset", "is_default": true },
  "observed_at": "2026-09-25T09:10:00.000Z",
  "coverage": { "checked": true, "center_covered": true, "covered_fraction": 0.666 },
  "radar": {
    "source": "rainviewer", "kind": "observation",
    "zoom": 6, "size_px": 512, "span_km": 368.9, "km_per_px": 0.721,
    "requested_radius_km": 150, "effective_radius_km": 184.5,
    "center_px": [256, 256], "north_up": true,
    "frames": [
      { "time": 1790324400, "time_iso": "2026-09-25T08:20:00.000Z", "url": "https://tilecache.rainviewer.com/v2/radar/…/512/6/53.9000/27.5667/2/1_1.png", "image_index": 0 }
    ],
    "nowcast": { "available": false, "reason": "RainViewer no longer publishes nowcast frames" }
  }
}
```

Errors are structured: `{"error": {"code": "unknown_location", "message": "…", "provider": "open-meteo-geocoding",
"retryable": false}}` with `isError: true`. The codes are `invalid_input`, `unknown_location`, `geocoding_failed`,
`radar_unavailable`, `outside_radar_coverage`, `provider_unavailable`, `provider_not_configured`, `upstream_timeout`,
`rate_limited` and `internal_error`.

## Caching and limits

- The in-isolate cache holds the radar index for 60 s, frame PNGs for 2 h (a frame's URL never changes content),
  coverage tiles for 1 day, geocoding for 7 days and forecasts for 5–10 min. Keyless upstream GETs also ask
  Cloudflare's edge cache to keep them (`cf.cacheTtl`). meteoblue responses are never edge-cached.
- One `radar` call makes at most about 15 subrequests (index, up to 12 frames, coverage). Image decoding is limited
  to reading one pixel neighbourhood and the coverage mask (about 1 ms each), which fits the Free plan.

## Project layout

```text
src/index.ts              Worker entry: OAuthProvider (built from env) → owner check → stateless MCP handler
src/mcp/                  MCP server factory (tool registration, logging) and per-call deps
src/tools/                radar, weather_now, precipitation_nowcast, rain_eta (pure functions of input + deps)
src/providers/rainviewer/ index parsing, tile URLs, PNG decoder, colour table → dBZ
src/providers/openmeteo/  forecast + geocoder
src/providers/meteoblue/  optional forecast provider
src/location/             presets, resolution, tile geometry
src/auth/                 Access for SaaS handler, id_token verification, owner allow-list
src/types/                provider interfaces, incl. the future MotionEstimator shape
test/                     vitest suites + real captured fixtures
```

Future work: a motion estimator from consecutive frames (the `MotionEstimator` interface is already in
`src/types/motion.ts`), animated frame sequences, and a basemap under the radar images.

Third-party code: the Access OAuth handler is adapted from Cloudflare's MIT-licensed `remote-mcp-cf-access` demo
(see `LICENSE-THIRD-PARTY.md`).
