#!/usr/bin/env node
// Start here when the user has several apps: list the Vercel projects of every team the login can
// see, find each one's code on this machine, sort them into
//   traffic → worth considering a move (analysed in depth),
//   small   → (almost) free on Vercel, leave them there,
//   idle    → no usage (leave or clean up),
// and write one index report + one report per traffic app.
//
// Usage: node scan-vercel-apps.mjs [--out-dir=vercel-cloudflare-report] [--roots=~/code,~/work] [--depth=5]
//          [--team=<slug|id>] [--days=N] [--traffic-usd=3] [--traffic-invocations=100000] [--traffic-requests=500000]
//          [--all (also deep-analyse small apps)] [--hourly=<USD per hour of the user's time>] [--summary=overview.md] [--lang=en|vi] [--open]
// Read-only: Vercel API GETs + local file reads. Nothing is uploaded.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { findToken, createVercelClient } from './lib/vercel-api.mjs'
import { parseCharges, aggregate, monthlyMetrics, hobbyFit } from './lib/vercel-usage-insights.mjs'
import { workersMonthlyCost } from './lib/workers-pricing.mjs'
import { analyzeVercel } from './lib/analyze-vercel.mjs'
import { analyzeRepo } from './lib/analyze-repo.mjs'
import { findLocalNextApps, matchProjects } from './lib/local-repos.mjs'
import { triage, TRAFFIC, isLarge, DEEP_QUESTIONS } from './lib/app-triage.mjs'
import { savingsPlan } from './lib/savings-plan.mjs'
import { buildReportHtml, cardsHtml, footerHtml, openFile, usd } from './lib/build-report.mjs'
import { htmlPage, mdToFragment, escapeHtml, table } from './lib/report-render.mjs'

const args = process.argv.slice(2)
const opt = n => args.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3)
const lang = opt('lang') === 'vi' ? 'vi' : 'en'
const vi = lang === 'vi'
const outDir = resolve(opt('out-dir') ?? 'vercel-cloudflare-report')
const roots = (opt('roots')?.split(',') ?? [homedir()]).map(r => resolve(r.replace(/^~/, homedir())))
const thresholds = {
  usd: Number(opt('traffic-usd') ?? TRAFFIC.usd),
  invocations: Number(opt('traffic-invocations') ?? TRAFFIC.invocations),
  requests: Number(opt('traffic-requests') ?? TRAFFIC.requests),
}
const k = n => Math.round(n).toLocaleString('en-US')
const home = p => p.replace(homedir(), '~')

const auth = findToken()
if (!auth) { console.error('No Vercel token: set VERCEL_TOKEN or run `vercel login`.'); process.exit(2) }
const api = createVercelClient(auth.token)

console.log(`Scanning ${roots.join(', ')} for Next.js apps…`)
const localApps = findLocalNextApps(roots, Number(opt('depth') ?? 5))
const teams = (await api.teams()).filter(t => !opt('team') || t.id === opt('team') || t.slug === opt('team'))

const rows = []
const teamBills = []
for (const team of teams) {
  const projects = await api.projects(team.id)
  const from = opt('days') ? new Date(Date.now() - Number(opt('days')) * 86_400_000) : team.billing?.period?.start ? new Date(team.billing.period.start) : new Date(Date.now() - 30 * 86_400_000)
  let agg = null
  try { agg = aggregate(parseCharges(await api.charges(team.id, from.toISOString(), new Date().toISOString()))) } catch { /* plan without billing data */ }
  if (agg) {
    // Real bill = subscription + billed usage (after allowances/credit), projected to 30 days.
    const billed = Object.values(agg.account.services).reduce((s, x) => s + x.billed, 0) * 30 / agg.days
    const list = Object.values(agg.account.services).reduce((s, x) => s + x.effective, 0) * 30 / agg.days
    teamBills.push({ team, bill: agg.subscriptionUsd * 30 / agg.days + billed, subscription: agg.subscriptionUsd * 30 / agg.days, billed, list })
  }
  for (const m of matchProjects(projects, localApps)) {
    const p = agg?.projects.get(m.project.name)
    const metrics = p ? monthlyMetrics(p, agg.days) : null
    rows.push({ team, ...m, metrics, usage: metrics?.effectiveUsd ?? 0, ...triage(metrics, thresholds, lang) })
  }
}
rows.sort((a, b) => b.usage - a.usage)
const traffic = rows.filter(r => r.tier === 'traffic')
const small = rows.filter(r => r.tier === 'small')
const idle = rows.filter(r => r.tier === 'idle')
console.log(`${localApps.length} local Next.js apps · ${rows.length} Vercel projects · ${traffic.length} with traffic · ${small.length} small · ${idle.length} idle`)

