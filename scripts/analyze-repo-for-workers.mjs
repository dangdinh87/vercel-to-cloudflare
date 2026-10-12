#!/usr/bin/env node
// Deep Cloudflare Workers (OpenNext) readiness analysis of a Next.js repo.
// Builds an import graph from every route entry, classifies each route as build-time or
// request-time, and only flags Workers hazards on code that actually runs per request.
//
// Usage: node analyze-repo-for-workers.mjs <repoDir> [--json] [--md=report.md] [--html=report.html]
// Default: Markdown to stdout. Exit 1 when any P0 exists.
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { analyzeRepo } from './lib/analyze-repo.mjs'
import { renderRepoMarkdown, markdownToHtml } from './lib/report-render.mjs'

const args = process.argv.slice(2)
const repo = args.find(a => !a.startsWith('--'))
if (!repo) {
  console.error('Usage: node analyze-repo-for-workers.mjs <repoDir> [--json] [--md=file] [--html=file]')
  process.exit(2)
}
const opt = name => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3)

const model = analyzeRepo(resolve(repo))
const md = renderRepoMarkdown(model)
if (opt('md')) writeFileSync(opt('md'), md)
if (opt('html')) writeFileSync(opt('html'), markdownToHtml(md, `Workers readiness — ${model.root.split('/').pop()}`))
if (args.includes('--json')) console.log(JSON.stringify(model, (k, v) => (v instanceof Set ? [...v] : v), 2))
else if (!opt('md') && !opt('html')) console.log(md)
else console.log(`Readiness ${model.score.readiness}/100 · ${model.score.verdict} · effort ${model.score.effortHours.join('–')} h · P0 ${model.score.counts.P0} · P1 ${model.score.counts.P1}`)
process.exitCode = model.score.counts.P0 > 0 ? 1 : 0
