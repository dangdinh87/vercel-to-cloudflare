#!/usr/bin/env node
// Small concurrent load test for a trial Worker. Run `wrangler tail --format json`
// alongside to get CPU per request (summarize with summarize-tail.mjs).
//
// Usage: node load-test.mjs <baseUrl> <path...> [--concurrency=10] [--rounds=3]
// Exit 1 when any request returns 5xx or fails at the network level.

import { pathToFileURL } from 'node:url'
export function percentile(sorted, p) {
  if (!sorted.length) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
}

export function summarize(results) {
  const byPath = new Map()
  for (const r of results) {
    const s = byPath.get(r.path) ?? { statuses: {}, ms: [] }
    s.statuses[r.status] = (s.statuses[r.status] ?? 0) + 1
    s.ms.push(r.ms)
    byPath.set(r.path, s)
  }
  return [...byPath].map(([path, s]) => {
    const ms = [...s.ms].sort((a, b) => a - b)
    return { path, n: ms.length, statuses: s.statuses, p50: percentile(ms, 50), p90: percentile(ms, 90), max: ms.at(-1) }
  })
}

async function hit(base, path) {
  const t0 = performance.now()
  try {
    const res = await fetch(new URL(path, base), { redirect: 'manual', headers: { 'user-agent': 'cf-migration-load-test' } })
    await res.arrayBuffer()
    return { path, status: res.status, ms: Math.round(performance.now() - t0) }
  } catch (e) {
    return { path, status: 'ERR', ms: Math.round(performance.now() - t0), error: String(e) }
  }
}

/** Each round sends every path ⌈concurrency/paths⌉ times, `concurrency` requests in flight. */
export async function loadTest(base, paths, { concurrency = 10, rounds = 3 } = {}) {
  const queue = []
  for (let r = 0; r < rounds; r++) for (const p of paths) for (let c = 0; c < Math.ceil(concurrency / paths.length); c++) queue.push(p)
  const results = []
  let next = 0
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < queue.length) results.push(await hit(base, queue[next++]))
  }))
  return results
}

async function run() {
  const args = process.argv.slice(2)
  const opt = name => Number(args.find(a => a.startsWith(`--${name}=`))?.split('=')[1])
  const positional = args.filter(a => !a.startsWith('--'))
  const [base, ...paths] = positional
  if (!base || !paths.length) {
    console.error('Usage: node load-test.mjs <baseUrl> <path...> [--concurrency=10] [--rounds=3]')
    process.exit(2)
  }
  const results = await loadTest(base, paths, { concurrency: opt('concurrency') || 10, rounds: opt('rounds') || 3 })

  console.table(summarize(results).map(s => ({ ...s, statuses: JSON.stringify(s.statuses) })))
  const bad = results.filter(r => r.status === 'ERR' || r.status >= 500)
  console.log(`${results.length} requests, ${bad.length} failed (5xx/network)`)
  for (const b of bad.slice(0, 10)) console.log(`  ${b.status} ${b.path} ${b.error ?? ''}`)
  process.exitCode = bad.length ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run()
