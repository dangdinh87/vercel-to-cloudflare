// Readiness score, effort range and verdict. Weights/efforts calibrated on hands-on OpenNext migrations.

const WEIGHT = { P0: 15, P1: 5, P2: 1, P3: 0.2, INFO: 0 }
// Penalty counts at most this many files per rule: one bad pattern repeated is one fix.
const PENALTY_FILES = { P0: 3, P1: 3, P2: 3, P3: 3, INFO: 0 }
const MAX_FILES_PER_RULE = 6 // past this, one shared helper usually fixes the rest
const FIXED_PHASES = [
  { name: 'Trial deploy (worktree, OpenNext, R2/D1/DO, measure)', effort: [4, 8] },
  { name: 'Staging with real DB + secrets, smoke money/auth paths', effort: [6, 10] },
  { name: 'CI deploy + DNS move + domain + placement', effort: [6, 10] },
]

export function score(model) {
  const byRule = new Map()
  for (const f of model.findings) {
    if (f.sev === 'INFO') continue
    const list = byRule.get(f.rule) ?? []
    list.push(f)
    byRule.set(f.rule, list)
  }
  let penalty = 0
  const effort = [0, 0]
  const perRule = []
  for (const [rule, list] of byRule) {
    const counted = list.slice(0, MAX_FILES_PER_RULE)
    const p = list.slice(0, PENALTY_FILES[list[0].sev]).reduce((s, f) => s + WEIGHT[f.sev], 0)
    const e = counted.reduce((acc, f) => [acc[0] + (f.effort?.[0] ?? 0), acc[1] + (f.effort?.[1] ?? 0)], [0, 0])
    penalty += p
    effort[0] += e[0]; effort[1] += e[1]
    perRule.push({ rule, sev: list[0].sev, files: list.length, effort: e })
  }
  for (const ph of FIXED_PHASES) { effort[0] += ph.effort[0]; effort[1] += ph.effort[1] }

  const counts = { P0: 0, P1: 0, P2: 0, P3: 0, INFO: 0 }
  for (const f of model.findings) counts[f.sev]++
  const hardBlockers = model.findings.filter(f => f.sev === 'P0' && (f.rule === 'dep:blocker' || f.rule === 'dep:native'))
  const verdict = hardBlockers.length
    ? 'NO-GO until blockers are replaced'
    : counts.P0 + counts.P1 > 0 ? 'GO after fixes' : 'GO'

  return {
    readiness: Math.max(0, Math.round(100 - penalty)),
    verdict,
    counts,
    effortHours: effort.map(h => Math.round(h)),
    perRule: perRule.sort((a, b) => WEIGHT[b.sev] - WEIGHT[a.sev] || b.files - a.files),
    fixedPhases: FIXED_PHASES,
    hardBlockers: hardBlockers.map(f => f.pkg ?? f.file),
  }
}
