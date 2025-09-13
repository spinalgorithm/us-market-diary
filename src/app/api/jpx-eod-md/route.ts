// src/app/api/jpx-eod-md/route.ts
import { NextRequest } from 'next/server'
export const dynamic = 'force-dynamic'

// ← 블록 밖(최상위)에 함수표현식으로 정의
const tableBlock = (title: string, rows: any[] = [], showValue = false) => {
  const head = showValue
    ? `| Rank | Ticker | o→c | Chg% | Vol | ¥Vol(M) | Theme | Brief |
|---:|---|---|---:|---:|---:|---|---|`
    : `| Rank | Ticker | o→c | Chg% | Vol | Theme | Brief |
|---:|---|---|---:|---:|---|---|`

  const body = rows
    .map((r: any) => {
      const oc = `${r.o}→${r.c}`
      return showValue
        ? `| ${r.rank ?? ''} | ${r.ticker ?? ''} | ${oc} | ${r.chgPct ?? ''} | ${r.vol ?? ''} | ${r.jpyValueM ?? ''} | ${r.theme ?? ''} | ${r.brief ?? ''} |`
        : `| ${r.rank ?? ''} | ${r.ticker ?? ''} | ${oc} | ${r.chgPct ?? ''} | ${r.vol ?? ''} | ${r.theme ?? ''} | ${r.brief ?? ''} |`
    })
    .join('\n')

  return `### ${title}
${head}
${body}
`
}

export async function GET(req: NextRequest) {
  try {
    const base = req.nextUrl.origin
    const r = await fetch(base + '/api/jpx-eod', { cache: 'no-store' })
    const j = await r.json()
    if (!j?.ok) throw new Error(j?.error || 'JPX endpoint error')

    const { dateJst, cards = [], tables = {} as any } = j

    const mdLines: string[] = []
    mdLines.push(`# 日本株 夜間警備員 日誌 | ${dateJst}`)
    mdLines.push('')
    mdLines.push(`## カード（主要ETF・メガキャップ）`)
    mdLines.push('')
    for (const c of cards) {
      mdLines.push(`**${c.ticker}** — ${c.name} | ${c.o}→${c.c} | Chg ${c.chgPct}% | Vol ${c.vol}  `)
      mdLines.push(`${c.theme}｜${c.brief}`)
      mdLines.push('')
    }
    mdLines.push('---\n')
    mdLines.push('## 📊 データ(Top10)')
    mdLines.push(tableBlock('Top 10 — 売買代金（百万円換算）', tables.byValue, true))
    mdLines.push(tableBlock('Top 10 — 出来高（株数）', tables.byVolume))
    mdLines.push(tableBlock('Top 10 — 上昇株（¥1,000+）', tables.gainers))
    mdLines.push(tableBlock('Top 10 — 下落株（¥1,000+）', tables.losers))
    mdLines.push('\n#日本株 #夜間警備員 #日経平均 #TOPIX #半導体 #AI #出来高 #売買代金')

    return new Response(mdLines.join('\n'), {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  } catch (err: any) {
    return new Response(`Fetch failed: ${String(err?.message || err)}`, { status: 500 })
  }
}
