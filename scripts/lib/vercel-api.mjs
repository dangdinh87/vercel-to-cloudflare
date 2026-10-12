// Read-only Vercel REST client. Token: VERCEL_TOKEN, else the Vercel CLI login file.
// Never print or persist the token.
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function findToken() {
  if (process.env.VERCEL_TOKEN) return { token: process.env.VERCEL_TOKEN, source: 'VERCEL_TOKEN env' }
  const h = homedir()
  const candidates = [
    join(h, 'Library/Application Support/com.vercel.cli/auth.json'), // macOS
    join(process.env.XDG_DATA_HOME ?? join(h, '.local/share'), 'com.vercel.cli/auth.json'), // Linux
    join(process.env.APPDATA ?? join(h, 'AppData/Roaming'), 'com.vercel.cli/Data/auth.json'), // Windows
    join(h, '.vercel/auth.json'), // legacy
  ]
  for (const file of candidates) {
    if (!existsSync(file)) continue
    try {
      const token = JSON.parse(readFileSync(file, 'utf8')).token
      if (token) return { token, source: 'Vercel CLI login' }
    } catch { /* unreadable → try next */ }
  }
  return null
}

// Read-only GETs are memoised per process: a multi-app scan asks for the same charges/projects
// several times (charges for a month are several MB).
const memo = new Map()

export function createVercelClient(token) {
  async function request(path, params = {}, { text = false } = {}) {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '').map(([k, v]) => [k, String(v)]))
    const url = `https://api.vercel.com${path}?${qs}`
    if (!memo.has(url)) {
      memo.set(url, (async () => {
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
        const body = await res.text()
        if (!res.ok) throw new Error(`Vercel API ${res.status} ${path}: ${body.slice(0, 200)}`)
        return body
      })())
    }
    try {
      const body = await memo.get(url)
      return text ? body : JSON.parse(body)
    } catch (e) {
      memo.delete(url)
      throw e
    }
  }

  /** Follow `pagination.next` → `until`. */
  async function paginate(path, params, key, max = 20) {
    const out = []
    let until
    for (let i = 0; i < max; i++) {
      const page = await request(path, { ...params, until })
      out.push(...(page[key] ?? []))
      until = page.pagination?.next
      if (!until) break
    }
    return out
  }

  return {
    user: () => request('/v2/user').then(r => r.user),
    teams: () => request('/v2/teams').then(r => r.teams ?? []),
    projects: teamId => paginate('/v9/projects', { teamId, limit: 100 }, 'projects'),
    /** FOCUS-format JSONL, one row per day × service × project × region. */
    charges: (teamId, from, to) => request('/v1/billing/charges', { teamId, from, to }, { text: true }),
    deployments: (teamId, projectId, since) => paginate('/v6/deployments', { teamId, projectId, since, limit: 100 }, 'deployments', 10),
  }
}
