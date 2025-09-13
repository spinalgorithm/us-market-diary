// app/api/jpx-eod/route.ts
import { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

type Quote = {
  symbol: string
  shortName?: string
  regularMarketOpen?: number
  regularMarketPrice?: number
  regularMarketPreviousClose?: number
  regularMarketChangePercent?: number
  regularMarketVolume?: number
  currency?: string
}

type Row = {
  rank?: number
  ticker: string
  name: string
  o: string
  c: string
  chgPct: string
  vol: string
  jpyValueM?: string
  theme?: string
  brief?: string
}

// ===== 설정 =====
const DEFAULT_UNIVERSE = [
  // 인덱스/ETF
  '1321.T', // 日経225 連動型上場投信
  '1306.T', // TOPIX 連動型上場投信
  '1570.T', // 日経平均レバレッジ
  // 메가캡/대표
  '7203.T', // TOYOTA
  '6758.T', // SONY GROUP
  '9984.T', // SOFTBANK GROUP
  '8035.T', // TOKYO ELECTRON
  '6861.T', // KEYENCE
  '6098.T', // RECRUIT
  '9432.T', // NTT
  '9433.T', // KDDI
  '7974.T', // NINTENDO
  '4502.T', // TAKEDA
  '4063.T', // SHIN-ETSU
  '7735.T', // SCREEN
  '6920.T', // LASERTEC
  '8316.T', // SUMITOMO MITSUI
  '8306.T', // MUFG
  '9983.T', // FAST RETAILING
  '6752.T', // PANASONIC
  '7267.T', // HONDA
]

const THEMES: Record<string, { theme: string; brief: string }> = {
  // ETF / 인덱스
  '1321.T': { theme: 'インデックス/ETF', brief: '日経225連動ETF' },
  '1306.T': { theme: 'インデックス/ETF', brief: 'TOPIX連動ETF' },
  '1570.T': { theme: 'インデックス/ETF', brief: '日経平均レバレッジETF' },
  // 대형 섹터
  '7203.T': { theme: '自動車/モビリティ', brief: '自動車メーカー（トヨタ）' },
  '6758.T': { theme: 'エレクトロニクス/エンタメ', brief: 'ソニー（エレクトロニクス・ゲーム）' },
  '9984.T': { theme: '投資持株/テック', brief: 'ソフトバンクG（投資持株）' },
  '8035.T': { theme: '半導体/製造装置', brief: '東京エレクトロン（半導体製造装置）' },
  '6861.T': { theme: '計測/FA', brief: 'キーエンス（センサー/FA）' },
  '6098.T': { theme: '人材/プラットフォーム', brief: 'リクルートHD（人材/メディア）' },
  '9432.T': { theme: '通信', brief: 'NTT（通信）' },
  '9433.T': { theme: '通信', brief: 'KDDI（通信）' },
  '7974.T': { theme: 'ゲーム/エンタメ', brief: '任天堂（ゲーム）' },
  '4502.T': { theme: '製薬', brief: '武田薬品（製薬）' },
  '4063.T': { theme: '化学/素材', brief: '信越化学工業（化学/半導体材料）' },
  '7735.T': { theme: '半導体/製造装置', brief: 'SCREEN（半導体製造装置）' },
  '6920.T': { theme: '半導体/検査装置', brief: 'レーザーテック（半導体検査）' },
  '8316.T': { theme: '銀行/金融', brief: '三井住友FG（メガバンク）' },
  '8306.T': { theme: '銀行/金融', brief: '三菱UFJ（メガバンク）' },
  '9983.T': { theme: '小売/アパレル', brief: 'ファーストリテイリング（ユニクロ）' },
  '6752.T': { theme: 'エレクトロニクス', brief: 'パナソニック（家電/B2B）' },
  '7267.T': { theme: '自動車/モビリティ', brief: 'ホンダ（自動車）' },
}

function fmt(n?: number, d = 2) {
  if (n === undefined || n === null || Number.isNaN(n)) return ''
  return new Intl.NumberFormat('ja-JP', { minimumFractionDigits: d, maximumFractionDigits: d }).format(n)
}
function fmtInt(n?: number) {
  if (n === undefined || n === null || Number.isNaN(n)) return ''
  return new Intl.NumberFormat('ja-JP').format(Math.round(n))
}
function jpyMillions(price?: number, vol?: number) {
  if (!price || !vol) return ''
  const v = (price * vol) / 1_000_000 // 百万円
  return new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 1 }).format(v)
}

