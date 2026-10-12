// Deterministic code fixes for Workers readiness. Each fix returns planned file edits
// ({ file, before, after } or { file, create }) — nothing is written here.
// "safe" fixes keep Vercel behaviour; "tradeoff" fixes change UX/perf and need explicit consent.
import { existsSync, readFileSync } from 'node:fs'
import { join, basename } from 'node:path'

/** Default reader; apply-fixes passes an overlay so several fixes can edit the same file in turn. */
export const diskReader = root => rel => (existsSync(join(root, rel)) ? readFileSync(join(root, rel), 'utf8') : null)
const NEXT_CONFIGS = ['next.config.ts', 'next.config.mjs', 'next.config.js', 'next.config.cjs']

export const FIXES = [
  {
    id: 'edge-runtime', kind: 'safe',
    title: 'Remove `export const runtime = "edge"` (OpenNext runs everything on the Node.js runtime)',
    plan(root, model, io) {
      const files = [...new Set(model.findings.filter(f => f.rule === 'edge-runtime').map(f => f.file))]
      return files.map(file => {
        const before = io(file)
        return { file, before, after: before.replace(/^export\s+const\s+runtime\s*=\s*['"](?:experimental-)?edge['"];?[ \t]*\r?\n/m, '') }
      }).filter(e => e.before !== e.after)
    },
  },
  {
    id: 'session-short-circuit', kind: 'safe',
    title: 'Answer guest /api/auth/session with null without booting Auth.js (one dynamic request less per guest page view)',
    plan(root, model, io) {
      // The catch-all auth route may sit in a route group: app/(auth)/api/auth/[...nextauth]/route.ts
      const file = model.routes.list.find(r => r.kind === 'route' && /\/api\/auth\/\[\.\.\.[^\]]+\]$/.test(r.path))?.rel
      const before = file && io(file)
      if (!before || /session-token/.test(before)) return []
      const ts = /\.tsx?$/.test(file)
      const guard = (withCtx = false) => `// Without a session cookie the answer is always null: skip the auth library (and the CPU/DB it costs).
export function GET(${ts ? `req: NextRequest${withCtx ? ', ctx: unknown' : ''}` : `req${withCtx ? ', ctx' : ''}`}) {
  if (req.nextUrl.pathname.endsWith('/session') && !req.cookies.getAll().some(c => c.name.includes('session-token'))) {
    return Response.json(null, { headers: { 'Cache-Control': 'private, no-cache, no-store' } })
  }
  return CALL
}`
      const patterns = [
        // Auth.js v5: export const { GET, POST } = handlers
        [/export\s+const\s*\{\s*GET\s*,\s*POST\s*\}\s*=\s*handlers;?/, () => `export const { POST } = handlers\n\n${guard().replace('CALL', 'handlers.GET(req)')}`],
        // re-export from a shared auth module: export { GET, POST } from '@/auth'
        [/export\s*\{\s*GET\s*,\s*POST\s*\}\s*from\s*(['"][^'"]+['"]);?/, m => `import { GET as authGET, POST } from ${m[1]}\nexport { POST }\n\n${guard().replace('CALL', 'authGET(req)')}`],
        // NextAuth v4: const handler = NextAuth(opts); export { handler as GET, handler as POST }
        [/export\s*\{\s*(\w+)\s+as\s+GET\s*,\s*\1\s+as\s+POST\s*\};?/, m => `export { ${m[1]} as POST }\n\n${guard(true).replace('CALL', `${m[1]}(req, ctx${ts ? ' as never' : ''})`)}`],
      ]
      const hit = patterns.find(([re]) => re.test(before))
      if (!hit) return []
      let after = before.replace(hit[0], (...g) => hit[1](g))
      if (ts && !/import\s+(type\s+)?\{[^}]*NextRequest[^}]*\}\s+from\s+['"]next\/server['"]/.test(after)) after = `import type { NextRequest } from 'next/server'\n${after}`
      return [{ file, before, after }]
    },
  },
  {
    id: 'opennext-scaffold', kind: 'safe',
    title: 'Add open-next.config.ts, wrangler.jsonc, cf:* scripts and .gitignore entries (no effect on Vercel)',
    plan(root, model, io) {
      const edits = []
      const pkgText = io('package.json')
      const pkg = pkgText ? JSON.parse(pkgText) : {}
      const name = (pkg.name ?? basename(root)).replace(/^@[^/]+\//, '').replace(/[^a-z0-9-]/gi, '-').toLowerCase()
      if (!io('open-next.config.ts')) edits.push({ file: 'open-next.config.ts', create: `import { defineCloudflareConfig } from '@opennextjs/cloudflare'
import r2IncrementalCache from '@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache'
import d1NextTagCache from '@opennextjs/cloudflare/overrides/tag-cache/d1-next-tag-cache'
import doQueue from '@opennextjs/cloudflare/overrides/queue/do-queue'

export default defineCloudflareConfig({
  incrementalCache: r2IncrementalCache, // prerendered + ISR pages in R2
  tagCache: d1NextTagCache, // revalidateTag / revalidatePath
  queue: doQueue, // time-based ISR refresh
  // Serve cached pages before loading the Next.js server: the biggest CPU (= money) saving.
  enableCacheInterception: true,
})
` })
      if (!io('wrangler.jsonc') && !io('wrangler.toml')) edits.push({ file: 'wrangler.jsonc', create: `{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "${name}",
  "main": ".open-next/worker.js",
  "compatibility_date": "${new Date().toISOString().slice(0, 10)}",
  "compatibility_flags": ["nodejs_compat", "global_fetch_strictly_public"],
  "assets": { "directory": ".open-next/assets", "binding": "ASSETS" },
  "services": [{ "binding": "WORKER_SELF_REFERENCE", "service": "${name}" }],
  "observability": { "enabled": true },
  // Create once: wrangler r2 bucket create ${name}-next-cache && wrangler d1 create ${name}-tag-cache
  "r2_buckets": [{ "binding": "NEXT_INC_CACHE_R2_BUCKET", "bucket_name": "${name}-next-cache" }],
  "d1_databases": [{ "binding": "NEXT_TAG_CACHE_D1", "database_name": "${name}-tag-cache", "database_id": "<paste id from wrangler d1 create>" }],
  "durable_objects": { "bindings": [{ "name": "NEXT_CACHE_DO_QUEUE", "class_name": "DOQueueHandler" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["DOQueueHandler"] }]
  // Workers Paid only: "limits": { "cpu_ms": 30000 }. Secrets: wrangler secret put NAME (never in vars).
}
` })
      if (pkgText) {
        const scripts = { 'cf:build': 'opennextjs-cloudflare build', 'cf:preview': 'opennextjs-cloudflare build && opennextjs-cloudflare preview', 'cf:deploy': 'opennextjs-cloudflare build && opennextjs-cloudflare deploy' }
        const missing = Object.entries(scripts).filter(([k]) => !pkg.scripts?.[k])
        if (missing.length) {
          const next = { ...pkg, scripts: { ...pkg.scripts, ...Object.fromEntries(missing) } }
          const indent = pkgText.match(/^(\s+)"/m)?.[1] ?? '  '
          edits.push({ file: 'package.json', before: pkgText, after: JSON.stringify(next, null, indent) + (pkgText.endsWith('\n') ? '\n' : '') })
        }
      }
      const gi = io('.gitignore') ?? ''
      const add = ['.open-next', '.wrangler', '.dev.vars'].filter(e => !new RegExp(`^/?${e.replace('.', '\\.')}/?$`, 'm').test(gi))
      if (add.length) edits.push({ file: '.gitignore', before: gi, after: `${gi}${gi && !gi.endsWith('\n') ? '\n' : ''}\n# Cloudflare Workers (OpenNext)\n${add.join('\n')}\n` })
      return edits
    },
  },
  {
    id: 'inline-css-off', kind: 'tradeoff',
    title: 'Turn off experimental.inlineCss (required on Workers; Lighthouse −2/−3, LCP +0.7–1.4 s)',
    plan(root, model, io) {
      const file = NEXT_CONFIGS.find(f => io(f))
      const before = file && io(file)
      if (!before || !/inlineCss\s*:\s*true/.test(before)) return []
      return [{ file, before, after: before.replace(/inlineCss\s*:\s*true/, 'inlineCss: false') }]
    },
  },
  {
    id: 'images-unoptimized', kind: 'tradeoff',
    title: 'Set images.unoptimized (no Cloudflare Images cost; images are served as uploaded)',
    plan(root, model, io) {
      if (!model.findings.some(f => f.rule === 'image-optimization' && f.sev !== 'INFO')) return []
      const file = NEXT_CONFIGS.find(f => io(f))
      const before = file && io(file)
      if (!before || /unoptimized\s*:\s*true/.test(before)) return []
      let after = null
      if (/\bimages\s*:\s*\{/.test(before)) after = before.replace(/\bimages\s*:\s*\{/, 'images: {\n    unoptimized: true,')
      else {
        const m = before.match(/(const\s+\w+\s*(?::\s*NextConfig\s*)?=\s*\{|export\s+default\s+\{|module\.exports\s*=\s*\{)/)
        if (m) after = before.replace(m[0], `${m[0]}\n  images: { unoptimized: true },`)
      }
      return after ? [{ file, before, after }] : []
    },
  },
  {
    id: 'longer-revalidate', kind: 'tradeoff',
    title: 'Raise revalidate windows under 10 minutes to 1 hour (fewer regenerations; data up to 1 h stale)',
    plan(root, model, io) {
      const files = [...new Set(model.findings.filter(f => f.rule === 'short-revalidate').map(f => f.file))]
      return files.map(file => {
        const before = io(file)
        return { file, before, after: before.replace(/export\s+const\s+revalidate\s*=\s*([\d_]+)/, (m, n) => (Number(n.replace(/_/g, '')) < 600 ? 'export const revalidate = 3600' : m)) }
      }).filter(e => e.before !== e.after)
    },
  },
]

// Findings that need judgement → a manual checklist (pattern lives in references/code-fixes.md).
export const MANUAL_HINTS = {
  'fs': 'Make the route build-time (generateStaticParams + dynamicParams=false, no revalidate) or read via fetch/import/DB — code-fixes.md › Filesystem',
  'process-cwd': 'Same as fs — code-fixes.md › Filesystem',
  'dns': 'Skip DNS on Workers (isCloudflareWorkers()) — code-fixes.md › node:dns',
  'ws-headers': 'Use fetch(url, { headers: { Upgrade: "websocket" } }) on Workers — code-fixes.md › WebSocket',
  'heavy-node-lib': 'Lazy `await import()` inside the function that needs it — code-fixes.md › Heavy Node libs',
  's-maxage': 'Split guest vs personal routes; guest gets `export const revalidate = N` — cache-and-request-diet.md §3',
  'xff': 'Prefer cf-connecting-ip on Workers — code-fixes.md › Client IP',
  'per-view-dynamic-api': 'Guest variant as ISR route, or defer to interaction — cache-and-request-diet.md',
  'per-view-write': 'Batch / sendBeacon / sample — cache-and-request-diet.md §5',
  'client-polling': 'Back off 3 s → 10 s, cap, pause when hidden — cache-and-request-diet.md §5',
  'long-timeout': 'Keep after()/waitUntil work < 30 s; stream or poll for long requests — code-fixes.md › Respond first',
  'bundle-data': 'Move data to public/*.json or DB by id — code-fixes.md › Big data out of the bundle',
  'og-runtime': 'Build-time OG (dynamicParams=false) — code-fixes.md › Filesystem',
  'vercel-pkg': 'Remove/replace the @vercel/* package (GA, next/og, R2/KV, after())',
  'vercel-crons': 'Re-home crons (wrangler triggers or GitHub Actions) at cutover — not before, or they run twice',
  'node-middleware': 'Keep the proxy matcher narrow; check open OpenNext issues; measure on the trial',
  'tcp-pool': 'Hyperdrive or an HTTP driver (Neon serverless, Upstash)',
  'subprocess': 'Move to an external service / Queue consumer / build step',
  'code-from-string': 'Precompile templates or swap the library',
  'raw-socket': 'cloudflare:sockets or an HTTP API',
  'next-experimental': 'Check OpenNext support for these flags at your versions',
  'tracing-includes': 'Files read at runtime via fs will not exist on Workers',
}
