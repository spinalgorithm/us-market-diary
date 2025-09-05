import { NextRequest } from 'next/server'
import OpenAI from 'openai'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ==== ENV ====
const POLYGON_API_KEY = process.env.POLYGON_API_KEY || ''
const OPENAI_API_KEY  = process.env.OPENAI_API_KEY || ''   // 없으면 본문은 폴백
const OPENAI_MODEL    = process.env.OPENAI_MODEL || 'gpt-5' // ?model= 로 덮어쓰기 가능

// ==== Utils ====
type AnyRow = Record<string, any>
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const num = (v: any): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN
  return Number.isFinite(n) ? n : null
}
const pick = (r: AnyRow, keys: string[]) => { for (const k of keys) if (r[k] != null) return r[k] }
const extractFields = (r: AnyRow) => {
  const symbol = String(pick(r, ['symbol','ticker','T']) || '').trim()
  const open   = num(pick(r, ['open','o','price_open']))
  const close  = num(pick(r, ['close','c','price_close','price']))
  const vwap   = num(pick(r, ['vwap','vw']))
  const volume = num(pick(r, ['volume','v','share_volume']))
  let chgPct   = num(pick(r, ['chgPct','changePercent','change_pct','changesPercentage']))
  if (chgPct == null && open != null && close != null && open !== 0) chgPct = ((close - open) / open) * 100
  return { symbol, open, close, vwap, volume, chgPct }
}
const normalizeRow = (r: AnyRow) => {
  const f = extractFields(r)
  const px = f.close ?? f.vwap ?? f.open ?? null
  const dollar = (px && f.volume) ? px * f.volume : null
  return { ...r, ...f, px, dollar }
}
function uniq<T>(arr: T[]) {
  const s = new Set<string>(); const out: T[] = []
  for (const x of arr) { const k = typeof x === 'string' ? x : JSON.stringify(x)
    if (!s.has(k)) { s.add(k); out.push(x) } }
  return out
}

// ==== ETF 라벨 ====
const ETF_SET = new Set([
  'SPY','QQQ','DIA','IWM','VTI','VOO','XLF','XLK','XLE','XLV','XLY','XLI','XLP','XLU',
  'SOXL','SOXS','SQQQ','TQQQ','UVXY','TLT','TSLL','TSLS','BITO','SDS','SH','PSQ'
])
const ETF_INV_SET = new Set(['SQQQ','SOXS','UVXY','SDS','SH','PSQ','TSLS'])

// ==== Polygon grouped ====
function formatEtYmd(d: Date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone:'America/New_York', year:'numeric', month:'2-digit', day:'2-digit' }).format(d)
}
async function fetchGrouped(dateEt: string) {
  const url = `https://api.polygon.io/v2/aggs/grouped/locale/us/market/stocks/${dateEt}?adjusted=true&apiKey=${POLYGON_API_KEY}`
  const r = await fetch(url, { cache:'no-store' })
  if (!r.ok) throw new Error(`Polygon grouped ${r.status}`)
  return r.json()
}
async function resolveTradingDay(preferred?: string) {
  if (!POLYGON_API_KEY) throw new Error('POLYGON_API_KEY missing')
  if (preferred) {
    try {
      const j = await fetchGrouped(preferred)
      if (Array.isArray(j?.results) && j.results.length > 200) return { dateEt: preferred, results: j.results }
    } catch { /* fallback */ }
  }
  for (let back=0; back<7; back++) {
    const cand = formatEtYmd(new Date(Date.now() - back*86400000))
    try {
      const j = await fetchGrouped(cand)
      if (Array.isArray(j?.results) && j.results.length > 200) return { dateEt: cand, results: j.results }
    } catch {}
    await sleep(120)
  }
  throw new Error('No trading day found (last 7d)')
}

