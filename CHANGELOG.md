# Changelog

## 1.2.0 — 2026-10-12

- CI on every push: script tests plus format checks for `SKILL.md` (name, third-person description, length, no `$<digit>`), reference depth, plugin/marketplace manifests and eval cases.
- README preview image (report for the public vercel/commerce repo).
- Fix: a Markdown heading directly followed by a list rendered as one bold paragraph in reports.

## 1.1.0 — 2026-10-12

- Install as a Claude Code plugin: `/plugin marketplace add dangdinh87/vercel-to-cloudflare`.
- Eval suite for `claude plugin eval`: readiness report, safe fixes without committing, "is moving worth it?".
- Third-person skill description, a copyable progress checklist and request → action examples.

## 1.0.0 — 2026-10-12

- `scan-vercel-apps.mjs`: Vercel projects → local code → traffic / small / idle triage, index report with the bill and a savings plan.
- `analyze-repo-for-workers.mjs`: import-graph readiness analysis (request-time vs build-time code, monorepo workspaces, barrels, package probing).
- `analyze-vercel-account.mjs`, `make-report.mjs`, `apply-fixes.mjs`, `inspect-worker-bundle.mjs`, `measure-worker.mjs`, `load-test.mjs`, `summarize-tail.mjs`.
