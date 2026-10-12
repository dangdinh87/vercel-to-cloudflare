---
type: llm
---

PASS if the answer does all of these:
(a) warns that moving only the busy app while still paying Vercel Pro for the others costs more than staying;
(b) gives a cheaper plan: the busy app on Cloudflare Workers, and the small apps either on Vercel Hobby (only if they are non-commercial) or moved onto the same Workers account (if they are commercial or internal company tools);
(c) says Workers Paid is about 5 USD per month per account plus usage beyond the included amounts;
(d) names at least two trade-offs, such as hours of migration work, slower uncached pages, staler cached data or losing Vercel conveniences.
FAIL if it recommends moving only the busy app while keeping Vercel Pro, presents Cloudflare as a flat 5 USD regardless of usage, or gives no trade-offs.
