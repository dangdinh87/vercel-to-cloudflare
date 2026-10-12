// Orchestrates the repo analysis into one model consumed by report-render.
import { join } from 'node:path'
import { readdirSync, statSync, existsSync } from 'node:fs'
import { listFiles, readText, stripComments, isTestFile, isClientFile } from './repo-files.mjs'
import { createGraph } from './import-graph.mjs'
import { discoverEntries, classifyEntries, usesDynamicApi } from './route-inventory.mjs'
import { applyRules, REQUIREMENT_PATTERNS } from './code-rules.mjs'
import { globalRoots, findApiCalls, findPolling, matchRoute, sessionProviderUse, callsInMount, callerNames } from './client-request-diet.mjs'
import { checkDependencies, verifiedOkPackages, PACKAGES } from './dependency-compat.mjs'
import { probeFindings } from './package-probe.mjs'
import { checkNextConfig, checkVercelJson, collectEnv, packageFacts } from './config-checks.mjs'
import { score } from './scoring.mjs'

const MiB = 1024 * 1024
const SHORT_REVALIDATE_S = 600
const DATA_DIR = /(^|\/)(data|content|fixtures)\//
const BARREL_SENSITIVE = new Set(['fs', 'process-cwd', 'dns', 'raw-socket', 'subprocess', 'code-from-string', 'dirname'])

