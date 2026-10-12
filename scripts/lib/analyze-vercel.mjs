// Vercel account analysis focused on ONE main project → model + Markdown renderer.
import { findToken, createVercelClient } from './vercel-api.mjs'
import { parseCharges, schemaWarnings, aggregate, monthlyMetrics, costDrivers, derived, dailySpikes, insights, driverInsights, buildStats, hobbyFit, workersEstimate, cleanupCandidates } from './vercel-usage-insights.mjs'
import { table } from './report-render.mjs'

const usd = n => `$${n.toFixed(2)}`
const k = n => Math.round(n).toLocaleString('en-US')

/** opts: { project, team, days, from, to, deployments = true, calibration (measure-worker.mjs JSON) } */
export async function analyzeVercel(opts = {}) {
  const auth = findToken()
  if (!auth) throw new Error('No Vercel token: set VERCEL_TOKEN or run `vercel login`.')
  const api = createVercelClient(auth.token)

  const teams = await api.teams()
  const team = opts.team ? teams.find(t => t.id === opts.team || t.slug === opts.team) : teams.find(t => t.billing?.plan === 'pro') ?? teams[0]
  if (!team) throw new Error(`Team ${opts.team ?? ''} not found (personal Hobby scopes without a team are not supported by the billing API).`)

  const now = new Date()
  const periodStart = team.billing?.period?.start ? new Date(team.billing.period.start) : null
  const from = opts.from ? new Date(opts.from) : opts.days ? new Date(now - Number(opts.days) * 86_400_000) : periodStart ?? new Date(now - 30 * 86_400_000)
  const to = opts.to ? new Date(opts.to) : now

  const [rows, projects] = await Promise.all([api.charges(team.id, from.toISOString(), to.toISOString()).then(parseCharges), api.projects(team.id)])
  const warnings = schemaWarnings(rows)
  const agg = aggregate(rows)
  const byName = new Map(projects.map(p => [p.name, p]))
  const monthly = [...agg.projects.values()].map(p => ({ p, m: monthlyMetrics(p, agg.days) })).sort((a, b) => b.m.effectiveUsd - a.m.effectiveUsd)
  const main = opts.project ? monthly.find(x => x.p.name === opts.project) : monthly[0]
  if (!main) throw new Error(`Project ${opts.project ?? ''} has no usage between ${from.toISOString().slice(0, 10)} and ${to.toISOString().slice(0, 10)}. Projects with usage: ${monthly.map(x => x.p.name).join(', ')}`)

  const meta = byName.get(main.p.name)
  const builds = opts.deployments !== false && meta ? buildStats(await api.deployments(team.id, meta.id, from.getTime()), agg.days) : null
  const d = derived(main.m)
  const spikes = dailySpikes(main.p)
  const drivers = costDrivers(main.p, agg.days, 8)
  const found = [...driverInsights(drivers, { builds, d }), ...insights(main.m, d, { builds, spikes })]
  const est = workersEstimate(main.m, opts.calibration)
  const others = monthly.filter(x => x !== main)
  const othersUsage = others.reduce((s, x) => s + x.m.effectiveUsd, 0)
  const totalUsage = monthly.reduce((s, x) => s + x.m.effectiveUsd, 0)
  const billedAll = Object.values(agg.account.services).reduce((s, x) => s + x.billed, 0) * 30 / agg.days
  const subscriptionMonth = agg.subscriptionUsd * 30 / agg.days
  // Real bill = subscription + BilledCost (after allowances/credit). For "keep Pro for the rest",
  // give the remaining projects their list-price share of the actually billed usage, so both
  // options compare real money (list prices overstate the bill ~1.5×).
  const seat = subscriptionMonth || 20
  const proBill = usage => seat + (totalUsage > 0 ? billedAll * (usage / totalUsage) : 0)
  const hobbyOthers = hobbyFit(others.map(x => x.m))
  const isPro = team.billing?.plan === 'pro'

  return {
    warnings,
    team: { slug: team.slug, plan: team.billing?.plan, period: team.billing?.period },
    window: { from: from.toISOString(), to: to.toISOString(), days: agg.days }, tokenSource: auth.source,
    main: {
      name: main.p.name,
      meta: meta && { framework: meta.framework, node: meta.nodeVersion, region: meta.resourceConfig?.functionDefaultRegions ?? meta.serverlessFunctionRegion, fluid: meta.resourceConfig?.fluid, domains: meta.targets?.production?.alias?.slice(0, 5) },
      monthly: main.m, derived: d, drivers, insights: found, spikes, regions: main.p.regions, builds, workers: est,
    },
    others: others.map(x => ({ name: x.p.name, monthly: x.m })), hobbyOthers, totalUsage, othersUsage, billedAll, subscriptionMonth,
    cleanup: cleanupCandidates(projects),
    options: [
      { name: `Stay: everything on Vercel ${isPro ? 'Pro' : team.billing?.plan ?? ''}`, usd: [subscriptionMonth + billedAll, subscriptionMonth + billedAll], caveat: 'actual: subscription + billed usage, projected' },
      { name: `Move ${main.p.name} → Workers, keep Vercel Pro for the rest`, usd: [est.costLow + proBill(othersUsage), est.costHigh + proBill(othersUsage)], caveat: 'Pro part: subscription + the rest\'s share of billed usage' },
      { name: `Move ${main.p.name} → Workers, rest → Vercel Hobby`, usd: [est.costLow, est.costHigh],
        caveat: (hobbyOthers.some(h => h.pct > 100) ? `rest exceeds Hobby: ${hobbyOthers.filter(h => h.pct > 100).map(h => h.label).join(', ')}; ` : '') + 'Hobby = non-commercial only' },
    ],
  }
}

