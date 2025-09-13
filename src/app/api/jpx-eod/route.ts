// src/app/api/jpx-eod/route.ts
import { NextRequest } from 'next/server'
export const dynamic = 'force-dynamic'

// ====== Types ======
type TableRow = {
  rank?: number
  ticker?: string
  o?: number | string
  c?: number | string
  chgPct?: number | string
  vol?: number | string
  jpyValueM?: number | string // 売買代金（百万円）
  theme?: string
  brief?: string
  name?: string
}

type TablesPayload = {
  byValue?: TableRow[]   // 売買代金Top
  byVolume?: TableRow[]  // 出来高Top
  gainers?: TableRow[]   // 上昇（任意条件）
  losers?: TableRow[]    // 下落（任意条件）
}

// ====== Small utils ======
const toNumber = (v: any): number | undefined => {
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}
const pct = (o?: number, c?: number): string => {
  if (!Number.isFinite(o!) || !Number.isFinite(c!)) return ''
  return (((c! - o!) / o!) * 100).toFixed(2)
}

// ====== Date (JST) ======
const getDateJst = (req: NextRequest): string => {
  const q = req.nextUrl.searchParams.get('date')
  if (q) return q
  const fmt = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' })
  const parts = fmt.formatToParts(new Date())
  const y = parts.find(p => p.type === 'year')?.value
  const m = parts.find(p => p.type === 'month')?.value
  const d = parts.find(p => p.type === 'day')?.value
  return `${y}-${m}-${d}`
}

// ====== Theme/Brief dictionary ======
type BriefInfo = { theme?: string; brief?: string; name?: string }
const JP_BRIEF: Record<string, BriefInfo> = {
  '1321.T': { theme: 'インデックス/ETF', brief: '日経225連動ETF', name: 'iシェアーズ 日経225' },
  '1306.T': { theme: 'インデックス/ETF', brief: 'TOPIX連動ETF', name: 'NEXT FUNDS TOPIX' },
  '8035.T': { theme: '半導体/装置', brief: '半導体製造装置', name: '東京エレクトロン' },
  '9984.T': { theme: '投資/通信', brief: '投資持株・通信', name: 'ソフトバンクG' },
  '7203.T': { theme: '自動車', brief: '自動車', name: 'トヨタ自動車' },
  '6758.T': { theme: 'エレクトロニクス/ゲーム', brief: 'エレクトロニクス・エンタメ', name: 'ソニーG' },
  '7974.T': { theme: 'ゲーム', brief: '家庭用ゲーム', name: '任天堂' },
  '8306.T': { theme: '金融', brief: 'メガバンク', name: '三菱UFJ' },
}

// 안전하게 info를 가져오는 헬퍼
const getInfo = (sym: string): BriefInfo | undefined => JP_BRIEF[sym as keyof typeof JP_BRIEF]

// ====== Yahoo quotes (best-effort, may 401) ======
const fetchYahooCards = async (tickers: string[]) => {
  if (!tickers.length) return []
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(tickers.join(','))}`
  const res = await fetch(url, {
    cache: 'no-store',
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; JPX-EOD/1.0; +https://vercel.app)',
      'Accept-Language': 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7'
    }
  })
  if (!res.ok) throw new Error(`Yahoo quote error: ${res.status}`)
  const j = await res.json()
  const results = j?.quoteResponse?.result ?? []
  const out: TableRow[] = []
  for (const r of results) {
    const t: string = r.symbol
    const open = toNumber(r.regularMarketOpen ?? r.open)
    const close = toNumber(r.regularMarketPrice ?? r.price ?? r.regularMarketPreviousClose)
    const vol = toNumber(r.regularMarketVolume ?? r.volume)
    const info = getInfo(t)

    out.push({
      ticker: t,
      name: info?.name ?? r.shortName ?? r.longName ?? '',
      o: open,
      c: close,
      chgPct: (open && close) ? pct(open, close) : '',
      vol: vol ?? '',
      theme: info?.theme ?? '',
      brief: info?.brief ?? ''
    })
  }
  return out
}

// ====== Stooq fallback for cards ======
const toStooq = (yahoo: string) => yahoo.replace(/\.T$/i, '.jp')
const fetchStooqCards = async (yahooTickers: string[]) => {
  if (!yahooTickers.length) return []
  const syms = yahooTickers.map(toStooq).join(',')
  const url = `https://stooq.com/q/l/?s=${encodeURIComponent(syms)}&i=d`
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) throw new Error(`Stooq error: ${res.status}`)
  const csv = await res.text()
  const lines = csv.trim().split('\n')
  const out: TableRow[] = []
  // header: Symbol,Date,Time,Open,High,Low,Close,Volume
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',')
    const sym = (cols[0] || '').trim()
    const o = toNumber(cols[3])
    const c = toNumber(cols[6])
    const v = toNumber(cols[7])
    const ysym = sym.replace(/\.jp$/i, '.T')
    const info = getInfo(ysym)

    out.push({
      ticker: ysym,
      name: info?.name ?? '',
      o, c,
      chgPct: (o && c) ? pct(o, c) : '',
      vol: v ?? '',
      theme: info?.theme ?? '',
      brief: info?.brief ?? ''
    })
  }
  return out
}

// ====== Tables builder (소스 없으면 안전한 빈표 반환) ======
const buildJpxTables = async (): Promise<TablesPayload> => {
  const src = process.env.JPX_SOURCE_URL
  if (!src) {
    return { byValue: [], byVolume: [], gainers: [], losers: [] }
  }
  try {
    const r = await fetch(src, { cache: 'no-store' })
    if (!r.ok) throw new Error(`JPX_SOURCE_URL fetch ${r.status}`)
    const j = await r.json()
    const safe = (a: any): TableRow[] => Array.isArray(a) ? a : []
    return {
      byValue: safe(j.byValue),
      byVolume: safe(j.byVolume),
      gainers: safe(j.gainers),
      losers: safe(j.losers)
    }
  } catch (e) {
    console.warn('JPX_SOURCE_URL failed:', e)
    return { byValue: [], byVolume: [], gainers: [], losers: [] }
  }
}

// ====== Main handler ======
export async function GET(req: NextRequest) {
  try {
    const dateJst = getDateJst(req)
    const url = new URL(req.url)
    const skipQuotes = url.searchParams.get('noQuotes') === '1' || url.searchParams.get('skipQuotes') === '1'
    const topTickers = (url.searchParams.get('tickers')
      ?? '1321.T,1306.T,8035.T,9984.T,7203.T,6758.T,7974.T,8306.T'
    ).split(',').map(s => s.trim()).filter(Boolean)

    // 1) 표 데이터
    const tables = await buildJpxTables()

    // 2) 카드 (야후 → Stooq → 빈배열)
    let cards: TableRow[] = []
    if (!skipQuotes) {
      try {
        cards = await fetchYahooCards(topTickers)
      } catch (e) {
        console.warn('Yahoo quotes failed. Fallback to Stooq.', e)
        try {
          cards = await fetchStooqCards(topTickers)
        } catch (e2) {
          console.warn('Stooq fallback failed.', e2)
          cards = []
        }
      }
    }

    return Response.json({
      ok: true,
      dateJst,
      tables,
      cards
    })

  } catch (err: any) {
    return Response.json({ ok: false, error: String(err?.message || err) }, { status: 500 })
  }
}
