import { NextRequest } from 'next/server'
export const dynamic = 'force-dynamic'

// (권장) 카드 테이블 빌더는 파일 최상단에 화살표함수로
const tableBlock = (title: string, rows: any[] = [], showValue = false) => {
  const head = showValue
    ? `| Rank | Ticker | o→c | Chg% | Vol | ¥Vol(M) | Theme | Brief |
|---:|---|---|---:|---:|---:|---|---|`
    : `| Rank | Ticker | o→c | Chg% | Vol | Theme | Brief |
|---:|---|---|---:|---:|---|---|`
  const body = (rows || []).map((r: any) => {
    const oc = `${r.o ?? ''}→${r.c ?? ''}`
    return showValue
      ? `| ${r.rank ?? ''} | ${r.ticker ?? ''} | ${oc} | ${r.chgPct ?? ''} | ${r.vol ?? ''} | ${r.jpyValueM ?? ''} | ${r.theme ?? ''} | ${r.brief ?? ''} |`
      : `| ${r.rank ?? ''} | ${r.ticker ?? ''} | ${oc} | ${r.chgPct ?? ''} | ${r.vol ?? ''} | ${r.theme ?? ''} | ${r.brief ?? ''} |`
  }).join('\n')
  return `### ${title}\n${head}\n${body}\n`
}

export async function GET(req: NextRequest) {
  try {
    const base = req.nextUrl.origin
    // ✅ 야후를 스킵해서 베이스를 안정적으로 받습니다.
    const r = await fetch(`${base}/api/jpx-eod?noQuotes=1`, { cache: 'no-store' })
    const j = await r.json()

    if (!j?.ok) {
      // 소프트 폴백: 마크다운 최소骨組み만 반환
      const msg = j?.error || 'JPX endpoint error'
      return new Response(
        `# 日本株 夜間警備員 日誌\n\nデータ取得に失敗しました（${msg}）。\n`,
        { headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
      )
    }

    const { dateJst, tables = {}, cards = [] } = j
    const md: string[] = []

    md.push(`# 日本株 夜間警備員 日誌 | ${dateJst}`)
    md.push('')
    md.push(`## カード（主要ETF・大型）`)
    md.push('')
    for (const c of (cards || [])) {
      md.push(`**${c.ticker}** — ${c.name ?? ''} | ${c.o ?? ''}→${c.c ?? ''} | Chg ${c.chgPct ?? ''}% | Vol ${c.vol ?? ''}  `)
      md.push(`${c.theme ?? ''}｜${c.brief ?? ''}`)
      md.push('')
    }
    md.push('---\n')
    md.push('## 📊 データ(Top10)')
    md.push(tableBlock('Top 10 — 売買代金（百万円換算）', tables.byValue, true))
    md.push(tableBlock('Top 10 — 出来高（株数）', tables.byVolume))
    md.push(tableBlock('Top 10 — 上昇株（¥1,000+）', tables.gainers))
    md.push(tableBlock('Top 10 — 下落株（¥1,000+）', tables.losers))
    md.push('\n#日本株 #夜間警備員 #日経平均 #TOPIX #半導体 #AI #出来高 #売買代金')

    return new Response(md.join('\n'), {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  } catch (err: any) {
    return new Response(`Fetch failed: ${String(err?.message || err)}`, { status: 500 })
  }
}
