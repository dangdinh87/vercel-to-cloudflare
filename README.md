# vercel-to-cloudflare

A Claude Code skill that helps you **pay less for Next.js hosting**. It finds which of your Vercel apps get enough traffic to be worth moving, checks whether they will run on Cloudflare Workers (via [OpenNext](https://opennext.js.org/cloudflare)), applies the safe code fixes, and writes a plain-language HTML report: what you pay now, what you would pay, and what you give up.

The target setup: apps with real traffic share **one Cloudflare Workers Paid plan** (5 USD/month per account plus usage). Small apps stay on **Vercel Hobby**, which is free for non-commercial sites. Never trading correctness away is the hard rule; speed, data freshness and some hours of work are the trade-offs, and the report spells each one out.

> Not affiliated with Vercel or Cloudflare. Prices and limits change: the skill re-checks the official pages and dates every number it quotes.

## What it does

1. **Scan.** Lists every project in your Vercel account, finds each one's code on your machine (via `.vercel/project.json` or git remote), and sorts the projects into *traffic* (worth a look), *small* (leave on Vercel) and *idle*.
2. **Analyse the code.** Builds an import graph from every route, so it only flags code that runs **per request**: `fs`, `node:dns`, WebSocket headers, native addons, `runtime = "edge"`, a bundle over 64 MiB, `after()` work longer than 30 s, `s-maxage` (ignored on Workers), dynamic API calls on every page view, polling… Each finding comes with the import chain that leads to it. It follows workspace packages in monorepos, and unknown npm packages are inspected on disk.
3. **Analyse the bill.** Reads Vercel billing data (read-only) and shows the real bill, cost drivers (builds, Fast Origin Transfer, ISR…), cache share, CPU per request, the cost on Workers, and how much each option would save.
4. **Plan.** Lists each step to a lower bill with its trade-off and the hours it takes, and when the work pays for itself. Large-traffic apps get a set of questions first.
5. **Fix.** `apply-fixes.mjs` edits code. It only previews by default, never commits, pushes or installs, and refuses to touch files with uncommitted changes. Trade-off fixes run only when you explicitly accept them.
6. **Measure and move.** Measures real CPU on a trial Worker to replace the estimates, then walks through staging, DNS cutover and rollback in gated phases.

## Install

As a Claude Code plugin (recommended — `/plugin` keeps it updated):

```text
/plugin marketplace add dangdinh87/vercel-to-cloudflare
/plugin install vercel-to-cloudflare@vercel-to-cloudflare
```

Or as a plain skill:

```bash
git clone https://github.com/dangdinh87/vercel-to-cloudflare ~/.claude/skills/vercel-to-cloudflare
```

Requirements: Node.js ≥ 22 and git. The scripts have zero npm dependencies; if a repo has `typescript` installed, they borrow it for exact import parsing.
Optional: `vercel login`, needed for the bill analysis. `wrangler login`, needed for trial deploys and CPU measurement.

## Use

In Claude Code, ask in your own words, for example *"Can I cut my Vercel bill by moving to Cloudflare?"*, or run `/vercel-to-cloudflare`. Claude scans, asks only what it can't find out itself, and opens the report.

The scripts also work on their own:

```bash
S=~/.claude/skills/vercel-to-cloudflare/scripts
node $S/scan-vercel-apps.mjs --open                           # all Vercel apps → index report
node $S/make-report.mjs --repo=. --vercel --out=report.html --open
node $S/apply-fixes.mjs .                                     # dry run; add --write to apply
node $S/inspect-worker-bundle.mjs .                           # after `opennextjs-cloudflare build`
node $S/measure-worker.mjs --url=https://<worker>.workers.dev --worker=<name> --repo=.
```

## Privacy and safety

- **Read-only by default.** Analysis only reads local files and calls `api.vercel.com` with GET requests.
- **Vercel token.** Taken from `VERCEL_TOKEN` or your Vercel CLI login file. It is never printed, stored or sent anywhere except `api.vercel.com`.
- **Local scan.** The scan looks for Next.js apps under your home folder (change this with `--roots=`). Secrets and `.env` values are never read; only variable names are.
- **Reports.** They are local files that contain your project names and domains. Review a report before you share it.
- **Code changes.** `apply-fixes.mjs` writes only with `--write`, never commits, pushes or installs packages, and skips files you are editing.
- **Load.** `measure-worker.mjs` sends about 30 requests to a Worker you own.

## Accuracy

Findings are heuristics, not proof. Confirm every must-fix in the code, then on a trial Worker. The analyser was checked against 33 apps in 18 public repos (cal.com, dub, payload, formbricks, papermark, midday, umami, ai-chatbot…).

[`references/validation.md`](references/validation.md) has the details and the known blind spots. Next.js only; Windows works best under WSL, as OpenNext recommends.

## Tests

```bash
node --test scripts/tests/*.test.mjs        # script unit tests (no network)
claude plugin validate .                     # plugin + marketplace manifests
claude plugin eval . --scaffold --trust-plugin --allow-tools Bash,Write,Edit --judge-model sonnet
```

The eval suite (`evals/`) has three cases: a readiness report on a small app with known problems, applying only the safe fixes without committing, and the "is moving worth it?" money question. Evals run Claude with your own credentials and cost a little each run. A Sonnet judge is recommended; the default small judge sometimes fails correct but differently-worded answers.

## License

MIT, see [LICENSE](LICENSE).
