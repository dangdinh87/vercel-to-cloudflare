import { imagesMonthlyCost, ZONE_PLANS } from './workers-pricing.mjs'
// "How do I pay less?" — target = traffic apps on one Workers Paid plan + small apps on Vercel
// Hobby, with every step's trade-off spelled out from the actual findings and usage.

const S = {
  en: {
    move: n => `Move the ${n} traffic app(s) to one Cloudflare Workers Paid plan (5 USD/month per account)`,
    moveTrade: h => `${h[0]}–${h[1]} h of work (trial → fixes → staging → DNS); slightly slower uncached pages; lose Vercel previews/analytics convenience`,
    hobby: 'Put the small apps on Vercel Hobby (free)',
    hobbyTrade: fits => `non-commercial only (payments, ads/AdSense, paid client work)${fits ? '' : '; their usage exceeds Hobby allowances → they may be paused'}`,
    inline: 'Turn off experimental.inlineCss', inlineTrade: 'Lighthouse −2/−3, LCP +0.7–1.4 s (required on Workers; also cuts Fast Origin Transfer on Vercel today)',
    cache: 'Serve guest API calls and pages from cache (ISR ≥ 1 h)', cacheTrade: 'data up to an hour stale',
    shortIsr: 'Lengthen short revalidate windows (≥ 1 h)', shortIsrTrade: 'pages refresh less often',
    data: 'Move big data out of the server bundle (static JSON / DB)', dataTrade: 'a build step + client fetch to write',
    builds: usd => `Cut build minutes (≈ ${usd}/month list): skip docs-only builds now; build in CI after the move`, buildsTrade: 'maintain a CI pipeline',
    images: 'Use images.unoptimized (or Cloudflare Images)', imagesTrade: 'heavier images unless you pre-size them',
    analytics: 'Drop Vercel Web Analytics', analyticsTrade: 'use GA / Cloudflare Web Analytics instead',
    dynamicHeavy: name => `${name}: most requests run server code — cache more before moving, or Workers CPU will be the main cost`,
    commercialSmall: 'Check: are any of the small apps commercial? Then Hobby is not allowed — keep Pro for them or move them too.',
    imagesCost: (n, usd) => `next/image does ~${n} transformations/month → Cloudflare Images ≈ ${usd}/month (included in the target), or images.unoptimized for $0`,
    zone: names => `${names} has large traffic: budget may need a Cloudflare zone plan — Pro ${ZONE_PLANS.pro.monthly} USD/month (${ZONE_PLANS.pro.annual} billed yearly: more rules, image optimization) or Business ${ZONE_PLANS.business.monthly} USD/month (${ZONE_PLANS.business.annual} yearly: 100% uptime SLA, chat support). Not included in the target.`,
  },
  vi: {
    move: n => `Chuyển ${n} app có traffic sang 1 gói Cloudflare Workers Paid (5 USD/tháng cho cả tài khoản)`,
    moveTrade: h => `${h[0]}–${h[1]} giờ làm (deploy thử → sửa → staging → DNS); trang chưa cache chậm hơn chút; mất tiện ích preview/analytics của Vercel`,
    hobby: 'Đưa các app nhỏ về Vercel Hobby (miễn phí)',
    hobbyTrade: fits => `chỉ cho site phi thương mại (thanh toán, quảng cáo/AdSense, làm thuê = thương mại)${fits ? '' : '; usage vượt hạn mức Hobby → có thể bị tạm dừng'}`,
    inline: 'Tắt experimental.inlineCss', inlineTrade: 'Lighthouse giảm 2–3 điểm, LCP chậm thêm 0,7–1,4 s (bắt buộc trên Workers; trên Vercel cũng giảm luôn phí băng thông)',
    cache: 'Trả API cho khách và trang từ cache (ISR ≥ 1 giờ)', cacheTrade: 'dữ liệu có thể cũ tối đa 1 giờ',
    shortIsr: 'Kéo dài các revalidate ngắn (≥ 1 giờ)', shortIsrTrade: 'trang cập nhật thưa hơn',
    data: 'Đưa dữ liệu lớn ra khỏi bundle server (file JSON tĩnh / DB)', dataTrade: 'phải viết bước build + fetch phía client',
    builds: usd => `Giảm phút build (≈ ${usd}/tháng giá niêm yết): bỏ build khi chỉ sửa docs; sau khi chuyển thì build trong CI`, buildsTrade: 'tự quản lý pipeline CI',
    images: 'Dùng images.unoptimized (hoặc Cloudflare Images)', imagesTrade: 'ảnh nặng hơn nếu không resize trước',
    analytics: 'Bỏ Vercel Web Analytics', analyticsTrade: 'dùng GA / Cloudflare Web Analytics thay thế',
    dynamicHeavy: name => `${name}: phần lớn request chạy code server — nên cache thêm trước khi chuyển, nếu không CPU Workers sẽ là khoản tốn chính`,
    commercialSmall: 'Cần kiểm: app nhỏ nào có dùng cho mục đích thương mại? Nếu có thì không được dùng Hobby — giữ Pro cho chúng hoặc chuyển luôn.',
    imagesCost: (n, usd) => `next/image đang biến đổi ~${n} ảnh/tháng → Cloudflare Images ≈ ${usd}/tháng (đã cộng vào mục tiêu), hoặc images.unoptimized để 0 đồng`,
    zone: names => `${names} có traffic lớn: có thể cần thêm gói tên miền Cloudflare — Pro ${ZONE_PLANS.pro.monthly} USD/tháng (${ZONE_PLANS.pro.annual} nếu trả năm: nhiều rule hơn, tối ưu ảnh) hoặc Business ${ZONE_PLANS.business.monthly} USD/tháng (${ZONE_PLANS.business.annual} nếu trả năm: cam kết uptime 100%, hỗ trợ chat). Chưa cộng vào mục tiêu.`,
  },
}

