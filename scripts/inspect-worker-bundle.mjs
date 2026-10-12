#!/usr/bin/env node
// After `opennextjs-cloudflare build`: attribute the Worker bundle (limit 64 MiB uncompressed)
// to npm packages, app routes, manifests and server chunks, using OpenNext's esbuild metafile
// (.open-next/server-functions/default/handler.mjs.meta.json).
//
// Usage: node inspect-worker-bundle.mjs <repoDir> [--top=20] [--json]
// Exact upload size: `wrangler deploy --dry-run --outdir dist` prints "Total Upload".
import { pathToFileURL } from 'node:url'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const MiB = 1024 * 1024
export const LIMIT_MIB = 64

/** Bucket one esbuild input path. */
export function groupOf(input) {
  const p = input.replace(/\\/g, '/')
  const nm = p.lastIndexOf('node_modules/')
  if (nm >= 0) {
    const rest = p.slice(nm + 'node_modules/'.length).split('/')
    return `npm: ${rest[0].startsWith('@') ? rest.slice(0, 2).join('/') : rest[0]}`
  }
  if (/client-reference-manifest|_buildManifest|[-_]manifest\.(js|json)$/.test(p)) return 'next: manifests (inlineCss lands here)'
  const app = p.match(/\.next\/server\/app\/(.+?)\/(?:page|route|layout|default)[^/]*$/)
  if (app) return `route: /${app[1]}`
  if (/\.next\/server\/chunks\/ssr\//.test(p)) return 'next: SSR chunks'
  if (/\.next\/server\/chunks\//.test(p)) return 'next: server chunks'
  if (/\.next\/server\//.test(p)) return 'next: other server files'
  return `other: ${p.split('/').slice(0, 3).join('/')}`
}

const B64 = Object.fromEntries([...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'].map((c, i) => [c, i]))

/** Bytes of generated code per source file, from a (possibly sectioned) source map. */
export function bytesPerSource(map, code) {
  const out = new Map()
  const lines = code.split('\n')
  const addMap = (m, lineOffset = 0, colOffset = 0) => {
    if (m.sections) {
      for (const s of m.sections) addMap(s.map, lineOffset + s.offset.line, s.offset.line === 0 ? colOffset + s.offset.column : s.offset.column)
      return
    }
    let srcIdx = 0
    m.mappings.split(';').forEach((lineMap, li) => {
      const genLine = lines[lineOffset + li] ?? ''
      let col = li === 0 ? colOffset : 0
      const segs = []
      for (const seg of lineMap.split(',')) {
        if (!seg) continue
        const vals = []
        let shift = 0, value = 0
        for (const ch of seg) {
          const d = B64[ch]
          value += (d & 31) << shift
          if (d & 32) shift += 5
          else { vals.push(value & 1 ? -(value >>> 1) : value >>> 1); value = 0; shift = 0 }
        }
        col += vals[0]
        if (vals.length > 1) srcIdx += vals[1]
        segs.push([col, vals.length > 1 ? srcIdx : -1])
      }
      for (let i = 0; i < segs.length; i++) {
        const [c, si] = segs[i]
        if (si < 0) continue
        const end = i + 1 < segs.length ? segs[i + 1][0] : genLine.length
        const src = m.sources[si] ?? '?'
        out.set(src, (out.get(src) ?? 0) + Math.max(0, end - c))
      }
    })
  }
  addMap(map)
  return out
}

/** Normalise a source-map source to a readable bucket. */
export function sourceGroup(src) {
  let p = src
  try { p = decodeURIComponent(src) } catch { /* keep raw */ }
  p = p.replace(/^.*\[project\]\//, '').replace(/^(turbopack|webpack|file):\/+/, '').replace(/^(\.\.?\/)+/, '')
  const nm = p.lastIndexOf('node_modules/')
  if (nm >= 0) { const r = p.slice(nm + 13).split('/'); return `npm: ${r[0].startsWith('@') ? r.slice(0, 2).join('/') : r[0]}` }
  const parts = p.split('/')
  if (parts[0] === 'src') return `src: ${parts.slice(0, 3).join('/')}`
  if (parts[0] === 'app') return `app: ${parts.slice(0, 3).join('/')}`
  return `other: ${parts.slice(0, 2).join('/')}`
}

const CHUNK_RE = /\.next\/server\/chunks\//

export function attribute(meta, { readChunk } = {}) {
  const [outName, out] = Object.entries(meta.outputs).sort((a, b) => b[1].bytes - a[1].bytes)[0]
  const groups = new Map()
  const files = []
  const sources = new Map()
  const addSource = (k, b) => sources.set(k, (sources.get(k) ?? 0) + b)
  for (const [input, info] of Object.entries(out.inputs)) {
    const g = groupOf(input)
    groups.set(g, (groups.get(g) ?? 0) + info.bytesInOutput)
    files.push({ input, bytes: info.bytesInOutput })
    if (!CHUNK_RE.test(input)) { addSource(g, info.bytesInOutput); continue }
    // Open opaque Next chunks through their source maps; scale to post-esbuild bytes.
    const chunk = readChunk?.(input)
    if (!chunk) { addSource('next chunks (no source map)', info.bytesInOutput); continue }
    const per = bytesPerSource(chunk.map, chunk.code)
    const sum = [...per.values()].reduce((a, b) => a + b, 0) || 1
    for (const [src, b] of per) addSource(sourceGroup(src), (b / sum) * info.bytesInOutput)
  }
  return {
    output: outName, totalBytes: out.bytes,
    groups: [...groups].map(([group, bytes]) => ({ group, bytes })).sort((a, b) => b.bytes - a.bytes),
    files: files.sort((a, b) => b.bytes - a.bytes),
    sources: [...sources].map(([group, bytes]) => ({ group, bytes })).sort((a, b) => b.bytes - a.bytes),
  }
}

/** Attribution for a repo built with OpenNext, or null when there is no build output. */
export function inspectBundle(repo) {
  const fnDir = join(repo, '.open-next/server-functions/default')
  const metaPath = join(fnDir, 'handler.mjs.meta.json')
  if (!existsSync(metaPath)) return null
  // Maps live in the repo's own build output (.next/server/chunks/*.js.map); OpenNext drops them.
  const readChunk = input => {
    const rel = input.slice(input.indexOf('.next/'))
    const code = [join(fnDir, rel), join(repo, rel)].find(existsSync)
    const map = [join(fnDir, rel + '.map'), join(repo, rel + '.map')].find(existsSync)
    if (!code || !map) return null
    try { return { code: readFileSync(code, 'utf8'), map: JSON.parse(readFileSync(map, 'utf8')) } } catch { return null }
  }
  return attribute(JSON.parse(readFileSync(metaPath, 'utf8')), { readChunk })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repo = process.argv[2]
  const top = Number(process.argv.find(a => a.startsWith('--top='))?.slice(6)) || 20
  if (!repo) { console.error('Usage: node inspect-worker-bundle.mjs <repoDir> [--top=20] [--json]'); process.exit(2) }
  const r = inspectBundle(repo)
  if (!r) { console.error('No OpenNext build output (.open-next/server-functions/default/handler.mjs.meta.json) — run `opennextjs-cloudflare build` first.'); process.exit(2) }
  if (process.argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)) } else {
  const mib = b => (b / MiB).toFixed(2)
  console.log(`Server handler: ${mib(r.totalBytes)} MiB (Worker limit ${LIMIT_MIB} MiB uncompressed; worker.js adds ~1 MiB of OpenNext glue)`)
  if (r.totalBytes > 0.85 * LIMIT_MIB * MiB) console.log('⚠ within 15% of the limit — cut before adding features')
  console.log('\nBy group:')
  console.table(r.groups.slice(0, top).map(g => ({ group: g.group, MiB: mib(g.bytes), share: `${((g.bytes / r.totalBytes) * 100).toFixed(1)}%` })))
  console.log('By source (Next chunks opened via source maps):')
  console.table(r.sources.slice(0, top).map(g => ({ source: g.group, MiB: mib(g.bytes), share: `${((g.bytes / r.totalBytes) * 100).toFixed(1)}%` })))
  console.log('Largest inputs:')
  console.table(r.files.slice(0, top).map(f => ({ input: f.input.replace(/^.*server-functions\/default\//, ''), MiB: mib(f.bytes) })))
  }
}
