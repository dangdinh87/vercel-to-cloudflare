# Feasibility audit (phase 0)

Run both analyzers first, then verify each P0/P1 by reading the code:

```bash
node scripts/analyze-repo-for-workers.mjs <repo> --html=plans/reports/workers-readiness.html
node scripts/analyze-vercel-account.mjs --project=<main> --html=plans/reports/vercel-deep-dive.html
```
The repo analyzer follows imports from every route, so `fs` inside a build-time-only OG route shows as INFO, not P1; unreachable files are ignored; content modules (data/, content/) only count for size. Its per-page-view table separates `mount` vs `on-open`/`handler`, guest vs signed-in, eager vs lazy — only eager + mount + dynamic handler is a real per-view cost.

## Make-or-break limits (Workers Paid)

| Limit | Value | Typical way apps hit it |
|---|---|---|
| Bundle (uncompressed upload) | **64 MiB** | `experimental.inlineCss` (CSS copied into every route manifest) and large data modules imported by server code |
| Startup | 1 s | Rarely: OpenNext loads the handler on the first request |
| RAM / isolate | 128 MB | Parsing big uploads (PDF/DOCX) keeps several copies of the file in memory |
| `waitUntil` / `after()` | **30 s after response** | Background AI calls or moderation with long deadlines get cut → records stuck half-done. Keep the total under ~20 s, per-call timeout = remaining budget |
| CPU / request | 30 s default (`limits.cpu_ms` up to 300 s) | Fine on Paid; Free = 10 ms → 503 under load |
| Concurrent outbound connections | 6 | Fan-outs (push notifications, many parallel fetches) queue up |
| Subrequests | 10,000 | Fine |
| No project filesystem | — | `fs.readFile` for fonts/icons/data at request time → 500 |

## What to grep for (and why)

- `fs.` / `readFileSync` / `process.cwd()` in runtime code → no filesystem. Build-time only is OK.
- `from 'node:dns'` / `dns.lookup` → not usable; SSRF guard must skip DNS on Workers (runtime `global_fetch_strictly_public` already blocks private IPs).
- `new WebSocket(url, { headers })` → undici-only; Workers needs `fetch(url, {headers:{Upgrade:'websocket'}})`.
- Top-level imports of heavy Node libs (`web-push`, `@aws-sdk/*`, `sharp`, `puppeteer`) in critical routes → a load failure 500s the whole route. Lazy `await import()`.
- `s-maxage` / `Cache-Control: public` on route handlers → **no effect on Workers**. Use `export const revalidate = N` (ISR, served from R2) instead.
- `x-forwarded-for` for rate limiting → spoofable on CF (client can prepend). Use `cf-connecting-ip`.
- In-memory `Map` caches / limiters → per-isolate, many isolates. Never correctness-critical; DB quota for money paths.
- Fire-and-forget promises (`void doThing()`) → may be cancelled when response closes. Wrap in `after()`.
- `experimental.inlineCss` → must be off.
- Huge imported data modules (`import DATA from './10mb-data'`) → bundle + heap. Move to `public/*.json` or DB.
- `next/image` with raster optimisation → needs Images binding; use `unoptimized` or `images.unoptimized`.
- Env read at module scope (`const KEY = process.env.X`) → verify it's populated on Workers (smoke test the feature).
- `@vercel/analytics`, `@vercel/og` specifics, `vercel.json` crons/redirects → re-home (GitHub Actions cron, `next.config` redirects).
- `maxDuration` → ignored on Workers; responses silent > ~100 s may 524 through CF proxy.

## Beyond the scripts

- GA4 page views per path (90 days) → low-value heavy routes to cut (thousands of prerendered pages that get < 1% of views are a common find).
- Chrome DevTools on prod as a guest: confirm the per-page-view table (HTML + API + RSC). Static files are free on Cloudflare; count only dynamic requests.
- Vercel insight → code: high FOT/invocation ↔ inlineCss / big payloads; ISR churn ↔ short `revalidate`; low cache share ↔ per-view dynamic APIs.

## Output of phase 0

A short report: blockers (P0/P1), list of routes to fix, monthly request + CPU estimate, decision table (stay / migrate / migrate partially) with total bill per option across ALL the user's projects.
