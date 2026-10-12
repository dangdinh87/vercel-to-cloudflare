// Strings for the user-facing parts of make-report (overview, cards, glossary, limits).
// Detailed tables stay in English: they quote code, config keys and Vercel/Cloudflare terms.

export const T = {
  en: {
    title: 'Vercel → Cloudflare Workers report',
    generated: 'Generated', scope: 'Scope',
    overview: 'Overview', keyNumbers: 'Key numbers', details: 'Details', glossary: 'Glossary', limits: 'What this report cannot tell you', sources: 'Sources (checked {date})',
    readiness: 'Readiness', effort: 'Estimated work', billNow: 'Vercel bill now', workers: 'On Workers (estimate)', mustFix: 'Must-fix issues',
    hours: 'h', perMonth: '/month',
    autoVerdict: { GO: 'The app can move to Cloudflare Workers with routine setup.', 'GO after fixes': 'The app can move, but the must-fix issues below come first.', 'NO-GO until blockers are replaced': 'Do not move yet: some packages or code cannot run on Workers.' },
    topProblems: 'Biggest problems', nextActions: 'Next actions', money: 'Money',
    moneyLine: (now, cf, rest) => `Vercel now ≈ ${now}/month. Moving the main project: ${cf}/month on Workers${rest}.`,
    noSummary: 'Auto-generated overview. For a plain-language summary in your language, the assistant writes one and passes it with --summary.',
    repoDetails: 'Code readiness (per route, per file)', vercelDetails: 'Vercel usage deep dive', bundleDetails: 'Worker bundle contents',
    limitItems: [
      'Findings are heuristics from reading the code; confirm each must-fix by reading the file, then on a trial Worker.',
      'Calls made through helper functions are marked "unknown" and listed, not flagged.',
      'Workers cost is an estimate calibrated on one production app; measure with `wrangler tail` before deciding.',
      'Prices and allowances change; the sources below show when they were last checked.',
      'Secrets and env values are never read — only their names.',
    ],
  },
  vi: {
    title: 'Báo cáo chuyển Vercel → Cloudflare Workers',
    generated: 'Tạo lúc', scope: 'Phạm vi',
    overview: 'Tổng quan', keyNumbers: 'Số liệu chính', details: 'Chi tiết', glossary: 'Giải thích thuật ngữ', limits: 'Báo cáo này KHÔNG nói được gì', sources: 'Nguồn (kiểm tra ngày {date})',
    readiness: 'Mức sẵn sàng', effort: 'Ước tính công', billNow: 'Hoá đơn Vercel hiện tại', workers: 'Trên Workers (ước tính)', mustFix: 'Lỗi phải sửa',
    hours: 'giờ', perMonth: '/tháng',
    autoVerdict: { GO: 'App chuyển sang Cloudflare Workers được, chỉ cần cấu hình bình thường.', 'GO after fixes': 'App chuyển được, nhưng phải sửa các lỗi bắt buộc bên dưới trước.', 'NO-GO until blockers are replaced': 'Chưa nên chuyển: có thư viện hoặc code không chạy được trên Workers.' },
    topProblems: 'Vấn đề lớn nhất', nextActions: 'Việc nên làm tiếp', money: 'Tiền',
    moneyLine: (now, cf, rest) => `Vercel hiện ≈ ${now}/tháng. Chuyển project chính: ${cf}/tháng trên Workers${rest}.`,
    noSummary: 'Phần tổng quan tự sinh. Muốn bản tóm tắt dễ hiểu hơn, trợ lý sẽ viết riêng và truyền vào bằng --summary.',
    repoDetails: 'Mức sẵn sàng của code (theo route, theo file)', vercelDetails: 'Phân tích sâu usage Vercel', bundleDetails: 'Thành phần bundle Worker',
    limitItems: [
      'Kết quả là suy luận từ việc đọc code; mỗi lỗi bắt buộc cần mở file kiểm lại, rồi thử trên Worker thật.',
      'Lời gọi API đi qua hàm tiện ích được đánh dấu "unknown" — có trong bảng nhưng không thành cảnh báo.',
      'Chi phí Workers là ước tính, hiệu chỉnh trên 1 app thật; hãy đo bằng `wrangler tail` trước khi quyết.',
      'Giá và hạn mức thay đổi; mục Nguồn ghi ngày kiểm tra gần nhất.',
      'Không đọc giá trị secret/env — chỉ đọc tên biến.',
    ],
  },
}

