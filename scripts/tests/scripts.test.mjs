import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { stripComments } from '../lib/repo-files.mjs'
import { parseImports } from '../lib/import-graph.mjs'
import { matchRoute, findApiCalls, findPolling } from '../lib/client-request-diet.mjs'
import { analyzeRepo } from '../lib/analyze-repo.mjs'
import { renderRepoMarkdown, markdownToHtml } from '../lib/report-render.mjs'
import { schemaWarnings, aggregate, monthlyMetrics, derived, workersEstimate, hobbyFit, cleanupCandidates, driverInsights, costDrivers } from '../lib/vercel-usage-insights.mjs'
import { workersMonthlyCost, estimateFromVercel } from '../lib/workers-pricing.mjs'
import { calibrate, pickPaths } from '../measure-worker.mjs'
import { bytesPerSource, sourceGroup, groupOf } from '../inspect-worker-bundle.mjs'
import { summarize, percentile } from '../load-test.mjs'
import { parseConcatenatedJson, summarizeEvents } from '../summarize-tail.mjs'

function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'cf-analyze-'))
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true })
    writeFileSync(join(dir, rel), body)
  }
  return dir
}

test('stripComments keeps strings that look like comments and line numbers', () => {
  const src = "const a = '/api/*' // c\nconst u = 'https://x' /* b\nc */ x\nimport y from './y'"
  const out = stripComments(src)
  assert.ok(out.includes("'/api/*'") && out.includes("'https://x'") && !out.includes('// c'))
  assert.equal(out.split('\n').length, src.split('\n').length)
})

test('parseImports: multi-line, type-only, dynamic, require', () => {
  const imps = parseImports("import {\n  a,\n  b,\n} from './a'\nimport type { T } from './t'\nconst m = await import('./lazy')\nconst r = require('fs')\nexport { x } from './re'")
  const by = Object.fromEntries(imps.map(i => [i.spec, i]))
  assert.equal(by['./a'].typeOnly, false)
  assert.equal(by['./t'].typeOnly, true)
  assert.equal(by['./lazy'].lazy, true)
  assert.ok(by.fs && by['./re'])
})

test('matchRoute prefers static segments and handles catch-all', () => {
  const routes = ['/api/promo/active', '/api/promo/[id]', '/api/auth/[...nextauth]'].map(routePath => ({ routePath }))
  assert.equal(matchRoute('/api/promo/active', routes).routePath, '/api/promo/active')
  assert.equal(matchRoute('/api/promo/*', routes).routePath, '/api/promo/[id]')
  assert.equal(matchRoute('/api/auth/session', routes).routePath, '/api/auth/[...nextauth]')
  assert.equal(matchRoute('/api/nope', routes), null)
})

test('findApiCalls classifies trigger and audience', () => {
  const src = `'use client'
useEffect(() => { fetch('/api/promo/active') }, [])
useEffect(() => { if (!open) return; fetch('/api/auth/providers') }, [open])
useEffect(() => { if (!user) return; fetch('/api/feed') }, [user])
function onClickSave() { fetch('/api/save', { method: 'POST' }) }
navigator.sendBeacon('/api/log', b)
fetch(\`/api/items/\${id}\`)`
  const calls = Object.fromEntries(findApiCalls('x.tsx', src).map(c => [c.endpoint, c]))
  assert.equal(calls['/api/promo/active'].trigger, 'mount')
  assert.equal(calls['/api/promo/active'].audience, 'guest')
  assert.equal(calls['/api/auth/providers'].trigger, 'on-open')
  assert.equal(calls['/api/feed'].audience, 'signed-in')
  assert.equal(calls['/api/save'].trigger, 'handler')
  assert.equal(calls['/api/save'].method, 'POST')
  assert.equal(calls['/api/log'].method, 'POST')
  assert.ok(calls['/api/items/*'])
})

test('findPolling ignores countdowns, keeps network polls', () => {
  const src = `'use client'
setInterval(() => setLeft(l => l - 1), 1000)
setInterval(() => { fetch('/api/status') }, 3000)
const POLL_MS = 5_000`
  const ms = findPolling('p.tsx', src).map(p => p.ms).sort()
  assert.deepEqual(ms, [3000, 5000])
})

