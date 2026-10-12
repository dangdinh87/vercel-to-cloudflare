// File discovery + cached reads for the repo analyzer.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, relative, extname } from 'node:path'

export const CODE_EXT = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']
const SKIP_DIRS = new Set([
  'node_modules', '.next', '.open-next', '.vercel', '.wrangler', '.git', '.turbo', '.claude',
  'dist', 'build', 'out', 'coverage', 'public', 'plans', 'docs', '.cache',
])

/** All code + json files under root (skipping build output, deps, docs, public assets). */
export function listFiles(root) {
  const out = []
  const walk = dir => {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue
      const abs = join(dir, name)
      let st
      try { st = statSync(abs) } catch { continue }
      if (st.isDirectory()) walk(abs)
      else {
        const ext = extname(name)
        if (CODE_EXT.includes(ext) || ext === '.json') out.push({ abs, rel: toPosix(relative(root, abs)), size: st.size, ext })
      }
    }
  }
  walk(root)
  return out
}

export const toPosix = p => p.split('\\').join('/')

const textCache = new Map()
export function readText(abs) {
  let t = textCache.get(abs)
  if (t === undefined) {
    t = existsSync(abs) ? readFileSync(abs, 'utf8') : ''
    textCache.set(abs, t)
  }
  return t
}

/**
 * Strip comments, keeping strings and line numbers intact (comment chars → spaces).
 * A tiny state machine: regexes like `'/api/*'` or `"https://x"` inside strings must survive.
 */
export function stripComments(src) {
  let out = ''
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i], d = src[i + 1]
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') { out += ' '; i++ }
    } else if (c === '/' && d === '*') {
      out += '  '; i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++ }
      if (i < n) { out += '  '; i += 2 }
    } else if (c === '"' || c === "'" || c === '`') {
      out += c; i++
      while (i < n && src[i] !== c) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] ?? ''); i += 2; continue }
        if (c !== '`' && src[i] === '\n') break // unterminated quote (e.g. regex literal) — resync at EOL
        out += src[i]; i++
      }
      if (i < n && src[i] === c) { out += c; i++ }
    } else {
      out += c; i++
    }
  }
  return out
}

export const isTestFile = rel => /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel) || /(^|\/)(__tests__|__mocks__|e2e)\//.test(rel)
export const isClientFile = src => /^\s*(['"])use client\1/m.test(src.slice(0, 400))

export function readJson(abs) {
  if (!existsSync(abs)) return null
  // tsconfig allows comments + trailing commas
  const raw = stripComments(readFileSync(abs, 'utf8')).replace(/,(\s*[}\]])/g, '$1')
  try { return JSON.parse(raw) } catch { return null }
}

export function lineOf(src, index) {
  let line = 1
  for (let i = 0; i < index && i < src.length; i++) if (src.charCodeAt(i) === 10) line++
  return line
}
