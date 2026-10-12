# Staging, cutover, cleanup (phases 4–5)

## Staging (real DB + secrets)

- Worker `<app>-staging`; DB = a separate database branch (or a read-only role). Secrets: `wrangler secret put NAME` one by one; list required env by grepping `process.env.` and checking each route fails closed when missing.
- Smoke every money/auth path, not just pages:
  - OAuth login end-to-end (callback URL must be added to the provider for the staging host).
  - Payment webhook with test key + fake order → 200 and entitlement granted.
  - AI streaming (SSE) + `after()` persistence when client disconnects.
  - File upload/parse at max size (RAM 128 MB), several in parallel.
  - `revalidateTag`/`revalidatePath` via the real internal routes → page refreshes (D1 `revalidations` table gets rows).
  - Push notifications, email, chat/ops notifications.
- Load: 10–30 concurrent × several rounds → **0 × 5xx** is the gate.

## CI deploy

GitHub Actions on push to `main`: install → build (needs build-time DB/env as secrets) → `opennextjs-cloudflare deploy` with `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`. Disable Vercel auto-deploy only after cutover. Keep the test gate in the build (tests must be hermetic).

## DNS move

1. Lower TTL a day before.
2. Export every record from the current DNS: MX and inbound-mail records, SPF, DKIM (`<provider>._domainkey`), DMARC, BIMI, CAA, subdomains (admin, api…), verification TXT (search console, ad/analytics tools).
3. Recreate on Cloudflare, compare with `dig +short <name> <type> @<cf-ns>` for each before switching nameservers.
4. Attach custom domain to the Worker (`routes` / Custom Domains). Keep webhook URLs on the same domain so payment provider config doesn't change.
5. `placement: { region: 'aws:<db-region>' }` in wrangler.jsonc.

## Rollback

Point DNS back to Vercel; the old deployment keeps running. Don't delete the Vercel project for ≥ 2 weeks.

## Watch (2 weeks)

`wrangler tail` / Workers observability: 5xx, `exceededCpu`, `exceededMemory`, exceptions. Search Console coverage. Compare DAU-type counters with the Vercel period (fire-and-forget writes being cancelled shows up here). DB compute usage.

## Cleanup (ask before deleting)

- `wrangler delete <app>-trial` — a public trial on workers.dev is a duplicate site that can get indexed.
- `wrangler r2 bucket delete <app>-trial-next-cache`, `wrangler d1 delete <app>-trial-tag-cache`.
- `git worktree remove .claude/worktrees/cf-trial && git branch -D spike/cloudflare-trial`.
- Downgrade/cancel Vercel plan only after the 2-week window.
