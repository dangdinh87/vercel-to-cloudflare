// Markdown renderer for both analyzers + a tiny Markdown→HTML converter (tables, lists, headings,
// code, bold, links) so one renderer serves terminal, .md and a standalone .html report.

export const esc = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')
export const table = (head, rows) => rows.length
  ? [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map(r => `| ${r.map(esc).join(' | ')} |`)].join('\n')
  : '_none_'
const loc = f => `${f.file}${f.lines?.[0] ? `:${f.lines.slice(0, 4).join(',')}${f.lines.length > 4 ? '…' : ''}` : ''}`
const chainText = c => (c && c.length > 1 ? c.join(' → ') : '')
const SEV_ORDER = { P0: 0, P1: 1, P2: 2, P3: 3, INFO: 4 }

export function renderRepoMarkdown(m) {
  const s = m.score
  const out = []
  const name = m.root.split('/').filter(Boolean).pop()
  out.push(`# Cloudflare Workers readiness — ${name}`)
  out.push(`Generated ${m.generatedAt.slice(0, 16).replace('T', ' ')} · next ${m.facts.next ?? '?'} · react ${m.facts.react ?? '?'} · ${m.facts.pm} · imports parsed with ${m.facts.parser} · ${m.facts.files} files, ${m.facts.reachable} reachable from routes, ${m.facts.runtimeFiles} run at request time`)
  out.push('## Verdict')
  out.push(table(['Readiness', 'Verdict', 'Effort (h)', 'P0', 'P1', 'P2', 'P3', 'Build-only (OK)'],
    [[`${s.readiness}/100`, s.verdict, `${s.effortHours[0]}–${s.effortHours[1]}`, s.counts.P0, s.counts.P1, s.counts.P2, s.counts.P3, s.counts.INFO]]))
  if (s.hardBlockers.length) out.push(`**Hard blockers:** ${s.hardBlockers.join(', ')}`)

  const top = m.findings.filter(f => f.sev === 'P0' || f.sev === 'P1').sort((a, b) => SEV_ORDER[a.sev] - SEV_ORDER[b.sev])
  out.push('## Must fix (P0/P1)')
  out.push(top.length ? top.map(f => `- **${f.sev} ${f.rule}** \`${loc(f)}\`${f.pkg ? ` (${f.pkg})` : ''} — ${f.msg}${chainText(f.chain) ? `\n  - reached via: \`${chainText(f.chain)}\`` : ''}${f.note ? ` _(${f.note})_` : ''}`).join('\n') : '_none_')

  out.push('## Routes by render mode')
  out.push('Request-time modes (`dynamic`, `isr`, `on-demand`, `ssg+on-demand`, `runtime`) execute on the Worker; `static-build`/`ssg` are prerendered into R2 at deploy.')
  out.push(table(['Kind:mode', 'Count'], Object.entries(m.routes.byMode).sort((a, b) => b[1] - a[1])))
  const isr = m.routes.list.filter(r => r.mode === 'isr').sort((a, b) => (a.revalidate ?? 0) - (b.revalidate ?? 0))
  if (isr.length) out.push('**ISR routes** (each regeneration = Next boot + DB):\n\n' + table(['Route', 'revalidate (s)', 'File'], isr.map(r => [r.path, r.revalidate, r.rel])))
  const edge = m.routes.list.filter(r => r.runtime === 'edge')
  if (edge.length) out.push(`**Edge runtime routes (unsupported by OpenNext):** ${edge.map(r => r.path).join(', ')}`)

  out.push('## Requests on every page view (global layouts)')
  out.push('From components reachable from the root layout. `mount` + `guest` + `eager` + dynamic handler = paid Worker CPU (and a DB wake-up) on every view.')
  out.push(table(['Request', 'Trigger', 'Audience', 'Loading', 'Handler mode', 'Status', 'Call site'],
    m.diet.perView.map(p => [`${p.method} ${p.endpoint}`, p.trigger, p.audience, p.loading, p.mode,
      p.mitigated ? 'short-circuited' : p.mode === 'dynamic' && p.trigger === 'mount' && p.loading === 'eager' ? '⚠ costs per view' : 'ok',
      `${p.file}${p.line ? ':' + p.line : ''}`])))
  if (m.diet.polling.length) out.push('**Client polling (< 60 s):**\n\n' + table(['Every', 'Where', 'Snippet'], m.diet.polling.map(p => [`${p.ms / 1000}s`, `${p.file}:${p.line}`, p.snippet])))

  out.push('## Bundle pressure (Worker limit 64 MiB uncompressed)')
  const b = m.bundle
  out.push(`First-party source reachable from routes: **${b.reachableSourceMiB} MiB** (node_modules + Next runtime come on top: measure with \`inspect-worker-bundle.mjs\` after a trial build). CSS source ${b.cssMiB} MiB across ${b.pageCount} pages${m.findings.some(f => f.rule === 'inline-css') ? ' — **inlineCss duplicates it per route manifest**' : ''}.`)
  if (b.dataDirs.length) out.push('**Data directories inside the server bundle:**\n\n' + table(['Dir', 'MiB'], b.dataDirs.map(d => [d.dir, d.mib])))
  if (b.unreachableDataDirs.length) out.push('**Data directories NOT reachable from routes (good — not bundled):** ' + b.unreachableDataDirs.map(d => `${d.dir} (${d.mib} MiB)`).join(', '))
  out.push('**Heaviest reachable modules:**\n\n' + table(['Module', 'KiB', 'Reached via'], b.heavy.map(h => [h.rel, Math.round(h.size / 1024), chainText(h.chain?.slice(0, 4))])))

  out.push('## Dependencies')
  const deps = m.findings.filter(f => f.rule.startsWith('dep:'))
  out.push(table(['Package', 'Status', 'Used at', 'Severity', 'Fix', 'Evidence'], deps.map(d => [`${d.pkg}@${d.version}`, d.rule.slice(4), d.where, d.sev, d.msg, d.verified ? 'verified on a real Workers deploy' : 'general — verify on trial'])))
  if (m.packages.verifiedOk.length) out.push(`Known-good on Workers: ${m.packages.verifiedOk.join(', ')}`)
  if (m.probe) out.push(`Packages not in the compatibility table: ${m.probe.unknownRuntime} used at request time — ${m.probe.probed} inspected on disk (native addons, subprocesses, size)${m.probe.notInstalled ? `, ${m.probe.notInstalled} not installed (install dependencies and re-run to inspect them)` : ''}.`)
  if (m.packages.runtimeBuiltins.length) out.push(`Node built-ins imported at request time (need \`nodejs_compat\`): ${m.packages.runtimeBuiltins.map(([n, c]) => `${n}×${c}`).join(', ')}`)

  out.push('## Config, env, cache bindings')
  out.push(`- OpenNext / wrangler installed: ${m.facts.opennext ?? 'no'} / ${m.facts.wrangler ?? 'no'}`)
  out.push(`- Cache bindings needed: ${m.requirements.length ? m.requirements.join('; ') : 'none'}`)
  out.push(`- Server secrets read at request time (${m.env.server.length}) → \`wrangler secret put\`: ${m.env.server.join(', ') || 'none'}`)
  out.push(`- NEXT_PUBLIC_* (${m.env.public.length}) → must exist at **build** time in CI: ${m.env.public.join(', ') || 'none'}`)
  if (m.env.envFiles.length) out.push(`- ⚠ ${m.env.envFiles.join(', ')} present: never build the deploy artefact from a tree containing real .env files (OpenNext may bundle them).`)
  if (m.crons.length) out.push(`- Vercel crons to re-home: ${m.crons.map(c => `\`${c.schedule}\` ${c.path}`).join(', ')}`)

  out.push('## Other findings (P2/P3)')
  const rest = m.findings.filter(f => (f.sev === 'P2' || f.sev === 'P3') && !f.rule.startsWith('dep:')).sort((a, b) => SEV_ORDER[a.sev] - SEV_ORDER[b.sev])
  out.push(table(['Sev', 'Rule', 'Where', 'Why / fix'], rest.slice(0, 60).map(f => [f.sev, f.rule, loc(f), f.msg + (f.note ? ` (${f.note})` : '')])))
  if (rest.length > 60) out.push(`…and ${rest.length - 60} more (see --json).`)
  const info = m.findings.filter(f => f.sev === 'INFO')
  if (info.length) out.push('**Checked and OK:** ' + info.map(f => `${f.rule} in \`${f.file}\`${f.note ? ` (${f.note})` : ''}`).join('; '))

  out.push('## Effort breakdown')
  out.push(table(['Item', 'Sev', 'Files', 'Hours'], [
    ...s.perRule.map(r => [r.rule, r.sev, r.files, `${r.effort[0]}–${r.effort[1]}`]),
    ...s.fixedPhases.map(p => [p.name, '—', '—', `${p.effort[0]}–${p.effort[1]}`]),
  ]))
  out.push('_Effort ranges are rough guides. Heuristic analysis — confirm every P0/P1 by reading the code, then prove it on a trial Worker._')
  return out.join('\n\n')
}

