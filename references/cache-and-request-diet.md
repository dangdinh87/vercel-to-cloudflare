# Cache + request diet

On Workers every dynamic request costs CPU (and wakes the DB). On Vercel many were absorbed by the CDN via `s-maxage`. Fix before cutover — these also cut DB compute on scale-to-zero databases, which never sleep if something hits them every few minutes.

## 1. Count dynamic requests per page view first

Chrome DevTools on prod as a guest, filter Fetch/XHR + document. A typical guest page view: `/api/auth/session` (sometimes twice), a banner/config API, a widget API, + per-page APIs.

## 2. Guest session short-circuit (JWT strategy)

```ts
// app/api/auth/[...nextauth]/route.ts
export const { POST } = handlers
export function GET(req: NextRequest) {
  if (req.nextUrl.pathname.endsWith('/session') &&
      !req.cookies.getAll().some(c => c.name.includes('authjs.session-token'))) {
    return Response.json(null, { headers: { 'Cache-Control': 'private, no-cache, no-store' } })
  }
  return handlers.GET(req)
}
```
Must return `null`, not `{}` (client treats `{}` as signed in).
Some next-auth v5 betas request the session twice per page view (BroadcastChannel echo in `getSession`). Check the Network tab; if doubled, patch next-auth (`pnpm patch`) so the tab that fetched does not re-trigger itself.

## 3. `s-maxage` → ISR route handlers

Split personalised vs guest:
```
/api/banner             export const revalidate = 3600   (guest, identical for everyone)
/api/banner/me           no-store                          (signed in)
/api/daily/guest         export const revalidate = 3600
```
Route-handler ISR is stored in R2 and served via cache interception (no Next boot). Query params break ISR — use separate paths, not `?anon=1`.

## 4. Pick revalidate by how fresh it must be (small site defaults)

| Content | revalidate |
|---|---|
| sitemap, llms.txt, search index | 86400 |
| option lists, rarely edited catalogs | 21600 |
| feeds, public profiles, banners, guest widgets | 3600 |
| content changed by admin | on-demand `revalidateTag`/`revalidatePath` (D1 tag cache) |
Small sites rarely need fresher data — confirm acceptable staleness with the user.

## 5. Client polling + timers

- Status polling (payments, background jobs): start fast, back off (e.g. a few seconds → 10 s+), cap the total time, pause when `document.hidden`, re-check on `visibilitychange`.
- Notification refetch on tab return: ≥ 10 min.
- Per-user background "check" endpoints: every few hours, not on every page.
- Delete no-op endpoints still called by the client.
- Cron: run campaigns a few times/day, not hourly (each run wakes the DB).

## 6. Server-side in-memory caches

Per-isolate TTL cache for immutable-ish rows fetched by id (1 h, size cap) and throttles (`lastSeen` 5 min). Correctness must never depend on a hit.

## 7. DB compute (scale-to-zero databases, e.g. Neon free tier)

- Set autoscaling max to 0.25 CU (2 CU costs 8× per hour awake).
- Goal: ≥ 5 quiet minutes so compute suspends. Anything polling < 5 min (cron, CDN TTL 2 min, ISR 5 min) keeps it awake all day.
