// Pure functions over Vercel FOCUS billing rows (+ projects/deployments) → metrics and insights.
import { estimateFromVercel, workersMonthlyCost } from './workers-pricing.mjs'

// Service names as they appear in /v1/billing/charges (Oct 2026).
export const SVC = {
  cdn: 'CDN Requests', inv: 'Function Invocations', cpu: 'Fluid Active CPU', mem: 'Fluid Provisioned Memory',
  fot: 'Fast Origin Transfer', fdt: 'Fast Data Transfer', isrW: 'ISR Writes', isrR: 'ISR Reads',
  build: 'Build CPU Minutes', wa: 'Web Analytics Events', img: 'Image Optimization Transformation',
  cdnCpu: 'CDN Requests - Additional CPU Duration', fw: 'Firewall Rate Limit Requests',
}

// Hobby included usage (vercel.com/docs/limits/fair-use-guidelines, checked 2026-10-12).
// Per ACCOUNT, non-commercial only. CDN requests have no listed Hobby allowance.
export const HOBBY = [
  { key: 'inv', label: 'Function invocations', limit: 1_000_000 },
  { key: 'cpu', label: 'Active CPU (h)', limit: 4 },
  { key: 'mem', label: 'Provisioned memory (GB-h)', limit: 360 },
  { key: 'fdt', label: 'Fast Data Transfer (GB)', limit: 100 },
  { key: 'fot', label: 'Fast Origin Transfer (GB)', limit: 10 },
  { key: 'img', label: 'Image transformations', limit: 5_000 },
]

export function parseCharges(jsonl) {
  return jsonl.split('\n').filter(Boolean).map(l => JSON.parse(l))
}

const CORE = ['cdn', 'inv', 'cpu', 'fot', 'fdt']
const FIELDS = ['ChargePeriodStart', 'ServiceName', 'ConsumedQuantity', 'EffectiveCost', 'BilledCost', 'Tags']

/**
 * The billing endpoint returns FOCUS rows whose service names Vercel can rename. Report drift
 * instead of silently showing zeros.
 */
export function schemaWarnings(rows) {
  if (!rows.length) return ['Billing API returned no rows for this window (no usage, wrong team, or a plan without billing data).']
  const warnings = []
  const missingFields = FIELDS.filter(f => !(f in rows[0]))
  if (missingFields.length) warnings.push(`Billing rows lack fields ${missingFields.join(', ')} — the API format changed; numbers below may be wrong.`)
  const names = new Set(rows.map(r => r.ServiceName))
  const missing = CORE.filter(k => !names.has(SVC[k]))
  if (missing.length) warnings.push(`Expected services not found: ${missing.map(k => `"${SVC[k]}"`).join(', ')}. Vercel may have renamed them — update SVC in vercel-usage-insights.mjs. Present names include: ${[...names].slice(0, 12).join(', ')}…`)
  if (!rows.some(r => r.Tags?.ProjectName)) warnings.push('No rows carry Tags.ProjectName — per-project numbers are unavailable.')
  return warnings
}

const day = r => r.ChargePeriodStart.slice(0, 10)

/** Aggregate rows → { days, projects: Map, account, subscriptionUsd }. */
export function aggregate(rows) {
  const days = new Set(rows.map(day)).size || 1
  const projects = new Map()
  const account = { services: {}, regions: {} }
  let subscriptionUsd = 0
  const add = (bucket, name, r) => {
    const s = (bucket[name] ??= { qty: 0, unit: r.ConsumedUnit, effective: 0, billed: 0 })
    s.qty += Number(r.ConsumedQuantity || 0); s.effective += Number(r.EffectiveCost || 0); s.billed += Number(r.BilledCost || 0)
  }
  for (const r of rows) {
    if (r.ServiceCategory === 'Subscription Licenses') { subscriptionUsd += Number(r.EffectiveCost || 0); continue }
    add(account.services, r.ServiceName, r)
    const name = r.Tags?.ProjectName
    if (!name) continue
    const p = projects.get(name) ?? { name, id: r.Tags.ProjectId, services: {}, daily: {}, regions: {} }
    add(p.services, r.ServiceName, r)
    if (r.ServiceName === SVC.cdn || r.ServiceName === SVC.inv) {
      const d = (p.daily[day(r)] ??= { cdn: 0, inv: 0 })
      d[r.ServiceName === SVC.cdn ? 'cdn' : 'inv'] += Number(r.ConsumedQuantity || 0)
    }
    if (r.ServiceName === SVC.fdt && r.RegionName) p.regions[r.RegionName] = (p.regions[r.RegionName] ?? 0) + Number(r.ConsumedQuantity || 0)
    projects.set(name, p)
  }
  return { days, projects, account, subscriptionUsd }
}

