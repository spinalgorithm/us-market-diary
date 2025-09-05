import { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

// ==== ENV ====
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5' // or 'gpt-5-mini'
const POLYGON_API_KEY = process.env.POLYGON_API_KEY || ''

// ==== tiny utils ====
async function jfetch<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { ...init, cache: 'no-store' })
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}: ${await r.text()}`)
  return r.json() as Promise<T>
}
const safeNum = (v: any, d = 0) => (Number.isFinite(+v) ? +v : d)
const uniq = <T,>(arr: T[]) => Array.from(new Set(arr))

// ==== types ====
type Row = {
  Ticker: string
  o: number
  c: number
  chgPct: number
  vol: number
  dollarVolM: number
  theme?: string
  brief?: string
}
type EOD = {
  dateEt: string
  mostActive: Row[]
  topDollar: Row[]
  topGainers10: Row[]
  topLosers10: Row[]
}

// ==== Theme tag sets ====
const ETF_INV = new Set(['SQQQ','SOXS','SPXS','TZA','FAZ','LABD','TBT','UVXY'])
const ETF_IDX = new Set(['SPY','QQQ','DIA','IWM','VTI','VOO','XLK','XLF','XLE','XLY','XLI','XLV','XLP','XLU','XLC','SMH','SOXL','SOXS','TSLL','TQQQ'])
const SEMIS = new Set(['NVDA','AVGO','AMD','TSM','ASML','AMAT','LRCX','MU','INTC','SOXL','SOXS','SMH'])
const MEGA_SOFT_AI = new Set(['MSFT','GOOGL','AMZN','META','CRM','ADBE','ORCL','PLTR'])
const EV_MOB = new Set(['TSLA','NIO','LI','RIVN','F','GM','TSLL'])
const EC_RETAIL = new Set(['AMZN','SHOP','MELI','NEGG','AEO','DLTH','WMT','COST'])
const BIO_HEALTH = new Set(['NVO','PFE','MRK','BMY','AZN','REGN','VRTX','NBY','IONS','RAPT','STSS'])

function labelTheme(t: string) {
  if (ETF_INV.has(t)) return 'インバース/レバレッジETF'
  if (ETF_IDX.has(t)) return 'インデックス/ETF'
  if (SEMIS.has(t)) return '半導体/AIインフラ'
  if (MEGA_SOFT_AI.has(t)) return 'ソフトウェア/AI'
  if (EV_MOB.has(t)) return 'EV/モビリティ'
  if (EC_RETAIL.has(t)) return 'EC/小売'
  if (BIO_HEALTH.has(t)) return 'バイオ/ヘルスケア'
  return 'その他/テーマ不明'
}

// ==== Polygon grouped aggs fallback ====
function prevWeekdayETISO(today = new Date()): string {
  const d = new Date(today)
  d.setUTCDate(d.getUTCDate() - 1)
  while ([0,6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0,10)
}
type PolygonGrouped = {
  results?: Array<{ T: string; v: number; o: number; c: number }>
}
async function pullFromPolygonOrThrow(dateEt: string): Promise<EOD> {
  if (!POLYGON_API_KEY) throw new Error('POLYGON_API_KEY missing')
  const url = `https://api.polygon.io/v2/aggs/grouped/locale/us/market/stocks/${dateEt}?adjusted=true&apiKey=${POLYGON_API_KEY}`
  const j = await jfetch<PolygonGrouped>(url)
  const rows = (j.results || [])
    .filter(r => r && r.T && Number.isFinite(r.o) && Number.isFinite(r.c) && Number.isFinite(r.v))
    .map(r => ({
      Ticker: r.T.toUpperCase(),
      o: +r.o, c: +r.c,
      chgPct: (r.c / (r.o || 1) - 1) * 100,
      vol: +r.v,
      dollarVolM: (+r.v * +r.c) / 1_000_000
    }))

  const byDollar = [...rows].sort((a,b)=> b.dollarVolM - a.dollarVolM).slice(0,10)
  const byVol = [...rows].sort((a,b)=> b.vol - a.vol).slice(0,10)
  const gainers10 = rows.filter(r => r.c >= 10).sort((a,b)=> b.chgPct - a.chgPct).slice(0,10)
  const losers10 = rows.filter(r => r.c >= 10).sort((a,b)=> a.chgPct - b.chgPct).slice(0,10)

  return { dateEt, mostActive: byVol, topDollar: byDollar, topGainers10: gainers10, topLosers10: losers10 }
}

