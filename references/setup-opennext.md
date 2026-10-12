# OpenNext setup + trial deploy (phase 1)

Versions proven together: next 16.3.8, @opennextjs/cloudflare 1.20.8, wrangler 4.149.0. Next < 16.3 needed upgrading first.

## 1. Isolated worktree

```bash
git worktree add .claude/worktrees/cf-trial -b spike/cloudflare-trial
cd .claude/worktrees/cf-trial && pnpm install
pnpm add @opennextjs/cloudflare && pnpm add -D wrangler
pnpm exec wrangler login        # token needs workers_scripts:write; `wrangler whoami` to check
```
Do NOT copy `.env.local`. Put dummy values in `wrangler.jsonc` `vars` for the trial. If build needs a DB, point at a throwaway Neon branch or mock.

## 2. open-next.config.ts

```ts
import { defineCloudflareConfig } from '@opennextjs/cloudflare'
import r2IncrementalCache from '@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache'
import d1NextTagCache from '@opennextjs/cloudflare/overrides/tag-cache/d1-next-tag-cache'
import doQueue from '@opennextjs/cloudflare/overrides/queue/do-queue'

export default defineCloudflareConfig({
  incrementalCache: r2IncrementalCache, // ISR/SSG pages + route-handler ISR
  tagCache: d1NextTagCache,             // revalidateTag / revalidatePath
  queue: doQueue,                       // time-based ISR refresh, deduplicated
  enableCacheInterception: true,        // serve cache hits before loading Next server — biggest CPU win
})
```
Start with no overrides only to prove the build; without R2 every request SSRs (CPU 400–1,300 ms).

## 3. wrangler.jsonc

```jsonc
{
  "name": "<app>-trial",
  "main": ".open-next/worker.js",
  "compatibility_date": "2026-10-01",
  "compatibility_flags": ["nodejs_compat", "global_fetch_strictly_public"],
  "limits": { "cpu_ms": 30000 },            // Paid only; Free rejects deploy (code 100328)
  "assets": { "directory": ".open-next/assets", "binding": "ASSETS" },
  "services": [{ "binding": "WORKER_SELF_REFERENCE", "service": "<app>-trial" }],
  "observability": { "enabled": true },
  "r2_buckets": [{ "binding": "NEXT_INC_CACHE_R2_BUCKET", "bucket_name": "<app>-next-cache" }],
  "d1_databases": [{ "binding": "NEXT_TAG_CACHE_D1", "database_name": "<app>-tag-cache", "database_id": "<id>" }],
  "durable_objects": { "bindings": [{ "name": "NEXT_CACHE_DO_QUEUE", "class_name": "DOQueueHandler" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["DOQueueHandler"] }],
  "vars": { "AUTH_SECRET": "dummy", "DATABASE_URL": "postgresql://dummy..." }
  // later: "placement": { "region": "aws:<your-db-region>" } — next to the DB
}
```
Create resources: `wrangler r2 bucket create <app>-next-cache`, `wrangler d1 create <app>-tag-cache` (retry once on "Authentication error").

## 4. next.config switches for the trial

- `experimental.inlineCss: false` (gate behind env in trial: `inlineCss: !process.env.CF_BUILD`).
- Optionally cap `generateStaticParams` for huge SSG sets during trial.

## 5. Build + deploy

```bash
L=build.log; pnpm exec opennextjs-cloudflare build > $L 2>&1; echo "EXIT=$?" >> $L; tail -3 $L
pnpm exec opennextjs-cloudflare deploy > deploy.log 2>&1; echo "EXIT=$?" >> deploy.log
grep -iE 'Total Upload|Worker Startup' deploy.log   # upload KiB (uncompressed) + startup ms
```
`deploy` also populates R2 with prerendered pages. Local: `pnpm exec opennextjs-cloudflare preview`.
Disk: builds are large — check `df -h` first (ENOSPC kills the build mid-way).

## 6. Observe

```bash
node scripts/measure-worker.mjs --url=https://<app>-trial.<sub>.workers.dev --worker=<app>-trial \
  --repo=. --wrangler="pnpm exec wrangler" --out=calibration.json
```
Starts `wrangler tail --format json` (prints nothing until the first event — the script waits 12 s), sends ~30 requests, and splits CPU into cached (< 50 ms median) vs dynamic. Static files served by the assets binding never reach the Worker and produce no events. Feed `calibration.json` to `make-report.mjs --calibration=`.
Manual alternative: `wrangler tail … --format json > tail.jsonl` + `load-test.mjs` + `summarize-tail.mjs tail.jsonl`.
A temporary probe route (e.g. `app/api/cf-check/route.ts`) is a fast way to test libs (PDF parse, web-push, dns guard, after()) on real workerd — keep it trial-only.
