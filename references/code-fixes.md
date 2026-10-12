# Cross-platform code fixes (phase 2)

Every fix must keep Vercel working. Detect runtime, don't fork the codebase.

## Runtime detection

```ts
// src/shared/lib/runtime-platform.ts
export function isCloudflareWorkers(): boolean {
  return typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers'
}
```

## Client IP (rate limiting)

```ts
export function getClientIp(req: Request): string {
  if (isCloudflareWorkers()) {
    const cfIp = req.headers.get('cf-connecting-ip')?.trim()
    if (cfIp) return cfIp // on Vercel this header would be client-controlled
  }
  const xff = req.headers.get('x-forwarded-for')
  if (xff) return xff.split(',')[0]!.trim()
  return req.headers.get('x-real-ip')?.trim() ?? 'unknown'
}
```
In-memory limiters are per-isolate: fine as a speed bump, never the only guard on money/AI paths (keep DB quotas).

## node:dns in SSRF guards

On Workers skip the DNS lookup; keep the literal-IP / `localhost` / `.internal` checks. `global_fetch_strictly_public` blocks private ranges at runtime.

## WebSocket with headers

```ts
if (isCloudflareWorkers()) {
  const res = await fetch(url.replace(/^wss:/, 'https:'), { headers: { ...headers, Upgrade: 'websocket' } })
  const ws = (res as Response & { webSocket?: (WebSocket & { accept(): void }) | null }).webSocket
  if (!ws) throw new Error(`upgrade failed (${res.status})`)
  ws.accept()
  return ws
}
```
Caveat: some third-party WebSocket services block Cloudflare egress IPs intermittently — keep a fallback provider.

## Heavy Node libs → lazy import

```ts
type WebPush = typeof import('web-push')
let wp: Promise<WebPush> | null = null
const loadWebPush = () => (wp ??= import('web-push').then(m => (m.default ?? m) as WebPush))
```
A load failure then only breaks the feature, not the route (critical for payment webhooks).

## Respond first, side effects later

- Payment webhook: record payment → return 200 → `after(() => notify(...))` (email, push, chat notifications).
- Fire-and-forget writes (last-seen, analytics): `after(() => touchLastSeen(id))` — plain `void promise` may be cancelled.
- Everything in `after()` must finish < 30 s: give each external call `timeoutMs = deadline - elapsed`, total ≤ ~20 s.

## Filesystem

- OG images reading fonts/icons with `fs`: make them build-time only — `export const dynamicParams = false` + `generateStaticParams`, no `revalidate`; avoid `unstable_cache` inside (it makes the route ISR). Add a test that asserts every `opengraph-image` file exports `dynamicParams = false`.
- Data snapshots read with `fs` at runtime → DB query or `import` JSON (watch bundle) or `fetch` static asset.

## Big data out of the bundle

Pattern for a large content dataset (several MB of JSON/TS data):
- A build script emits a light index (ids/titles, no bodies) for server pages, plus content-hashed `public/<dir>/*.json` files for data anyone may read (immutable caching).
- Client hook loads category files on demand, module-level promise cache.
- Data that needs a login or payment stays behind an API that checks access server-side; add a test that none of it leaks into `public/`.
- Gitignore generated `public/` files; generate in `postinstall`/`prebuild`; `--check` mode in CI.

## Small ones

- `next/image` for local SVG/icons → `unoptimized`.
- `vercel.json` redirects/crons → `next.config` redirects; GitHub Actions cron hitting the domain.
- Redirect pages under a root `loading.tsx` become 200 + meta refresh → use a route handler returning a real 308, or `next.config` redirects.
- Hide dev/preview pages in prod via redirect gated on `NODE_ENV === 'production'` and an opt-in env flag.
- Remove `@vercel/analytics` if GA exists.