/** Monthly (30-day) projection of the key metrics of one project. */
export function monthlyMetrics(p, days) {
  const q = key => (p.services[SVC[key]]?.qty ?? 0) * 30 / days
  const m = Object.fromEntries(Object.keys(SVC).map(k => [k, q(k)]))
  m.effectiveUsd = Object.values(p.services).reduce((s, x) => s + x.effective, 0) * 30 / days
  m.billedUsd = Object.values(p.services).reduce((s, x) => s + x.billed, 0) * 30 / days
  m.buildUsd = Object.entries(p.services).filter(([name]) => /^Build /.test(name)).reduce((s, [, x]) => s + x.effective, 0) * 30 / days
  return m
}

export function costDrivers(p, days, top = 5) {
  return Object.entries(p.services).map(([name, s]) => ({ name, unit: s.unit, qtyMonth: s.qty * 30 / days, usdMonth: s.effective * 30 / days }))
    .filter(x => x.usdMonth > 0.005).sort((a, b) => b.usdMonth - a.usdMonth).slice(0, top)
}

/** Ratios that explain WHY a project costs what it costs. */
export function derived(m) {
  return {
    cacheShare: m.cdn > 0 ? 1 - m.inv / m.cdn : null, // share of requests NOT reaching a function
    cpuMsPerInv: m.inv > 0 ? (m.cpu * 3.6e6) / m.inv : null,
    memPerCpu: m.cpu > 0 ? m.mem / m.cpu : null, // GB-h of provisioned memory per active-CPU hour → I/O wait
    fotKbPerInv: m.inv > 0 ? (m.fot * 1e6) / m.inv : null,
    isrWriteRatio: m.isrR > 0 ? m.isrW / m.isrR : null,
  }
}

export function dailySpikes(p) {
  const rows = Object.entries(p.daily).sort(([a], [b]) => a.localeCompare(b))
  const vals = rows.map(([, d]) => d.cdn).sort((a, b) => a - b)
  const median = vals[Math.floor(vals.length / 2)] ?? 0
  return { rows, median, spikes: rows.filter(([, d]) => median > 0 && d.cdn > 2.5 * median) }
}

// What each top cost driver means and what to do about it (on Vercel and after a move).
const DRIVER_HINTS = {
  'Build CPU Minutes': (x, ex) => `${ex.builds ? `${ex.builds.total} builds × ~${ex.builds.avgMin.toFixed(1)} min ≈ $${(x.usdMonth / Math.max(1, ex.builds.perDay * 30)).toFixed(2)}/build. ` : ''}Batch pushes, skip builds for docs/plans-only commits (ignored build step), trim prebuild work. On Cloudflare the build runs in your CI (GitHub Actions minutes) instead.`,
  'Fast Origin Transfer': (x, ex) => `Bytes from functions/ISR to the CDN. ${ex.d?.fotKbPerInv ? `${ex.d.fotKbPerInv.toFixed(0)} KB per invocation. ` : ''}Turn off inlineCss, shrink RSC/JSON payloads, cache more. Not billed on Cloudflare.`,
  'ISR Reads': () => 'Every cached page/RSC/data-cache read. Cheap per unit but scales with crawl volume; block junk crawlers. On Workers these become R2 reads (free tier generous).',
  'ISR Writes': () => 'Regenerations. Lengthen revalidate windows; avoid ISR on high-cardinality crawled slugs.',
  'Web Analytics Events': () => 'Vercel Web Analytics — drop it if GA already exists (saves money now, required after a move).',
  'Fluid Active CPU': () => 'Pure compute; the part Workers bills the same way (per CPU ms).',
  'Fluid Provisioned Memory': () => 'Memory × wall time while functions wait on I/O. Workers does not bill wall time.',
  'Fast Data Transfer': () => 'Bytes to users. Free on Cloudflare.',
  'Image Optimization Transformation': () => 'next/image transforms. On Workers: Cloudflare Images or unoptimized.',
}

export function driverInsights(drivers, extra) {
  const total = drivers.reduce((s, x) => s + x.usdMonth, 0)
  return drivers.slice(0, 3).filter(x => x.usdMonth > 0.5).map(x => ({
    sev: x.usdMonth / total > 0.3 ? 'P1' : 'P2',
    title: `${x.name}: $${x.usdMonth.toFixed(2)}/month (${((x.usdMonth / total) * 100).toFixed(0)}% of usage)`,
    detail: DRIVER_HINTS[x.name]?.(x, extra) ?? 'Check the Vercel usage page for this line item.',
  }))
}