// ---------- Markdown → HTML ----------

const inline = s => s
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  .replace(/_([^_]+)_(?=\W|$)/g, '<em>$1</em>')
  .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2">$1</a>')

/** Markdown (the subset our renderers emit) → HTML fragment. */
export function mdToFragment(md) {
  // A heading line directly followed by text/list (no blank line) is still its own block.
  const blocks = md.split(/\n{2,}/).flatMap(b => (/^#{1,4} [^\n]*\n/.test(b) ? [b.slice(0, b.indexOf('\n')), b.slice(b.indexOf('\n') + 1)] : [b]))
  return blocks.map(block => {
    if (/^#{1,4} /.test(block)) { const lvl = block.match(/^#+/)[0].length; return `<h${lvl}>${inline(block.replace(/^#+ /, ''))}</h${lvl}>` }
    if (/^\|/.test(block)) {
      const rows = block.split('\n').filter(l => !/^\|[-|\s]+\|$/.test(l)).map(l => l.slice(1, -1).split(/(?<!\\)\|/).map(c => inline(c.trim().replace(/\\\|/g, '|'))))
      const [head, ...body] = rows
      return `<div class="tw"><table><thead><tr>${head.map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody>${body.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
    }
    if (/^(- |\d+\. )/.test(block)) {
      const ordered = /^\d+\. /.test(block)
      const items = block.split(/\n(?=- |\d+\. )/).map(item => {
        const [first, ...subs] = item.replace(/^(- |\d+\. )/, '').split(/\n\s+- /)
        return `<li>${inline(first)}${subs.length ? `<ul>${subs.map(x => `<li>${inline(x)}</li>`).join('')}</ul>` : ''}</li>`
      }).join('')
      return ordered ? `<ol>${items}</ol>` : `<ul>${items}</ul>`
    }
    return `<p>${inline(block).replace(/\n/g, '<br>')}</p>`
  }).join('\n')
}

export const escapeHtml = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Standalone page: solid colours, light/dark, readable on phones. */
export function htmlPage(title, body, lang = 'en') {
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>
:root{--bg:#f6f7f9;--surface:#fff;--raised:#eef1f5;--ink:#14171f;--ink2:#3b4352;--muted:#5b6475;--border:#dfe3ea;--accent:#2563eb;--good:#15803d;--warn:#b45309;--bad:#be123c}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--surface:#171a21;--raised:#1f242e;--ink:#e8ebf1;--ink2:#c4cad5;--muted:#9aa3b2;--border:#2a2f3a;--accent:#60a5fa;--good:#4ade80;--warn:#fbbf24;--bad:#fb7185}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1180px;margin:0 auto;padding:24px clamp(16px,4vw,32px) 64px}
h1{font-size:clamp(1.4rem,3vw,1.8rem);line-height:1.15;letter-spacing:-.02em;margin:.2em 0 .3em}
h2{font-size:1.2rem;margin:2em 0 .6em;padding-top:.7em;border-top:1px solid var(--border)}h3{font-size:1.02rem;margin:1.4em 0 .4em}
p,li{color:var(--ink2)}code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--raised);padding:1px 5px;border-radius:6px;word-break:break-word}
.meta{color:var(--muted);font-size:13.5px}
nav.toc{display:flex;flex-wrap:wrap;gap:6px 14px;margin:10px 0 4px;font-size:14px}nav.toc a{color:var(--accent);text-decoration:none}
.cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin:16px 0}
@media(min-width:760px){.cards{grid-template-columns:repeat(4,minmax(0,1fr))}}
.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:12px 14px}
.card b{display:block;font-size:1.45rem;line-height:1.15;letter-spacing:-.01em}.card span{color:var(--muted);font-size:13px}
.card.good{border-color:color-mix(in srgb,var(--good) 45%,var(--border))}.card.warn{border-color:color-mix(in srgb,var(--warn) 45%,var(--border))}.card.bad{border-color:color-mix(in srgb,var(--bad) 45%,var(--border))}
.overview{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:6px 18px 10px;margin:12px 0}
.tw{overflow-x:auto;border:1px solid var(--border);border-radius:12px;background:var(--surface);margin:.6em 0}
table{border-collapse:collapse;width:100%;font-size:13.5px}th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--border);vertical-align:top}
th{color:var(--muted);font-weight:600;white-space:nowrap;background:var(--raised)}tr:last-child td{border-bottom:0}
em{color:var(--muted)}a{color:var(--accent)}
details{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:4px 16px;margin:12px 0}
details>summary{cursor:pointer;font-weight:650;padding:10px 0;font-size:1.05rem}details[open]>summary{border-bottom:1px solid var(--border);margin-bottom:6px}
details h1{font-size:1.15rem}details h2{font-size:1.05rem;border-top:0;padding-top:0;margin-top:1.4em}
dl{display:grid;grid-template-columns:minmax(120px,max-content) 1fr;gap:6px 16px;margin:8px 0}dt{font-weight:600}dd{margin:0;color:var(--ink2)}
@media(max-width:560px){dl{grid-template-columns:1fr}dd{margin-bottom:8px}}
</style></head><body><main>${body}</main></body></html>`
}

export function markdownToHtml(md, title) {
  return htmlPage(title, mdToFragment(md))
}
