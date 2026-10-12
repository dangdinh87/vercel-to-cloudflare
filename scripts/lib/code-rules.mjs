// Line-level rules evaluated with context: a rule scoped 'runtime' only matters when the file
// is reachable from a request-time entry; build-only hits are downgraded to INFO.
// effort = [minHours, maxHours] per affected file, calibrated on hands-on OpenNext migrations.

export const RULES = [
  { id: 'subprocess', sev: 'P1', scope: 'runtime', effort: [4, 16], re: /from\s+['"](node:)?(child_process|worker_threads|cluster)['"]|require\(\s*['"](node:)?(child_process|worker_threads|cluster)['"]/,
    msg: 'No subprocesses/threads on Workers: importing works (nodejs_compat stub), calling throws. If this runs on a request path, move it to an external service, Queue consumer or build step.' },
  { id: 'code-from-string', sev: 'P1', scope: 'runtime', effort: [1, 4], re: /\bnew\s+Function\s*\(|(^|[^\w.])eval\s*\(/,
    msg: 'Workers forbid eval/new Function. Precompile templates or swap the library.' },
  { id: 'fs', sev: 'P1', scope: 'runtime', effort: [1, 3], re: /from\s+['"](node:)?fs(\/promises)?['"]|require\(\s*['"](node:)?fs['"]\s*\)/,
    msg: 'No project filesystem at request time. Make the route build-time (generateStaticParams + dynamicParams=false, no revalidate), fetch a static asset, import JSON, or use DB/R2.' },
  { id: 'process-cwd', sev: 'P1', scope: 'runtime', effort: [0.5, 2], re: /process\.cwd\(\)/,
    msg: 'process.cwd() paths do not exist on Workers.' },
  { id: 'dirname', sev: 'P2', scope: 'runtime', effort: [0.5, 1], re: /\b__dirname\b|\b__filename\b|import\.meta\.dirname/,
    msg: '__dirname-based file paths do not resolve to project files on Workers.' },
  { id: 'dns', sev: 'P1', scope: 'runtime', effort: [1, 2], re: /from\s+['"](node:)?dns(\/promises)?['"]/,
    msg: 'node:dns is not reliable on Workers. Skip the lookup there (global_fetch_strictly_public blocks private IPs) or use DoH.' },
  { id: 'raw-socket', sev: 'P1', scope: 'runtime', effort: [2, 6], re: /from\s+['"](node:)?(net|tls|dgram|http2)['"]/,
    msg: 'Raw TCP/UDP: only outbound TCP via cloudflare:sockets. Prefer an HTTP API.' },
  { id: 'ws-headers', sev: 'P1', scope: 'runtime', effort: [1, 3], re: /new\s+WebSocket\([^)]*headers/,
    msg: 'WebSocket with headers is undici-only. On Workers: fetch(url, { headers: { Upgrade: "websocket" } }) → res.webSocket.accept().' },
  { id: 'edge-runtime', sev: 'P1', scope: 'any', effort: [0.25, 0.5], re: /export\s+const\s+runtime\s*=\s*['"](edge|experimental-edge)['"]/,
    msg: 'OpenNext Cloudflare targets the Node.js runtime; remove `runtime = "edge"` (everything runs on workerd anyway).' },
  { id: 'heavy-node-lib', sev: 'P2', scope: 'runtime', effort: [0.5, 2], re: /^import\s+[^'"]*from\s+['"](web-push|@aws-sdk\/[\w-]+|aws-sdk|nodemailer|jsdom|googleapis|firebase-admin(\/[\w-]+)?|@google-cloud\/[\w-]+)['"]/,
    msg: 'Heavy Node lib imported eagerly: a load failure 500s the whole route and it inflates every isolate. Lazy `await import()` or use an HTTP API / binding.' },
  { id: 'tcp-pool', sev: 'P2', scope: 'runtime', effort: [2, 6], re: /new\s+(Pool|Client)\s*\(|\bcreatePool\s*\(|mongoose\.connect\s*\(|new\s+(Redis|IORedis)\s*\(/,
    msg: 'TCP DB/Redis client: sockets cannot be reused across requests on Workers. Use Hyperdrive, an HTTP driver (Neon serverless, Upstash) or per-request clients.' },
  { id: 's-maxage', sev: 'P2', scope: 'runtime', effort: [0.5, 1], re: /s-maxage/,
    msg: 's-maxage on a Worker response is not cached at the edge. Use `export const revalidate = N` (ISR in R2); split guest vs personal routes.' },
  { id: 'xff', sev: 'P2', scope: 'runtime', effort: [0.5, 1], re: /x-forwarded-for/i,
    msg: 'First x-forwarded-for entry is client-controlled behind Cloudflare. Prefer cf-connecting-ip on Workers.' },
  { id: 'vercel-headers-env', sev: 'P2', scope: 'runtime', effort: [0.25, 1], re: /x-vercel-|process\.env\.VERCEL(_URL|_ENV|_REGION|_GIT_\w+)?\b/,
    msg: 'Vercel-only headers/env (geo, VERCEL_URL, VERCEL_ENV) are absent on Workers. Use request.cf / cf-ipcountry and your own env.' },
  { id: 'vercel-pkg', sev: 'P2', scope: 'any', effort: [0.25, 2], re: /from\s+['"]@vercel\/(analytics|speed-insights|kv|postgres|blob|functions|edge-config|global-config|og)[^'"]*['"]/,
    msg: 'Vercel-specific package. Replace (GA, next/og, R2/KV, after()) or remove.' },
  { id: 'long-timeout', sev: 'P2', scope: 'runtime', effort: [0.5, 2], test: line => {
      const m = line.match(/\b[A-Z_]*(TIMEOUT|DEADLINE|BUDGET)[A-Z_]*\s*=\s*([\d_]+)/)
      return m && Number(m[2].replace(/_/g, '')) >= 25_000
    },
    msg: 'Timeout ≥ 25 s: work inside after()/waitUntil is cut 30 s after the response; a silent request > ~100 s can 524 through the CF proxy.' },
  { id: 'og-runtime', sev: 'P2', scope: 'runtime', effort: [1, 3], re: /new\s+ImageResponse\s*\(/,
    msg: 'ImageResponse rendered at request time: resvg/yoga WASM is CPU-heavy on Workers and font/icon reads via fs fail. Prefer build-time OG (dynamicParams=false).' },
  { id: 'max-duration', sev: 'P3', scope: 'any', effort: [0, 0.5], re: /export\s+const\s+maxDuration/,
    msg: 'maxDuration is ignored on Workers (CPU limit via limits.cpu_ms; wall time unlimited while the client is connected).' },
  { id: 'after-waituntil', sev: 'P3', scope: 'runtime', effort: [0, 0.5], re: /\bafter\(|\bwaitUntil\(/,
    msg: 'Background work must finish < 30 s after the response on Workers.' },
  { id: 'fire-and-forget', sev: 'P3', scope: 'runtime', effort: [0, 0.5], re: /^\s*void\s+[\w.]+\(/,
    msg: 'Un-awaited promise can be cancelled when the response closes. Wrap in after().' },
  { id: 'module-env', sev: 'P3', scope: 'runtime', effort: [0, 0.5], re: /^(export\s+)?const\s+\w+\s*=\s*process\.env\./,
    msg: 'Env read at module load — verify the feature on the trial Worker (env injection order).' },
  { id: 'module-timer', sev: 'P3', scope: 'runtime', effort: [0, 0.5], re: /^(setInterval|setTimeout)\s*\(/,
    msg: 'Module-scope timer: does not fire reliably between requests on Workers. Do cleanup lazily on access.' },
]

const WORKERS_GUARD = /Cloudflare-Workers|isCloudflareWorkers\s*\(|getCloudflareContext\s*\(/
const GUARDABLE = new Set(['fs', 'process-cwd', 'dns', 'raw-socket', 'ws-headers', 'dirname', 'tcp-pool'])

/** Config requirements implied by code (not problems): which OpenNext overrides to enable. */
export const REQUIREMENT_PATTERNS = [
  { id: 'tag-cache', re: /\brevalidate(Tag|Path)\s*\(/, need: 'D1 tag cache (d1NextTagCache) — on-demand revalidation' },
  { id: 'data-cache', re: /\bunstable_cache\s*\(|['"]use cache['"]|next:\s*\{\s*revalidate/, need: 'R2 incremental cache — unstable_cache / use cache / fetch revalidate' },
]

/**
 * Evaluate rules on one file. ctx = { runtime: bool, buildOnly: bool, isEntry: bool }.
 * Returns findings with sev possibly downgraded to 'INFO'.
 */
export function applyRules(rel, code, ctx) {
  const out = []
  const lines = code.split('\n')
  for (const rule of RULES) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const hit = rule.test ? rule.test(line) : rule.re.test(line)
      if (!hit) continue
      let sev = rule.sev
      let note
      if (rule.id === 'xff' && /cf-connecting-ip/.test(code)) { sev = 'INFO'; note = 'cf-connecting-ip already preferred' }
      else if (GUARDABLE.has(rule.id) && WORKERS_GUARD.test(code)) { sev = 'P3'; note = 'file branches on the Workers runtime — verify that branch avoids this' }
      if (rule.scope === 'runtime' && !ctx.runtime) {
        if (!ctx.buildOnly) continue
        sev = 'INFO'
        note = 'build-time only — OK'
      }
      out.push({ rule: rule.id, sev, file: rel, line: i + 1, msg: rule.msg, effort: rule.effort, note })
    }
  }
  return out
}
