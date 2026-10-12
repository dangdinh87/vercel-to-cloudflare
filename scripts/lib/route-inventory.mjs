// App/Pages Router entry discovery + render-mode classification (build-time vs request-time).
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readText, stripComments, isClientFile } from './repo-files.mjs'

const APP_SPECIAL = /^(page|layout|template|default|not-found|forbidden|unauthorized|global-error|error|loading|route|opengraph-image|twitter-image|icon|apple-icon|sitemap|robots|manifest)\.(tsx?|jsx?|mjs)$/
const SHARED_KINDS = new Set(['layout', 'template', 'default', 'not-found', 'forbidden', 'unauthorized', 'global-error', 'error', 'loading'])
const METADATA_KINDS = new Set(['opengraph-image', 'twitter-image', 'icon', 'apple-icon', 'sitemap', 'robots', 'manifest'])
export const RUNTIME_MODES = new Set(['dynamic', 'isr', 'on-demand', 'ssg+on-demand', 'runtime'])

function num(expr) {
  if (expr == null) return undefined
  const e = expr.replace(/_/g, '').replace(/\s+as\s+const$/, '').trim()
  if (e === 'false') return false
  if (/^[\d\s*+]+$/.test(e)) return e.split('+').reduce((s, term) => s + term.split('*').reduce((p, f) => p * Number(f.trim() || 1), 1), 0)
  return undefined
}

