// Module import graph: parse imports, resolve tsconfig paths, reachability + chains.
import { builtinModules } from 'node:module'
import { existsSync, statSync } from 'node:fs'
import { dirname, join, resolve, relative } from 'node:path'
import { CODE_EXT, readText, stripComments, toPosix } from './repo-files.mjs'
import { workspacePackages, workspaceTargets, readTsconfigChain } from './workspace.mjs'
import { loadTypeScript, parseImportsTs } from './ts-parser.mjs'

const BUILTINS = new Set(builtinModules.map(m => m.replace(/^node:/, '')))

const STATIC_RE = /(?:^|[^\w$.])(import|export)\s+(type\s+)?(?:[\w*{}\s,$]+?\s+from\s+)?['"]([^'"\n]+)['"]/g
const DYNAMIC_RE = /(?:^|[^\w$.])import\(\s*['"]([^'"\n]+)['"]\s*\)/g
const REQUIRE_RE = /(?:^|[^\w$.])require\(\s*['"]([^'"\n]+)['"]\s*\)/g

/** Raw specifiers of one source text: [{ spec, lazy, typeOnly }]. */
export function parseImports(src) {
  const code = stripComments(src)
  const out = []
  for (const m of code.matchAll(STATIC_RE)) out.push({ spec: m[3], lazy: false, typeOnly: Boolean(m[2]), reexport: m[1] === 'export' })
  for (const m of code.matchAll(DYNAMIC_RE)) out.push({ spec: m[1], lazy: true, typeOnly: false })
  for (const m of code.matchAll(REQUIRE_RE)) out.push({ spec: m[1], lazy: false, typeOnly: false })
  return out
}

