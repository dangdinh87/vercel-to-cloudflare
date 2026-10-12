# Validation log (what the analyzer was checked against)

Re-run after changing rules; findings should stay the same unless the change is intended.
`git clone --depth 1` into a scratch dir and run `analyze-repo-for-workers.mjs <dir> --md=/dev/null`.

## Public repos (checked 2026-10-12)

| Repo (commit date) | Result | Notable true positives |
|---|---|---|
| vercel/commerce (2026-06) | 72, GO after fixes | `inlineCss: true` (P0); OG image reads a font with `fs` + `process.cwd()` at request time (P1); `ppr`/`useCache` flags |
| next-forge `apps/app` (2026-05, monorepo) | 96, GO | follows `@repo/*` workspace packages (35 app files → 83 analysed); `proxy.ts` (P2); `@sentry/nextjs` caveat |
| next-forge `apps/web` | 91, GO after fixes | `sitemap.ts` runs `fs.readdirSync("app")` at request time (P1) |
| shadcn-ui/taxonomy (2026-04, Next 13) | 87, GO after fixes | `runtime = "edge"` OG route (P1); `@vercel/og`, `@vercel/analytics`, Prisma, next-auth v4 caveats |
| vercel/nextjs-subscription-payments (2025-01) | 100, GO | Supabase + Stripe over HTTP; only Stripe fetch-client caveat |

False positives fixed during validation: `/api/...` literals in server files (third-party endpoints) counted as per-view calls; image-optimization warning without `next/image`; next-auth v4 given v5 advice; `useCache` flag missed.

## Broad corpus (2026-10-12): 33 Next.js apps in 18 public repos

cal.com, dub, documenso, formbricks, papermark, midday, umami, payload, novel, ai-chatbot (Vercel + Supabase variants), saas-starter, platforms, create-t3-app, next-forge, commerce, taxonomy, subscription-payments. All analysed in < 6 s each (largest: dub 3,864 files → 4,153 reachable incl. workspace packages).

True positives spot-checked: cal.com `sharp` imported at request time (NO-GO until replaced), OG `runtime=edge`, email templates read with `fs` at request time, SSRF guard on `node:dns`; dub 8 `runtime=edge` routes + DNS domain validation; papermark DNS validation + edge OG; midday MDX blog read with `fs` for unknown slugs; payload `child_process` imported directly + telemetry `fs` (needs config off on Workers).

Fixed during this pass: crash on a broken symlink (dub); library/storybook folders counted as apps; Payload's barrel `index.ts` made 54 CLI files look request-time (now P2 "reached only through a barrel", score 19 → 75); `child_process` import treated as P0 (it loads on workerd; calling fails → P1); 502 of 529 runtime packages unknown to the table → `package-probe.mjs` inspects them on disk; disk-size warnings dropped (icon packs are tree-shaken).

`apply-fixes.mjs` on copies of ai-chatbot and dub: 7 and 12 edits; two edits to next.config.ts compose; Auth.js re-export route rewritten correctly; second run = 0 edits.

## Behaviour evals (`claude plugin eval`, 2026-10-12, one run each)

- `readiness-report`: the skill triggers and the must-fix answer names inlineCss, request-time `fs` in the OG route and `runtime = 'edge'` (judge 3/3 PASS).
- `money-question`: 1.00 with a Sonnet judge. The answer warned that moving one app while keeping Pro costs more, treated internal company tools as commercial (so no Hobby), priced Workers per account plus usage, and listed trade-offs. A Haiku judge failed the same answer 3/3, so use `--judge-model sonnet`.
- Cases that grant Bash (`ran-analyzer`, `safe-fixes`) need a machine whose Docker credential store has no symlink inside, otherwise the eval sandbox refuses to grant Bash.

## Parser parity

The TypeScript-compiler parser and the regex fallback produce identical reachability, score and findings on large apps; TS parsing is about 2× slower.

## End-to-end machine scan

`scan-vercel-apps.mjs` on a developer machine with dozens of local Next.js apps (clones, worktrees, Next 9–16): every Vercel project with usage was matched to its main checkout via `.vercel/project.json` (clones/worktrees listed as copies). Bugs found and fixed: `$`-digit text in SKILL.md replaced by the loader's positional arguments; per-app Workers base fee (it is per account — now summed and priced once); "keep Pro for the rest" priced at list while "stay" used billed amounts.

## Known blind spots

- Calls behind > 2 helper levels stay `unknown` (listed, not flagged).
- Dynamic `import(variable)` and runtime-built paths are not followed.
- Folders named `data/`, `content/`, `fixtures/` are treated as data (size only).
- Pages Router: basic support (getServerSideProps/getStaticProps detection only).