// ==== Try local base endpoints first ====
async function getBaseEOD(origin: string, date: string | null): Promise<EOD | null> {
  const tryPaths = [
    `${origin}/api/eod${date ? `?date=${date}` : ''}`,
    `${origin}/api/eod-lite${date ? `?date=${date}` : ''}`,
  ]
  for (const u of tryPaths) {
    try {
      const j: any = await jfetch<any>(u)
      const root = j?.data ? j.data : j
      if (!root) continue
      const dateEt = String(root.dateEt || '')
      const mk = (arr: any[]) => (arr || []).map(r => ({
        Ticker: String(r.Ticker || r.ticker || '').toUpperCase(),
        o: safeNum(r.o ?? r.open, 0),
        c: safeNum(r.c ?? r.close, 0),
        chgPct: safeNum(r.chgPct ?? r.ChgPct ?? r.chg ?? r.Chg, 0),
        vol: safeNum(r.vol ?? r.volume, 0),
        dollarVolM: safeNum(r.dollarVolM ?? r.dollarVol ?? r.$VolM, 0),
      }))
      const eod: EOD = {
        dateEt,
        mostActive: mk(root.mostActive),
        topDollar: mk(root.topDollar),
        topGainers10: mk(root.topGainers10),
        topLosers10: mk(root.topLosers10),
      }
      if (eod.topDollar?.length && eod.mostActive?.length) return eod
    } catch { /* next */ }
  }
  return null
}

// ==== Brief (one-liners) ====
// 1) Static briefs for well-known tickers/ETFs
const STATIC_BRIEF: Record<string,string> = {
  // ETFs
  SPY: 'S&P500連動ETF',
  QQQ: 'NASDAQ100連動ETF',
  DIA: 'ダウ平均連動ETF',
  IWM: 'ラッセル2000連動ETF',
  SMH: '半導体セクターETF',
  SOXL: '半導体指数ブル3倍ETF',
  SOXS: '半導体指数ベア3倍ETF',
  SQQQ: 'NASDAQ100ベア3倍ETF',
  TSLL: 'テスラ連動レバレッジETF',
  UVXY: 'VIX先物連動レバレッジETF',

  // Mega / large caps
  NVDA: 'GPU/AI半導体大手',
  AMD: 'CPU/GPU半導体',
  AVGO: '半導体・通信インフラ',
  INTC: '半導体(プロセッサ)',
  AMZN: 'ECとクラウド(AWS)',
  GOOGL: '検索・広告・クラウド',
  AAPL: 'デバイスとサービス',
  MSFT: 'OS/クラウド/AI',
  META: 'SNSと広告',
  CRM: '企業向けSaaS',
  ORCL: 'エンタープライズDB/クラウド',
  ADBE: 'クリエイティブSaaS',
  PLTR: 'データ分析プラットフォーム',
  TSLA: 'EVとエネルギー',

  // Others seen often
  OPEN: '不動産売買プラットフォーム',
  NEGG: 'PC・家電EC',
  AEO: '衣料小売',
  RAPT: 'バイオ/ヘルスケア',
  STSS: '医療関連',
  SMR: '小型モジュール原子炉',
}

// 2) Simple translation mapping for common SIC words
function jpFromSic(sic?: string): string | null {
  if (!sic) return null
  const s = sic.toLowerCase()
  if (s.includes('semiconductor')) return '半導体'
  if (s.includes('computer') || s.includes('software') || s.includes('data')) return 'ソフトウェア/ITサービス'
  if (s.includes('retail')) return '小売'
  if (s.includes('wholesale') || s.includes('distribut')) return '流通/卸'
  if (s.includes('pharma') || s.includes('biolog') || s.includes('biotech')) return '製薬/バイオ'
  if (s.includes('aerospace') || s.includes('defense')) return '航空宇宙/防衛'
  if (s.includes('electr') && s.includes('service')) return '電力/ユーティリティ'
  if (s.includes('oil') || s.includes('petroleum') || s.includes('gas')) return 'エネルギー'
  if (s.includes('bank') || s.includes('financ')) return '金融'
  if (s.includes('telecom') || s.includes('communication')) return '通信'
  return null
}