mkdirSync(outDir, { recursive: true })
const slugFile = name => `${name.replace(/[^a-z0-9-]+/gi, '-')}.html`
let cleanup = []
for (const r of args.includes('--all') ? [...traffic, ...small] : traffic) {
  const repo = r.local ? analyzeRepo(r.local.dir) : null
  let vercel = null, vercelError = null
  try { vercel = await analyzeVercel({ team: r.team.id, project: r.project.name, days: opt('days') }) } catch (e) { vercelError = e.message }
  Object.assign(r, { repo, workers: vercel?.main.workers, report: slugFile(r.project.name) })
  if (vercel?.cleanup?.length) cleanup = vercel.cleanup
  writeFileSync(join(outDir, r.report), buildReportHtml({ repo, vercel, vercelError, lang, title: `${r.project.name}: Vercel → Cloudflare Workers`, backLink: 'index.html' }))
  console.log(`  ${r.tier} ${r.project.name}: ${usd(r.usage)}/mo · ${r.local ? `${r.local.dir} (${r.how})` : 'no local code'}${repo ? ` · readiness ${repo.score.readiness}` : ''}`)
}

// ---------- money: move only the traffic apps ----------
const totalBill = teamBills.reduce((s, b) => s + b.bill, 0)
const withEst = traffic.filter(r => r.workers)
const sum = i => withEst.reduce((acc, r) => [acc[0] + r.workers.requests[i], acc[1] + r.workers.cpuMs[i]], [0, 0])
// The 5 USD Workers base + included 10M requests / 30M CPU-ms are per ACCOUNT: sum, then price once.
const workers = withEst.length ? [workersMonthlyCost(...sum(0)).total, workersMonthlyCost(...sum(1)).total] : null
const smallHobby = hobbyFit(small.map(r => r.metrics))
const smallFitsHobby = smallHobby.every(h => h.pct <= 100)
// If small apps stay on Pro: subscription + their share of billed usage.
const proTeam = teamBills.find(b => b.team.billing?.plan === 'pro')
const smallList = small.reduce((s, r) => s + r.usage, 0)
const smallOnPro = proTeam ? proTeam.subscription + (proTeam.list > 0 ? proTeam.billed * (smallList / proTeam.list) : 0) : 0

const large = traffic.filter(r => isLarge(r.metrics))
for (const r of large) r.large = true
const plan = savingsPlan({ now: totalBill, workers, traffic: withEst, small, smallFitsHobby, smallOnPro, large }, lang)
const hourly = opt('hourly') ? Number(opt('hourly')) : null
const effort = plan.steps[0]?.effort
const breakEven = hourly && effort && plan.saving?.[1] > 0 ? [effort[0] * hourly / plan.saving[1], effort[1] * hourly / Math.max(plan.saving[0], 0.01)] : null

const per = vi ? '/tháng' : '/month'

// ---- Top: three numbers + one line per app. Everything else is folded below.
const cards = [
  [usd(totalBill) + per, vi ? 'Đang trả cho Vercel' : 'Paying Vercel now', ''],
  plan.target ? [`${usd(plan.target[0])}–${usd(plan.target[1])}${per}`, large.length ? (vi ? 'Sau khi chuyển (ước tính — cần hỏi thêm)' : 'After moving (estimate — needs answers)') : (vi ? 'Sau khi chuyển (Workers + Hobby)' : 'After moving (Workers + Hobby)'), large.length ? 'warn' : 'good'] : [vi ? 'Giữ nguyên' : 'Stay', vi ? 'Không có app đáng chuyển' : 'Nothing worth moving', 'good'],
  ...(plan.saving ? [[`${usd(plan.saving[0] * 12)}–${usd(plan.saving[1] * 12)}`, vi ? 'Tiết kiệm mỗi năm' : 'Saved per year', plan.saving[1] > 5 ? 'good' : '']] : []),
]