export function readSegmentConfig(src) {
  const code = stripComments(src)
  const get = name => code.match(new RegExp(`export\\s+const\\s+${name}\\s*(?::[^=\\n]+)?=\\s*([^;\\n]+)`))?.[1]?.trim()
  const dp = get('dynamicParams')
  const methods = new Set()
  for (const m of code.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)) methods.add(m[1])
  for (const m of code.matchAll(/export\s+const\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)) methods.add(m[1])
  for (const m of code.matchAll(/export\s+const\s*\{([^}]+)\}\s*=/g)) for (const k of m[1].split(',')) if (/^(GET|POST|PUT|PATCH|DELETE)$/.test(k.trim())) methods.add(k.trim())
  for (const m of code.matchAll(/export\s*\{([^}]+)\}/g)) for (const k of m[1].split(',')) { const n = k.trim().split(/\s+as\s+/).pop(); if (/^(GET|POST|PUT|PATCH|DELETE)$/.test(n)) methods.add(n) }
  return {
    dynamic: get('dynamic')?.replace(/['"]/g, ''),
    revalidate: num(get('revalidate')),
    dynamicParams: dp === 'false' ? false : dp === 'true' ? true : undefined,
    runtime: get('runtime')?.replace(/['"]/g, ''),
    maxDuration: num(get('maxDuration')),
    hasGenerateStaticParams: /export\s+(?:async\s+)?function\s+generateStaticParams|export\s+const\s+generateStaticParams/.test(code),
    methods: [...methods],
    pagesSsr: /export\s+(?:async\s+)?function\s+getServerSideProps|export\s+const\s+getServerSideProps/.test(code),
    pagesIsr: /revalidate\s*:\s*\d/.test(code) && /getStaticProps/.test(code),
  }
}

/** Server-side request-time APIs that force dynamic rendering. Client files never count. */
export function usesDynamicApi(src) {
  // Client components and server-action modules don't make the render dynamic.
  if (isClientFile(src) || /^\s*(['"])use server\1/m.test(src.slice(0, 400))) return false
  const code = stripComments(src)
  return /from\s+['"]next\/headers['"]/.test(code) || /\bconnection\(\)/.test(code) || /\bawait\s+auth\(\)/.test(code)
    || /\b(unstable_noStore|noStore)\(\)/.test(code)
}

function routePathOf(dirSegments) {
  const segs = dirSegments.filter(s => !/^\(.*\)$/.test(s) && !s.startsWith('@'))
  return '/' + segs.join('/')
}

/**
 * Discover entries. Returns [{ rel, kind, routePath, config, dynamicSegment, ancestors: [rel] }].
 * `ancestors` = layout/template files above (they render with the page).
 */
export function discoverEntries(root, files) {
  const entries = []
  const appRoots = ['app', 'src/app'].filter(d => existsSync(join(root, d)))
  for (const appRoot of appRoots) {
    const layoutsByDir = new Map()
    const prefix = appRoot + '/'
    for (const f of files) {
      if (!f.rel.startsWith(prefix)) continue
      const parts = f.rel.slice(prefix.length).split('/')
      const name = parts.pop()
      const m = name.match(APP_SPECIAL)
      if (!m || parts.some(p => p.startsWith('_'))) continue
      const kind = m[1]
      const e = { rel: f.rel, kind, dirParts: parts, routePath: routePathOf(parts), dynamicSegment: parts.some(p => p.startsWith('[')) }
      if (kind === 'layout' || kind === 'template') {
        const key = parts.join('/')
        layoutsByDir.set(key, [...(layoutsByDir.get(key) ?? []), f.rel])
      }
      entries.push(e)
    }
    for (const e of entries) {
      if (!e.rel.startsWith(prefix)) continue
      const anc = []
      for (let i = 0; i <= e.dirParts.length; i++) {
        const key = e.dirParts.slice(0, i).join('/')
        for (const l of layoutsByDir.get(key) ?? []) if (l !== e.rel) anc.push(l)
      }
      e.ancestors = anc
    }
  }
  for (const pagesRoot of ['pages', 'src/pages'].filter(d => existsSync(join(root, d)))) {
    for (const f of files) {
      if (!f.rel.startsWith(pagesRoot + '/') || !/\.(tsx?|jsx?|mjs)$/.test(f.rel)) continue
      const parts = f.rel.slice(pagesRoot.length + 1).replace(/\.(tsx?|jsx?|mjs)$/, '').split('/')
      const kind = parts[0] === 'api' ? 'pages-api' : /^_(app|document|error)$/.test(parts.at(-1)) ? 'pages-shared' : 'pages-page'
      entries.push({ rel: f.rel, kind, dirParts: parts, routePath: '/' + parts.join('/').replace(/\/?index$/, ''), dynamicSegment: parts.some(p => p.startsWith('[')), ancestors: [] })
    }
  }
  for (const name of ['middleware', 'proxy', 'instrumentation']) {
    for (const dir of ['', 'src/']) for (const ext of ['.ts', '.js', '.mjs']) {
      const rel = `${dir}${name}${ext}`
      if (files.some(f => f.rel === rel)) entries.push({ rel, kind: name, dirParts: [], routePath: '*', dynamicSegment: false, ancestors: [] })
    }
  }
  for (const e of entries) e.config = readSegmentConfig(readText(join(root, e.rel)))
  return entries
}

/**
 * Assign e.mode + e.why. `reachesDynamicApi(rels)` → a reachable file using a dynamic API (or null);
 * `readEntry(e)` → entry source text.
 * Modes: static-build, ssg, isr, on-demand, ssg+on-demand, dynamic, runtime, shared.
 */
export function classifyEntries(entries, { reachesDynamicApi, readEntry }) {
  for (const e of entries) {
    const c = e.config
    if (e.kind === 'middleware' || e.kind === 'proxy' || e.kind === 'instrumentation') { e.mode = 'runtime'; e.why = 'runs on every matching request'; continue }
    if (e.kind === 'pages-api') { e.mode = 'dynamic'; e.why = 'pages API route'; continue }
    if (e.kind === 'pages-page') {
      e.mode = c.pagesSsr ? 'dynamic' : c.pagesIsr ? 'isr' : 'static-build'
      e.why = c.pagesSsr ? 'getServerSideProps' : c.pagesIsr ? 'getStaticProps revalidate' : 'static'
      continue
    }
    if (SHARED_KINDS.has(e.kind) || e.kind === 'pages-shared') { e.mode = 'shared'; continue }
    if (e.kind === 'route') {
      if (c.dynamic === 'force-dynamic' || c.revalidate === 0) { e.mode = 'dynamic'; e.why = 'force-dynamic'; continue }
      if (typeof c.revalidate === 'number') { e.mode = 'isr'; e.why = `revalidate=${c.revalidate}`; continue }
      if (c.dynamic === 'force-static' || c.revalidate === false) { e.mode = e.dynamicSegment && c.dynamicParams !== false ? 'ssg+on-demand' : 'static-build'; e.why = 'force-static'; continue }
      e.mode = 'dynamic'; e.why = 'route handlers are dynamic by default'; continue
    }
    // page + metadata routes
    const dynFile = reachesDynamicApi([e.rel, ...e.ancestors])
    if (c.dynamic === 'force-dynamic' || c.revalidate === 0) { e.mode = 'dynamic'; e.why = 'force-dynamic'; continue }
    if (c.dynamic !== 'force-static' && dynFile) { e.mode = 'dynamic'; e.why = `dynamic API in ${dynFile}`; continue }
    if (e.kind === 'page' && c.dynamic !== 'force-static' && /\bsearchParams\b/.test(stripComments(readEntry(e)))) { e.mode = 'dynamic'; e.why = 'reads searchParams'; continue }
    if (typeof c.revalidate === 'number') { e.mode = 'isr'; e.why = `revalidate=${c.revalidate}`; continue }
    if (e.dynamicSegment) {
      if (c.hasGenerateStaticParams && c.dynamicParams === false) { e.mode = 'ssg'; e.why = 'generateStaticParams + dynamicParams=false' }
      else if (c.hasGenerateStaticParams) { e.mode = 'ssg+on-demand'; e.why = 'unknown params render at request time' }
      else { e.mode = 'on-demand'; e.why = 'dynamic segment without generateStaticParams' }
      continue
    }
    e.mode = 'static-build'; e.why = METADATA_KINDS.has(e.kind) ? 'static metadata route' : 'no dynamic API'
  }
  // Shared files (layouts, error, loading) render at request time when any route below them does.
  for (const e of entries) {
    if (e.mode !== 'shared') continue
    const below = entries.filter(x => x !== e && x.mode !== 'shared' && x.rel.startsWith(e.rel.slice(0, e.rel.lastIndexOf('/') + 1)))
    e.runtime = below.some(x => RUNTIME_MODES.has(x.mode)) || e.kind === 'not-found' || e.kind === 'error' || e.kind === 'global-error'
  }
  for (const e of entries) if (e.mode !== 'shared') e.runtime = RUNTIME_MODES.has(e.mode)
  return entries
}