// 3) Fallback brief from theme
function briefFromTheme(theme: string): string {
  switch (theme) {
    case 'インデックス/ETF': return '指数連動ETF'
    case 'インバース/レバレッジETF': return 'ベア/レバレッジETF'
    case '半導体/AIインフラ': return '半導体/AIインフラ関連'
    case 'ソフトウェア/AI': return 'ソフト/AI関連'
    case 'EV/モビリティ': return 'EV/モビリティ関連'
    case 'EC/小売': return 'EC/小売'
    case 'バイオ/ヘルスケア': return 'バイオ/ヘルスケア'
    default: return '—'
  }
}

// 4) Polygon reference lookup (optional)
type PolyRef = {
  results?: {
    ticker: string
    name?: string
    type?: string // 'CS','AD','ETF'...
    sic_description?: string
  }
}
async function polyBrief(ticker: string): Promise<string | null> {
  if (!POLYGON_API_KEY) return null
  try {
    const url = `https://api.polygon.io/v3/reference/tickers/${encodeURIComponent(ticker)}?apiKey=${POLYGON_API_KEY}`
    const j = await jfetch<PolyRef>(url)
    const r = j.results
    if (!r) return null
    if (r.type === 'ETF') {
      // 参照名からETFっぽい一行に
      if (ticker === 'SPY') return 'S&P500連動ETF'
      if (ticker === 'QQQ') return 'NASDAQ100連動ETF'
      return 'ETF'
    }
    const sicJp = jpFromSic(r.sic_description || '')
    if (sicJp && r.name) return `${sicJp}（${r.name}）`
    if (sicJp) return sicJp
    if (r.name) return r.name
    return null
  } catch {
    return null
  }
}

// 5) Concurrency limiter for many lookups
async function pMap<T, R>(list: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const ret: R[] = []
  let idx = 0
  const workers = Array(Math.min(limit, list.length)).fill(0).map(async () => {
    while (idx < list.length) {
      const i = idx++
      ret[i] = await fn(list[i])
    }
  })
  await Promise.all(workers)
  return ret
}

async function enrichBriefs(rows: Row[]): Promise<Record<string,string>> {
  const tickers = uniq(rows.map(r => r.Ticker))
  const out: Record<string,string> = {}
  // 1) static
  for (const t of tickers) {
    if (STATIC_BRIEF[t]) out[t] = STATIC_BRIEF[t]
  }
  // 2) theme fallback (temporary placeholders)
  for (const t of tickers) {
    if (out[t]) continue
    const theme = labelTheme(t)
    out[t] = briefFromTheme(theme)
  }
  // 3) polygon detail to improve unknowns (only when key provided)
  if (POLYGON_API_KEY) {
    const fillTargets = tickers.filter(t => out[t] === '—' || out[t] === 'EC/小売' || out[t] === 'ソフト/AI関連' || out[t] === '半導体/AIインフラ関連')
    const results = await pMap(fillTargets, 6, async (t) => {
      const b = await polyBrief(t)
      return { t, b }
    })
    for (const r of results) {
      if (r.b) out[r.t] = r.b
    }
  }
  return out
}

// ==== Signals for narrative ====
function buildSignals(eod: EOD) {
  const find = (arr: Row[], t: string) => arr.find(x => x.Ticker === t)
  const td = eod.topDollar, tv = eod.mostActive
  const spy = find(td, 'SPY') || find(tv, 'SPY')
  const qqq = find(td, 'QQQ') || find(tv, 'QQQ')
  const soxs = find(tv, 'SOXS') || find(td, 'SOXS')
  const nvda = find(td, 'NVDA') || find(tv, 'NVDA')
  const riskOn = (spy?.chgPct ?? 0) > 0 && (qqq?.chgPct ?? 0) > 0 && (soxs?.chgPct ?? 0) < 0
  const semiStrong = (nvda?.chgPct ?? 0) >= 0 && (nvda?.vol ?? 0) > 5e7
  const adv = td.filter(x => x.chgPct > 0).length
  const dec = td.length - adv
  return { riskOn, semiStrong, adv, dec }
}