export function insights(m, d, extra = {}) {
  const out = []
  const k = n => Math.round(n).toLocaleString('en-US')
  if (d.cacheShare != null && d.cacheShare < 0.6 && m.inv > 30_000) out.push({ sev: 'P1', title: 'Most requests reach a function', detail: `Only ${(d.cacheShare * 100).toFixed(0)}% of ${k(m.cdn)} requests/month are served without a function. On Workers each of the ${k(m.inv)} invocations boots Next. Look for guest API calls per page view, short revalidate, dynamic pages that could be ISR.` })
  if (d.cpuMsPerInv != null && d.cpuMsPerInv > 250) out.push({ sev: 'P2', title: 'Heavy CPU per invocation', detail: `${d.cpuMsPerInv.toFixed(0)} ms active CPU per invocation (SSR without cache, big bundles, OG rendering at request time). Workers bills exactly this.` })
  if (d.memPerCpu != null && d.memPerCpu > 15) out.push({ sev: 'INFO', title: 'Functions mostly wait on I/O', detail: `${d.memPerCpu.toFixed(0)} GB-h provisioned memory per active-CPU hour → time is spent waiting on DB/AI/fetch. Vercel bills that memory-time; Workers bills CPU only → favourable for the move.` })
  if (d.fotKbPerInv != null && d.fotKbPerInv > 150) out.push({ sev: 'P2', title: 'Large uncached responses', detail: `${d.fotKbPerInv.toFixed(0)} KB of origin transfer per invocation (${m.fot.toFixed(1)} GB/month). Typical causes: inlineCss, big RSC/JSON payloads, crawlers hitting uncached pages.` })
  if (m.isrW > 50_000 || (d.isrWriteRatio != null && d.isrWriteRatio > 0.05 && m.isrW > 5_000)) out.push({ sev: 'P2', title: 'ISR churn', detail: `${k(m.isrW)} ISR writes vs ${k(m.isrR)} reads per month (${((d.isrWriteRatio ?? 0) * 100).toFixed(1)}%). Revalidate windows too short, or crawlers walking many slugs. Each write = a regeneration (CPU + DB wake-up).` })
  if (m.wa > 0) out.push({ sev: 'INFO', title: 'Vercel Web Analytics in use', detail: `${k(m.wa)} events/month — stops working off Vercel; GA/CF Web Analytics instead.` })
  if (m.img > 1_000) out.push({ sev: 'P2', title: 'Image optimization used', detail: `${k(m.img)} transformations/month → on Workers needs Cloudflare Images (binding/loader) or images.unoptimized.` })
  if (extra.builds) {
    const b = extra.builds
    if (b.perDay > 3) out.push({ sev: 'P2', title: 'Many builds', detail: `${b.total} builds in ${b.days} days (${b.perDay.toFixed(1)}/day, avg ${b.avgMin.toFixed(1)} min, ${b.failed} failed). Batch pushes or add an ignored-build step; on CF builds run in your CI.` })
  }
  if (extra.spikes?.spikes.length) out.push({ sev: 'INFO', title: 'Traffic spikes', detail: `${extra.spikes.spikes.length} day(s) > 2.5× median (${k(extra.spikes.median)} req/day): ${extra.spikes.spikes.map(([dt, x]) => `${dt} ${k(x.cdn)}`).join(', ')} — usually crawlers; robots/WAF rules help on both platforms.` })
  return out
}

export function buildStats(deployments, days) {
  const done = deployments.filter(d => d.buildingAt && d.ready)
  const avgMin = done.length ? done.reduce((s, d) => s + (d.ready - d.buildingAt), 0) / done.length / 60_000 : 0
  return { total: deployments.length, failed: deployments.filter(d => d.state === 'ERROR').length, canceled: deployments.filter(d => d.state === 'CANCELED').length,
    production: deployments.filter(d => d.target === 'production').length, avgMin, perDay: deployments.length / days, days }
}

export function hobbyFit(monthlyByProject) {
  const total = {}
  for (const m of monthlyByProject) for (const h of HOBBY) total[h.key] = (total[h.key] ?? 0) + (m[h.key] ?? 0)
  return HOBBY.map(h => ({ ...h, used: total[h.key], pct: (total[h.key] / h.limit) * 100 }))
}

export function workersEstimate(m, measured = null) {
  const e = estimateFromVercel({ cdnRequests: m.cdn, invocations: m.inv, isrReads: m.isrR, activeCpuHours: m.cpu }, measured)
  return { ...e, costLow: workersMonthlyCost(e.requests[0], e.cpuMs[0]).total, costHigh: workersMonthlyCost(e.requests[1], e.cpuMs[1]).total }
}

/** Projects worth cleaning up: failing, unsupported Node, long idle. */
export function cleanupCandidates(projects, now = Date.now()) {
  const out = []
  for (const p of projects) {
    const reasons = []
    const prod = p.targets?.production
    const nodeMajor = Number(String(p.nodeVersion ?? '').split('.')[0])
    if (prod?.readyState === 'ERROR' || prod?.readyState === 'BLOCKED') reasons.push(`latest production ${prod.readyState}`)
    if (nodeMajor && nodeMajor < 20) reasons.push(`Node ${p.nodeVersion} (unsupported runtime — redeploys fail)`)
    const last = prod?.createdAt ?? p.updatedAt
    if (last && now - last > 180 * 86_400_000) reasons.push(`no production deploy for ${Math.round((now - last) / 86_400_000)} days`)
    if (!prod) reasons.push('never deployed to production')
    if (reasons.length) out.push({ name: p.name, framework: p.framework ?? '—', reasons })
  }
  return out
}