const FIXED_PHASES = [16, 28] // trial + staging + cutover, done once for all apps together

/**
 * traffic: rows with { project, repo (analyzeRepo model), workers, metrics, vercel insights? }
 * Returns { now, target: [lo, hi], saving: [lo, hi], steps: [{ action, tradeoff, effort?, saves? }], warnings }
 */
export function savingsPlan({ now, workers, traffic, small, smallFitsHobby, smallOnPro, large = [] }, lang = 'en') {
  const t = S[lang] ?? S.en
  const steps = []
  const warnings = []
  const smallCost = smallFitsHobby ? 0 : smallOnPro
  // Image transformations move to Cloudflare Images (5K/month free) unless the app goes unoptimized.
  const transforms = traffic.reduce((s, r) => s + (r.metrics?.img ?? 0), 0)
  const imagesUsd = imagesMonthlyCost(transforms)
  const target = workers ? [workers[0] + smallCost + imagesUsd, workers[1] + smallCost + imagesUsd] : null
  const saving = target ? [Math.max(0, now - target[1]), Math.max(0, now - target[0])] : null

  if (traffic.length && workers) {
    // App-specific effort minus the shared phases counted once.
    const appHours = traffic.reduce((acc, r) => r.repo ? [acc[0] + r.repo.score.effortHours[0] - FIXED_PHASES[0], acc[1] + r.repo.score.effortHours[1] - FIXED_PHASES[1]] : acc, [0, 0])
    const hours = [Math.max(FIXED_PHASES[0], appHours[0] + FIXED_PHASES[0]), Math.max(FIXED_PHASES[1], appHours[1] + FIXED_PHASES[1])]
    steps.push({ action: t.move(traffic.length), tradeoff: t.moveTrade(hours), effort: hours, saves: saving })
  }
  if (small.length) steps.push({ action: t.hobby, tradeoff: t.hobbyTrade(smallFitsHobby), effort: [0.5, 1] })
  if (small.length) warnings.push(t.commercialSmall)

  const has = rule => traffic.some(r => r.repo?.findings.some(f => f.rule === rule && f.sev !== 'INFO'))
  if (has('inline-css')) steps.push({ action: t.inline, tradeoff: t.inlineTrade, effort: [0.25, 0.5] })
  if (has('per-view-dynamic-api') || has('s-maxage')) steps.push({ action: t.cache, tradeoff: t.cacheTrade, effort: [1, 4] })
  if (has('short-revalidate')) steps.push({ action: t.shortIsr, tradeoff: t.shortIsrTrade, effort: [0.25, 1] })
  if (has('bundle-data')) steps.push({ action: t.data, tradeoff: t.dataTrade, effort: [6, 16] })
  if (has('image-optimization')) steps.push({ action: t.images, tradeoff: t.imagesTrade, effort: [0.5, 2] })
  const buildUsd = traffic.reduce((s, r) => s + (r.metrics?.buildUsd ?? 0), 0)
  if (buildUsd >= 2) steps.push({ action: t.builds(`$${buildUsd.toFixed(2)}`), tradeoff: t.buildsTrade, effort: [1, 3] })
  if (traffic.some(r => (r.metrics?.wa ?? 0) > 0)) steps.push({ action: t.analytics, tradeoff: t.analyticsTrade, effort: [0.25, 0.5] })

  if (transforms > 0) warnings.push(t.imagesCost(Math.round(transforms).toLocaleString('en-US'), `$${imagesUsd.toFixed(2)}`))
  if (large.length) warnings.push(t.zone(large.map(r => r.project.name).join(', ')))
  for (const r of traffic) {
    const share = r.metrics && r.metrics.cdn > 0 ? 1 - r.metrics.inv / r.metrics.cdn : null
    if (share != null && share < 0.5) warnings.push(t.dynamicHeavy(r.project.name))
  }
  return { now, target, saving, steps, warnings }
}