const verdict = () => {
  if (!traffic.length) return vi ? '**Cứ để trên Vercel.** Không app nào đủ traffic để chuyển mà tiết kiệm được.' : '**Stay on Vercel.** No app has enough traffic for a move to save money.'
  const names = traffic.map(r => r.project.name).join(', ')
  const lines = [vi
    ? `**Có thể trả ${usd(plan.target[0])}–${usd(plan.target[1])}/tháng thay vì ${usd(totalBill)}** nếu chuyển ${names} sang Cloudflare và để các app còn lại trên Vercel.`
    : `**You could pay ${usd(plan.target[0])}–${usd(plan.target[1])}/month instead of ${usd(totalBill)}** by moving ${names} to Cloudflare and leaving the rest on Vercel.`]
  if (large.length) lines.push(vi
    ? `⚠ **${large.map(r => r.project.name).join(', ')} có traffic lớn** — cần trả lời các câu hỏi bên dưới trước khi quyết định.`
    : `⚠ **${large.map(r => r.project.name).join(', ')} has large traffic** — answer the questions below before deciding.`)
  else lines.push(vi ? `Đổi lại: khoảng ${plan.steps[0]?.effort?.join('–')} giờ làm, trang chưa cache chậm hơn chút. Chi tiết ở "Kế hoạch".` : `In exchange: about ${plan.steps[0]?.effort?.join('–')} hours of work and slightly slower uncached pages. See "Plan".`)
  return lines.join('\n\n')
}

const advice = r => r.tier === 'small' ? (vi ? 'Để lại Vercel' : 'Leave on Vercel')
  : r.large ? (vi ? 'Hỏi kỹ trước khi quyết' : 'Ask first — large traffic')
  : (vi ? 'Nên chuyển sang Workers' : 'Move to Workers')
const why = r => {
  const base = r.reasons[0]
  if (r.tier === 'small') return base
  const fix = r.repo ? (r.repo.score.counts.P0 + r.repo.score.counts.P1) : null
  return `${base}${fix != null ? (vi ? ` · ${fix ? `${fix} lỗi phải sửa trước` : 'không có lỗi chặn'}` : ` · ${fix ? `${fix} must-fix` : 'no blockers'}`) : ''}`
}
const linkify = html => html.replace(/\[([^\]]+)\]\(([^)]+\.html)\)/g, '<a href="$2">$1</a>')
const appsTable = table(vi ? ['App', 'Nên làm', 'Vì sao', 'Chi tiết'] : ['App', 'Do', 'Why', 'Details'],
  [...traffic, ...small].map(r => [r.project.name, advice(r), why(r), r.report ? `[${vi ? 'mở' : 'open'}](${r.report})` : '—']))

// ---- Folded details
const fold = (title, html) => html ? `<details><summary>${title}</summary>${html}</details>` : ''
const planHtml = [
  plan.target ? `<p>${vi ? `Mục tiêu: app có traffic dùng chung 1 gói Cloudflare Workers Paid (5 USD/tháng cho cả tài khoản), app nhỏ ở Vercel Hobby.` : 'Target: traffic apps share one Cloudflare Workers Paid plan (5 USD/month per account), small apps on Vercel Hobby.'}${breakEven ? (vi ? ` Hoà vốn công sức sau ≈ ${breakEven[0].toFixed(0)}–${breakEven[1].toFixed(0)} tháng (với ${usd(hourly)}/giờ).` : ` Pays back in ≈ ${breakEven[0].toFixed(0)}–${breakEven[1].toFixed(0)} months at ${usd(hourly)}/hour.`) : ''}</p>` : '',
  plan.steps.length ? mdToFragment(table(vi ? ['Bước', 'Đánh đổi', 'Giờ'] : ['Step', 'Trade-off', 'Hours'], plan.steps.map(st => [st.action, st.tradeoff, st.effort ? `${st.effort[0]}–${st.effort[1]}` : '—']))) : '',
  plan.warnings.length ? `<ul>${plan.warnings.map(w => `<li>⚠ ${escapeHtml(w)}</li>`).join('')}</ul>` : '',
].join('')
const techTable = table(
  vi ? ['App', 'Vì sao có traffic', 'Usage/tháng (niêm yết)', 'Code trên máy', 'Sẵn sàng', 'P0 / P1'] : ['App', 'Why it counts', 'Usage/month (list)', 'Local code', 'Readiness', 'P0 / P1'],
  traffic.map(r => [r.project.name, r.reasons.join('; '), usd(r.usage),
    r.local ? `${home(r.local.dir)}${r.copies.length ? ` (+${r.copies.length} ${vi ? 'bản sao' : 'copies'})` : ''}` : (vi ? '— không thấy (thêm `--roots=`)' : '— not found (add `--roots=`)'),
    r.repo ? `${r.repo.score.readiness}/100 ${r.repo.score.verdict}` : '—', r.repo ? `${r.repo.score.counts.P0} / ${r.repo.score.counts.P1}` : '—']))