export function packageName(spec) {
  const parts = spec.split('/')
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

export function createResolver(root) {
  const packages = workspacePackages(root)
  const ts = readTsconfigChain(root, packages)
  const paths = ts.paths.map(({ pattern, targets, base }) => ({
    prefix: pattern.replace(/\*$/, ''), wildcard: pattern.endsWith('*'), base,
    targets: targets.map(t => ({ prefix: t.replace(/\*$/, ''), wildcard: t.endsWith('*') })),
  }))

  const isFile = p => { try { return statSync(p).isFile() } catch { return false } }
  const tryFile = base => {
    if (isFile(base)) return base
    for (const ext of [...CODE_EXT, '.json']) if (isFile(base + ext)) return base + ext
    // TS ESM style: './x.js' pointing at x.ts
    const noJs = base.replace(/\.(m|c)?js$/, '')
    if (noJs !== base) for (const ext of CODE_EXT) if (isFile(noJs + ext)) return noJs + ext
    for (const ext of CODE_EXT) if (isFile(join(base, 'index' + ext))) return join(base, 'index' + ext)
    return null
  }

  /** → { file: rel } | { pkg } | { builtin } | { unresolved } */
  return function resolveSpec(fromAbs, spec) {
    const bare = spec.replace(/^node:/, '')
    if (spec.startsWith('node:') || BUILTINS.has(bare.split('/')[0]) && !spec.startsWith('.')) return { builtin: bare.split('/')[0] }
    if (spec.startsWith('cloudflare:')) return { builtin: spec }
    if (spec.startsWith('.') || spec.startsWith('/')) {
      const f = tryFile(resolve(dirname(fromAbs), spec))
      return f ? { file: toPosix(relative(root, f)) } : { unresolved: spec }
    }
    for (const p of paths) {
      if (p.wildcard ? !spec.startsWith(p.prefix) : spec !== p.prefix) continue
      const rest = p.wildcard ? spec.slice(p.prefix.length) : ''
      for (const t of p.targets) {
        const f = tryFile(resolve(p.base, t.prefix + (t.wildcard ? rest : '')))
        if (f) return { file: toPosix(relative(root, f)) }
      }
    }
    const name = packageName(spec)
    const ws = packages.get(name)
    if (ws) {
      // Workspace package: follow into its source so its code is analysed like the app's own.
      for (const candidate of workspaceTargets(ws, spec.slice(name.length + 1))) {
        const f = tryFile(candidate)
        if (f) return { file: toPosix(relative(root, f)), workspace: name }
      }
      return { pkg: name, workspace: name }
    }
    if (ts.baseUrl) {
      const f = tryFile(resolve(ts.baseUrl, spec))
      if (f) return { file: toPosix(relative(root, f)) }
    }
    return { pkg: name }
  }
}

/**
 * Lazily-built graph. node(rel) → { edges: [{ to?, pkg?, builtin?, lazy }] }.
 * Type-only imports are dropped: they never reach the bundle.
 */
export function createGraph(root, { parser = 'auto' } = {}) {
  const resolveSpec = createResolver(root)
  const ts = parser === 'regex' ? null : loadTypeScript(root)
  const parse = (src, abs) => {
    if (!ts) return parseImports(src)
    try { return parseImportsTs(ts, src, abs) } catch { return parseImports(src) }
  }
  const nodes = new Map()
  const node = rel => {
    let n = nodes.get(rel)
    if (n) return n
    const abs = join(root, rel)
    const src = rel.endsWith('.json') || !existsSync(abs) ? '' : readText(abs)
    const edges = []
    for (const imp of parse(src, abs)) {
      if (imp.typeOnly) continue
      const r = resolveSpec(abs, imp.spec)
      if (r.file) edges.push({ to: r.file, lazy: imp.lazy, reexport: Boolean(imp.reexport) })
      else if (r.pkg) edges.push({ pkg: r.pkg, lazy: imp.lazy })
      else if (r.builtin) edges.push({ builtin: r.builtin, lazy: imp.lazy })
    }
    n = { rel, edges }
    nodes.set(rel, n)
    return n
  }

  /** Set of files reachable from `roots` (following lazy edges unless eagerOnly). */
  const reachable = (roots, { eagerOnly = false } = {}) => {
    const seen = new Set()
    const stack = [...roots]
    while (stack.length) {
      const rel = stack.pop()
      if (seen.has(rel)) continue
      seen.add(rel)
      for (const e of node(rel).edges) if (e.to && !(eagerOnly && e.lazy) && !seen.has(e.to)) stack.push(e.to)
    }
    return seen
  }

  /** Shortest import chain root → target, or null. */
  const chain = (rootRel, target) => {
    const prev = new Map([[rootRel, null]])
    const queue = [rootRel]
    while (queue.length) {
      const cur = queue.shift()
      if (cur === target) {
        const path = []
        for (let c = cur; c; c = prev.get(c)) path.unshift(c)
        return path
      }
      for (const e of node(cur).edges) if (e.to && !prev.has(e.to)) { prev.set(e.to, cur); queue.push(e.to) }
    }
    return null
  }

  /** Multi-source BFS: parent pointers giving each reachable file its shortest chain from any root. */
  const forest = roots => {
    const parent = new Map(roots.map(r => [r, null]))
    const queue = [...roots]
    for (let i = 0; i < queue.length; i++) {
      for (const e of node(queue[i]).edges) if (e.to && !parent.has(e.to)) { parent.set(e.to, queue[i]); queue.push(e.to) }
    }
    const chainTo = rel => {
      if (!parent.has(rel)) return null
      const path = []
      for (let c = rel; c; c = parent.get(c)) path.unshift(c)
      return path
    }
    /** True when the chain crosses a barrel (`export … from`): reachable for the bundler, not necessarily called. */
    const viaBarrel = rel => {
      const c = chainTo(rel)
      if (!c) return false
      for (let i = 1; i < c.length; i++) if (node(c[i - 1]).edges.some(e => e.to === c[i] && e.reexport)) return true
      return false
    }
    return { has: rel => parent.has(rel), files: () => parent.keys(), chainTo, viaBarrel }
  }

  return { node, reachable, chain, forest, parser: ts ? `typescript ${ts.version}` : 'regex' }
}
