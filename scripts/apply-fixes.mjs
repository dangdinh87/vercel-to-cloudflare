#!/usr/bin/env node
// Apply the automatable Workers-readiness fixes to a repo. DRY-RUN by default (prints a diff).
//   --write                 actually edit files (never commits, never pushes, never installs)
//   --accept=a,b            also apply trade-off fixes: inline-css-off, images-unoptimized, longer-revalidate
//   --only=a,b              limit to these fix ids
//   --allow-dirty           edit files that already have uncommitted changes
// Usage: node apply-fixes.mjs <repo> [--write] [--accept=…] [--only=…] [--json]
// Everything else becomes a manual checklist with the pattern to use.
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { analyzeRepo } from './lib/analyze-repo.mjs'
import { FIXES, MANUAL_HINTS, diskReader } from './lib/codemods.mjs'

const args = process.argv.slice(2)
const opt = n => args.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3)
const repoArg = args.find(a => !a.startsWith('--'))
if (!repoArg) { console.error('Usage: node apply-fixes.mjs <repo> [--write] [--accept=inline-css-off,images-unoptimized,longer-revalidate] [--only=…]'); process.exit(2) }
const root = resolve(repoArg)
const write = args.includes('--write')
const accept = new Set(opt('accept')?.split(',') ?? [])
const only = opt('only') ? new Set(opt('only').split(',')) : null

const model = analyzeRepo(root)
const chosen = FIXES.filter(f => (!only || only.has(f.id)) && (f.kind === 'safe' || accept.has(f.id)))
const disk = diskReader(root)
const skippedTradeoffs = FIXES.filter(f => f.kind === 'tradeoff' && !accept.has(f.id) && f.plan(root, model, disk).length)
// Fixes run in order on an in-memory overlay, so two fixes touching next.config.ts compose
// instead of the second overwriting the first. Files are written once, at the end.
const overlay = new Map()
const io = rel => (overlay.has(rel) ? overlay.get(rel) : disk(rel))
const plans = []
for (const f of chosen) {
  const edits = f.plan(root, model, io)
  for (const e of edits) overlay.set(e.file, e.create ?? e.after)
  if (edits.length) plans.push({ fix: f, edits })
}

// Refuse to touch files with uncommitted changes (they may hold someone's work in progress).
const dirty = new Set((spawnSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' }).stdout ?? '')
  .split('\n').filter(Boolean).map(l => l.slice(3).replace(/^"|"$/g, '')))
const blocked = plans.flatMap(p => p.edits.filter(e => !e.create && dirty.has(e.file)).map(e => e.file))
if (write && blocked.length && !args.includes('--allow-dirty')) {
  console.error(`These files have uncommitted changes — commit/stash them or pass --allow-dirty:\n  ${blocked.join('\n  ')}`)
  process.exit(1)
}

function diff(file, before, after) {
  const dir = mkdtempSync(join(tmpdir(), 'cf-fix-'))
  try {
    writeFileSync(join(dir, 'a'), before ?? '')
    writeFileSync(join(dir, 'b'), after)
    const out = spawnSync('git', ['diff', '--no-index', '--no-color', '-U2', 'a', 'b'], { cwd: dir, encoding: 'utf8' }).stdout ?? ''
    return out.replace(/^diff --git.*\n(index.*\n)?(new file mode.*\n)?/m, '')
      .replace(/^--- (a\/)?a$/m, before ? `--- ${file}` : '--- /dev/null').replace(/^\+\+\+ (b\/)?b$/m, `+++ ${file}`)
  } finally { rmSync(dir, { recursive: true }) }
}

const applied = []
for (const { fix, edits } of plans) {
  console.log(`\n■ ${fix.id} (${fix.kind}) — ${fix.title}`)
  for (const e of edits) {
    console.log(diff(e.file, e.create ? '' : e.before, e.create ?? e.after))
    applied.push({ fix: fix.id, file: e.file, created: Boolean(e.create) })
  }
}

if (write) for (const [file, content] of overlay) {
  mkdirSync(dirname(join(root, file)), { recursive: true })
  writeFileSync(join(root, file), content)
}

const autoRules = new Set(['edge-runtime', 'inline-css', 'image-optimization', 'short-revalidate'])
// Findings an applied fix already resolves don't belong on the manual list.
if (applied.some(a => a.fix === 'session-short-circuit')) autoRules.add('session-per-view')
const resolved = f => autoRules.has(f.rule) || (autoRules.has('session-per-view') && f.rule === 'per-view-dynamic-api' && /\/api\/auth\/session/.test(f.msg))
const manual = model.findings
  .filter(f => (f.sev === 'P0' || f.sev === 'P1' || f.sev === 'P2') && !resolved(f) && !f.rule.startsWith('dep:'))
  .map(f => ({ rule: f.rule, sev: f.sev, where: `${f.file}${f.lines?.[0] ? `:${f.lines[0]}` : ''}`, how: MANUAL_HINTS[f.rule] ?? f.msg }))
const deps = model.findings.filter(f => f.rule.startsWith('dep:') && f.sev !== 'INFO').map(f => ({ pkg: f.pkg, how: f.msg }))

if (args.includes('--json')) console.log(JSON.stringify({ write, applied, skippedTradeoffs: skippedTradeoffs.map(f => f.id), manual, deps }, null, 2))
console.log(`\n${write ? 'Applied' : 'Would apply (dry run — add --write)'}: ${applied.length} edit(s) in ${new Set(applied.map(a => a.file)).size} file(s).`)
if (skippedTradeoffs.length) console.log(`Trade-off fixes available (need --accept=): ${skippedTradeoffs.map(f => `${f.id} — ${f.title}`).join('\n  ')}`)
if (applied.some(a => a.fix === 'opennext-scaffold')) console.log(`Install (updates the lockfile — run yourself): ${model.facts.pm} add -D @opennextjs/cloudflare wrangler`)
if (manual.length) {
  console.log(`\nManual checklist (${manual.length}):`)
  for (const m of manual.slice(0, 40)) console.log(`  [${m.sev}] ${m.rule} ${m.where} → ${m.how}`)
}
if (deps.length) console.log(`\nDependencies to review: ${deps.map(d => `${d.pkg} (${d.how})`).join('; ')}`)
console.log('\nNext: typecheck + tests + build on Vercel first (the fixes must keep Vercel working). Nothing was committed.')
