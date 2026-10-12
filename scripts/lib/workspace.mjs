// Monorepo support: workspace packages (pnpm/npm/yarn/bun) and tsconfig `extends` chains, so
// imports like `@repo/ui` or `@/lib/x` defined in a shared tsconfig resolve to real source files.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { readJson } from './repo-files.mjs'

/** Nearest ancestor (including root) that declares workspaces; null if none. */
export function findWorkspaceRoot(root) {
  let dir = resolve(root)
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir
    const pkg = readJson(join(dir, 'package.json'))
    if (pkg?.workspaces) return dir
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return null
}

function workspaceGlobs(wsRoot) {
  const yaml = join(wsRoot, 'pnpm-workspace.yaml')
  if (existsSync(yaml)) {
    const text = readFileSync(yaml, 'utf8')
    const block = text.split(/^packages:\s*$/m)[1] ?? ''
    return [...block.matchAll(/^\s*-\s*['"]?([^'"\n#]+?)['"]?\s*$/gm)].map(m => m[1]).filter(g => !g.startsWith('!'))
  }
  const ws = readJson(join(wsRoot, 'package.json'))?.workspaces
  return Array.isArray(ws) ? ws : ws?.packages ?? []
}

const isDir = p => { try { return statSync(p).isDirectory() } catch { return false } }

/** Expand 'apps/*', 'packages/**', 'tooling/config' into package directories. */
function expand(wsRoot, glob) {
  const parts = glob.replace(/\/$/, '').split('/')
  let dirs = [wsRoot]
  for (const part of parts) {
    const next = []
    for (const d of dirs) {
      if (part === '*' || part === '**') {
        for (const n of readdirSync(d)) if (!n.startsWith('.') && n !== 'node_modules' && isDir(join(d, n))) next.push(join(d, n))
        if (part === '**') next.push(...dirs.flatMap(x => (isDir(x) ? readdirSync(x).filter(n => n !== 'node_modules' && !n.startsWith('.')).map(n => join(x, n)).filter(isDir) : [])))
      } else if (isDir(join(d, part))) next.push(join(d, part))
    }
    dirs = next
  }
  return dirs.filter(d => existsSync(join(d, 'package.json')))
}

/** name → { dir, pkg } for every workspace package. */
export function workspacePackages(root) {
  const wsRoot = findWorkspaceRoot(root)
  const map = new Map()
  if (!wsRoot) return map
  for (const glob of workspaceGlobs(wsRoot)) {
    for (const dir of expand(wsRoot, glob)) {
      const pkg = readJson(join(dir, 'package.json'))
      if (pkg?.name) map.set(pkg.name, { dir, pkg })
    }
  }
  return map
}

const CONDITIONS = ['source', 'development', 'react-server', 'import', 'module', 'node', 'default', 'require', 'types']

function pickTarget(entry) {
  if (typeof entry === 'string') return entry
  if (Array.isArray(entry)) return entry.map(pickTarget).find(Boolean) ?? null
  if (entry && typeof entry === 'object') for (const c of CONDITIONS) if (entry[c]) return pickTarget(entry[c])
  return null
}

/** Candidate file paths (without extension probing) for `pkgName/subpath` inside a workspace package. */
export function workspaceTargets({ dir, pkg }, subpath) {
  const key = subpath ? `./${subpath}` : '.'
  const out = []
  const exp = pkg.exports
  if (exp && typeof exp === 'object' && !Array.isArray(exp) && Object.keys(exp).some(k => k.startsWith('.'))) {
    if (exp[key]) out.push(pickTarget(exp[key]))
    for (const [pattern, target] of Object.entries(exp)) {
      if (!pattern.includes('*')) continue
      const [pre, post] = pattern.split('*')
      if (key.startsWith(pre) && key.endsWith(post)) out.push(pickTarget(target)?.replace('*', key.slice(pre.length, key.length - post.length)))
    }
  } else if (!subpath && exp) out.push(pickTarget(exp))
  if (!subpath) out.push(pkg.source, pkg.module, pkg.main, 'src/index', 'index')
  else out.push(subpath, `src/${subpath}`)
  // Built paths (dist/*.js) usually mirror src/*.ts in workspaces that are not prebuilt.
  return out.filter(Boolean).flatMap(p => [join(dir, p), join(dir, p.replace(/^\.?\/?dist\//, 'src/').replace(/\.(m|c)?js$/, ''))])
}

/** tsconfig with `extends` merged (relative files and workspace/npm packages); paths keep their own base dir. */
export function readTsconfigChain(root, packages, file = join(root, 'tsconfig.json'), depth = 0) {
  const cfg = readJson(file) ?? readJson(join(root, 'jsconfig.json'))
  if (!cfg || depth > 4) return { paths: [], baseUrl: null }
  const own = cfg.compilerOptions ?? {}
  const cfgDir = dirname(file)
  let inherited = { paths: [], baseUrl: null }
  for (const ext of [cfg.extends].flat().filter(Boolean)) {
    let target = null
    if (ext.startsWith('.')) target = resolve(cfgDir, ext.endsWith('.json') ? ext : `${ext}.json`)
    else {
      const name = ext.startsWith('@') ? ext.split('/').slice(0, 2).join('/') : ext.split('/')[0]
      const rest = ext.slice(name.length + 1)
      const base = packages.get(name)?.dir ?? join(root, 'node_modules', name)
      target = join(base, rest ? (rest.endsWith('.json') ? rest : `${rest}.json`) : 'tsconfig.json')
    }
    if (target && existsSync(target)) {
      const parent = readTsconfigChain(dirname(target), packages, target, depth + 1)
      inherited = { paths: [...parent.paths, ...inherited.paths], baseUrl: parent.baseUrl ?? inherited.baseUrl }
    }
  }
  const baseUrl = own.baseUrl ? resolve(cfgDir, own.baseUrl) : inherited.baseUrl
  const pathBase = baseUrl ?? cfgDir
  const ownPaths = Object.entries(own.paths ?? {}).map(([pattern, targets]) => ({ pattern, targets, base: pathBase }))
  // Own `paths` replace inherited ones entirely (TypeScript semantics).
  return { paths: own.paths ? ownPaths : inherited.paths, baseUrl }
}
