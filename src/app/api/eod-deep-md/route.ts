import { NextRequest } from 'next/server'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const u = new URL(req.url)
  // 쿼리(date, model 등) 보존해서 eod-deep 호출
  const r = await fetch(`${u.origin}/api/eod-deep${u.search}`, { cache: 'no-store' })
  const j = await r.json()
  if (!j.ok) return new Response(j.error || 'error', { status: 500 })
  return new Response(j.markdown, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
}