test('analyzeRepo: build-time vs request-time context, per-view calls, deps, bundle', () => {
  const big = 'export const DATA = ' + JSON.stringify('x'.repeat(3 * 1024 * 1024)) + '\n'
  const dir = fixture({
    'package.json': JSON.stringify({ dependencies: { next: '16.3.8', sharp: '0.33.0', 'web-push': '3.6.7', 'next-auth': '5.0.0-beta.25' } }),
    'tsconfig.json': '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } } // comment',
    'next.config.ts': 'export default { experimental: { inlineCss: true } }',
    'vercel.json': JSON.stringify({ crons: [{ path: '/api/cron', schedule: '0 * * * *' }] }),
    'app/layout.tsx': "import Banner from '@/components/banner'\nimport { SessionProvider } from 'next-auth/react'\nexport default function L({ children }) { return children }",
    'src/components/banner.tsx': "'use client'\nimport { useEffect } from 'react'\nexport default function B() { useEffect(() => { fetch('/api/promo') }, []); return null }",
    'app/api/promo/route.ts': "export async function GET() { return Response.json({}, { headers: { 'Cache-Control': 's-maxage=60' } }) }",
    'app/api/cached/route.ts': 'export const revalidate = 3600\nexport async function GET() { return Response.json({}) }',
    'app/og/[slug]/opengraph-image.tsx': "import { card } from '@/lib/og'\nexport const dynamicParams = false\nexport function generateStaticParams() { return [] }\nexport default card",
    'app/live/[slug]/opengraph-image.tsx': "import { card } from '@/lib/og'\nexport default card",
    'src/lib/og.tsx': "import { readFile } from 'node:fs/promises'\nexport const card = () => null",
    'app/api/thumb/route.ts': "import sharp from 'sharp'\nimport { DATA } from '@/data/big/blob'\nexport async function GET() { return new Response(DATA) }",
    'src/data/big/blob.ts': big,
    'app/api/push/route.ts': "import webpush from 'web-push'\nexport const runtime = 'edge'\nexport async function POST() {}",
    'src/lib/unused.ts': "import { exec } from 'node:child_process'",
  })
  try {
    const m = analyzeRepo(dir)
    const find = (rule, file) => m.findings.find(f => f.rule === rule && (!file || f.file === file))
    assert.equal(find('inline-css').sev, 'P0')
    assert.equal(find('fs', 'src/lib/og.tsx').sev, 'P1', 'og lib reached by a request-time OG route')
    assert.deepEqual(find('fs', 'src/lib/og.tsx').chain, ['app/live/[slug]/opengraph-image.tsx', 'src/lib/og.tsx'])
    assert.equal(find('dep:blocker').pkg, 'sharp')
    assert.equal(find('dep:blocker').sev, 'P0')
    assert.equal(find('edge-runtime').sev, 'P1')
    assert.ok(find('heavy-node-lib'))
    assert.ok(find('vercel-crons'))
    assert.equal(find('bundle-data').sev, 'P2')
    assert.ok(!m.findings.some(f => f.file === 'src/lib/unused.ts'), 'unreachable files are ignored')
    const promo = m.diet.perView.find(p => p.endpoint === '/api/promo')
    assert.equal(promo.mode, 'dynamic')
    assert.equal(find('per-view-dynamic-api').sev, 'P1')
    assert.ok(m.diet.perView.some(p => p.endpoint === '/api/auth/session'))
    assert.equal(m.routes.list.find(r => r.path === '/api/cached').mode, 'isr')
    assert.equal(m.routes.list.find(r => r.rel === 'app/og/[slug]/opengraph-image.tsx').mode, 'ssg')
    assert.equal(m.score.verdict, 'NO-GO until blockers are replaced')
    const md = renderRepoMarkdown(m)
    assert.ok(md.includes('## Must fix') && md.includes('/api/promo'))
    assert.ok(markdownToHtml(md, 't').includes('<table>'))
  } finally { rmSync(dir, { recursive: true }) }
})

const row = (svc, qty, cost, project, dayStr = '2026-10-01', unit = 'x') => ({
  ChargePeriodStart: `${dayStr}T07:00:00.000Z`, ServiceName: svc, ServiceCategory: 'Compute', ConsumedQuantity: qty, ConsumedUnit: unit,
  EffectiveCost: cost, BilledCost: 0, Tags: project ? { ProjectName: project, ProjectId: 'p1' } : {}, RegionName: 'Singapore',
})

