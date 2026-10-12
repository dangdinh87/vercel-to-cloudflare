#!/usr/bin/env node
// Deep, read-only analysis of a Vercel account focused on ONE main project: where the money and
// requests go, why (ratios), how it maps to Cloudflare Workers, and which bill each option gives.
//
// Usage: node analyze-vercel-account.mjs [--project=<name>] [--team=<slug|id>] [--days=N | --from=YYYY-MM-DD --to=YYYY-MM-DD]
//                                        [--no-deployments] [--calibration=measure.json] [--json] [--md=file] [--html=file]
// Token: VERCEL_TOKEN or the Vercel CLI login (`vercel login`). Main project defaults to the costliest.
// For the user-facing report, prefer make-report.mjs (overview + glossary + sources).
import { writeFileSync, readFileSync } from 'node:fs'
import { analyzeVercel, renderVercelMarkdown } from './lib/analyze-vercel.mjs'
import { markdownToHtml } from './lib/report-render.mjs'

const args = process.argv.slice(2)
const opt = n => args.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3)

try {
  const model = await analyzeVercel({ project: opt('project'), team: opt('team'), days: opt('days'), from: opt('from'), to: opt('to'), deployments: !args.includes('--no-deployments'), calibration: opt('calibration') ? JSON.parse(readFileSync(opt('calibration'), 'utf8')) : null })
  const md = renderVercelMarkdown(model)
  if (opt('md')) writeFileSync(opt('md'), md)
  if (opt('html')) writeFileSync(opt('html'), markdownToHtml(md, `Vercel deep dive — ${model.main.name}`))
  if (args.includes('--json')) console.log(JSON.stringify(model, null, 2))
  else if (!opt('md') && !opt('html')) console.log(md)
  else console.log(`${model.main.name}: usage $${model.main.monthly.effectiveUsd.toFixed(2)}/mo · Workers est $${model.main.workers.costLow.toFixed(2)}–$${model.main.workers.costHigh.toFixed(2)} · ${model.main.insights.length} insights`)
} catch (e) {
  console.error(e.message)
  process.exitCode = 2
}
