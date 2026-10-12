// Known npm packages vs Cloudflare Workers (nodejs_compat). `verified` = proven on a real Workers deploy
// trial Worker (Oct 2026); everything else is general knowledge → confirm on a trial deploy.
// status: blocker (cannot run) | replace (works poorly / better alternative) | caveat (works with care) | ok

export const PACKAGES = {
  sharp: { status: 'blocker', fix: 'images.unoptimized or Cloudflare Images; never at request time', effort: [1, 4] },
  canvas: { status: 'blocker', fix: 'next/og (WASM) at build time or an external renderer', effort: [4, 12] },
  '@napi-rs/canvas': { status: 'blocker', fix: 'next/og at build time', effort: [4, 12] },
  'skia-canvas': { status: 'blocker', fix: 'next/og at build time', effort: [4, 12] },
  puppeteer: { status: 'blocker', fix: '@cloudflare/puppeteer (Browser Rendering binding)', effort: [4, 12] },
  'puppeteer-core': { status: 'blocker', fix: '@cloudflare/puppeteer', effort: [4, 12] },
  playwright: { status: 'blocker', fix: 'Browser Rendering or external service', effort: [4, 12] },
  '@sparticuz/chromium': { status: 'blocker', fix: 'Browser Rendering binding', effort: [4, 12] },
  bcrypt: { status: 'blocker', fix: 'bcryptjs (same hashes) or WebCrypto PBKDF2', effort: [0.5, 1] },
  argon2: { status: 'blocker', fix: 'hash-wasm argon2 or WebCrypto PBKDF2 (rehash on login)', effort: [2, 6] },
  'better-sqlite3': { status: 'blocker', fix: 'D1', effort: [8, 24] },
  sqlite3: { status: 'blocker', fix: 'D1', effort: [8, 24] },
  'socket.io': { status: 'blocker', fix: 'Durable Objects WebSockets', effort: [8, 24] },
  bullmq: { status: 'blocker', fix: 'Cloudflare Queues', effort: [6, 16] },
  'node-cron': { status: 'blocker', fix: 'Cron Triggers or GitHub Actions hitting an endpoint', effort: [1, 3] },
  cron: { status: 'blocker', fix: 'Cron Triggers', effort: [1, 3] },
  'pdf-parse': { status: 'replace', fix: 'unpdf (pdf-parse reads a test file via fs on import)', effort: [1, 2] },
  'aws-sdk': { status: 'replace', fix: 'R2 binding or aws4fetch (v2 SDK is huge)', effort: [2, 6] },
  '@aws-sdk/client-s3': { status: 'caveat', fix: 'works but heavy + SigV4 CPU; prefer R2 binding / aws4fetch', effort: [1, 3] },
  nodemailer: { status: 'replace', fix: 'HTTP email API (Resend, Postmark, SES HTTP)', effort: [1, 3] },
  ws: { status: 'replace', fix: 'native WebSocket / fetch Upgrade', effort: [1, 3] },
  formidable: { status: 'replace', fix: 'await request.formData()', effort: [0.5, 2] },
  multer: { status: 'replace', fix: 'await request.formData()', effort: [0.5, 2] },
  jsdom: { status: 'replace', fix: 'linkedom or HTMLRewriter', effort: [1, 4] },
  googleapis: { status: 'replace', fix: 'per-API @googleapis/* package or REST via fetch (bundle size)', effort: [1, 4] },
  'firebase-admin': { status: 'caveat', fix: 'gRPC parts fail; REST APIs or firebase-rest libs', effort: [2, 8] },
  '@vercel/kv': { status: 'replace', fix: '@upstash/redis or Workers KV', effort: [1, 3] },
  '@vercel/postgres': { status: 'replace', fix: '@neondatabase/serverless', effort: [1, 3] },
  '@vercel/analytics': { status: 'replace', fix: 'remove (only collects on Vercel) — GA / CF Web Analytics', effort: [0.25, 0.5] },
  '@vercel/speed-insights': { status: 'replace', fix: 'remove', effort: [0.25, 0.5] },
  '@vercel/og': { status: 'replace', fix: 'next/og', effort: [0.5, 1] },
  '@vercel/functions': { status: 'replace', fix: 'after() from next/server / getCloudflareContext().ctx', effort: [0.5, 2] },
  '@vercel/blob': { status: 'caveat', fix: 'HTTP API works anywhere; consider R2 to drop Vercel', effort: [0, 4] },
  '@sentry/nextjs': { status: 'caveat', fix: '@sentry/cloudflare for the Worker', effort: [1, 3] },
  pino: { status: 'caveat', fix: 'transports use worker threads; log to console', effort: [0.5, 1] },
  winston: { status: 'caveat', fix: 'file transports fail; console only', effort: [0.5, 1] },
  pg: { status: 'caveat', fix: 'works via nodejs_compat sockets; use Hyperdrive for pooling', effort: [1, 4] },
  mysql2: { status: 'caveat', fix: 'use with Hyperdrive', effort: [1, 4] },
  mongoose: { status: 'caveat', fix: 'TCP driver — verify on trial; connection per request', effort: [2, 8] },
  mongodb: { status: 'caveat', fix: 'TCP driver — verify on trial', effort: [2, 8] },
  ioredis: { status: 'replace', fix: '@upstash/redis (HTTP) or KV', effort: [1, 4] },
  redis: { status: 'replace', fix: '@upstash/redis (HTTP) or KV', effort: [1, 4] },
  prisma: { status: 'caveat', fix: 'driver adapter (@prisma/adapter-neon/pg/d1); watch bundle size', effort: [2, 6] },
  '@prisma/client': { status: 'caveat', fix: 'driver adapter required on Workers; watch bundle size', effort: [2, 6] },
  'web-push': { status: 'caveat', verified: true, fix: 'works with nodejs_compat (reference-app trial); lazy-import so a load failure only breaks push', effort: [0.5, 1] },
  unpdf: { status: 'ok', verified: true, fix: 'PDF parse verified on the trial Worker' },
  mammoth: { status: 'caveat', fix: 'pure JS but RAM-heavy on large DOCX (128 MB isolate) — test max size', effort: [0.5, 2] },
  '@neondatabase/serverless': { status: 'ok', verified: true, fix: 'HTTP driver — ideal on Workers' },
  '@upstash/redis': { status: 'ok', fix: 'HTTP' },
  'next-auth': { status: 'caveat', verified: true, fix: 'v5 works; short-circuit /api/auth/session without cookie (guest requests)', effort: [0.5, 2] },
  ai: { status: 'ok', verified: true, fix: 'fetch-based streaming works' },
  openai: { status: 'ok', fix: 'fetch-based' },
  stripe: { status: 'caveat', fix: 'use Stripe.createFetchHttpClient() + constructEventAsync for webhooks', effort: [0.5, 1] },
  jsonwebtoken: { status: 'caveat', fix: 'works with nodejs_compat; jose is lighter', effort: [0, 1] },
  '@react-pdf/renderer': { status: 'caveat', fix: 'heavy WASM/yoga; render at build or offload', effort: [2, 6] },
}

