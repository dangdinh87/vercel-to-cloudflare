// next.config / vercel.json / package.json / env checks.
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { readText, readJson, stripComments, isClientFile } from './repo-files.mjs'

export function checkNextConfig(root) {
  const name = ['next.config.ts', 'next.config.mjs', 'next.config.js', 'next.config.cjs'].find(n => existsSync(join(root, n)))
  if (!name) return { file: null, findings: [], facts: {} }
  const src = stripComments(readText(join(root, name)))
  const findings = []
  const line = re => { const i = src.search(re); return i < 0 ? 0 : src.slice(0, i).split('\n').length }
  const f = (rule, sev, re, msg, effort) => findings.push({ rule, sev, file: name, line: line(re), msg, effort })

  if (/inlineCss\s*:(?!\s*false\b)/.test(src)) f('inline-css', 'P0', /inlineCss/, 'experimental.inlineCss copies CSS into every route manifest (can push the bundle past the 64 MiB limit). Turn off for Workers (Lighthouse −2/−3 measured).', [0.25, 0.5])
  if (/output\s*:\s*['"]export['"]/.test(src)) f('output-export', 'INFO', /output\s*:/, 'Static export: deploy to Workers static assets / Pages — no OpenNext needed.', [0, 0])
  const images = /images\s*:\s*\{[\s\S]*?\}/.exec(src)?.[0] ?? ''
  const unoptimized = /unoptimized\s*:\s*true/.test(images)
  const customLoader = /loader(File)?\s*:/.test(images)
  if (!unoptimized && !customLoader) f('image-optimization', 'P2', /images\s*:|module\.exports|export default/, 'next/image optimization needs a Cloudflare Images binding/loader on Workers; or set images.unoptimized / per-image unoptimized for SVG/icons.', [0.5, 2])
  if (/serverExternalPackages|serverComponentsExternalPackages/.test(src)) f('server-external', 'P3', /server(Components)?ExternalPackages/, 'serverExternalPackages: each listed package must load on workerd — check them on the trial build.', [0, 1])
  if (/\b(ppr|cacheComponents|dynamicIO|useCache)\s*:\s*(true|['"]incremental['"])/.test(src)) f('next-experimental', 'P2', /\b(ppr|cacheComponents|dynamicIO|useCache)\s*:/, 'PPR / cacheComponents / use cache: check OpenNext support and cache-handler behaviour for your exact versions before migrating.', [1, 4])
  if (/outputFileTracingIncludes/.test(src)) f('tracing-includes', 'P2', /outputFileTracingIncludes/, 'outputFileTracingIncludes ships files for runtime fs reads — those reads will fail on Workers.', [1, 3])
  return { file: name, findings, facts: { imagesUnoptimized: unoptimized, hasRedirects: /redirects\s*\(/.test(src), hasHeaders: /headers\s*\(/.test(src) } }
}

export function checkVercelJson(root) {
  const cfg = readJson(join(root, 'vercel.json'))
  if (!cfg) return { findings: [], crons: [] }
  const findings = []
  const crons = cfg.crons ?? []
  if (crons.length) findings.push({ rule: 'vercel-crons', sev: 'P2', file: 'vercel.json', line: 0, effort: [1, 2],
    msg: `${crons.length} Vercel cron(s) → wrangler "triggers.crons" + scheduled handler, or GitHub Actions curl with a secret: ${crons.map(c => `${c.schedule} ${c.path}`).join('; ')}` })
  for (const key of ['redirects', 'rewrites', 'headers']) if (cfg[key]?.length) findings.push({ rule: 'vercel-routing', sev: 'P2', file: 'vercel.json', line: 0, effort: [0.5, 2],
    msg: `vercel.json ${key} (${cfg[key].length}) are ignored on Workers → move into next.config ${key}().` })
  if (cfg.functions) findings.push({ rule: 'vercel-functions', sev: 'P3', file: 'vercel.json', line: 0, effort: [0, 0.5], msg: 'functions memory/maxDuration settings do not apply; Workers: 128 MB, limits.cpu_ms.' })
  if (cfg.regions) findings.push({ rule: 'vercel-regions', sev: 'INFO', file: 'vercel.json', line: 0, effort: [0, 0], msg: `regions ${JSON.stringify(cfg.regions)} → wrangler "placement": { "region": "aws:<db-region>" } next to the DB.` })
  if (cfg.buildCommand) findings.push({ rule: 'vercel-build', sev: 'INFO', file: 'vercel.json', line: 0, effort: [0, 0], msg: `buildCommand "${cfg.buildCommand}" — replicate in CI before \`opennextjs-cloudflare build\` (test gates, codegen).` })
  return { findings, crons }
}

/** Env names: secrets (server) + NEXT_PUBLIC (inlined at build). */
export function collectEnv(root, runtimeFiles) {
  const server = new Map(), publicVars = new Map()
  for (const rel of runtimeFiles) {
    if (rel.endsWith('.json')) continue
    const src = readText(join(root, rel))
    const client = isClientFile(src)
    for (const m of src.matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
      const map = m[1].startsWith('NEXT_PUBLIC_') ? publicVars : client ? null : server
      if (map) map.set(m[1], (map.get(m[1]) ?? 0) + 1)
    }
  }
  for (const k of ['NODE_ENV', 'NEXT_RUNTIME']) server.delete(k)
  const envFiles = readdirSync(root).filter(n => /^\.env/.test(n))
  return { server: [...server.keys()].sort(), public: [...publicVars.keys()].sort(), envFiles }
}

export function packageFacts(root) {
  const pkg = readJson(join(root, 'package.json')) ?? {}
  const pm = existsSync(join(root, 'pnpm-lock.yaml')) ? 'pnpm' : existsSync(join(root, 'yarn.lock')) ? 'yarn' : existsSync(join(root, 'bun.lockb')) || existsSync(join(root, 'bun.lock')) ? 'bun' : 'npm'
  const all = { ...pkg.dependencies, ...pkg.devDependencies }
  return {
    pkg, pm, deps: pkg.dependencies ?? {},
    next: all.next, react: all.react, opennext: all['@opennextjs/cloudflare'], wrangler: all.wrangler, nextAuth: all['next-auth'],
    scripts: pkg.scripts ?? {},
  }
}
