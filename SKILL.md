---
name: vercel-to-cloudflare
description: Cuts a Next.js team's hosting bill by moving apps with real traffic from Vercel to one Cloudflare Workers Paid plan (OpenNext) and leaving small apps on Vercel Hobby, with every trade-off spelled out. Scans the Vercel account and local code, checks Workers readiness (import-graph analysis of build-time vs request-time code, 64 MiB bundle, fs, node:dns, WebSocket headers, native addons, after()/waitUntil, s-maxage, per-page-view API calls, polling, env, proxy.ts), explains Vercel cost drivers, estimates and measures Workers cost, applies safe code fixes and writes a plain-language HTML report. Use when the user wants to reduce a Vercel bill, asks whether to move, convert or port a Next.js app to Cloudflare Workers, or needs a trial Worker, CPU measurement or DNS cutover.
license: MIT
---

# Vercel → Cloudflare Workers (Next.js + OpenNext)

**Goal: pay less.** Target setup: every app with real traffic on ONE Cloudflare Workers Paid plan (5 USD/month per account + usage beyond 10M requests / 30M CPU-ms; big apps may add a Cloudflare Pro/Business zone plan or Images), small apps on Vercel Hobby (free, non-commercial). The user trades a bit of speed, freshness, Lighthouse and some hours of work for a much smaller bill — show the money, list each trade-off in plain words ([savings-tradeoffs.md](references/savings-tradeoffs.md)), let them choose. Never trade away correctness: **no errors** stays the hard constraint.

Built from hands-on OpenNext migration work and checked on 33 open-source Next.js apps.

## Every run: interview → research → report

Follow [interview-research-report.md](references/interview-research-report.md):
1. **Discover, then ask.** Run `scan-vercel-apps.mjs` first: it lists every Vercel project the login can see, finds each one's code on this machine (`.vercel/project.json`, else git remote + rootDirectory) and sorts them into **traffic** (runtime cost ≥ 3 USD/month or volume beyond free allowances → analyse) vs **small/idle** (almost free → recommend leaving them on Vercel; build minutes don't count as traffic) — never ask the user to pick from local folders. Then ask (AskUserQuestion) only what discovery can't answer: which trade-offs are acceptable (slower uncached pages, staler data, Lighthouse −2/−3, hours of work, dropping low-traffic pages), commercial use (decides Hobby), hourly value (break-even), DB + region, Cloudflare access (Free vs Paid). Never ask for tokens in chat.
   **Scale the interview to the stakes:** small/medium apps → 2–3 questions and a short verdict. **Large traffic** (≥ 10M requests, ≥ 3M invocations or ≥ 50 USD/month runtime — the scan flags them) → stop and ask the deep questions (peaks, cost of downtime, SEO, payments/webhooks, Vercel features in use, rollback owner, budget for Cloudflare Pro/Business, gradual move) before recommending anything.
2. **Re-check volatile facts** (limits, prices, OpenNext support) on the official pages listed there when they are > 30 days old; when sources disagree, say which governs.
3. **Deliver a local HTML report** with an Overview first, in the user's language: `make-report.mjs … --summary=overview.md --lang=<en|vi> --open`. Chat replies stay short and point to the file.

Copy this checklist into the conversation and tick it off:

```
Migration progress:
- [ ] Scan: scan-vercel-apps.mjs → traffic / small / idle apps
- [ ] Interview: trade-offs, commercial use, hourly value (deep questions for large traffic)
- [ ] Report: make-report.mjs with an overview in the user's language, opened
- [ ] User picked an option (stay / move traffic apps / move all)
- [ ] Fix: apply-fixes.mjs dry run → user sees diff → --write → typecheck + tests + build pass
- [ ] Trial Worker: bundle < 64 MiB, key routes 200, measure-worker.mjs calibration
- [ ] Staging with real secrets: login, payments, uploads, revalidation verified
- [ ] Cutover: DNS records copied and checked with dig, rollback written down
- [ ] Clean up: delete trial Worker, R2/D1 resources, worktree
```

## Examples

- *"My Vercel bill keeps growing, should I move to Cloudflare?"* → `scan-vercel-apps.mjs --open`, then ask about trade-offs and commercial use; answer with the money (now → target → saving per year) and which apps to leave alone.
- *"Can this repo run on Cloudflare Workers?"* → `make-report.mjs --repo=. --out=… --open`; confirm each P0/P1 by opening the file the report points to before calling it a blocker.
- *"Make it Workers-ready."* → `apply-fixes.mjs .` (dry run) → show the diff → `--write` only after the user agrees → typecheck, tests, build. Trade-off fixes (`--accept=…`) only for trade-offs the user accepted.

## Golden rules

1. Fix code so it runs on BOTH platforms and ship it to Vercel first; Vercel stays the rollback until Cloudflare is stable ≥ 2 weeks.
2. Trial in an isolated git worktree with dummy env. Never build the deploy artefact from a tree containing real `.env*` (OpenNext may bundle them). Real secrets only via `wrangler secret put`.
3. Workers Paid (5 USD/month) for any real app: Free = 10 ms CPU → `exceededCpu` 503s under light concurrency.
4. Measure, don't guess: `measure-worker.mjs` (or `wrangler tail --format json` → `summarize-tail.mjs`).
5. Each phase has a gate. Read real exit codes from logs, not wrapper success.
6. Never commit, push, deploy, delete projects or change DNS without explicit approval. Delete public trial `*.workers.dev` Workers afterwards (duplicate site).

