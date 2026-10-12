# Interview → research → report (do this every run)

## 1. Interview: ask, don't guess

Discover first (`scan-vercel-apps.mjs`), then collect only what you can't read from the repo or APIs. Use AskUserQuestion (≤ 4 questions per call, recommended option first). Skip a question only when the answer is already in the conversation, the repo, or memory.

| Need | Why it changes the answer | Ask when |
|---|---|---|
| Which app matters most | `scan-vercel-apps.mjs` already ranks Vercel projects by usage and finds their code — confirm, don't ask from scratch | only if the top two are close or code wasn't found |
| Which trade-offs are acceptable (multiSelect): slower uncached pages, data up to 1 h stale, Lighthouse −2/−3, N hours of work, dropping low-traffic pages, own CI | decides which levers in savings-tradeoffs.md go into the plan | always — the skill's goal is a lower bill |
| Is the site **commercial**? (payments, ads incl. AdSense, paid work) | Vercel Hobby is non-commercial only — removes the cheapest option | before recommending Hobby |
| Other projects on the same Vercel team: keep, move, Hobby, delete? | Pro seat stays while any project needs it | when the team has > 1 active project |
| Value of their hour (`--hourly=`) and monthly budget | break-even of 20–100 h of work | before a go/no-go |
| DB / external services and region (Neon, Supabase, Redis, payments webhooks) | placement, TCP drivers, webhook URLs | before trial deploy |
| Access: Vercel token (`vercel login`), Cloudflare account + plan (Free/Paid) | which scripts can run; Free plan = 10 ms CPU | before running account analysis / deploy |
| Deadlines, traffic peaks, acceptable downtime | cutover timing | before DNS move |

**Large-traffic apps** (flagged by the scan: ≥ 10M requests, ≥ 3M invocations or ≥ 50 USD/month runtime): ask the deep questions in `scripts/lib/app-triage.mjs` (`DEEP_QUESTIONS`, en/vi — 3–4 per AskUserQuestion call) before any recommendation, and prefer a gradual move (one app or route group at a time).

Never ask for secrets or tokens in chat; tell the user which command to run (`vercel login`, `wrangler login`).

## 2. Research: re-check volatile facts before quoting

Numbers below were verified on **2026-10-12**. If today is > 30 days later, WebFetch the source and update before quoting. When two official sources disagree, quote both and say which one governs.

| Fact (2026-10-12) | Source |
|---|---|
| Worker size 64 MiB **uncompressed**, no compressed limit; startup 1 s; 128 MB/isolate; CPU 30 s default, 5 min max (Paid), 10 ms (Free); `waitUntil` ≤ 30 s; 6 simultaneous outbound connections; 10,000 subrequests (Paid) | developers.cloudflare.com/workers/platform/limits — governs. OpenNext docs still say "10 MiB compressed (Paid)": outdated |
| Workers Paid $5/account/month incl. 10M requests + 30M CPU-ms; +$0.30/M requests, +$0.02/M CPU-ms; static asset requests free; Free = 100k req/day | developers.cloudflare.com/workers/platform/pricing |
| Cloudflare zone plans: Free 0; Pro 25 USD/month (20 billed yearly); Business 250 (200 yearly; 100% uptime SLA, chat support); Contract custom. Cloudflare Images: 5,000 unique transformations/month free, then 0.50 USD per 1,000 | cloudflare.com/plans/network-cdn, developers.cloudflare.com/images/pricing |
| R2 free 10 GB-month, 1M class A, 10M class B; D1 Paid 25B rows read, 50M written; DO Paid 1M requests, 400k GB-s | same pricing page |
| OpenNext: all Next 16 minors, latest 14/15 minors; Node.js runtime only (no `runtime = 'edge'`); `proxy.ts` / Node middleware support merged 2026-08-25 (PR #1309) but bundling bugs open (#1373 +4.6 MB, #1400 `@opentelemetry/api`); Windows → use WSL/CI | opennext.js.org/cloudflare, github.com/opennextjs/opennextjs-cloudflare/issues |
| Vercel Hobby included: 100 GB Fast Data Transfer, 1M function invocations, 10 GB Fast Origin Transfer, 4 h Active CPU, 360 GB-h provisioned memory, 5K image transformations; **non-commercial only** (payments, product ads, AdSense, paid client work; donations are OK) | vercel.com/docs/limits/fair-use-guidelines |
| Vercel Pro: subscription + monthly usage credit; real bill ≈ subscription + `BilledCost` from `/v1/billing/charges` (EffectiveCost = list price) | vercel.com/pricing; billing API |

Also search for breaking changes of the exact versions in the repo (`next`, `@opennextjs/cloudflare`, `wrangler`, auth library) before the trial deploy.

## 3. Report: one local HTML the user can read

Deliver every analysis as a local HTML file (`<repo>/reports/` or the project's report folder), then open it (`open` / `xdg-open` / `start`). Build it with `scripts/make-report.mjs`.

Structure — **Overview first**, written by you in the user's language, plain words, no jargon without explanation:
1. **Overview**: verdict in one sentence (stay / fix first / migrate), 3 biggest problems, 3 next actions with effort, money now vs after (range), what you could not verify.
2. Key numbers (cards): readiness, effort hours, current bill, Workers estimate.
3. Details: repo readiness, Vercel deep dive, bundle — generated by the scripts.
4. Glossary (auto) + sources with the date checked.

Write the overview to a Markdown file and pass `--summary=overview.md`. Keep chat replies short and point to the file.
