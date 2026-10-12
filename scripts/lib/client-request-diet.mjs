// Finds requests the browser makes on EVERY page view (from global layouts) and client polling,
// then maps each /api endpoint to its route handler's render mode. On Workers every dynamic hit
// boots Next (100–400 ms CPU) and usually wakes the DB; ISR hits are served from R2.
import { stripComments, isClientFile, lineOf } from './repo-files.mjs'

const API_LITERAL = /(['"`])(\/api\/[^'"`\s?#]*)/g
const NETWORKY = /fetch\(|refresh|reload|\bload|poll|mutate|check|sync|revalidate|invalidate/i
// Early-return guards that keep a call to signed-in users only.
const AUTH_GUARD = /if\s*\(\s*(?:!\s*(?:user|session|userId|isSignedIn|isLoggedIn|isAuthenticated)\b|status\s*!==?\s*['"]authenticated['"]|status\s*===?\s*['"]unauthenticated['"])[^)]*\)\s*\{?\s*return/
const HANDLER_NAME = /^(on[A-Z]|handle)|submit|click|send|toggle|delete|remove|save|report|dismiss|vote|like|share|copy|open|close/i
/** Global layouts: app root layout(s) incl. a top-level [locale]-style segment, pages _app. */
export function globalRoots(entries) {
  return entries.filter(e =>
    (e.kind === 'layout' && e.dirParts.filter(p => !/^\(.*\)$/.test(p)).every((p, i) => i === 0 && p.startsWith('[')))
    || (e.kind === 'pages-shared' && /_app$/.test(e.rel.replace(/\.\w+$/, ''))),
  ).map(e => e.rel)
}

/** End index of the call whose '(' is at openIdx (strings skipped). */
function callEnd(code, openIdx) {
  let depth = 0
  for (let i = openIdx; i < code.length; i++) {
    const c = code[i]
    if (c === '"' || c === "'" || c === '`') { const q = c; i++; while (i < code.length && code[i] !== q) { if (code[i] === '\\') i++; i++ } continue }
    if (c === '(') depth++
    else if (c === ')' && --depth === 0) return i
  }
  return code.length
}

function mountRanges(code) {
  const ranges = []
  for (const m of code.matchAll(/\b(?:useEffect|useLayoutEffect|useSWR|useQuery|useSWRImmutable)\s*\(/g)) {
    const open = m.index + m[0].length - 1
    ranges.push([open, callEnd(code, open)])
  }
  return ranges
}

const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'return', 'function', 'else', 'do', 'try'])

function enclosingFunctionName(code, index) {
  const head = code.slice(Math.max(0, index - 3000), index)
  let name = null
  for (const m of head.matchAll(/(?:function\s+(\w+)|(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>|(\w+)\s*\([^)]*\)\s*\{)/g)) {
    const n = m[1] ?? m[2] ?? m[3]
    if (n && !KEYWORDS.has(n)) name = n
  }
  return name
}

function normalizeEndpoint(raw) {
  const cut = raw.indexOf('${')
  let ep = raw
  if (cut >= 0) ep = raw[cut - 1] === '/' ? raw.slice(0, cut) + '*' : raw.slice(0, cut)
  return ep.replace(/\$\{[^}]*\}/g, '*').replace(/\/$/, '') || '/api'
}

/**
 * API literals with context: trigger = mount | on-open | handler | unknown, audience = guest | signed-in.
 * Heuristic, but it separates "every page view" from "on click" well enough to rank.
 */
export function findApiCalls(rel, src) {
  const code = stripComments(src)
  const ranges = mountRanges(code)
  const lines = code.split('\n')
  const out = []
  for (const m of code.matchAll(API_LITERAL)) {
    const after = code.slice(m.index, m.index + 300)
    const before = code.slice(Math.max(0, m.index - 40), m.index)
    const method = /sendBeacon\??\.?\(\s*$/.test(before) ? 'POST' : after.match(/method\s*:\s*['"](\w+)['"]/)?.[1]?.toUpperCase() ?? 'GET'
    const endpoint = normalizeEndpoint(m[2])
    const line = lineOf(code, m.index)
    const fn = enclosingFunctionName(code, m.index)
    const range = ranges.find(([a, b]) => m.index > a && m.index < b)
    // `useEffect(() => { if (!open) return; fetch(...) }, [open])` = runs when a modal/panel opens.
    const openGated = range && /if\s*\(\s*!\s*(open|isOpen|visible|show|expanded)\b/.test(code.slice(range[0], m.index))
    const trigger = openGated ? 'on-open' : range ? 'mount' : (fn && HANDLER_NAME.test(fn)) ? 'handler' : 'unknown'
    const scope = range ? code.slice(range[0], m.index) : lines.slice(Math.max(0, line - 15), line).join('\n')
    const audience = /\/me(\/|$)/.test(endpoint) || AUTH_GUARD.test(scope) ? 'signed-in' : 'guest'
    out.push({ endpoint, method, file: rel, line, trigger, audience, fn })
  }
  return out
}

/**
 * One level of indirection: is `fnName(...)` called inside a useEffect/useSWR in this source?
 * Lets `ensureMeInit()` (defined in a lib, called from a hook's effect) count as "on mount".
 */
export function callsInMount(src, fnName) {
  if (!fnName || !src.includes(fnName)) return null
  const code = stripComments(src)
  const ranges = mountRanges(code)
  const re = new RegExp(`(?<![\\w.$])${fnName.replace(/[$]/g, '\\$')}\\s*\\(`, 'g')
  for (const m of code.matchAll(re)) {
    const range = ranges.find(([a, b]) => m.index > a && m.index < b)
    if (range) return { line: lineOf(code, m.index), guarded: AUTH_GUARD.test(code.slice(range[0], m.index)) }
  }
  return null
}

/** Names of the functions that call `fnName(...)` outside any effect (next level to follow). */
export function callerNames(src, fnName) {
  if (!fnName || !src.includes(fnName)) return []
  const code = stripComments(src)
  const re = new RegExp(`(?<![\\w.$])${fnName.replace(/[$]/g, '\\$')}\\s*\\(`, 'g')
  const names = new Set()
  for (const m of code.matchAll(re)) {
    const n = enclosingFunctionName(code, m.index)
    if (n && n !== fnName && n.length >= 3) names.add(n)
  }
  return [...names]
}

export function findPolling(rel, src) {
  if (!isClientFile(src)) return []
  const code = stripComments(src)
  const out = []
  const push = (index, ms, snippet) => {
    if (ms >= 500 && ms < 60_000) out.push({ file: rel, line: lineOf(code, index), ms, snippet: snippet.replace(/\s+/g, ' ').slice(0, 80) })
  }
  const toMs = s => s.replace(/_/g, '').split('*').reduce((p, f) => p * Number(f.trim() || 1), 1)
  for (const m of code.matchAll(/setInterval\s*\(/g)) {
    const open = m.index + m[0].length - 1
    const body = code.slice(open, callEnd(code, open) + 1)
    const delay = body.match(/,\s*([A-Z_]+|[\d_*\s]+)\s*\)$/)?.[1]?.trim()
    if (!delay || !NETWORKY.test(body)) continue // countdowns/animations are not requests
    const value = /^[A-Z_]+$/.test(delay) ? code.match(new RegExp(`\\b${delay}\\s*=\\s*([\\d_*\\s]+)`))?.[1] : delay
    if (value) push(m.index, toMs(value), body)
  }
  for (const m of code.matchAll(/\b(?:refreshInterval|refetchInterval)\s*:\s*([\d_]+)/g)) push(m.index, toMs(m[1]), m[0])
  for (const m of code.matchAll(/\b[A-Z_]*POLL[A-Z_]*_MS\s*=\s*([\d_*\s]+)/g)) push(m.index, toMs(m[1]), m[0])
  return out
}

/** Match '/api/a/*' against route entries ('/api/a/[id]', '/api/auth/[...nextauth]'); most specific wins. */
export function matchRoute(endpoint, routeEntries) {
  const segs = endpoint.split('/').filter(Boolean)
  let best = null
  for (const e of routeEntries) {
    const rs = e.routePath.split('/').filter(Boolean)
    const score = routeScore(rs, segs)
    if (score >= 0 && (!best || score > best.score)) best = { entry: e, score }
  }
  return best?.entry ?? null
}

function routeScore(rs, segs) {
  let score = 0
  for (let i = 0; i < rs.length; i++) {
    const r = rs[i]
    if (r.startsWith('[[...')) return score
    if (r.startsWith('[...')) return segs.length > i ? score : -1
    if (i >= segs.length) return -1
    if (r.startsWith('[')) { score += 1; continue }
    if (segs[i] !== r) return -1
    score += 3
  }
  return rs.length === segs.length ? score + 1 : -1
}

export function sessionProviderUse(rel, src) {
  return /SessionProvider/.test(src) && /from\s+['"]next-auth\/react['"]/.test(src) ? { file: rel } : null
}
