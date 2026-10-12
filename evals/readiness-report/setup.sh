#!/usr/bin/env bash
# Small Next.js app with three known Workers problems: inlineCss, fs in a request-time OG route,
# and runtime = 'edge'. Shared by the eval cases (run via case.yaml scaffold_script).
set -euo pipefail
mkdir -p app/api/geo "app/og/[slug]" public
cat > package.json <<'JSON'
{ "name": "demo-shop", "private": true, "scripts": { "build": "next build" }, "dependencies": { "next": "16.0.0", "react": "19.0.0", "react-dom": "19.0.0" } }
JSON
cat > next.config.ts <<'TS'
const nextConfig = {
  experimental: { inlineCss: true },
}
export default nextConfig
TS
cat > app/layout.tsx <<'TSX'
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html><body>{children}</body></html>
}
TSX
echo 'export default function Home() { return <h1>Shop</h1> }' > app/page.tsx
cat > "app/og/[slug]/opengraph-image.tsx" <<'TSX'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ImageResponse } from 'next/og'
export default async function Image() {
  const font = await readFile(join(process.cwd(), 'public/inter.ttf'))
  return new ImageResponse(<div>Shop</div>, { fonts: [{ name: 'Inter', data: font }] })
}
TSX
cat > app/api/geo/route.ts <<'TS'
export const runtime = 'edge'
export async function GET() { return Response.json({ ok: true }) }
TS
git init -q && git add . && git -c user.name=eval -c user.email=eval@example.com commit -q -m init
