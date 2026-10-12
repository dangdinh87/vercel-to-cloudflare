// Builds the user-facing HTML (overview first) from analysis models. Shared by make-report.mjs
// (one app) and scan-vercel-apps.mjs (every Vercel app found on this machine).
import { spawn } from 'node:child_process'
import { renderRepoMarkdown, mdToFragment, htmlPage, escapeHtml, table } from './report-render.mjs'
import { renderVercelMarkdown } from './analyze-vercel.mjs'
import { T, GLOSSARY, SOURCES, FACTS_CHECKED } from './report-i18n.mjs'

export const usd = n => `$${n.toFixed(2)}`

export function autoOverview({ repo, vercel }, lang) {
  const t = T[lang]
  const lines = []
  if (repo) lines.push(`**${t.autoVerdict[repo.score.verdict] ?? repo.score.verdict}**`)
  const problems = []
  if (repo) for (const f of repo.findings.filter(f => f.sev === 'P0' || f.sev === 'P1').slice(0, 3)) problems.push(`${f.sev} \`${f.file}\` — ${f.msg.split('. ')[0]}.`)
  if (vercel) for (const i of vercel.main.insights.filter(i => i.sev === 'P1').slice(0, 3 - Math.min(problems.length, 2))) problems.push(`${i.title} — ${i.detail.split('. ')[0]}.`)
  if (problems.length) lines.push(`### ${t.topProblems}\n\n` + problems.map(p => `- ${p}`).join('\n'))
  if (repo) {
    const actions = repo.score.perRule.filter(r => r.sev === 'P0' || r.sev === 'P1').slice(0, 3).map(r => `- ${r.rule} (${r.files} file${r.files > 1 ? 's' : ''}, ${r.effort[0]}–${r.effort[1]} ${t.hours})`)
    if (actions.length) lines.push(`### ${t.nextActions}\n\n${actions.join('\n')}`)
  }
  if (vercel) {
    const o = vercel.options
    lines.push(`### ${t.money}\n\n` + t.moneyLine(usd(o[0].usd[0]), `${usd(o[2].usd[0])}–${usd(o[2].usd[1])}`, lang === 'vi'
      ? ` nếu các project còn lại xuống Hobby; giữ Pro cho chúng thì tổng ${usd(o[1].usd[0])}–${usd(o[1].usd[1])}`
      : ` if the other projects go to Hobby; keeping Pro for them totals ${usd(o[1].usd[0])}–${usd(o[1].usd[1])}`))
  }
  lines.push(`_${t.noSummary}_`)
  return lines.join('\n\n')
}

export function cardsFor({ repo, vercel, bundle }, lang) {
  const t = T[lang]
  const cards = []
  if (repo) {
    const s = repo.score
    const tone = s.verdict === 'GO' ? 'good' : s.verdict.startsWith('NO-GO') ? 'bad' : 'warn'
    cards.push([`${s.readiness}/100`, `${t.readiness} · ${s.verdict}`, tone])
    cards.push([`${s.effortHours[0]}–${s.effortHours[1]} ${t.hours}`, t.effort, ''])
    cards.push([`${s.counts.P0 + s.counts.P1}`, `${t.mustFix} (P0 ${s.counts.P0} · P1 ${s.counts.P1})`, s.counts.P0 ? 'bad' : s.counts.P1 ? 'warn' : 'good'])
  }
  if (vercel) {
    cards.push([`${usd(vercel.options[0].usd[0])}${t.perMonth}`, `${t.billNow} (team)`, ''])
    cards.push([`${usd(vercel.main.workers.costLow)}–${usd(vercel.main.workers.costHigh)}`, `${t.workers} · ${vercel.main.name}`, ''])
  }
  if (bundle) cards.push([`${(bundle.totalBytes / 1048576).toFixed(1)} MiB`, 'Worker bundle (limit 64 MiB)', bundle.totalBytes > 54 * 1048576 ? 'warn' : 'good'])
  return cards
}

export const cardsHtml = cards => cards.length
  ? `<div class="cards">${cards.map(([v, l, tone]) => `<div class="card ${tone}"><b>${escapeHtml(v)}</b><span>${escapeHtml(l)}</span></div>`).join('')}</div>` : ''

/** Shared tail: limits, glossary, sources. */
export function footerHtml(lang) {
  const t = T[lang]
  return [
    `<h2 id="limits">${t.limits}</h2><ul>${t.limitItems.map(x => `<li>${mdToFragment(x).replace(/^<p>|<\/p>$/g, '')}</li>`).join('')}</ul>`,
    `<h2 id="glossary">${t.glossary}</h2><dl>${GLOSSARY[lang].map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('')}</dl>`,
    `<h2>${t.sources.replace('{date}', FACTS_CHECKED)}</h2><ul>${SOURCES.map(([n, u]) => `<li><a href="${u}">${escapeHtml(n)}</a></li>`).join('')}</ul>`,
  ].join('\n')
}

export function buildReportHtml({ repo, vercel, vercelError, bundle, summaryMd, lang = 'en', title, backLink }) {
  const t = T[lang]
  const stripH1 = md => md.replace(/^# .*\n+/, '')
  const sections = []
  if (repo) sections.push(['repo', t.repoDetails, mdToFragment(stripH1(renderRepoMarkdown(repo)))])
  if (vercel) sections.push(['vercel', t.vercelDetails, mdToFragment(stripH1(renderVercelMarkdown(vercel)))])
  if (vercelError) sections.push(['vercel', t.vercelDetails, `<p>⚠ ${escapeHtml(vercelError)}</p>`])
  if (bundle) sections.push(['bundle', t.bundleDetails, mdToFragment(table(['Source', 'MiB', 'Share'], bundle.sources.slice(0, 20).map(g => [g.group, (g.bytes / 1048576).toFixed(2), `${((g.bytes / bundle.totalBytes) * 100).toFixed(1)}%`])))])
  const heading = title ?? t.title
  const scope = [repo && `repo ${repo.root.split(/[\\/]/).pop()}`, vercel && `Vercel ${vercel.team.slug}/${vercel.main.name}`, bundle && 'bundle'].filter(Boolean).join(' · ')
  const body = [
    backLink ? `<p class="meta"><a href="${backLink}">← ${lang === 'vi' ? 'Tổng quan mọi app' : 'All apps'}</a></p>` : '',
    `<h1>${escapeHtml(heading)}</h1>`,
    `<p class="meta">${t.generated} ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC · ${t.scope}: ${escapeHtml(scope)}</p>`,
    `<nav class="toc"><a href="#overview">${t.overview}</a>${sections.map(([id, name]) => `<a href="#${id}">${escapeHtml(name)}</a>`).join('')}<a href="#limits">${t.limits}</a><a href="#glossary">${t.glossary}</a></nav>`,
    `<h2 id="overview">${t.overview}</h2>`,
    cardsHtml(cardsFor({ repo, vercel, bundle }, lang)),
    `<div class="overview">${mdToFragment(summaryMd ?? autoOverview({ repo, vercel }, lang))}</div>`,
    `<h2>${t.details}</h2>`,
    ...sections.map(([id, name, html]) => `<details id="${id}"><summary>${escapeHtml(name)}</summary>${html}</details>`),
    footerHtml(lang),
  ].join('\n')
  return htmlPage(heading, body, lang)
}

export function openFile(path) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const cmdArgs = process.platform === 'win32' ? ['/c', 'start', '', path] : [path]
  spawn(cmd, cmdArgs, { detached: true, stdio: 'ignore' }).unref()
}
