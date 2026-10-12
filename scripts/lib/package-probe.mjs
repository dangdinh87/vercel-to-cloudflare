// Inspect installed packages the compatibility table doesn't know. Hand-written tables never cover
// every app, so look at the package itself: native addons, subprocess use, Workers-ready exports, size.
// Needs node_modules (pnpm/npm/yarn); returns null per package when not installed.
import { existsSync, readFileSync, readdirSync, statSync, realpathSync } from 'node:fs'
import { join, dirname } from 'node:path'

const NATIVE_DEPS = ['node-gyp-build', 'prebuild-install', 'bindings', 'node-addon-api', '@mapbox/node-pre-gyp', 'nan', 'node-pre-gyp', 'napi-build-utils']
const WORKER_CONDITIONS = ['workerd', 'worker', 'edge-light', 'edge-runtime', 'browser']

/** Find node_modules/<name> walking up from `root` (monorepos hoist to the workspace root). */
export function locatePackage(root, name) {
  let dir = root
  for (let i = 0; i < 6; i++) {
    const p = join(dir, 'node_modules', name, 'package.json')
    if (existsSync(p)) { try { return dirname(realpathSync(p)) } catch { return dirname(p) } }
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return null
}

function dirSize(dir, budget = { files: 4000 }) {
  let bytes = 0
  const walk = d => {
    let names
    try { names = readdirSync(d) } catch { return }
    for (const n of names) {
      if (budget.files-- <= 0) return
      if (n === 'node_modules') continue
      const p = join(d, n)
      let st
      try { st = statSync(p) } catch { continue }
      if (st.isDirectory()) walk(p)
      else bytes += st.size
    }
  }
  walk(dir)
  return bytes
}

function hasNodeBinary(dir, depth = 0) {
  if (depth > 3) return false
  let names
  try { names = readdirSync(dir) } catch { return false }
  for (const n of names) {
    if (n.endsWith('.node')) return true
    if (n === 'node_modules' || n.startsWith('.')) continue
    const p = join(dir, n)
    try { if (statSync(p).isDirectory() && hasNodeBinary(p, depth + 1)) return true } catch { /* skip */ }
  }
  return false
}

const collectConditions = (exp, acc = new Set()) => {
  if (exp && typeof exp === 'object') for (const [k, v] of Object.entries(exp)) { if (!k.startsWith('.')) acc.add(k); collectConditions(v, acc) }
  return acc
}

function entryFile(dir, pkg) {
  const exp = pkg.exports
  const pick = e => (typeof e === 'string' ? e : e && typeof e === 'object' ? pick(e['.'] ?? e.node ?? e.import ?? e.require ?? e.default ?? Object.values(e)[0]) : null)
  for (const c of [pick(exp), pkg.module, pkg.main, 'index.js']) {
    if (c && existsSync(join(dir, c)) && statSync(join(dir, c)).isFile()) return join(dir, c)
  }
  return null
}

/** → { name, version, native, subprocess, workerReady, mib } or null when not installed. */
export function probePackage(root, name) {
  const dir = locatePackage(root, name)
  if (!dir) return null
  let pkg
  try { pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) } catch { return null }
  const deps = { ...pkg.dependencies, ...pkg.optionalDependencies }
  const native = Boolean(pkg.gypfile || existsSync(join(dir, 'binding.gyp')) || NATIVE_DEPS.some(d => d in deps) || hasNodeBinary(dir))
  const entry = entryFile(dir, pkg)
  const src = entry ? readFileSync(entry, 'utf8').slice(0, 400_000) : ''
  const subprocess = /require\(\s*['"](node:)?(child_process|worker_threads)['"]\s*\)|from\s+['"](node:)?(child_process|worker_threads)['"]/.test(src)
  const conditions = collectConditions(pkg.exports)
  const workerReady = WORKER_CONDITIONS.some(c => conditions.has(c)) || Boolean(pkg.browser) || Boolean(pkg.workerd)
  return { name, version: pkg.version, native, subprocess, workerReady, mib: +(dirSize(dir) / 1048576).toFixed(1) }
}

/** Findings for unknown runtime packages (P0 native, P1 subprocess, P2 huge). */
export function probeFindings(root, packages) {
  const out = []
  let probed = 0, missing = 0
  for (const name of packages) {
    const r = probePackage(root, name)
    if (!r) { missing++; continue }
    probed++
    if (r.native) out.push({ rule: 'dep:native', sev: 'P0', file: 'package.json', lines: [0], pkg: name, version: r.version, where: 'runtime', effort: [2, 12],
      msg: `${name} ships a native addon (.node / node-gyp) — cannot load on workerd. Replace it, move the work off the request path, or keep this app on Vercel.` })
    else if (r.subprocess && !r.workerReady) out.push({ rule: 'dep:subprocess', sev: 'P2', file: 'package.json', lines: [0], pkg: name, version: r.version, where: 'runtime', effort: [1, 4],
      msg: `${name} uses child_process/worker_threads in its entry — fine to import on Workers, fails if that path is called. Test it on the trial.` })
    // Disk size is not bundle size (icon packs are tree-shaken) — inspect-worker-bundle.mjs measures the real cost.
  }
  return { findings: out, probed, missing }
}
