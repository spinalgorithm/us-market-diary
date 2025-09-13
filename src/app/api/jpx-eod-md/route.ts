// src/app/api/jpx-eod-md/route.ts
import { NextRequest } from 'next/server'
export const dynamic = 'force-dynamic'

type Row = {
  ticker: string
  name?: string
  theme?: string
  brief?: string
  o?: number
  c?: number
  vol?: number
  chgPct?: number
  jpyValueM?: number
}
type Tables = { byValue: Row[]; byVolume: Row[]; gainers: Row[]; losers: Row[] }
type Api = { ok: true; dateJst: string; isHoliday: boolean; reason?: string; cards: Row[]; tables: Tables }

function q(url: string){ return fetch(url, { cache:'no-store' }) }
function n(v:any){ const x=Number(v); return Number.isFinite(x)? x: undefined }
function fmtNum(x: number | undefined){ return typeof x==='number' ? x.toLocaleString('ja-JP') : '' }
function fmtPct(x: number | undefined){ return typeof x==='number' ? x.toFixed(2) : '' }
function oc(o?:number,c?:number){
  if (o==null || c==null) return ''
  return `${o}→${c}`
}

function rowLine(r: Row, withValue=false){
  if (withValue){
    return `| ${r.ticker} | ${oc(r.o,r.c)} | ${fmtPct(r.chgPct)} | ${fmtNum(r.vol)} | ${fmtNum(r.jpyValueM)} | ${r.theme ?? ''} | ${r.brief ?? ''} |`
  }
  return `| ${r.ticker} | ${oc(r.o,r.c)} | ${fmtPct(r.chgPct)} | ${fmtNum(r.vol)} | ${r.theme ?? ''} | ${r.brief ?? ''} |`
}

function tableBlock(title: string, rows: Row[], withValue=false){
  const head = withValue
    ? `| Rank | Ticker | o→c | Chg% | Vol | ¥Vol(M) | Theme | Brief |\n|---:|---|---|---:|---:|---:|---|---|`
    : `| Rank | Ticker | o→c | Chg% | Vol | Theme | Brief |\n|---:|---|---|---:|---:|---|---|`
  const lines = rows.map((r,i)=>`| ${i+1} ${rowLine(r, withValue).slice(1)}`)
  return `### ${title}\n${head}\n${lines.join('\n') || ''}\n`
}

export async function GET(req: NextRequest){
  // 내부 API 호출 (date 파라미터 그대로 전달 가능)
  const self = new URL(req.nextUrl)
  self.pathname = '/api/jpx-eod'
  const r = await q(self.toString())
  if (!r.ok) return new Response(`Fetch failed: ${r.status}`, { status: 500 })
  const j = await r.json() as Api

  const title = `# 日本株 夜間警備員 日誌 | ${j.dateJst}\n`
  const holidayBanner = j.reason?.startsWith('holiday') ? `> ※ 休場日だったため、直近の取引日（${j.dateJst}）で集計しています。\n\n` : ''
  const cards = j.cards.length
    ? `## カード（主要ETF・大型）\n${j.cards.map(r=>{
        const nm = r.name ? ` — ${r.name}` : ''
        const t = `${r.ticker}${nm}`
        const line = `- ${t}: ${oc(r.o,r.c)}（${fmtPct(r.chgPct)}） / Vol ${fmtNum(r.vol)} / ¥Vol ${fmtNum(r.jpyValueM)}`
        const meta = [r.theme, r.brief].filter(Boolean).join(' | ')
        return meta ? `${line}\n  - ${meta}` : line
      }).join('\n')}\n\n---\n`
    : `## カード（主要ETF・大型）\n（データを取得できませんでした）\n\n---\n`

  const t = j.tables
  const md =
`${title}
${holidayBanner}${cards}
## 📊 データ(Top10)
${tableBlock('Top 10 — 売買代金（百万円換算）', t.byValue, true)}
${tableBlock('Top 10 — 出来高（株数）', t.byVolume, false)}
${tableBlock('Top 10 — 上昇株（¥1,000+）', t.gainers, false)}
${tableBlock('Top 10 — 下落株（¥1,000+）', t.losers, false)}

#日本株 #夜間警備員 #日経平均 #TOPIX #半導体 #AI #出来高 #売買代金
`
  return new Response(md, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
}