// ==== Reference: 섹터/산업 보강 ====
// v1(company) -> v3(reference/tickers) 순으로 시도
type RefInfo = { symbol:string, sector?:string, industry?:string, sic_description?:string, name?:string, type?:string }
async function fetchCompanyV1(sym: string): Promise<Partial<RefInfo>|null> {
  const u = `https://api.polygon.io/v1/meta/symbols/${encodeURIComponent(sym)}/company?apiKey=${POLYGON_API_KEY}`
  const r = await fetch(u, { cache:'no-store' })
  if (!r.ok) return null
  const j = await r.json()
  return {
    symbol: sym,
    sector: j?.sector,
    industry: j?.industry,
    name: j?.name || j?.logo || undefined,
  }
}
async function fetchTickerV3(sym: string): Promise<Partial<RefInfo>|null> {
  const u = `https://api.polygon.io/v3/reference/tickers/${encodeURIComponent(sym)}?apiKey=${POLYGON_API_KEY}`
  const r = await fetch(u, { cache:'no-store' })
  if (!r.ok) return null
  const j = await r.json()
  const res = j?.results || {}
  return {
    symbol: sym,
    name: res.name,
    type: res.type,
    sic_description: res.sic_description,
  }
}
function mapTheme(sym: string, info?: Partial<RefInfo>): string {
  if (ETF_INV_SET.has(sym)) return 'インバース/レバレッジETF'
  if (ETF_SET.has(sym))    return 'インデックス/ETF'
  const S = (info?.sector||'').toLowerCase()
  const I = (info?.industry||'').toLowerCase()
  const D = (info?.sic_description||'').toLowerCase()
  const N = (info?.name||'').toLowerCase()
  const blob = `${S} ${I} ${D} ${N}`

  if (/semiconductor|semi|chip|foundry|nvidia|broadcom/.test(blob)) return '半導体/AIインフラ'
  if (/software|cloud|saas|ai|cyber|security|data/.test(blob))     return 'ソフトウェア/AI'
  if (/pharma|biotech|biolog|therapeutic|medical|health/.test(blob))return 'バイオ/ヘルスケア'
  if (/retail|e-?commerce|apparel|store|online shop|mall/.test(blob)) return '小売/EC'
  if (/automobile|auto|vehicle|ev|mobility|battery|tesla/.test(blob)) return 'EV/モビリティ'
  if (/energy|oil|gas|petroleum|refining|coal|uranium/.test(blob))    return 'エネルギー'
  if (/bank|financial|insurance|broker|asset|credit|lending|capital/.test(blob)) return '金融'
  if (/real estate|reit|property|mortgage/.test(blob))                return '不動産/REIT'
  if (/telecom|communication|wireless|satellite/.test(blob))          return '通信'
  if (/industrial|manufactur|aerospace|defense|machinery/.test(blob)) return '産業/防衛'
  if ((info?.type === 'W') || /(\.W|[-\.]WS|W$)$/.test(sym))          return 'ワラント/権利'
  return 'その他/テーマ不明'
}
async function annotateThemes(symbols: string[]) {
  const out = new Map<string, { theme:string, info?:Partial<RefInfo> }>()
  const uniqSyms = uniq(symbols).slice(0, 120)
  for (const sym of uniqSyms) {
    let info: Partial<RefInfo> | null = null
    try { info = await fetchCompanyV1(sym) } catch {}
    if (!info) { try { info = await fetchTickerV3(sym) } catch {} }
    const theme = mapTheme(sym, info || undefined)
    out.set(sym, { theme, info: info || undefined })
    await sleep(40) // 우발적 레이트리밋 완화
  }
  return out
}