const smallNote = small.length ? `<p>${vi ? `App nhỏ gần như miễn phí trên Vercel. Tổng usage ${smallFitsHobby ? 'vừa hạn mức Hobby (miễn phí, chỉ cho site phi thương mại)' : 'vượt hạn mức Hobby ở: ' + smallHobby.filter(h => h.pct > 100).map(h => h.label).join(', ')}; giữ Pro cho chúng ≈ ${usd(smallOnPro)}/tháng.` : `Small apps are almost free on Vercel. Together they ${smallFitsHobby ? 'fit Hobby (free, non-commercial only)' : 'exceed Hobby on: ' + smallHobby.filter(h => h.pct > 100).map(h => h.label).join(', ')}; keeping Pro for them ≈ ${usd(smallOnPro)}/month.`}</p>` : ''

const body = [
  `<h1>${vi ? 'Giảm tiền hosting: app nào nên chuyển sang Cloudflare?' : 'Pay less for hosting: which apps should move to Cloudflare?'}</h1>`,
  `<p class="meta">${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC · ${rows.length} ${vi ? 'project Vercel' : 'Vercel projects'} · ${localApps.length} ${vi ? 'app Next.js trên máy' : 'local Next.js apps'}</p>`,
  cardsHtml(cards),
  `<div class="overview">${mdToFragment(opt('summary') ? readFileSync(opt('summary'), 'utf8') : verdict())}</div>`,
  `<h2>${vi ? 'App của bạn' : 'Your apps'}</h2>`,
  linkify(mdToFragment(appsTable)),
  `<p class="meta">${vi ? `${idle.length} project khác không có usage trong kỳ → để nguyên.` : `${idle.length} other projects had no usage → leave them.`}</p>`,
  large.length ? `<h2>${vi ? 'Cần hỏi thêm (app traffic lớn)' : 'Questions first (large-traffic apps)'}</h2><p>${vi ? 'Traffic lớn thì một quyết định sai tốn nhiều tiền và người dùng. Trả lời các câu này để trợ lý khuyên chính xác:' : 'With large traffic, a wrong call costs real money and users. Answer these so the advice fits:'}</p><ol>${DEEP_QUESTIONS[lang].map(q => `<li>${escapeHtml(q)}</li>`).join('')}</ol>` : '',
  `<h2>${vi ? 'Xem thêm' : 'More'}</h2>`,
  fold(vi ? 'Kế hoạch giảm tiền: từng bước và đánh đổi' : 'Plan to pay less: steps and trade-offs', planHtml),
  fold(vi ? `Số liệu kỹ thuật các app có traffic (${traffic.length})` : `Technical numbers for traffic apps (${traffic.length})`, traffic.length ? mdToFragment(techTable) + `<p class="meta">${vi ? `Ngưỡng "có traffic": ≥ $${thresholds.usd}/tháng chi phí chạy (không tính build), hoặc ≥ ${k(thresholds.invocations)} lần gọi function, hoặc ≥ ${k(thresholds.requests)} request mỗi tháng.` : `"Traffic" threshold: ≥ $${thresholds.usd}/month runtime cost (builds excluded), or ≥ ${k(thresholds.invocations)} invocations, or ≥ ${k(thresholds.requests)} requests per month.`}</p>` : ''),
  fold(vi ? `App nhỏ (${small.length})` : `Small apps (${small.length})`, smallNote),
  fold(vi ? `Không có usage (${idle.length})` : `No usage (${idle.length})`, idle.length ? mdToFragment(table(['Project', 'Team', vi ? 'Code trên máy' : 'Local code'], idle.map(r => [r.project.name, r.team.slug, r.local ? home(r.local.dir) : '—']))) : ''),
  fold(vi ? `Project nên dọn (${cleanup.length})` : `Cleanup candidates (${cleanup.length})`, cleanup.length ? mdToFragment(table(['Project', 'Framework', vi ? 'Lý do' : 'Why'], cleanup.map(c => [c.name, c.framework, c.reasons.join('; ')]))) : ''),
  footerHtml(lang),
].join('\n')

const index = join(outDir, 'index.html')
writeFileSync(index, htmlPage(vi ? 'App Vercel → Cloudflare?' : 'Vercel apps → Cloudflare?', body, lang))
console.log(`Report: ${index}`)
if (args.includes('--open')) openFile(index)
