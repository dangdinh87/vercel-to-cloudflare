// Packaging checks that run anywhere (CI without the Claude CLI): SKILL.md frontmatter rules from
// Anthropic's skill authoring guide, plugin/marketplace manifests, and reference link depth.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync } from 'node:fs'

const root = new URL('../../', import.meta.url)
const read = rel => readFileSync(new URL(rel, root), 'utf8')

test('SKILL.md frontmatter follows the authoring rules', () => {
  const md = read('SKILL.md')
  const fm = md.match(/^---\n([\s\S]*?)\n---\n/)?.[1]
  assert.ok(fm, 'frontmatter present')
  const name = fm.match(/^name:\s*(.+)$/m)?.[1].trim()
  const description = fm.match(/^description:\s*(.+)$/m)?.[1].trim()
  assert.match(name, /^[a-z0-9-]{1,64}$/, 'name: lowercase letters, digits, hyphens, ≤ 64 chars')
  assert.ok(!/anthropic|claude/.test(name), 'name avoids reserved words')
  assert.ok(description && description.length <= 1024, 'description ≤ 1024 chars')
  assert.ok(!/<[a-z]/i.test(description), 'description has no XML tags')
  assert.match(description, /^[A-Z][a-z]+s\b/, 'description starts in third person ("Cuts…")')
  assert.match(description, /Use when/, 'description says when to use it')
  const body = md.slice(md.indexOf('\n---\n', 4) + 5)
  assert.ok(body.split('\n').length < 500, 'SKILL.md body < 500 lines')
  // The skill loader substitutes $1, $2… with user arguments.
  assert.equal(md.match(/\$\d/g), null, 'no $<digit> in SKILL.md')
})

test('every reference linked from SKILL.md exists and stays one level deep', () => {
  const md = read('SKILL.md')
  const links = [...md.matchAll(/\]\((references\/[^)]+\.md)\)/g)].map(m => m[1])
  assert.ok(links.length >= 5)
  for (const l of links) assert.ok(existsSync(new URL(l, root)), `${l} exists`)
  for (const f of readdirSync(new URL('references/', root))) {
    const text = read(`references/${f}`)
    assert.ok(text.split('\n').length <= 120, `${f} is short enough to read whole`)
  }
})

test('plugin and marketplace manifests agree', () => {
  const plugin = JSON.parse(read('.claude-plugin/plugin.json'))
  const market = JSON.parse(read('.claude-plugin/marketplace.json'))
  const skillName = read('SKILL.md').match(/^name:\s*(.+)$/m)[1].trim()
  assert.equal(plugin.name, skillName)
  assert.match(plugin.version, /^\d+\.\d+\.\d+$/)
  assert.equal(plugin.license, 'MIT')
  assert.ok(market.name && market.owner?.name)
  const entry = market.plugins.find(p => p.name === plugin.name)
  assert.ok(entry, 'marketplace lists the plugin under the same name')
  assert.equal(entry.source, './')
})

test('eval cases each have a prompt and at least one grader', () => {
  const dir = new URL('evals/', root)
  const cases = readdirSync(dir).filter(n => !n.startsWith('_') && n !== 'results')
  assert.ok(cases.length >= 3, 'at least three evaluations')
  for (const c of cases) {
    assert.ok(existsSync(new URL(`evals/${c}/prompt.md`, root)), `${c}/prompt.md`)
    assert.ok(readdirSync(new URL(`evals/${c}/graders/`, root)).some(f => f.endsWith('.md')), `${c} has graders`)
  }
})
