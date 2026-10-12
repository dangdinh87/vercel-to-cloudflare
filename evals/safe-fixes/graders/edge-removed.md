---
type: regex
target: { source: file, path: app/api/geo/route.ts }
pattern: "runtime\\s*=\\s*['\"]edge"
match: not_contains
---
