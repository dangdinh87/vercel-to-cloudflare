---
type: llm
---

PASS if the final answer names all three problems: (1) experimental.inlineCss must be turned off, (2) the opengraph-image route reads a file with fs/process.cwd() at request time, which fails on Workers, and (3) the `runtime = 'edge'` export must be removed for OpenNext.
FAIL if any of the three is missing, or if the answer claims the app runs on Workers unchanged.
