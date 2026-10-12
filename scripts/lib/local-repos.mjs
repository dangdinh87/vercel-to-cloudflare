// Find Next.js apps on this machine and match them to Vercel projects:
//  1. `.vercel/project.json` projectId (exact — written by `vercel link`)
//  2. git remote org/repo + Vercel rootDirectory (the project's linked GitHub repo)
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'

const SKIP = new Set(['node_modules', 'Library', 'Applications', 'Pictures', 'Music', 'Movies', '.Trash', '.git', '.next', '.open-next', '.vercel', 'dist', 'build', 'out', 'coverage'])

const git = (dir, ...args) => {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 5000 })
  return r.status === 0 ? r.stdout.trim() : null
}

/** 'git@github.com:Org/Repo.git' | 'https://github.com/org/repo' → 'org/repo' */
export function repoSlug(url) {
  const m = url?.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/)
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null
}

function readLink(dir) {
  const f = join(dir, '.vercel', 'project.json')
  if (!existsSync(f)) return null
  try { const j = JSON.parse(readFileSync(f, 'utf8')); return j.projectId ? j : null } catch { return null }
}

/** Every directory (≤ maxDepth) whose package.json depends on `next`. Dot-dirs are skipped. */
export function findLocalNextApps(roots = [homedir()], maxDepth = 5) {
  const apps = []
  const walk = (dir, depth) => {
    let names
    try { names = readdirSync(dir) } catch { return }
    if (names.includes('package.json')) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
        const next = pkg.dependencies?.next ?? pkg.devDependencies?.next
        // Libraries/configs depending on next (ui kits, storybook, eslint configs) are not apps.
        const isApp = ['app', 'src/app', 'pages', 'src/pages'].some(d => names.includes(d.split('/')[0]) && existsSync(join(dir, d)))
        if (next && isApp) apps.push(describe(dir, next))
      } catch { /* unreadable package.json */ }
    }
    if (depth >= maxDepth) return
    for (const n of names) {
      if (n.startsWith('.') || SKIP.has(n)) continue
      const p = join(dir, n)
      try { if (statSync(p).isDirectory()) walk(p, depth + 1) } catch { /* permission */ }
    }
  }
  for (const r of roots) walk(r, 0)
  return apps
}

function describe(dir, next) {
  const top = git(dir, 'rev-parse', '--show-toplevel')
  const gitDir = top && git(dir, 'rev-parse', '--git-dir')
  return {
    dir, next,
    gitRoot: top, subdir: top ? relative(top, dir).split('\\').join('/') : null,
    remote: top ? repoSlug(git(dir, 'remote', 'get-url', 'origin')) : null,
    lastCommit: top ? git(dir, 'log', '-1', '--format=%cs') : null,
    // linked worktrees keep their git dir under <main>/.git/worktrees/<name>
    isWorktree: Boolean(gitDir && /\.git[\\/]worktrees[\\/]/.test(gitDir)),
    link: readLink(dir) ?? (top ? readLink(top) : null),
  }
}

/** For each Vercel project: best local checkout + other copies + how it matched. */
export function matchProjects(projects, apps) {
  return projects.map(p => {
    const byLink = apps.filter(a => a.link?.projectId === p.id)
    const slug = p.link?.org && p.link?.repo ? `${p.link.org}/${p.link.repo}`.toLowerCase() : null
    const root = (p.rootDirectory ?? '').replace(/^\.?\/?|\/$/g, '')
    const byGit = slug ? apps.filter(a => a.remote === slug && (a.subdir ?? '') === root) : []
    const candidates = [...new Set([...byLink, ...byGit])]
    const rank = a => (a.isWorktree ? 0 : 2) + (a.link?.projectId === p.id ? 4 : 0)
    const sorted = candidates.sort((a, b) => rank(b) - rank(a) || String(b.lastCommit).localeCompare(String(a.lastCommit)))
    const best = sorted[0] ?? null
    return { project: p, local: best, copies: sorted.slice(1), how: !best ? null : best.link?.projectId === p.id ? 'vercel-link' : 'git-remote', repo: slug, rootDirectory: root }
  })
}