// Version-specific advice where one entry would mislead.
const SPECIAL = {
  'next-auth': v => (/^[\^~]?4\./.test(v) ? { msg: 'v4: runs on the Node.js runtime via nodejs_compat but is unverified on Workers — test sign-in/callback on the trial, or move to Auth.js v5 (verified)', verified: false } : null),
}

/**
 * deps: package.json dependencies; usage: Map pkg → 'runtime' | 'build' (from the import graph).
 * Returns findings for known packages that matter.
 */
export function checkDependencies(deps, usage) {
  const out = []
  for (const [name, version] of Object.entries(deps)) {
    const info = PACKAGES[name] ?? (name.startsWith('@aws-sdk/') ? PACKAGES['@aws-sdk/client-s3'] : null)
    if (!info || info.status === 'ok') continue
    const where = usage.get(name) ?? 'unused'
    const base = { blocker: 'P0', replace: 'P2', caveat: 'P3' }[info.status]
    const sev = where === 'runtime' ? base : 'INFO'
    const special = SPECIAL[name]?.(version)
    out.push({ rule: `dep:${info.status}`, sev, file: 'package.json', lines: [0], pkg: name, version, where, msg: info.fix, verified: Boolean(info.verified), effort: where === 'runtime' ? info.effort : [0, 0], ...(special ?? {}) })
  }
  return out
}

export function verifiedOkPackages(deps) {
  return Object.keys(deps).filter(n => PACKAGES[n]?.status === 'ok')
}