async function fetchYahooQuotes(symbols: string[]): Promise<Quote[]> {
  // Yahoo Finance quote API (非公式). サーバー側fetchはCORS影響 없음.
  const url = 'https://query1.finance.yahoo.com/v7/finance/quote?symbols=' + encodeURIComponent(symbols.join(','))
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, cache: 'no-store' })
  if (!r.ok) throw new Error(`Yahoo quote error: ${r.status}`)
  const j = await r.json()
  return (j?.quoteResponse?.result ?? []) as Quote[]
}

function toRow(q: Quote): Row {
  const o = q.regularMarketOpen ?? q.regularMarketPreviousClose ?? q.regularMarketPrice ?? 0
  const c = q.regularMarketPrice ?? q.regularMarketPreviousClose ?? 0
  const chgPct = q.regularMarketChangePercent
  const vol = q.regularMarketVolume
  const meta = THEMES[q.symbol] ?? { theme: 'その他/テーマ不明', brief: q.shortName || '' }
  return {
    ticker: q.symbol,
    name: q.shortName || q.symbol,
    o: o ? fmt(o, 2) : '',
    c: c ? fmt(c, 2) : '',
    chgPct: chgPct !== undefined ? fmt(chgPct, 2) : '',
    vol: vol !== undefined ? fmtInt(vol) : '',
    jpyValueM: jpyMillions(c || o, vol),
    theme: meta.theme,
    brief: meta.brief || '',
  }
}

export async function GET(req: NextRequest) {
  try {
    const universeParam = req.nextUrl.searchParams.get('tickers')
    const universe = (universeParam?.split(',').map(s => s.trim()).filter(Boolean)) ||
      (process.env.JPX_TICKERS?.split(',').map(s => s.trim()).filter(Boolean)) ||
      DEFAULT_UNIVERSE

    const quotes = await fetchYahooQuotes(universe)
    const rows = quotes.map(toRow)

    // 랭킹 만들기 (유니버스 내에서만): 売買代金/出来高/上昇/下落
    const byValue = [...rows]
      .filter(r => r.jpyValueM)
      .sort((a, b) => (Number(b.jpyValueM!.replace(/,/g, '')) - Number(a.jpyValueM!.replace(/,/g, ''))))
      .slice(0, 10)
      .map((r, i) => ({ ...r, rank: i + 1 }))

    const byVolume = [...rows]
      .filter(r => r.vol)
      .sort((a, b) => (Number(b.vol!.replace(/,/g, '')) - Number(a.vol!.replace(/,/g, ''))))
      .slice(0, 10)
      .map((r, i) => ({ ...r, rank: i + 1 }))

    const gainers = [...rows]
      .filter(r => r.chgPct !== '')
      .filter(r => {
        const price = Number((r.c || r.o).replace(/,/g, ''))
        return price >= 1000 // 1,000円以上のみ
      })
      .sort((a, b) => (Number(b.chgPct) - Number(a.chgPct)))
      .slice(0, 10)
      .map((r, i) => ({ ...r, rank: i + 1 }))

    const losers = [...rows]
      .filter(r => r.chgPct !== '')
      .filter(r => {
        const price = Number((r.c || r.o).replace(/,/g, ''))
        return price >= 1000
      })
      .sort((a, b) => (Number(a.chgPct) - Number(b.chgPct)))
      .slice(0, 10)
      .map((r, i) => ({ ...r, rank: i + 1 }))

    // 카드용 추천 (ETF + 메가캡 몇 개)
    const prefer = ['1321.T', '1306.T', '7203.T', '8035.T', '9984.T', '6758.T', '7974.T']
    const cards = rows.filter(r => prefer.includes(r.ticker))

    const now = new Date()
    const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000)
    const dateJst = jst.toISOString().slice(0, 10)

    return new Response(
      JSON.stringify({
        ok: true,
        dateJst,
        universe,
        cards,
        tables: { byValue, byVolume, gainers, losers },
      }),
      { headers: { 'Content-Type': 'application/json; charset=utf-8' } }
    )
  } catch (err: any) {
    return new Response(JSON.stringify({ ok: false, error: String(err?.message || err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    })
  }
}
