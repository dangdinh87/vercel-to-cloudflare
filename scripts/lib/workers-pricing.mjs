// Cloudflare Workers Paid pricing (checked Oct 2026 — re-verify before quoting) and the
// translation from Vercel usage to Worker usage, calibrated on real OpenNext measurements.

export const WORKERS = {
  baseUsd: 5,
  includedRequests: 10_000_000,
  includedCpuMs: 30_000_000,
  usdPerMillionRequests: 0.3,
  usdPerMillionCpuMs: 0.02,
}

// Cloudflare add-ons a bigger app may need (checked 2026-10-12, cloudflare.com/plans/network-cdn,
// developers.cloudflare.com/images/pricing). Zone plans are per domain.
export const ZONE_PLANS = { pro: { monthly: 25, annual: 20 }, business: { monthly: 250, annual: 200 } }
export const IMAGES = { freeTransforms: 5_000, usdPer1kTransforms: 0.5 }
export const imagesMonthlyCost = transforms => Math.max(0, transforms - IMAGES.freeTransforms) / 1000 * IMAGES.usdPer1kTransforms

/** Account-level monthly cost for total Worker requests + CPU ms. */
export function workersMonthlyCost(requests, cpuMs) {
  const reqOver = Math.max(0, requests - WORKERS.includedRequests) / 1e6 * WORKERS.usdPerMillionRequests
  const cpuOver = Math.max(0, cpuMs - WORKERS.includedCpuMs) / 1e6 * WORKERS.usdPerMillionCpuMs
  return { total: WORKERS.baseUsd + reqOver + cpuOver, base: WORKERS.baseUsd, requestOverage: reqOver, cpuOverage: cpuOver }
}

// Typical OpenNext on Workers: cache-intercepted hits ~15–35 ms; dynamic routes 100–400 ms;
// cold isolates load the bundle (200–600 ms). Vercel Fluid reuses warm instances better.
export const CALIBRATION = { cachedHitMs: [16, 40], dynamicFactor: [1, 2.5], dynamicFloorMs: [60, 150] }

/**
 * Monthly Vercel metrics → Worker estimate.
 *  - Function invocations ≈ dynamic Worker requests (each boots Next).
 *  - Non-function CDN requests are static assets (assets binding: free, no Worker run) or cached
 *    pages (cache interception: cheap Worker run). ISR reads over-count page hits (one request
 *    reads several cache entries), so cached hits ∈ [25% of non-function requests, min(ISR reads, all of them)].
 */
export function estimateFromVercel({ cdnRequests, invocations, isrReads, activeCpuHours }, measured = null) {
  const vercelCpuMsPerInv = invocations > 0 ? (activeCpuHours * 3.6e6) / invocations : 0
  const nonFunction = Math.max(0, cdnRequests - invocations)
  const cached = [nonFunction * 0.25, Math.min(isrReads, nonFunction)]
  // measure-worker.mjs output ([p50, p90] per class) replaces the assumptions when available.
  const cachedMs = measured?.cachedMs ?? CALIBRATION.cachedHitMs
  const dynMs = i => measured?.dynamicMs?.[i] ?? Math.max(CALIBRATION.dynamicFloorMs[i], vercelCpuMsPerInv * CALIBRATION.dynamicFactor[i])
  const cpu = i => invocations * dynMs(i) + cached[i] * cachedMs[i]
  return { requests: [invocations + cached[0], invocations + cached[1]], cpuMs: [cpu(0), cpu(1)], vercelCpuMsPerInv,
    basis: measured ? `measured on ${measured.worker ?? 'a trial Worker'} ${measured.measuredAt?.slice(0, 10) ?? ''}: cached ${measured.cachedMs?.join('/') ?? 'n/a'} ms, dynamic ${measured.dynamicMs?.join('/') ?? 'assumed'} ms (p50/p90)` : 'assumed (no measurement)' }
}
