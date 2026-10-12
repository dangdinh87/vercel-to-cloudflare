# Cutting the bill: levers and what each one costs you

Target setup: **all traffic apps on ONE Cloudflare Workers Paid plan (5 USD/month per account, 10M requests + 30M CPU-ms included) + small apps on Vercel Hobby (free, non-commercial)**. Present money first, then the trade-offs, and let the user pick — they decide which trade-offs are acceptable (ask in the interview).

## Levers, in the order they usually pay off

| Lever | Saves | You give up | Don't when |
|---|---|---|---|
| Traffic apps → one Workers Paid plan | Vercel Pro seat + usage | 20–100 h of work; a migration risk (follow the 6 gated phases); Vercel previews/analytics DX | savings × months < hours × hourly value |
| Small apps → Vercel Hobby | their share of Pro | non-commercial only (payments, ads, AdSense, paid work = commercial); paused if over allowances | the app earns money, or the group exceeds Hobby allowances |
| Longer cache (ISR 1 h–1 day, guest API as ISR route) | fewer Worker boots + DB wake-ups | data up to N hours stale | prices, stock, auth-dependent pages |
| `experimental.inlineCss` off | bundle (required on Workers) + Fast Origin Transfer on Vercel | Lighthouse −2/−3, LCP +0.7–1.4 s (typical) | Core Web Vitals is a hard KPI |
| Drop low-value pages (e.g. thousands of SSG detail pages with < 1% of views) | build time, cache writes, bundle | long-tail SEO landings (redirect them to the parent list) | those pages bring organic signups (check GA first) |
| Data out of the server bundle (static JSON / DB) | bundle headroom, cold-start CPU | build script + client fetch work | data is tiny |
| Builds in CI (GitHub Actions) instead of the host | build minutes (often the largest Vercel line for repos pushed many times a day) | you maintain the pipeline | private repo already near free CI minutes |
| Skip builds for docs/plans-only commits | build minutes now, on Vercel | — | — |
| `images.unoptimized` (no Cloudflare Images) | Images binding cost | heavier images | image-heavy storefronts |
| Drop Vercel Web Analytics → GA / CF Web Analytics | per-event charges | one analytics tool | — |
| Scale-to-zero DB (Neon Free): ISR ≥ 1 h, no < 5 min polling/crons, autoscale max 0.25 CU | DB compute hours (stay on free tier) | first request after idle waits ~0.5–1 s | latency-critical APIs |
| Accept slower dynamic pages (no Smart Placement tuning, cold isolates) | engineering time | 100–400 ms extra on uncached dynamic routes | real-time apps |
| Keep in-memory rate limits (no paid binding/WAF) | WAF/rate-limit add-ons | per-isolate limits only — keep money/AI quotas in the DB | public write endpoints under abuse |

## The bill is not always 5 USD

Workers Paid is 5 USD per account **plus** 0.30 USD per extra million requests and 0.02 USD per extra million CPU-ms — big apps pay more, and the scripts price this. Large apps may also need: a zone plan (Pro 25 USD/month, 20 yearly: more rules, image optimization; Business 250, 200 yearly: 100% SLA) and Cloudflare Images (5,000 transformations free, then 0.50 USD per 1,000). The report adds Images to the target and flags zone plans for large apps; ask before assuming they are needed.

## How to present it

1. Bill now (real: subscription + billed) → target bill (range) → saving per month and per year.
2. Steps ordered by saving ÷ effort, each with its trade-off in plain words.
3. Break-even: hours × the user's hourly value ÷ monthly saving.
4. What is NOT worth it (small apps, levers with tiny savings) — say "leave it".