// ==== 리스트 만들기/표 ====
function buildTopN(rows: AnyRow[], key: 'dollar'|'volume', minLen=10) {
  const arr = rows.map(normalizeRow)
  let primary = arr.filter(r => key==='dollar' ? r.dollar : r.volume)
                   .sort((a,b)=> key==='dollar' ? (b.dollar!-a.dollar!) : (b.volume!-a.volume!))
  if (primary.length < minLen) {
    const backup = arr.filter(r => !primary.includes(r) && (key==='dollar'? r.volume : r.dollar))
                      .sort((a,b)=> key==='dollar' ? (b.volume!-a.volume!) : (b.dollar!-a.dollar!))
    primary = [...primary, ...backup]
  }
  if (primary.length < minLen) {
    const filler = arr.filter(r => r.px && !primary.includes(r))
    primary = [...primary, ...filler]
  }
  const seen = new Set<string>(); const dedup: AnyRow[]=[]
  for (const r of primary) { const k = r.symbol
    if (k && !seen.has(k)) { seen.add(k); dedup.push(r) } }
  return dedup.slice(0, minLen)
}
const fmt = {
  int: (v:any)=> (num(v)==null? '—' : Math.trunc(Number(v)).toLocaleString()),
  pct: (v:any)=> (num(v)==null? '—' : `${Number(v).toFixed(2)}`),
  o2c: (o:any,c:any)=> { const oo=num(o), cc=num(c)
    if (oo==null && cc==null) return '—'
    const a = oo==null ? '—' : `${oo}`; const b = cc==null ? '—' : `${cc}`; return `${a}→${b}` },
  moneyM: (d:any)=> (num(d)==null? '—' : `${(Number(d)/1_000_000).toFixed(1)}`),
}
function renderTable(rows: AnyRow[], themeMap: Map<string,{theme:string}>) {
  const head = `| Rank | Ticker | o→c | Chg% | Vol | $Vol(M) | Themes |
|---:|---|---|---:|---:|---:|---|`
  const body = rows.map((r:AnyRow,i:number)=>{
    const sym = r.symbol
    const t   = themeMap.get(sym)?.theme ?? (ETF_SET.has(sym)? 'インデックス/ETF':'その他/テーマ不明')
    return `| ${i+1} | ${sym} | ${fmt.o2c(r.open,r.close)} | ${fmt.pct(r.chgPct)} | ${fmt.int(r.volume)} | ${fmt.moneyM(r.dollar)} | ${t} |`
  }).join('\n')
  return `${head}\n${body}\n`
}

// ==== LLM 기사(일본어/노트 톤) ====
async function writeStoryJa(model: string, cards: AnyRow[], themeMap: Map<string,{theme:string}>, tablesMd: string, dateEt: string) {
  if (!OPENAI_API_KEY) {
    return [
      `# 米国 夜間警備員 日誌 | ${dateEt}`,
      `LLMは未設定のため本文は簡略化。下の表をご確認ください。`,
      tablesMd
    ].join('\n\n')
  }
  const client = new OpenAI({ apiKey: OPENAI_API_KEY })
  const sys = [
    'あなたは米国市場を巡回する「夜間警備員」。日本語でNote向けEOD記事を書く専門編集者。',
    '数値は提供されたカード/表の o→c, Chg%, Vol のみを使用。目標価格・将来予測・未出所の数値は禁止。',
    '見出し→カード解説→30分リプレイ(事実)→EOD総括→明日のチェック(5)→テーマ・クラスター→表 の順。',
    '文体は簡潔で余白多め、比喩は軽く。ETFは必ず「インデックス/ETF」や「インバース/レバレッジETF」と明記。'
  ].join(' ')
  const cardLines = cards.map(r=>{
    const sym=r.symbol
    const theme = themeMap.get(sym)?.theme || (ETF_SET.has(sym)? 'インデックス/ETF':'その他/テーマ不明')
    return `- ${sym}（${theme}）: o→c ${fmt.o2c(r.open,r.close)}, Chg% ${fmt.pct(r.chgPct)}, Vol ${fmt.int(r.volume)}`
  }).join('\n')
  const prompt = [
    `# 見出し`,
    `夜間巡回報告：主役は静かに高く、インデックス/ETFとメガテックが足並みをそろえて引けた`,
    ``,
    `# カード（根拠データ）`,
    cardLines,
    ``,
    `# テーブル（根拠データ/そのまま使ってOK）`,
    tablesMd,
    ``,
    `# 指示`,
    `- カードごとに2~3文で要点。テーマ名はカッコで入れる。`,
    `- 「30分リプレイ」は事実描写のみ(上昇/下落/出来高の強弱)。`,
    `- 「EOD総括」は1~2段落で市場のムードを要約。`,
    `- 「明日のチェックリスト」は5項目、各1行。`,
    `- 最後に「テーマ・クラスター」を箇条書きで。`,
    `- その後に上の表(テキスト)をそのまま再掲。`
  ].join('\n')

  const completion = await client.chat.completions.create({
    model,
    messages: [
      { role:'system', content: sys },
      { role:'user',   content: prompt }
    ]
  })
  return (completion.choices?.[0]?.message?.content || '').trim()
}