export function renderVercelMarkdown(mdl) {
  const m = mdl.main, mm = m.monthly, dd = m.derived
  const pct = x => x == null ? '—' : `${(x * 100).toFixed(0)}%`
  const out = []
  out.push(`# Vercel deep dive — ${m.name}`)
  out.push(`Team **${mdl.team.slug}** (${mdl.team.plan}) · window ${mdl.window.from.slice(0, 10)} → ${mdl.window.to.slice(0, 10)} (${mdl.window.days} days, projected to 30) · token: ${mdl.tokenSource}`)
  if (mdl.warnings?.length) out.push(mdl.warnings.map(w => `- ⚠ ${w}`).join('\n'))
  if (m.meta) out.push(`Framework ${m.meta.framework} · Node ${m.meta.node} · function region ${JSON.stringify(m.meta.region)} · Fluid ${m.meta.fluid ? 'on' : 'off'} · domains ${m.meta.domains?.join(', ') ?? '—'}`)
  out.push('## Bill options (per month)')
  out.push(table(['Option', 'Monthly USD', 'Note'], mdl.options.map(o => [o.name, o.usd[0] === o.usd[1] ? usd(o.usd[0]) : `${usd(o.usd[0])} – ${usd(o.usd[1])}`, o.caveat ?? ''])))
  out.push(`Usage at list price: ${m.name} ${usd(mm.effectiveUsd)}/month, all projects ${usd(mdl.totalUsage)}/month; actually billed after allowances/credit: ${usd(mdl.billedAll)}/month + subscription ${usd(mdl.subscriptionMonth)}.`)
  out.push('## Main project — monthly usage')
  out.push(table(['Metric', 'Per month', 'Meaning'], [
    ['CDN requests', k(mm.cdn), 'every request incl. static files'],
    ['Function invocations', k(mm.inv), '≈ dynamic Worker requests (each boots Next)'],
    ['ISR reads / writes', `${k(mm.isrR)} / ${k(mm.isrW)}`, 'reads ≈ cached page hits on Workers (~16 ms CPU); writes = regenerations'],
    ['Active CPU', `${mm.cpu.toFixed(2)} h`, `${dd.cpuMsPerInv?.toFixed(0) ?? '—'} ms per invocation`],
    ['Provisioned memory', `${mm.mem.toFixed(0)} GB-h`, `${dd.memPerCpu?.toFixed(0) ?? '—'} GB-h per CPU-hour (I/O wait)`],
    ['Fast Origin Transfer', `${mm.fot.toFixed(1)} GB`, `${dd.fotKbPerInv?.toFixed(0) ?? '—'} KB per invocation`],
    ['Fast Data Transfer', `${mm.fdt.toFixed(1)} GB`, 'free on Cloudflare'],
    ['Requests not reaching a function', pct(dd.cacheShare), 'higher is cheaper on both platforms'],
    ['Build CPU minutes', k(mm.build), m.builds ? `${m.builds.total} builds, ${m.builds.perDay.toFixed(1)}/day, avg ${m.builds.avgMin.toFixed(1)} min, ${m.builds.failed} failed` : ''],
  ]))
  out.push('**Cost drivers (list price):**\n\n' + table(['Service', 'Qty/month', 'USD/month'], m.drivers.map(x => [x.name, `${x.qtyMonth.toFixed(x.qtyMonth < 100 ? 2 : 0)} ${x.unit ?? ''}`, usd(x.usdMonth)])))
  out.push('## Why — insights')
  out.push(m.insights.length ? m.insights.map(i => `- **${i.sev} ${i.title}** — ${i.detail}`).join('\n') : '_nothing unusual_')
  out.push('## On Cloudflare Workers (estimate)')
  out.push(table(['Worker requests/month', 'CPU ms/month', 'Monthly USD', 'Vercel CPU/inv'], [[`${k(m.workers.requests[0])} – ${k(m.workers.requests[1])}`, `${k(m.workers.cpuMs[0])} – ${k(m.workers.cpuMs[1])}`, `${usd(m.workers.costLow)} – ${usd(m.workers.costHigh)}`, `${m.workers.vercelCpuMsPerInv.toFixed(0)} ms`]]))
  out.push(`CPU basis: **${m.workers.basis}**.`)
  out.push('_Model: invocations → dynamic requests at Vercel CPU/inv × 1–2.5 (floor 60–150 ms); 25%–100% of the other CDN requests (capped by ISR reads) → cache-intercepted page hits at 16–40 ms; the rest → static assets (free). Calibrated on real OpenNext measurements (~15–35 ms cached, 100–400 ms dynamic) — confirm with `wrangler tail` on a trial Worker. Includes the $5 Workers Paid base; 10M requests + 30M CPU-ms included._')
  const regions = Object.entries(m.regions).sort((a, b) => b[1] - a[1]).slice(0, 6)
  if (regions.length) out.push('**Where traffic is served (Fast Data Transfer GB in window):** ' + regions.map(([r, gb]) => `${r} ${gb.toFixed(2)}`).join(' · ') + '. Put Worker `placement` next to the DB, not the users — the CDN serves users anyway.')
  out.push('## Daily requests (main project)')
  out.push(table(['Day', 'CDN requests', 'Invocations', ''], m.spikes.rows.map(([dt, x]) => [dt, k(x.cdn), k(x.inv), x.cdn > 2.5 * m.spikes.median ? 'spike' : ''])))
  out.push('## Other projects (monthly)')
  out.push(table(['Project', 'Usage USD', 'CDN req', 'Invocations', 'Active CPU h', 'FOT GB'], mdl.others.map(o => [o.name, usd(o.monthly.effectiveUsd), k(o.monthly.cdn), k(o.monthly.inv), o.monthly.cpu.toFixed(2), o.monthly.fot.toFixed(1)])))
  out.push('**If the other projects go to Hobby (allowances are per account, non-commercial only):**\n\n' + table(['Allowance', 'Used/month', 'Hobby includes', '%'], mdl.hobbyOthers.map(h => [h.label, h.used < 100 ? h.used.toFixed(2) : k(h.used), k(h.limit), `${h.pct.toFixed(0)}%${h.pct > 100 ? ' ⚠' : ''}`])))
  if (mdl.cleanup.length) out.push('## Cleanup candidates\n\n' + table(['Project', 'Framework', 'Why'], mdl.cleanup.map(c => [c.name, c.framework, c.reasons.join('; ')])))
  out.push('_Read-only analysis. Prices and allowances change — re-check vercel.com/docs/limits/fair-use-guidelines and developers.cloudflare.com/workers/platform/pricing before deciding._')
  return out.join('\n\n')
}
