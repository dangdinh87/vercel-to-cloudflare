// Which apps are worth moving? Only apps with real traffic: small/free apps cost (almost) nothing
// on Vercel, so moving them adds work without saving money — recommend leaving them.

// Monthly thresholds. Money decides: an app is "traffic" when its runtime usage (builds excluded)
// costs ≥ usd, or when volume alone would exhaust free allowances (Hobby includes 1M invocations).
// High call counts that cost cents (e.g. an internal dashboard polling itself) stay "small".
export const TRAFFIC = { usd: 3, invocations: 1_000_000, requests: 5_000_000 }

/**
 * m = monthlyMetrics(...) or null. → { tier: 'traffic' | 'small' | 'idle', reasons: [...] }
 * Build minutes are not traffic: an app whose cost is mostly builds stays "small".
 */
// Big apps: a wrong recommendation costs real money/users → interview in depth before advising.
export const LARGE = { usd: 50, invocations: 3_000_000, requests: 10_000_000 }

export function isLarge(m, t = LARGE) {
  return Boolean(m && (m.effectiveUsd - (m.buildUsd ?? 0) >= t.usd || m.inv >= t.invocations || m.cdn >= t.requests))
}

/** Asked before any recommendation for a large app (AskUserQuestion, a few per call). */
export const DEEP_QUESTIONS = {
  en: [
    'Peak traffic: busiest hour / launch days, and expected growth this year?',
    'What does one hour of downtime cost (revenue, signups, reputation)? Is a planned maintenance window possible?',
    'How much traffic comes from Google/SEO? Can URLs, redirects or speed change at all?',
    'Payments, webhooks, login providers, emails that must not break — which ones?',
    'Which Vercel features are in use: previews per PR, Edge Config, KV/Blob, Analytics, cron, image optimization, middleware?',
    'Where are the users and the database (latency budget)?',
    'Who can watch the cutover and roll back (DNS back to Vercel) during the first 2 weeks?',
    'Budget for Cloudflare paid add-ons (Images, WAF rules, Queues) if needed?',
    'OK to move gradually (one app or route group at a time) rather than all at once?',
  ],
  vi: [
    'Giờ cao điểm: giờ/ngày đông nhất (sale, ra mắt), và năm nay dự kiến tăng bao nhiêu?',
    'Site chết 1 giờ thì mất gì (doanh thu, đăng ký, uy tín)? Có thể chọn khung giờ bảo trì không?',
    'Bao nhiêu traffic đến từ Google/SEO? URL, redirect, tốc độ có được phép thay đổi không?',
    'Thanh toán, webhook, đăng nhập, email nào tuyệt đối không được hỏng?',
    'Đang dùng tính năng riêng nào của Vercel: preview mỗi PR, Edge Config, KV/Blob, Analytics, cron, tối ưu ảnh, middleware?',
    'Người dùng và database ở đâu (yêu cầu độ trễ)?',
    'Ai theo dõi lúc chuyển và trả DNS về Vercel nếu lỗi, trong 2 tuần đầu?',
    'Có ngân sách cho dịch vụ trả phí thêm của Cloudflare (Images, WAF, Queues) nếu cần không?',
    'Chấp nhận chuyển dần (từng app / từng nhóm route) thay vì chuyển một lần không?',
  ],
}

const L = {
  en: { idle: 'no usage this period', runtime: u => `$${u}/month of runtime usage`, inv: n => `${n} function invocations/month`, req: n => `${n} requests/month`,
    small: (r, i) => `${r} requests, ${i} invocations/month`, builds: u => `cost is mostly builds ($${u}), not traffic` },
  vi: { idle: 'không có usage trong kỳ', runtime: u => `$${u}/tháng chi phí chạy (không tính build)`, inv: n => `${n} lần gọi function/tháng`, req: n => `${n} request/tháng`,
    small: (r, i) => `${r} request, ${i} lần gọi function/tháng`, builds: u => `tiền chủ yếu là build ($${u}), không phải traffic` },
}

export function triage(m, t = TRAFFIC, lang = 'en') {
  const l = L[lang] ?? L.en
  if (!m || (m.cdn < 1_000 && m.inv < 1_000 && m.effectiveUsd < 0.05)) return { tier: 'idle', reasons: [l.idle] }
  const buildUsd = m.buildUsd ?? 0
  const trafficUsd = Math.max(0, m.effectiveUsd - buildUsd)
  const reasons = []
  const n = x => Math.round(x).toLocaleString('en-US')
  if (trafficUsd >= t.usd) reasons.push(l.runtime(trafficUsd.toFixed(2)))
  if (m.inv >= t.invocations) reasons.push(l.inv(n(m.inv)))
  if (m.cdn >= t.requests) reasons.push(l.req(n(m.cdn)))
  if (reasons.length) return { tier: 'traffic', reasons }
  const small = [l.small(n(m.cdn), n(m.inv))]
  if (buildUsd > 0.5 * m.effectiveUsd && buildUsd > 0.1) small.push(l.builds(buildUsd.toFixed(2)))
  return { tier: 'small', reasons: small }
}