export const GLOSSARY = {
  en: [
    ['Cloudflare Worker', 'Code that runs on Cloudflare\'s servers per request. Billed by requests + CPU milliseconds, not by waiting time.'],
    ['OpenNext', 'The adapter (@opennextjs/cloudflare) that turns a Next.js build into a Worker.'],
    ['Build-time vs request-time', 'Build-time code runs once when you deploy (safe to read files). Request-time code runs for each visitor — this is what must work on Workers and what you pay for.'],
    ['SSG / ISR / dynamic', 'SSG: page built at deploy. ISR: cached page rebuilt every N seconds. Dynamic: rendered on every request (most expensive).'],
    ['P0 / P1 / P2 / P3', 'P0 = blocks the move. P1 = will break or cost a lot, fix before moving. P2 = should fix. P3 = nice to know. INFO = checked, OK.'],
    ['CPU-ms', 'Milliseconds the CPU actually works on a request. Workers Paid includes 30 million per month.'],
    ['CDN request / function invocation', 'CDN request = any request (incl. images, JS). Function invocation = a request that ran your server code.'],
    ['FOT / FDT', 'Vercel transfer charges: Fast Origin Transfer = bytes from your functions to the CDN; Fast Data Transfer = bytes to visitors. Neither is billed on Cloudflare.'],
    ['R2 / D1 / Durable Objects', 'Cloudflare storage used by OpenNext for page cache (R2), revalidation tags (D1) and the refresh queue (DO).'],
    ['Cache interception', 'OpenNext option that serves cached pages before loading the Next.js server — the biggest CPU saving.'],
    ['Hobby / Pro', 'Vercel plans. Hobby is free but non-commercial only (payments, ads); Pro is paid per seat with a usage credit.'],
  ],
  vi: [
    ['Cloudflare Worker', 'Đoạn code chạy trên máy chủ Cloudflare cho mỗi request. Tính tiền theo số request + mili-giây CPU, không tính thời gian chờ.'],
    ['OpenNext', 'Bộ chuyển đổi (@opennextjs/cloudflare) biến bản build Next.js thành một Worker.'],
    ['Lúc build vs lúc request', 'Code lúc build chạy 1 lần khi deploy (đọc file thoải mái). Code lúc request chạy cho từng người xem — phần này phải chạy được trên Workers và là phần tốn tiền.'],
    ['SSG / ISR / dynamic', 'SSG: trang dựng sẵn lúc deploy. ISR: trang cache, dựng lại mỗi N giây. Dynamic: dựng lại mỗi request (tốn nhất).'],
    ['P0 / P1 / P2 / P3', 'P0 = chặn việc chuyển. P1 = sẽ lỗi hoặc tốn nhiều, sửa trước khi chuyển. P2 = nên sửa. P3 = biết để đó. INFO = đã kiểm, ổn.'],
    ['CPU-ms', 'Số mili-giây CPU thực sự xử lý request. Gói Workers Paid có sẵn 30 triệu/tháng.'],
    ['CDN request / function invocation', 'CDN request = mọi request (cả ảnh, JS). Function invocation = request có chạy code server của bạn.'],
    ['FOT / FDT', 'Phí truyền dữ liệu của Vercel: FOT = byte từ function tới CDN; FDT = byte tới người xem. Cloudflare không tính cả hai.'],
    ['R2 / D1 / Durable Objects', 'Kho của Cloudflare mà OpenNext dùng: cache trang (R2), tag làm mới (D1), hàng đợi làm mới (DO).'],
    ['Cache interception', 'Tuỳ chọn của OpenNext trả trang đã cache trước khi nạp server Next.js — tiết kiệm CPU nhiều nhất.'],
    ['Hobby / Pro', 'Gói của Vercel. Hobby miễn phí nhưng chỉ phi thương mại (thanh toán, quảng cáo là thương mại); Pro trả theo seat, kèm credit usage.'],
  ],
}

export const SOURCES = [
  ['Cloudflare Workers limits', 'https://developers.cloudflare.com/workers/platform/limits/'],
  ['Cloudflare Workers pricing', 'https://developers.cloudflare.com/workers/platform/pricing/'],
  ['OpenNext for Cloudflare', 'https://opennext.js.org/cloudflare'],
  ['OpenNext Cloudflare issues', 'https://github.com/opennextjs/opennextjs-cloudflare/issues'],
  ['Vercel fair use / Hobby allowances', 'https://vercel.com/docs/limits/fair-use-guidelines'],
  ['Vercel pricing', 'https://vercel.com/pricing'],
]
export const FACTS_CHECKED = '2026-10-12'