## Workflow

| Phase | Do | Gate |
|---|---|---|
| 0. Assess | `scan-vercel-apps.mjs`; interview; `make-report.mjs --repo --vercel` for the chosen app; read [feasibility-audit.md](references/feasibility-audit.md), [cost-and-limits.md](references/cost-and-limits.md) | Every P0/P1 confirmed in code; user picked an option |
| 1. Trial | Worktree + OpenNext per [setup-opennext.md](references/setup-opennext.md); `inspect-worker-bundle.mjs` | Startup < 1 s, bundle < 64 MiB, key routes 200 |
| 2. Fix | On a branch, loop: `apply-fixes.mjs <repo>` (dry run) → show the diff → `--write` → typecheck + tests + build → if anything fails, fix it or `git checkout -- <file>` and rerun. Then the manual checklist with [code-fixes.md](references/code-fixes.md), [cache-and-request-diet.md](references/cache-and-request-diet.md); ship to Vercel | typecheck + tests + build; Vercel prod smoke OK |
| 3. Measure | R2 + D1 + DO cache, `enableCacheInterception`; `measure-worker.mjs` → calibration.json | 0 × 5xx at 10–30 concurrent; CPU p50/p90 measured, estimate re-run with `--calibration` |
| 4. Staging | Real DB branch + secrets; login, payment webhooks, AI streams, uploads, revalidateTag | All money/auth paths verified |
| 5. Cutover | CI deploy, DNS, domain, placement per [cutover-and-cleanup.md](references/cutover-and-cleanup.md) | Mail records verified with `dig`; rollback documented |

## Scripts (`scripts/`, Node ≥ 22, zero deps)

Run them; don't read them into context unless a result needs explaining. All are read-only except `apply-fixes.mjs --write`.

| Script | Answers |
|---|---|
| `scan-vercel-apps.mjs [--roots=] [--lang=] [--summary=] [--open]` | **Start here.** All Vercel projects → local code → triage (traffic / small / idle) → deep reports for traffic apps + an index (bill now, Workers cost for the traffic apps priced once per account, small apps' Hobby fit, cleanup list) |
| `apply-fixes.mjs <repo> [--write] [--accept=inline-css-off,images-unoptimized,longer-revalidate]` | **Edits code** (dry run by default; never commits/installs; refuses files with uncommitted changes): removes `runtime='edge'`, guest session short-circuit (Auth.js v5 / re-export / NextAuth v4 shapes), OpenNext + wrangler scaffold, `cf:*` scripts, .gitignore; trade-off fixes only with `--accept`; prints the manual checklist |
| `make-report.mjs --out=… [--repo=] [--vercel --project=] [--bundle=] [--calibration=] [--summary=] [--lang=] [--open]` | One app's user-facing report: overview, key numbers, details, limits, glossary, sources |
| `analyze-repo-for-workers.mjs <repo>` | Readiness score/verdict/effort; import graph from every route (build-time code = OK); route modes; per-page-view API calls; polling; deps; data in bundle with import chains; env; cache bindings; proxy.ts |
| `analyze-vercel-account.mjs --project=<main>` | One project in depth: cost drivers + fixes, cache share, CPU/invocation, I/O wait, FOT, ISR churn, builds, spikes, regions, Workers estimate, 3 bill options, Hobby fit, cleanup list |
| `inspect-worker-bundle.mjs <repo>` | After `opennextjs-cloudflare build`: MiB by package/route/source (opens Turbopack chunks via source maps) |
| `measure-worker.mjs --url= --worker= [--repo=]` | Real CPU on a trial Worker (tail + light load): cached vs dynamic p50/p90 → `calibration.json`, which replaces the estimate's assumptions (`--calibration=` on make-report / analyze-vercel-account) |
| `load-test.mjs`, `summarize-tail.mjs` | 5xx under concurrency; CPU p50/p90/max per path from a saved tail |

Heuristics, not proof — see [validation.md](references/validation.md): checked on 33 apps in 18 public repos (cal.com, dub, payload, formbricks, papermark, midday, umami, ai-chatbot…). Unknown packages are inspected in node_modules (native addons → blocker; subprocess users → verify); findings reached only through a library barrel are downgraded. Follows workspace packages, tsconfig `extends`, helper functions up to 2 levels; parses imports with the repo's own TypeScript compiler when installed (the regex fallback gives the same results on large apps). Tests: `node --test scripts/tests/*.test.mjs`; behaviour evals: `claude plugin eval .` (see `evals/`).

## Biggest wins (in order)

1. `enableCacheInterception` + R2 cache (the largest CPU saving). 2. Large data out of the server bundle. 3. `experimental.inlineCss` off. 4. No dynamic API calls on every guest page view. 5. OG images build-time only.

## When NOT to migrate

- Savings < the user's hours × hourly value (typical: 20–100 h).
- Other projects keep Vercel Pro anyway — moving one app can cost MORE.
- Requests > ~100 s without streaming (524), native modules, > 128 MB RAM per request.
