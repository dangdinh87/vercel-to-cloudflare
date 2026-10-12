#!/usr/bin/env node
// Measure real CPU on a deployed (trial) Worker: start `wrangler tail`, send a small load,
// collect per-request cpuTime/outcome, and write a calibration file that replaces the
// estimate's assumptions (make-report.mjs / analyze-vercel-account.mjs --calibration=file).
//
// Usage: node measure-worker.mjs --url=https://<worker>.<sub>.workers.dev --worker=<name>
//          [--paths=/,/pricing,/api/x] [--repo=<dir> (pick paths from routes)] [--rounds=3] [--concurrency=8]
//          [--wrangler="npx wrangler"] [--cwd=<dir with wrangler login/config>] [--out=calibration.json]
// Sends rounds × concurrency-ish requests (default ≈ 30–60). Only run against your own Worker.
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadTest, percentile } from './load-test.mjs'
import { parseConcatenatedJson } from './summarize-tail.mjs'

const UA = 'cf-migration-load-test'
const CACHED_MAX_MS = 50 // below this median a path is served from cache (interception) on Workers
const sleep = ms => new Promise(r => setTimeout(r, ms))

/** Pick representative GET paths from the analyzer's route list: static pages + param-less GET handlers. */
export function pickPaths(routes, max = 8) {
  const ok = r => !/\[/.test(r.path) && !/\(|@/.test(r.path)
  const pages = routes.filter(r => r.kind === 'page' && ok(r)).map(r => r.path)
  const handlers = routes.filter(r => r.kind === 'route' && ok(r) && (r.methods ?? []).includes('GET') && !/auth|cron|webhook|internal/.test(r.path)).map(r => r.path)
  return [...new Set([...pages.slice(0, max - 3), ...handlers.slice(0, 3)])].map(p => p || '/')
}

/** Tail events → per-path stats + calibration. */
export function calibrate(events) {
  const byPath = new Map()
  const outcomes = {}
  for (const e of events) {
    outcomes[e.outcome ?? 'unknown'] = (outcomes[e.outcome ?? 'unknown'] ?? 0) + 1
    const url = e.event?.request?.url
    if (!url || typeof e.cpuTime !== 'number') continue
    const path = new URL(url).pathname
    byPath.set(path, [...(byPath.get(path) ?? []), e.cpuTime])
  }
  const paths = [...byPath].map(([path, cpu]) => {
    const s = [...cpu].sort((a, b) => a - b)
    return { path, n: s.length, p50: percentile(s, 50), p90: percentile(s, 90), max: s.at(-1), kind: percentile(s, 50) < CACHED_MAX_MS ? 'cached' : 'dynamic' }
  })
  const pool = kind => paths.filter(p => p.kind === kind).flatMap(p => byPath.get(p.path)).sort((a, b) => a - b)
  const cached = pool('cached'), dynamic = pool('dynamic')
  return {
    outcomes, paths,
    cachedMs: cached.length ? [percentile(cached, 50), percentile(cached, 90)] : null,
    dynamicMs: dynamic.length ? [percentile(dynamic, 50), percentile(dynamic, 90)] : null,
    samples: { cached: cached.length, dynamic: dynamic.length },
  }
}

async function main() {
  const args = process.argv.slice(2)
  const opt = n => args.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3)
  const url = opt('url'), worker = opt('worker')
  if (!url || !worker) { console.error('Usage: node measure-worker.mjs --url=<workers.dev URL> --worker=<name> [--paths=/,/x | --repo=<dir>]'); process.exit(2) }

  let paths = opt('paths')?.split(',').filter(Boolean)
  if (!paths && opt('repo')) {
    const { analyzeRepo } = await import('./lib/analyze-repo.mjs')
    paths = pickPaths(analyzeRepo(resolve(opt('repo'))).routes.list)
  }
  paths ??= ['/']

  const [cmd, ...pre] = (opt('wrangler') ?? 'npx wrangler').split(' ')
  const tail = spawn(cmd, [...pre, 'tail', worker, '--format', 'json'], { cwd: opt('cwd') ?? process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' })
  let out = '', err = ''
  tail.stdout.on('data', d => { out += d })
  tail.stderr.on('data', d => { err += d })
  // `--format json` prints nothing until the first event (no "Connected" banner), so give the
  // tail session time to attach and make sure the process is still alive.
  await sleep(12_000)
  if (tail.exitCode !== null) { console.error(`wrangler tail exited:\n${(err || out).slice(-800)}`); process.exit(1) }

  console.log(`Tail connected. Load: ${paths.join(', ')}`)
  const results = await loadTest(url, paths, { concurrency: Number(opt('concurrency')) || 8, rounds: Number(opt('rounds')) || 3 })
  await sleep(10_000) // tail events arrive a few seconds after the response
  tail.kill('SIGINT')
  await sleep(500)

  const events = parseConcatenatedJson(out).filter(e => {
    const ua = e.event?.request?.headers?.['user-agent']
    return !ua || ua === UA
  })
  const cal = calibrate(events)
  const bad = results.filter(r => r.status === 'ERR' || r.status >= 500)
  const report = { worker, url, measuredAt: new Date().toISOString(), requests: results.length, failed: bad.length, tailEvents: events.length, ...cal }
  const file = opt('out') ?? 'calibration.json'
  writeFileSync(file, JSON.stringify(report, null, 2))

  console.table(cal.paths)
  console.log(`requests ${results.length}, 5xx/network ${bad.length}, tail events ${events.length}, outcomes ${JSON.stringify(cal.outcomes)}`)
  console.log(`cached CPU p50/p90: ${cal.cachedMs?.join('/') ?? '—'} ms · dynamic CPU p50/p90: ${cal.dynamicMs?.join('/') ?? '—'} ms → ${resolve(file)}`)
  if (events.length < results.length * 0.5) console.log('⚠ fewer tail events than requests: tail sampling or a slow connection; rerun with more rounds before trusting the numbers.')
  process.exitCode = bad.length ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