test('vercel insights: aggregate, monthly projection, ratios, Workers estimate', () => {
  const rows = [
    row('CDN Requests', 100_000, 0, 'app', '2026-10-01'), row('CDN Requests', 300_000, 0, 'app', '2026-10-02'),
    row('Function Invocations', 20_000, 0.01, 'app', '2026-10-01'), row('Function Invocations', 20_000, 0.01, 'app', '2026-10-02'),
    row('Fluid Active CPU', 1, 0.2, 'app'), row('ISR Reads', 1_000_000, 0.4, 'app'), row('Build CPU Minutes', 300, 3, 'app'),
    { ...row('Pro', 0, 0.66, null), ServiceCategory: 'Subscription Licenses' },
  ]
  const agg = aggregate(rows)
  assert.equal(agg.days, 2)
  assert.ok(Math.abs(agg.subscriptionUsd - 0.66) < 1e-9)
  const m = monthlyMetrics(agg.projects.get('app'), agg.days)
  assert.equal(m.cdn, 400_000 * 15)
  assert.equal(m.inv, 40_000 * 15)
  const d = derived(m)
  assert.equal(d.cacheShare, 0.9)
  assert.equal(Math.round(d.cpuMsPerInv), 90) // 15 h × 3.6e6 / 600k
  const est = workersEstimate(m)
  assert.ok(est.requests[1] <= m.cdn, 'Worker requests never exceed CDN requests')
  assert.ok(est.costLow >= 5 && est.costHigh >= est.costLow)
  const drivers = driverInsights(costDrivers(agg.projects.get('app'), agg.days), {})
  assert.match(drivers[0].title, /Build CPU Minutes/)
  assert.equal(hobbyFit([m]).find(h => h.key === 'inv').pct, 60)
  assert.ok(!hobbyFit([m]).some(h => h.key === 'cdn'), 'Hobby lists no CDN request allowance')
})

test('workersMonthlyCost: base, CPU overage', () => {
  assert.equal(workersMonthlyCost(1e6, 10e6).total, 5)
  assert.equal(workersMonthlyCost(1e6, 80e6).total, 6)
})

test('cleanupCandidates flags failing, old-node and idle projects', () => {
  const now = Date.UTC(2026, 9, 12)
  const c = cleanupCandidates([
    { name: 'ok', nodeVersion: '24.x', targets: { production: { readyState: 'READY', createdAt: now - 86_400_000 } } },
    { name: 'old', nodeVersion: '14.x', targets: { production: { readyState: 'READY', createdAt: now - 400 * 86_400_000 } } },
    { name: 'broken', nodeVersion: '22.x', targets: { production: { readyState: 'ERROR', createdAt: now } } },
  ], now)
  assert.deepEqual(c.map(x => x.name), ['old', 'broken'])
})

test('bytesPerSource decodes VLQ mappings; groups normalise paths', () => {
  // 'AAAA' = col 0, src 0; 'GCAA' = col +3, src +1
  const per = bytesPerSource({ sources: ['a.js', 'b.js'], mappings: 'AAAA,GCAA' }, 'abcdef')
  assert.deepEqual([...per], [['a.js', 3], ['b.js', 3]])
  const sectioned = bytesPerSource({ sections: [{ offset: { line: 1, column: 0 }, map: { sources: ['c.js'], mappings: 'AAAA' } }] }, 'x\nyyyy')
  assert.deepEqual([...sectioned], [['c.js', 4]])
  assert.equal(sourceGroup('turbopack:///[project]/node_modules/.pnpm/zod@4/node_modules/zod/v4/index.js'), 'npm: zod')
  assert.equal(sourceGroup('../../src/features/cv/x.ts'), 'src: src/features/cv')
  assert.equal(groupOf('node_modules/.pnpm/next@16/node_modules/next/dist/x.js'), 'npm: next')
})

test('load-test summarize groups by path with percentiles', () => {
  const rows = summarize([{ path: '/', status: 200, ms: 10 }, { path: '/', status: 200, ms: 30 }, { path: '/', status: 503, ms: 20 }])
  assert.deepEqual(rows[0].statuses, { 200: 2, 503: 1 })
  assert.equal(rows[0].p50, 20)
  assert.equal(percentile([], 50), 0)
})

