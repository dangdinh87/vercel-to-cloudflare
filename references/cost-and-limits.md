# Cost model + plan facts (checked 2026-10-12 — sources in interview-research-report.md)

## Workers Paid

- $5/month base. Includes 10M requests + 30M CPU-ms. Overage: $0.30/M requests, **$0.02 per 1M CPU-ms**.
- Static assets (`assets` binding) requests are free and don't run the Worker.
- R2 / D1 / DO used by OpenNext cache stayed inside free allowances for ~1M req/month.
- Only CPU time is billed, not wall time waiting on DB/AI.

```
monthly $ ≈ 5 + max(0, worker_requests × avg_cpu_ms − 30e6) × 0.02 / 1e6
```
Example: 600k Worker requests/month at ~170 ms average CPU ≈ 102M CPU-ms → 5 + (102 − 30) × 0.02 ≈ 6.4 USD.

## Typical CPU per request (OpenNext, mid-size app, ~40 MiB bundle)

| Setup | CPU / request |
|---|---|
| No cache (every request SSR) | median 390–870 ms, p90 1.1 s, max 2 s |
| R2 incremental cache | median 86 ms, p90 438 ms (cold isolate 200–600 ms to load bundle) |
| + `enableCacheInterception` | avg 16 ms, p90 31 ms, max 34 ms |
| Dynamic routes (session, user APIs) | still boot Next → 100–400 ms |
Newer compatibility dates did not reduce CPU in practice. Bundle size drives cold-isolate CPU.

## Vercel side (for comparison)

- Pro: paid per seat with a monthly usage credit; real bill ≈ subscription + `BilledCost` (billing API), not the list-price `EffectiveCost`. Hobby: free, **non-commercial only** (payments, product ads, AdSense, paid client work; donations OK); includes 100 GB FDT, 1M invocations, 10 GB FOT, 4 h Active CPU, 360 GB-h memory, 5K image transforms.
- Get real usage: Vercel billing API / dashboard Usage per project (requests, invocations, Active CPU, FOT, ISR writes, build minutes).

## Move only apps with traffic

Small apps (runtime cost < ~3 USD/month, volume within free allowances) cost (almost) nothing on Vercel: moving them adds hours and saves nothing. Recommend leaving them — on Hobby if non-commercial and the group fits Hobby allowances, otherwise on Pro. Busy-but-cheap apps (an admin polling itself) are still small; build-minute cost is not traffic.

## Decide per whole account, not per app

Build a table: option → Vercel bill + CF bill. Moving one app while others still need Pro can raise the total. A common outcome: once the Vercel bill is already lean, moving one app while keeping Pro for the rest costs more than staying; only moving every traffic app (rest on Hobby) saves money.

## Value of time

Ask the user's hourly value. Break-even = migration hours × rate ÷ monthly savings. Present the number and let them decide — some users migrate for control or stability anyway.

## Non-cost limits worth stating upfront

- A Worker far from the database adds a round trip per query; set `placement` near the DB.
- Lighthouse with `inlineCss` off: −2/−3 points, LCP +0.7–1.4 s (accepted).
- Long non-streaming responses (> ~100 s) risk 524 through CF proxy.