export function analyzeRepo(root) {
  const files = listFiles(root)
  const sizes = new Map(files.map(f => [f.rel, f.size]))
  // Workspace packages live outside `root` (../../packages/ui/...): stat them on demand.
  const sizeOf = {
    get: rel => {
      if (!sizes.has(rel)) { try { sizes.set(rel, statSync(join(root, rel)).size) } catch { sizes.set(rel, 0) } }
      return sizes.get(rel)
    },
  }
  const graph = createGraph(root)
  const text = rel => readText(join(root, rel))

  // 1. Entries + render modes
  const entries = discoverEntries(root, files)
  const dynCache = new Map()
  const fileIsDynamic = rel => {
    if (!dynCache.has(rel)) dynCache.set(rel, !rel.endsWith('.json') && usesDynamicApi(text(rel)))
    return dynCache.get(rel)
  }
  const reachesDynamicApi = roots => {
    for (const rel of graph.reachable(roots, { eagerOnly: true })) if (fileIsDynamic(rel)) return rel
    return null
  }
  classifyEntries(entries, { reachesDynamicApi, readEntry: e => text(e.rel) })

  // 2. Reachability: request-time vs build-only
  const runtimeRoots = entries.filter(e => e.runtime).map(e => e.rel)
  const buildRoots = entries.filter(e => !e.runtime).map(e => e.rel)
  const runtimeForest = graph.forest(runtimeRoots)
  const buildForest = graph.forest(buildRoots)
  const allForest = graph.forest([...runtimeRoots, ...buildRoots])
  const reachableCode = [...allForest.files()].filter(rel => !isTestFile(rel))

  // 3. Code rules with context
  const raw = []
  for (const rel of reachableCode) {
    // Content modules (content text with code samples, fixtures) are data: only their size matters.
    if (rel.endsWith('.json') || DATA_DIR.test(rel)) continue
    const runtime = runtimeForest.has(rel)
    const ctx = { runtime, buildOnly: !runtime && buildForest.has(rel) }
    for (const f of applyRules(rel, stripComments(text(rel)), ctx)) {
      const forest = runtime ? runtimeForest : buildForest
      f.chain = forest.chainTo(rel)
      // Library barrels (`export * from`) make whole packages reachable; importing fs/child_process
      // is fine on workerd (nodejs_compat) — only calling them on a request path fails.
      if (runtime && (f.sev === 'P0' || f.sev === 'P1') && BARREL_SENSITIVE.has(f.rule) && forest.viaBarrel(rel)) {
        f.sev = 'P2'
        f.note = 'reached only through a barrel re-export — a problem only if this code runs on a request path; verify'
      }
      raw.push(f)
    }
  }
  const findings = groupByFile(raw)

  // Short ISR windows: every regeneration = Next boot + DB queries (and wakes a scale-to-zero DB).
  for (const e of entries) {
    if (e.mode === 'isr' && typeof e.config.revalidate === 'number' && e.config.revalidate < SHORT_REVALIDATE_S) {
      findings.push({ rule: 'short-revalidate', sev: 'P3', file: e.rel, lines: [0], effort: [0, 0.25], chain: [e.rel],
        msg: `revalidate=${e.config.revalidate}s: each regeneration boots Next + hits the DB. On a small site use ≥ 3600 unless freshness matters.` })
    }
  }

  // Node middleware (Next 16 proxy.ts, or middleware with runtime 'nodejs'): OpenNext support landed
  // 2026-08-25 (PR #1309) but bundling issues were still open in Oct 2026 (#1373, #1400).
  for (const e of entries) {
    const nodeMw = e.kind === 'proxy' || (e.kind === 'middleware' && /runtime\s*:\s*['"]nodejs['"]/.test(text(e.rel)))
    if (nodeMw) findings.push({ rule: 'node-middleware', sev: 'P2', file: e.rel, lines: [0], effort: [1, 4], chain: [e.rel],
      msg: 'Node.js middleware (proxy.ts) runs on every matching request. OpenNext supports it only since late Aug 2026 with open bundling bugs (+~4.6 MB, @opentelemetry/api resolution) — use the latest @opennextjs/cloudflare, check its issues, keep the matcher narrow, measure on the trial.' })
  }

  // 4. Packages + builtins by reachability
  const pkgUsage = new Map()
  const builtins = new Map()
  for (const rel of reachableCode) {
    const where = runtimeForest.has(rel) ? 'runtime' : 'build'
    for (const e of graph.node(rel).edges) {
      if (e.pkg && pkgUsage.get(e.pkg) !== 'runtime') pkgUsage.set(e.pkg, where)
      if (e.builtin && where === 'runtime') builtins.set(e.builtin, (builtins.get(e.builtin) ?? 0) + 1)
    }
  }
  const pkg = packageFacts(root)
  const depFindings = checkDependencies(pkg.deps, pkgUsage)
  // Packages the table doesn't know: inspect them in node_modules (native addons, subprocesses, size).
  const unknownRuntime = [...pkgUsage].filter(([n, w]) => w === 'runtime' && !PACKAGES[n] && !n.startsWith('@types/') && !/^(next|react|react-dom)$/.test(n)).map(([n]) => n)
  const probe = probeFindings(root, unknownRuntime)
  depFindings.push(...probe.findings)

  // 5. Bundle pressure from first-party source
  const bundle = bundleEstimate(root, reachableCode, sizeOf, allForest, files, entries)

  // 6. Per-page-view requests + polling
  const diet = requestDiet(root, entries, graph, reachableCode, text, pkg)

  // 7. Config, env, requirements
  const nextCfg = checkNextConfig(root)
  const vercel = checkVercelJson(root)
  const env = collectEnv(root, [...runtimeForest.files()])
  const requirements = new Set()
  if (entries.some(e => ['isr', 'ssg', 'ssg+on-demand', 'on-demand', 'static-build'].includes(e.mode))) requirements.add('R2 incremental cache (prerendered + ISR pages) + DO queue (time-based revalidation)')
  for (const rel of reachableCode) {
    if (rel.endsWith('.json')) continue
    const src = text(rel)
    for (const r of REQUIREMENT_PATTERNS) if (r.re.test(src)) requirements.add(r.need)
  }

  // Image optimisation only matters when the app actually renders next/image.
  const usesNextImage = reachableCode.some(rel => !rel.endsWith('.json') && /from\s+['"]next\/(legacy\/)?image['"]/.test(text(rel)))
  for (const f of nextCfg.findings) if (f.rule === 'image-optimization' && !usesNextImage) { f.sev = 'INFO'; f.note = 'next/image is not used' }

  const allFindings = [...nextCfg.findings.map(f => ({ ...f, lines: [f.line] })), ...vercel.findings.map(f => ({ ...f, lines: [f.line] })),
    ...findings, ...diet.findings, ...depFindings, ...bundle.findings]
  const model = {
    root, generatedAt: new Date().toISOString(),
    facts: { parser: graph.parser, files: files.length, reachable: reachableCode.length, runtimeFiles: [...runtimeForest.files()].length, pm: pkg.pm,
      next: pkg.next, react: pkg.react, opennext: pkg.opennext, wrangler: pkg.wrangler, nextAuth: pkg.nextAuth, nextConfig: nextCfg.file },
    routes: routeSummary(entries),
    findings: allFindings,
    bundle, diet: { ...diet, findings: undefined },
    runtimePackages: [...pkgUsage].filter(([, w]) => w === 'runtime').map(([p]) => p).sort(),
    probe: { unknownRuntime: unknownRuntime.length, probed: probe.probed, notInstalled: probe.missing },
    packages: { runtimeBuiltins: [...builtins].sort((a, b) => b[1] - a[1]), verifiedOk: verifiedOkPackages(pkg.deps), depCount: Object.keys(pkg.deps).length },
    env, crons: vercel.crons, requirements: [...requirements],
  }
  model.score = score(model)
  return model
}

function groupByFile(raw) {
  const map = new Map()
  for (const f of raw) {
    const key = `${f.rule}|${f.file}|${f.sev}`
    const g = map.get(key)
    if (g) g.lines.push(f.line)
    else map.set(key, { ...f, lines: [f.line] })
  }
  return [...map.values()]
}

function routeSummary(entries) {
  const byMode = {}
  for (const e of entries) {
    if (e.mode === 'shared') continue
    const kind = e.kind === 'route' || e.kind === 'pages-api' ? 'handler'
      : ['middleware', 'proxy', 'instrumentation'].includes(e.kind) ? e.kind
      : /image|icon|sitemap|robots|manifest/.test(e.kind) ? 'metadata' : 'page'
    const k = `${kind}:${e.mode}`
    byMode[k] = (byMode[k] ?? 0) + 1
  }
  return {
    byMode,
    list: entries.filter(e => e.mode !== 'shared').map(e => ({ rel: e.rel, kind: e.kind, path: e.routePath, mode: e.mode, why: e.why,
      revalidate: e.config.revalidate, runtime: e.config.runtime, methods: e.config.methods, gsp: e.config.hasGenerateStaticParams })),
  }
}

function bundleEstimate(root, reachableCode, sizeOf, allForest, files, entries) {
  const findings = []
  const reachableBytes = reachableCode.reduce((s, r) => s + (sizeOf.get(r) ?? 0), 0)
  const heavy = reachableCode.map(rel => ({ rel, size: sizeOf.get(rel) ?? 0 })).sort((a, b) => b.size - a.size).slice(0, 12)
    .map(h => ({ ...h, chain: allForest.chainTo(h.rel) }))
  // Group reachable files by their data-ish directory (src/data/qa/..., content/...) to expose big datasets.
  const dirBytes = new Map()
  for (const rel of reachableCode) {
    const m = rel.match(/^(.*?(?:^|\/)(?:data|content|fixtures)(?:\/[^/]+)?)\//)
    if (m) dirBytes.set(m[1], (dirBytes.get(m[1]) ?? 0) + (sizeOf.get(rel) ?? 0))
  }
  const unreachableData = new Map()
  for (const f of files) {
    if (allForest.has(f.rel)) continue
    const m = f.rel.match(/^(.*?(?:^|\/)(?:data|content)(?:\/[^/]+)?)\//)
    if (m) unreachableData.set(m[1], (unreachableData.get(m[1]) ?? 0) + f.size)
  }
  for (const [dir, bytes] of dirBytes) {
    if (bytes > 2 * MiB) {
      const sample = reachableCode.find(r => r.startsWith(dir + '/'))
      findings.push({ rule: 'bundle-data', sev: bytes > 8 * MiB ? 'P1' : 'P2', file: dir + '/', lines: [0], effort: bytes > 8 * MiB ? [8, 20] : [2, 6],
        chain: allForest.chainTo(sample), msg: `${(bytes / MiB).toFixed(1)} MiB of data modules reachable from routes → inside the 64 MiB Worker bundle and every isolate's heap. Serve via public/*.json (content-hashed) or DB by id.` })
    }
  }
  const cssBytes = sumCss(root)
  const pageCount = entries.filter(e => e.kind === 'page').length
  return {
    reachableSourceMiB: +(reachableBytes / MiB).toFixed(1),
    heavy, dataDirs: [...dirBytes].map(([dir, b]) => ({ dir, mib: +(b / MiB).toFixed(2) })).sort((a, b) => b.mib - a.mib).slice(0, 8),
    unreachableDataDirs: [...unreachableData].map(([dir, b]) => ({ dir, mib: +(b / MiB).toFixed(2) })).filter(d => d.mib >= 0.5).sort((a, b) => b.mib - a.mib).slice(0, 8),
    cssMiB: +(cssBytes / MiB).toFixed(2), pageCount,
    findings,
  }
}

function sumCss(root) {
  let total = 0
  const walk = dir => {
    for (const n of readdirSync(dir)) {
      if (['node_modules', '.next', '.open-next', '.git', 'public', '.claude'].includes(n)) continue
      const p = join(dir, n)
      let st
      try { st = statSync(p) } catch { continue } // broken symlinks in real repos
      if (st.isDirectory()) walk(p)
      else if (n.endsWith('.css')) total += st.size
    }
  }
  for (const d of ['app', 'src', 'styles']) if (existsSync(join(root, d))) walk(join(root, d))
  return total
}

function requestDiet(root, entries, graph, reachableCode, text, pkg) {
  const findings = []
  const routeEntries = entries.filter(e => e.kind === 'route' || e.kind === 'pages-api')
  const globals = globalRoots(entries)
  const globalSet = graph.reachable(globals)
  const eagerGlobal = graph.reachable(globals, { eagerOnly: true })
  const perView = []
  let sessionProvider = null
  for (const rel of globalSet) {
    if (rel.endsWith('.json') || isTestFile(rel)) continue
    const src = text(rel)
    sessionProvider ??= sessionProviderUse(rel, src)
    // Only browser code makes per-view requests; '/api/...' literals in server files are usually
    // paths on third-party hosts (e.g. a Shopify GraphQL endpoint).
    if (!isClientFile(src)) continue
    for (const call of findApiCalls(rel, src)) perView.push({ ...call, loading: eagerGlobal.has(rel) ? 'eager' : 'lazy' })
  }
  if (sessionProvider) perView.unshift({ endpoint: '/api/auth/session', method: 'GET', file: sessionProvider.file, line: 0, implicit: true, trigger: 'mount', audience: 'guest', loading: 'eager' })

  // Calls wrapped in helpers (`loadEntitlement()` → `ensureMeInit()` → fetch) count as "on mount"
  // when an eager global component calls the chain inside an effect. Up to two helper levels.
  const eagerSources = [...eagerGlobal].filter(r => !r.endsWith('.json') && !isTestFile(r))
  for (const c of perView) {
    if (c.trigger !== 'unknown' || !c.fn || c.fn.length < 3) continue
    let names = [c.fn]
    for (let depth = 0; depth < 2 && c.trigger === 'unknown' && names.length; depth++) {
      const next = new Set()
      for (const name of names) {
        for (const rel of eagerSources) {
          const src = text(rel)
          const hit = callsInMount(src, name)
          if (hit) {
            c.trigger = 'mount'
            c.via = `${rel}:${hit.line}${name !== c.fn ? ` (${name} → ${c.fn})` : ''}`
            if (hit.guarded) c.audience = 'signed-in'
            break
          }
          for (const caller of callerNames(src, name)) next.add(caller)
        }
        if (c.trigger === 'mount') break
      }
      names = [...next].slice(0, 20)
    }
  }

  const seen = new Set()
  const perViewRows = []
  for (const c of perView) {
    const key = `${c.method} ${c.endpoint}`
    if (seen.has(key)) continue
    seen.add(key)
    const route = matchRoute(c.endpoint, routeEntries)
    const row = { ...c, route: route?.rel ?? null, mode: route?.mode ?? 'unknown' }
    if (c.implicit && route) row.mitigated = /session-token/.test(text(route.rel))
    perViewRows.push(row)
    const dynamic = row.mode === 'dynamic' && !row.mitigated
    // Findings only for high-confidence "runs on load" calls; the table keeps the rest for review.
    if (!dynamic || c.loading === 'lazy' || c.trigger !== 'mount') continue
    const write = c.method !== 'GET'
    const sev = c.audience === 'guest' && !write ? 'P1' : 'P2'
    const who = c.audience === 'guest' ? 'every page view' : 'every page view of signed-in users'
    findings.push({ rule: write ? 'per-view-write' : 'per-view-dynamic-api', sev, file: c.file, lines: [c.line], effort: sev === 'P1' ? [1, 3] : [0.5, 1.5], chain: [c.file],
      msg: `${key} — called on mount from a global layout component → ${who}; handler ${route?.rel ?? '?'} is dynamic (boots Next + DB on Workers).` +
        (c.implicit ? ' Return null without a session cookie.' : write ? ' Batch/beacon it or sample.' : ' Guest variant with `export const revalidate`, or defer to interaction.') })
  }
  if (sessionProvider && /beta/.test(pkg.nextAuth ?? '')) {
    findings.push({ rule: 'next-auth-double-session', sev: 'P2', file: sessionProvider.file, lines: [0], effort: [0.5, 1], chain: [sessionProvider.file],
      msg: `next-auth ${pkg.nextAuth} (v5 beta): SessionProvider can request /api/auth/session twice per page view (BroadcastChannel echo). Check the Network tab; if doubled, patch next-auth (pnpm patch) so the tab that fetched does not re-trigger itself.` })
  }

  const polling = []
  for (const rel of reachableCode) {
    if (rel.endsWith('.json')) continue
    polling.push(...findPolling(rel, text(rel)))
  }
  for (const p of polling) {
    if (p.ms < 10_000) findings.push({ rule: 'client-polling', sev: 'P2', file: p.file, lines: [p.line], effort: [0.5, 1], chain: [p.file],
      msg: `Polls every ${p.ms / 1000}s (${p.snippet}). Back off (3 s → 10 s), cap duration, pause when document.hidden.` })
  }

  // Whole client API surface: endpoint → callers, handler mode
  const surface = new Map()
  for (const rel of reachableCode) {
    if (rel.endsWith('.json')) continue
    const src = text(rel)
    if (!isClientFile(src)) continue
    for (const c of findApiCalls(rel, src)) {
      const key = `${c.method} ${c.endpoint}`
      const s = surface.get(key) ?? { endpoint: c.endpoint, method: c.method, callers: new Set() }
      s.callers.add(rel)
      surface.set(key, s)
    }
  }
  const apiSurface = [...surface.values()].map(s => {
    const r = matchRoute(s.endpoint, routeEntries)
    return { endpoint: s.endpoint, method: s.method, callers: s.callers.size, mode: r?.mode ?? 'unknown', route: r?.rel ?? null }
  }).sort((a, b) => b.callers - a.callers)

  return { globals, perView: perViewRows, polling, apiSurface, findings }
}