test('summarize-tail parses pretty-printed concatenated JSON', () => {
  const ev = (path, cpu, outcome, exceptions = []) => JSON.stringify({ outcome, cpuTime: cpu, wallTime: cpu * 3, exceptions,
    event: { request: { url: `https://x.workers.dev${path}` } }, logs: [{ message: ['weird } { "string'] }] }, null, 2)
  const events = parseConcatenatedJson(`Connected...\n${ev('/', 10, 'ok')}\n${ev('/q', 900, 'exceededCpu', [{ name: 'Error', message: 'boom' }])}`)
  const s = summarizeEvents(events)
  assert.deepEqual(s.outcomes, { ok: 1, exceededCpu: 1 })
  assert.equal(s.rows[0].path, '/q')
  assert.deepEqual(s.exceptions, ['/q: Error boom'])
})

test('make-report: overview, glossary, limits and sources in one HTML (vi)', async () => {
  const { execFileSync } = await import('node:child_process')
  const { readFileSync } = await import('node:fs')
  const dir = fixture({
    'package.json': JSON.stringify({ dependencies: { next: '16.3.8' } }),
    'app/layout.tsx': 'export default function L({ children }) { return children }',
    'app/page.tsx': 'export default function P() { return null }',
    'overview.md': '**Kết luận:** chuyển được.\n\n- Việc 1',
  })
  try {
    const out = join(dir, 'r.html')
    execFileSync(process.execPath, [new URL('../make-report.mjs', import.meta.url).pathname, `--out=${out}`, `--repo=${dir}`, `--summary=${join(dir, 'overview.md')}`, '--lang=vi'])
    const html = readFileSync(out, 'utf8')
    for (const s of ['Tổng quan', 'Kết luận', 'Giải thích thuật ngữ', 'KHÔNG nói được', 'developers.cloudflare.com', '<html lang="vi"']) assert.ok(html.includes(s), s)
  } finally { rmSync(dir, { recursive: true }) }
})

test('schemaWarnings flags renamed services and empty data', () => {
  assert.match(schemaWarnings([])[0], /no rows/)
  const ok = ['CDN Requests', 'Function Invocations', 'Fluid Active CPU', 'Fast Origin Transfer', 'Fast Data Transfer'].map(n => row(n, 1, 0, 'app'))
  assert.deepEqual(schemaWarnings(ok), [])
  const renamed = ok.map(r => (r.ServiceName === 'CDN Requests' ? { ...r, ServiceName: 'Edge Requests v2' } : r))
  assert.match(schemaWarnings(renamed)[0], /CDN Requests/)
})