// ==== Main ====
export async function GET(req: NextRequest) {
  try {
    const u = new URL(req.url)
    const qDate  = u.searchParams.get('date') || undefined
    const qModel = u.searchParams.get('model') || OPENAI_MODEL

    // 1) 거래일 판별 + 집계
    const { dateEt, results } = await resolveTradingDay(qDate)
    const universe = (Array.isArray(results)? results: []).map(normalizeRow)
      .filter(r => r.symbol && r.symbol.length <= 8) // 잡음 축출

    // 2) Top 리스트
    const topDollar = buildTopN(universe, 'dollar', 10)
    const topVolume = buildTopN(universe, 'volume', 10)
    const is10p = (r:AnyRow)=> r.px && r.px >= 10
    const gainers10 = universe.filter(r=> is10p(r) && r.chgPct!=null && r.chgPct>0).sort((a,b)=> b.chgPct!-a.chgPct!).slice(0,10)
    const losers10  = universe.filter(r=> is10p(r) && r.chgPct!=null && r.chgPct<0).sort((a,b)=> a.chgPct!-b.chgPct!).slice(0,10)

    // 3) 테마 주석용 대상 수집
    const cardWish = ['SPY','QQQ','NVDA','TSLA','AMZN','GOOGL','AAPL','AVGO']
    const symSet = uniq([
      ...cardWish,
      ...topDollar.map(r=>r.symbol),
      ...topVolume.map(r=>r.symbol),
      ...gainers10.map(r=>r.symbol),
      ...losers10.map(r=>r.symbol),
    ])
    const themeMap = await annotateThemes(symSet)

    // 4) 카드 채우기(원하는 심볼 우선, 부족시 보충)
    const bySym = new Map(universe.map(r=>[r.symbol, r]))
    const cards: AnyRow[] = []
    for (const s of cardWish) if (bySym.has(s)) cards.push(bySym.get(s)!)
    for (const r of gainers10.slice(0,2)) if (!cards.find(x=>x.symbol===r.symbol)) cards.push(r)
    for (const r of topDollar.slice(0,2)) if (!cards.find(x=>x.symbol===r.symbol)) cards.push(r)

    // 5) 표 생성(테마 포함)
    const tablesMd = [
      '## 📊 データ(Top10)',
      '### Top 10 — 取引代金（ドル）',
      renderTable(topDollar, themeMap),
      '### Top 10 — 出来高（株数）',
      renderTable(topVolume, themeMap),
      '### Top 10 — 上昇株（$10+）',
      renderTable(gainers10, themeMap),
      '### Top 10 — 下落株（$10+）',
      renderTable(losers10, themeMap),
      '\n#米国株 #夜間警備員 #米株マーケット #ナスダック #S&P500 #テーマ #上昇株 #下落株 #出来高'
    ].join('\n\n')

    // 6) 본문(LLM) or 폴백
    const markdown = await writeStoryJa(qModel, cards, themeMap, tablesMd, dateEt)

    return Response.json({
      ok: true,
      dateEt,
      markdown,
      counts: {
        universe: universe.length,
        topDollar: topDollar.length,
        topVolume: topVolume.length,
        gainers10: gainers10.length,
        losers10: losers10.length
      }
    }, { headers: { 'Cache-Control':'no-store' }})
  } catch (e:any) {
    return Response.json({ ok:false, error: String(e?.message||e) }, { status:500 })
  }
}
