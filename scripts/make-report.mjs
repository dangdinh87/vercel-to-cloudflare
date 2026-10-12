#!/usr/bin/env node
// One local HTML report for the user: Overview first (plain language), key numbers, then details
// (code readiness, Vercel deep dive, bundle), limits, glossary and sources.
// For every Vercel app on this machine at once, use scan-vercel-apps.mjs.
//
// Usage: node make-report.mjs --out=report.html [--repo=<dir>] [--vercel [--project=<name>] [--team=] [--days=N]]
//                             [--bundle=<dir with .open-next>] [--calibration=measure.json] [--summary=overview.md] [--lang=en|vi] [--title=..] [--open]
// --summary: Markdown overview written by the assistant in the user's language (recommended).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { analyzeRepo } from './lib/analyze-repo.mjs'
import { analyzeVercel } from './lib/analyze-vercel.mjs'
import { inspectBundle } from './inspect-worker-bundle.mjs'
import { buildReportHtml, openFile } from './lib/build-report.mjs'

const args = process.argv.slice(2)
const opt = n => args.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3)
const out = opt('out')
if (!out || (!opt('repo') && !args.includes('--vercel') && !opt('bundle'))) {
  console.error('Usage: node make-report.mjs --out=report.html [--repo=<dir>] [--vercel [--project=<name>]] [--bundle=<dir>] [--summary=overview.md] [--lang=en|vi] [--open]')
  process.exit(2)
}
const lang = opt('lang') === 'vi' ? 'vi' : 'en'

const repo = opt('repo') ? analyzeRepo(resolve(opt('repo'))) : null
let vercel = null, vercelError = null
if (args.includes('--vercel')) {
  try {
    vercel = await analyzeVercel({ project: opt('project'), team: opt('team'), days: opt('days'), calibration: opt('calibration') ? JSON.parse(readFileSync(opt('calibration'), 'utf8')) : null })
  } catch (e) { vercelError = e.message }
}
const bundle = opt('bundle') ? inspectBundle(resolve(opt('bundle'))) : null
const summaryMd = opt('summary') ? readFileSync(opt('summary'), 'utf8') : undefined

mkdirSync(dirname(resolve(out)), { recursive: true })
writeFileSync(out, buildReportHtml({ repo, vercel, vercelError, bundle, summaryMd, lang, title: opt('title') }))
console.log(`Report: ${resolve(out)}`)
if (args.includes('--open')) openFile(resolve(out))