test('regressions from public repos: server-file API literals, unused next/image, next-auth v4, workspace packages', () => {
  const dir = fixture({
    'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n  - 'packages/*'\n",
    'packages/ui/package.json': JSON.stringify({ name: '@repo/ui', exports: { './button': './src/button.tsx' } }),
    'packages/ui/src/button.tsx': "import { readFileSync } from 'node:fs'\nexport const Button = () => null",
    'apps/web/package.json': JSON.stringify({ dependencies: { next: '16.0.0', 'next-auth': '^4.24.0', '@repo/ui': 'workspace:*' } }),
    'apps/web/next.config.ts': 'export default { images: { remotePatterns: [] }, experimental: { useCache: true } }',
    'apps/web/lib/constants.ts': "export const SHOP_API = '/api/2023-01/graphql.json'",
    'apps/web/app/layout.tsx': "import { SHOP_API } from '../lib/constants'\nexport default function L({ children }) { return children }",
    'apps/web/app/api/x/route.ts': "import { Button } from '@repo/ui/button'\nexport async function GET() { return Response.json(Button) }",
  })
  try {
    const m = analyzeRepo(join(dir, 'apps/web'))
    assert.ok(!m.diet.perView.some(p => p.endpoint.includes('graphql')), 'server-file literal is not a per-view call')
    assert.equal(m.findings.find(f => f.rule === 'image-optimization').sev, 'INFO')
    assert.ok(m.findings.some(f => f.rule === 'next-experimental'))
    assert.match(m.findings.find(f => f.pkg === 'next-auth').msg, /^v4/)
    const fs = m.findings.find(f => f.rule === 'fs')
    assert.equal(fs?.file, '../../packages/ui/src/button.tsx', 'workspace package source is analysed')
  } finally { rmSync(dir, { recursive: true }) }
})

test('measure-worker: calibration from tail events feeds the estimate', () => {
  const ev = (path, cpu) => ({ outcome: 'ok', cpuTime: cpu, event: { request: { url: `https://w.dev${path}` } } })
  const cal = calibrate([ev('/', 10), ev('/', 20), ev('/api/me', 200), ev('/api/me', 300), ev('/api/me', 260)])
  assert.deepEqual(cal.paths.find(p => p.path === '/').kind, 'cached')
  assert.deepEqual(cal.dynamicMs, [260, 300])
  const base = { cdnRequests: 1e6, invocations: 1e5, isrReads: 2e5, activeCpuHours: 1 }
  const est = estimateFromVercel(base, cal)
  assert.equal(est.cpuMs[0], 1e5 * 260 + 9e5 * 0.25 * cal.cachedMs[0])
  assert.match(est.basis, /measured/)
  assert.match(estimateFromVercel(base).basis, /assumed/)
  assert.deepEqual(pickPaths([{ kind: 'page', path: '/' }, { kind: 'page', path: '/p/[id]' }, { kind: 'route', path: '/api/list', methods: ['GET'] }, { kind: 'route', path: '/api/cron/x', methods: ['GET'] }]), ['/', '/api/list'])
})

test('TypeScript parser (when available) agrees with regex and drops all-type named imports', async t => {
  const { loadTypeScript, parseImportsTs } = await import('../lib/ts-parser.mjs')
  const ts = loadTypeScript(process.env.TS_ROOT ?? process.cwd())
  if (!ts) return t.skip('typescript not installed here (set TS_ROOT to a repo with node_modules)')
  const src = "import { type A, type B } from './types'\nimport def, { type C } from './mixed'\nexport type { D } from './d'\nconst x = await import('./lazy')\nconst y = require('fs')\n// import z from './comment'"
  const by = Object.fromEntries(parseImportsTs(ts, src, 'f.ts').map(i => [i.spec, i]))
  assert.equal(by['./types'].typeOnly, true)
  assert.equal(by['./mixed'].typeOnly, false)
  assert.equal(by['./d'].typeOnly, true)
  assert.equal(by['./lazy'].lazy, true)
  assert.ok(by.fs && !by['./comment'])
})

test('SKILL.md has no $<digit>: the skill loader substitutes positional arguments ($1, $5…)', async () => {
  const { readFileSync } = await import('node:fs')
  const md = readFileSync(new URL('../../SKILL.md', import.meta.url), 'utf8')
  assert.equal(md.match(/\$\d/g), null)
  assert.ok(!md.includes('$ARGUMENTS'))
})

test('local repo matching: vercel link beats git remote, worktrees rank last, copies counted', async () => {
  const { repoSlug, matchProjects } = await import('../lib/local-repos.mjs')
  assert.equal(repoSlug('git@github.com:Org/My-App.git'), 'org/my-app')
  assert.equal(repoSlug('https://github.com/org/app'), 'org/app')
  const apps = [
    { dir: '/a/wt', remote: 'org/app', subdir: '', isWorktree: true, lastCommit: '2026-10-10', link: null },
    { dir: '/a/main', remote: 'org/app', subdir: '', isWorktree: false, lastCommit: '2026-10-01', link: { projectId: 'p1' } },
    { dir: '/b/clone', remote: 'org/app', subdir: '', isWorktree: false, lastCommit: '2026-10-11', link: null },
    { dir: '/m/apps/web', remote: 'org/mono', subdir: 'apps/web', isWorktree: false, lastCommit: '2026-10-01', link: null },
  ]
  const [one, mono, none] = matchProjects([
    { id: 'p1', name: 'app', link: { org: 'Org', repo: 'app' } },
    { id: 'p2', name: 'web', link: { org: 'org', repo: 'mono' }, rootDirectory: 'apps/web' },
    { id: 'p3', name: 'gone', link: { org: 'org', repo: 'deleted' } },
  ], apps)
  assert.equal(one.local.dir, '/a/main')
  assert.equal(one.how, 'vercel-link')
  assert.deepEqual(one.copies.map(c => c.dir), ['/b/clone', '/a/wt'])
  assert.equal(mono.local.dir, '/m/apps/web')
  assert.equal(mono.how, 'git-remote')
  assert.equal(none.local, null)
})

test('triage: traffic apps vs small (incl. build-only cost) vs idle', async () => {
  const { triage } = await import('../lib/app-triage.mjs')
  assert.equal(triage(null).tier, 'idle')
  assert.equal(triage({ cdn: 3e6, inv: 4e5, effectiveUsd: 40, buildUsd: 15 }).tier, 'traffic')
  assert.equal(triage({ cdn: 2e5, inv: 1.8e5, effectiveUsd: 6, buildUsd: 0.3 }).tier, 'traffic')
  const buildHeavy = triage({ cdn: 2e3, inv: 900, effectiveUsd: 1.5, buildUsd: 1.4 })
  assert.equal(buildHeavy.tier, 'small')
  assert.match(buildHeavy.reasons.join(' '), /mostly builds/)
  assert.equal(triage({ cdn: 4e4, inv: 2e4, effectiveUsd: 0.6, buildUsd: 0.1 }).tier, 'small')
  assert.equal(triage({ cdn: 2e5, inv: 1.5e5, effectiveUsd: 0.8, buildUsd: 0.05 }).tier, 'small', 'busy but nearly free (self-polling admin)')
  assert.equal(triage({ cdn: 6e6, inv: 1.2e6, effectiveUsd: 1, buildUsd: 0 }).tier, 'traffic', 'volume beyond free allowances')
})

test('savingsPlan: target = Workers + Hobby, steps carry trade-offs from findings', async () => {
  const { savingsPlan } = await import('../lib/savings-plan.mjs')
  const repo = { score: { effortHours: [36, 99] }, findings: [{ rule: 'inline-css', sev: 'P0' }, { rule: 'short-revalidate', sev: 'P3' }] }
  const traffic = [{ project: { name: 'app' }, repo, metrics: { cdn: 1e6, inv: 6e5, buildUsd: 11, wa: 1000 } }]
  const plan = savingsPlan({ now: 30, workers: [6, 9], traffic, small: [{}], smallFitsHobby: true, smallOnPro: 20 }, 'vi')
  assert.deepEqual(plan.target, [6, 9])
  assert.deepEqual(plan.saving, [21, 24])
  const actions = plan.steps.map(s => s.action).join(' | ')
  for (const x of ['Workers Paid', 'Hobby', 'inlineCss', 'revalidate', 'build', 'Web Analytics']) assert.ok(actions.includes(x), x)
  assert.ok(plan.warnings.some(w => /thương mại/.test(w)))
  assert.ok(plan.warnings.some(w => /cache/.test(w)), 'mostly-dynamic app warned')
  const none = savingsPlan({ now: 20, workers: null, traffic: [], small: [], smallFitsHobby: true, smallOnPro: 20 }, 'en')
  assert.equal(none.target, null)
})

test('savingsPlan adds Cloudflare Images cost and flags zone plans for large apps', async () => {
  const { savingsPlan } = await import('../lib/savings-plan.mjs')
  const { isLarge } = await import('../lib/app-triage.mjs')
  const big = { project: { name: 'shop' }, repo: null, metrics: { cdn: 4e7, inv: 5e6, img: 25_000, effectiveUsd: 300, buildUsd: 10 } }
  assert.ok(isLarge(big.metrics))
  const plan = savingsPlan({ now: 320, workers: [40, 90], traffic: [big], small: [], smallFitsHobby: true, smallOnPro: 0, large: [big] }, 'en')
  assert.deepEqual(plan.target, [50, 100]) // + (25,000 − 5,000) / 1000 × 0.5 = 10 USD of Images
  assert.ok(plan.warnings.some(w => /Business 250/.test(w)))
})

test('package probe: native addons are blockers; worker-ready subprocess users are not flagged', async () => {
  const { probeFindings } = await import('../lib/package-probe.mjs')
  const nm = 'node_' + 'modules'
  const dir = fixture({
    [`${nm}/fast-hash/package.json`]: JSON.stringify({ name: 'fast-hash', version: '1.0.0', main: 'index.js', dependencies: { 'node-gyp-build': '^4' } }),
    [`${nm}/fast-hash/index.js`]: "module.exports = require('node-gyp-build')(__dirname)",
    [`${nm}/runner/package.json`]: JSON.stringify({ name: 'runner', version: '2.0.0', main: 'index.js' }),
    [`${nm}/runner/index.js`]: "const { spawn } = require('child_process')",
    [`${nm}/edge-ok/package.json`]: JSON.stringify({ name: 'edge-ok', version: '1.0.0', exports: { '.': { workerd: './w.js', default: './index.js' } } }),
    [`${nm}/edge-ok/index.js`]: "const cp = require('child_process')",
    [`${nm}/edge-ok/w.js`]: 'export {}',
  })
  try {
    const r = probeFindings(dir, ['fast-hash', 'runner', 'edge-ok', 'not-installed'])
    const by = Object.fromEntries(r.findings.map(f => [f.pkg, f]))
    assert.equal(by['fast-hash'].rule, 'dep:native')
    assert.equal(by['fast-hash'].sev, 'P0')
    assert.equal(by.runner.rule, 'dep:subprocess')
    assert.ok(!by['edge-ok'], 'packages with a workerd export are trusted')
    assert.equal(r.missing, 1)
    assert.equal(r.probed, 3)
  } finally { rmSync(dir, { recursive: true }) }
})

test('apply-fixes: composes edits on one file, all auth route shapes, idempotent, dry-run writes nothing', async () => {
  const { execFileSync } = await import('node:child_process')
  const { readFileSync } = await import('node:fs')
  const script = new URL('../apply-fixes.mjs', import.meta.url).pathname
  const shapes = {
    v5: "import { handlers } from '@/auth'\nexport const { GET, POST } = handlers\n",
    reexport: "export { GET, POST } from '@/app/(auth)/auth'\n",
    v4: "import NextAuth from 'next-auth'\nconst handler = NextAuth({})\nexport { handler as GET, handler as POST }\n",
  }
  for (const [shape, route] of Object.entries(shapes)) {
    const dir = fixture({
      'package.json': JSON.stringify({ name: 'demo', scripts: { build: 'next build' }, dependencies: { next: '16.0.0' } }, null, 2) + '\n',
      'next.config.ts': 'const nextConfig = {\n  experimental: { inlineCss: true },\n  images: { remotePatterns: [] },\n}\nexport default nextConfig\n',
      'app/layout.tsx': "import Image from 'next/image'\nexport default function L({ children }) { return children }",
      'app/(auth)/api/auth/[...nextauth]/route.ts': route,
      'app/api/og/route.tsx': "export const runtime = 'edge'\nexport async function GET() { return new Response('x') }\n",
    })
    try {
      const dry = execFileSync(process.execPath, [script, dir], { encoding: 'utf8' })
      assert.match(dry, /dry run/)
      assert.match(readFileSync(join(dir, 'next.config.ts'), 'utf8'), /inlineCss: true/, 'dry run must not write')
      execFileSync(process.execPath, [script, dir, '--write', '--accept=inline-css-off,images-unoptimized'], { encoding: 'utf8' })
      const cfg = readFileSync(join(dir, 'next.config.ts'), 'utf8')
      assert.match(cfg, /inlineCss: false/)
      assert.match(cfg, /unoptimized: true/, 'second edit on the same file kept the first')
      const auth = readFileSync(join(dir, 'app/(auth)/api/auth/[...nextauth]/route.ts'), 'utf8')
      assert.match(auth, /session-token/, `${shape}: guest short-circuit added`)
      assert.match(auth, /export (function GET|\{ (POST|handler as POST) \})/)
      assert.ok(!/runtime = 'edge'/.test(readFileSync(join(dir, 'app/api/og/route.tsx'), 'utf8')))
      assert.match(readFileSync(join(dir, 'package.json'), 'utf8'), /cf:deploy/)
      const again = execFileSync(process.execPath, [script, dir, '--write', '--allow-dirty', '--accept=inline-css-off,images-unoptimized'], { encoding: 'utf8' })
      assert.match(again, /Applied: 0 edit/, `${shape}: second run changes nothing`)
    } finally { rmSync(dir, { recursive: true }) }
  }
})
