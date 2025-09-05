import { NextRequest } from 'next/server'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  // 1) 기존 요청의 쿼리 파라미터를 그대로 /api/eod-deep 에 전달
  const url = new URL(req.url)
  url.pathname = '/api/eod-deep'
  // 언어 기본을 일본어로 고정하고 싶다면 없을 때만 ja를 주입
  if (!url.searchParams.get('lang')) url.searchParams.set('lang', 'ja')

  // 2) 메인 라우트 호출
  const r = await fetch(url.toString(), { cache: 'no-store' })
  const j = await r.json().catch(() => null)

  // 3) 정상 마크다운이면 반환
  if (j?.ok && typeof j?.markdown === 'string' && j.markdown.trim().length > 0) {
    return new Response(j.markdown, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }

  // 4) 폴백: 레거시 /api/eod 로 재시도 (동일 쿼리)
  const fallback = new URL(req.url)
  fallback.pathname = '/api/eod'
  const r2 = await fetch(fallback.toString(), { cache: 'no-store' })
  const j2 = await r2.json().catch(() => null)
  if (j2?.ok && typeof j2?.markdown === 'string' && j2.markdown.trim().length > 0) {
    return new Response(j2.markdown, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }

  // 5) 최종 에러
  const msg = j?.error || j2?.error || 'empty'
  return new Response(msg, { status: 500 })
