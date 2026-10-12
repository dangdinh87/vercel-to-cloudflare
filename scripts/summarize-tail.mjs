#!/usr/bin/env node
// Summarize `wrangler tail <worker> --format json > tail.jsonl` output:
// outcome counts, CPU/wall ms per path, exceptions.
// wrangler prints pretty-printed JSON objects back to back (not one per line),
// so parse by brace depth instead of splitting lines.
//
// Usage: node summarize-tail.mjs tail.jsonl
import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'
import { percentile } from './load-test.mjs'

export function parseConcatenatedJson(text) {
  const out = []
  let depth = 0, start = -1, inStr = false, esc = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') { if (depth++ === 0) start = i }
    else if (ch === '}' && depth > 0 && --depth === 0) {
      try { out.push(JSON.parse(text.slice(start, i + 1))) } catch { /* skip wrangler banner noise */ }
    }
  }
  return out
}

export function summarizeEvents(events) {
  const outcomes = {}
  const byPath = new Map()
  const exceptions = []
  for (const e of events) {
    outcomes[e.outcome ?? 'unknown'] = (outcomes[e.outcome ?? 'unknown'] ?? 0) + 1
    const url = e.event?.request?.url
    const path = url ? new URL(url).pathname : '(non-http)'
    const s = byPath.get(path) ?? { cpu: [], wall: [] }
    if (typeof e.cpuTime === 'number') s.cpu.push(e.cpuTime)
    if (typeof e.wallTime === 'number') s.wall.push(e.wallTime)
    byPath.set(path, s)
    for (const x of e.exceptions ?? []) exceptions.push(`${path}: ${x.name ?? ''} ${x.message ?? ''}`.trim())
  }
  const rows = [...byPath].map(([path, s]) => {
    const cpu = [...s.cpu].sort((a, b) => a - b)
    return { path, n: Math.max(s.cpu.length, s.wall.length), cpuP50: percentile(cpu, 50), cpuP90: percentile(cpu, 90), cpuMax: cpu.at(-1) ?? 0,
      cpuTotal: cpu.reduce((a, b) => a + b, 0) }
  }).sort((a, b) => b.cpuTotal - a.cpuTotal)
  return { total: events.length, outcomes, rows, exceptions }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2]
  if (!file) { console.error('Usage: node summarize-tail.mjs tail.jsonl'); process.exit(2) }
  const { total, outcomes, rows, exceptions } = summarizeEvents(parseConcatenatedJson(readFileSync(file, 'utf8')))
  const allCpu = rows.reduce((a, r) => a + r.cpuTotal, 0)
  console.log(`${total} events, outcomes: ${JSON.stringify(outcomes)}, avg CPU ${total ? Math.round(allCpu / total) : 0} ms`)
  console.table(rows)
  if (exceptions.length) { console.log('Exceptions:'); for (const x of [...new Set(exceptions)].slice(0, 20)) console.log('  ' + x) }
}