// ==== OpenAI (minimal params only) ====
async function complete(model: string, system: string, user: string) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
  })
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}: ${await r.text()}`)
  const j = await r.json()
  return j.choices?.[0]?.message?.content?.trim() || ''
}

// ==== Route ====
export async function GET(req: NextRequest) {
  try {
    const { origin, searchParams } = req.nextUrl
    const lang = (searchParams.get('lang') || 'ja').toLowerCase()
    const model = searchParams.get('model') || OPENAI_MODEL
    const dateParam = searchParams.get('date') // YYYY-MM-DD

    // 1) base EOD from local endpoints
    let eod = await getBaseEOD(origin, dateParam)
    // 2) fallback to Polygon
    if (!eod) {
      const dateEt = dateParam || prevWeekdayETISO()
      eod = await pullFromPolygonOrThrow(dateEt)
    }

    // 3) theme + brief
    const tag = (r: Row) => ({ ...r, theme: labelTheme(r.Ticker) })
    const td0 = eod.topDollar.map(tag)
    const tv0 = eod.mostActive.map(tag)
    const tg0 = eod.topGainers10.map(tag)
    const tl0 = eod.topLosers10.map(tag)
    const briefMap = await enrichBriefs([...td0, ...tv0, ...tg0, ...tl0])
    const td = td0.map(r => ({ ...r, brief: briefMap[r.Ticker] }))
    const tv = tv0.map(r => ({ ...r, brief: briefMap[r.Ticker] }))
    const tg = tg0.map(r => ({ ...r, brief: briefMap[r.Ticker] }))
    const tl = tl0.map(r => ({ ...r, brief: briefMap[r.Ticker] }))

    // 4) signals
    const sig = buildSignals(eod)

    // 5) tables with Brief column
    const header =
`| Rank | Ticker | o→c | Chg% | Vol | $Vol(M) | Themes | Brief |
|---:|---|---|---:|---:|---:|---|---|`
    const row = (r: Row & {theme:string, brief?:string}, i:number) =>
      `| ${i+1} | ${r.Ticker} | ${r.o.toFixed(2)}→${r.c.toFixed(2)} | ${r.chgPct.toFixed(2)} | ${r.vol.toLocaleString()} | ${r.dollarVolM.toFixed(1)} | ${r.theme} | ${r.brief || '—'} |`
    const table = (rows: (Row & {theme:string, brief?:string})[]) => rows.map(row).join('\n')

    const mdTables = `
### Top 10 — 取引代金（ドル）
${header}
${table(td)}

### Top 10 — 出来高（株数）
${header}
${table(tv)}

### Top 10 — 上昇株（$10+）
${header}
${table(tg)}

### Top 10 — 下落株（$10+）
${header}
${table(tl)}
`.trim()

    // 6) narrative prompt (日本語固定)
    const sys = `
あなたはnote.comで毎晩配信する「夜間警備員」の筆者です。出力は必ず日本語。
構成: 見出し1行→カード解説(主要12銘柄/各2行以内)→30分リプレイ→EOD総括→明日のチェック(5項目)→シナリオ(反発継続/もみ合い/反落 各2サイン)→テーマ・クラスター→最後に表(そのまま貼付)。
未来予測や目標価格の断定は禁止。数値は表の o→c / Chg% / Vol / $Vol(M) のみ引用可。`.trim()

    const user = `
# 米国 夜間警備員 日誌 | ${eod.dateEt}

■ 取引代金上位: ${td.slice(0,6).map(x=>`${x.Ticker}(${x.theme})`).join(', ')}
■ 出来高上位: ${tv.slice(0,6).map(x=>`${x.Ticker}(${x.theme})`).join(', ')}
■ 上昇($10+): ${tg.slice(0,5).map(x=>x.Ticker).join(', ')}
■ 下落($10+): ${tl.slice(0,5).map(x=>x.Ticker).join(', ')}

■ シグナル
- リスクオン傾向: ${sig.riskOn ? 'あり' : '未確定'}
- 半導体の下支え: ${sig.semiStrong ? '確認' : '弱め/中立'}
- 取引代金上位の広がり: 上昇${sig.adv} / 下落${sig.dec}

# 表は下へ。`.trim()

    const markdownBody = await complete(model, sys, user)
    const markdown = `${markdownBody}\n\n${mdTables}`

    return Response.json({
      ok: true,
      dateEt: eod.dateEt,
      markdown,
      analyzed: {
        model,
        usedPolygonFallback: !await getBaseEOD(req.nextUrl.origin, dateParam),
        tickersEnriched: Object.keys(briefMap).length
      }
    })
  } catch (e: any) {
    return Response.json({ ok: false, error: String(e?.message || e) }, { status: 200 })
  }
}
