// /app/api/eod-deep/route.ts
import { NextRequest } from 'next/server'
import OpenAI from 'openai'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ====== ENV ======
const POLYGON_API_KEY = process.env.POLYGON_API_KEY || ''
const OPENAI_API_KEY  = process.env.OPENAI_API_KEY || ''
const OPENAI_MODEL    = process.env.OPENAI_MODEL || 'gpt-5' // 쿼리로 덮어쓸 수 있음

// ====== 소도구 ======
type AnyRow = Record<string, any>
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const num = (v: any): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN
  return Number.isFinite(n) ? n : null
}
const pick = (r: AnyRow, keys: string[]) => {
  for (const k of keys) if (r[k] !== undefined && r[k] !== null) return r[k]
  return undefined
}
const extractFields = (r: AnyRow) => {
  const symbol = (pick(r, ['symbol', 'ticker', 'T']) || '').toString().trim()
  const open   = num(pick(r, ['open', 'o', 'price_open']))
  const close  = num(pick(r, ['close', 'c', 'price_close', 'price']))
  const vwap   = num(pick(r, ['vwap', 'vw']))
  const volume = num(pick(r, ['volume', 'v', 'share_volume']))
  let chgPct   = num(pick(r, ['chgPct', 'changePercent', 'change_pct', 'changesPercentage']))
  if (chgPct === null && open && close && open !== 0) chgPct = ((close - open) / open) * 100
  return { symbol, open, close, vwap, volume, chgPct }
}
const normalizeRow = (r: AnyRow) => {
  const f = extractFields(r)
  const px = f.close ?? f.vwap ?? f.open ?? null
  const dollar = (px && f.volume) ? px * f.volume : null
  return { ...r, ...f, px, dollar }
}
function buildTopN(rows: AnyRow[], key: 'dollar' | 'volume', minLen = 10) {
  const arr = rows.map(normalizeRow)
  let primary = arr
    .filter(r => key === 'dollar' ? r.dollar : r.volume)
    .sort((a, b) => (key === 'dollar' ? (b.dollar! - a.dollar!) : (b.volume! - a.volume!)))
  if (primary.length < minLen) {
    const backup = arr
      .filter(r => !primary.includes(r) && (key === 'dollar' ? r.volume : r.dollar))
      .sort((a, b) => (key === 'dollar' ? (b.volume! - a.volume!) : (b.dollar! - a.dollar!)))
    primary = [...primary, ...backup]
  }
  if (primary.length < minLen) {
    const filler = arr.filter(r => r.px && !primary.includes(r))
    primary = [...primary, ...filler]
  }
  const seen = new Set<string>()
  const deduped: AnyRow[] = []
  for (const r of primary) {
    const k = r.symbol || JSON.stringify(r)
    if (k && !seen.has(k)) { seen.add(k); deduped.push(r) }
  }
  return deduped.slice(0, minLen)
}
const fmt = {
  int: (v: any) => (num(v) === null ? '—' : Math.trunc(Number(v)).toLocaleString()),
  pct: (v: any) => (num(v) === null ? '—' : `${Number(v).toFixed(2)}`),
  o2c: (o: any, c: any) => {
    const oo = num(o), cc = num(c)
    if (oo === null && cc === null) return '—'
    const a = oo === null ? '—' : `${oo}`
    const b = cc === null ? '—' : `${cc}`
    return `${a}→${b}`
  },
  moneyM: (d: any) => (num(d) === null ? '—' : `${(Number(d) / 1_000_000).toFixed(1)}`),
}

// 간단 ETF 라벨링(강화용)
const ETF_SET = new Set([
  'SPY','QQQ','DIA','IWM','VTI','VOO','XLF','XLK','XLE','XLV',
  'SOXL','SOXS','SQQQ','TQQQ','UVXY','TLT','TSLL','TSLS','BITO'
])

// ====== Polygon Grouped Aggs ======
function formatEtYmd(d: Date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(d) // YYYY-MM-DD
}
async function fetchGrouped(dateEt: string) {
  const url = `https://api.polygon.io/v2/aggs/grouped/locale/us/market/stocks/${dateEt}?adjusted=true&apiKey=${POLYGON_API_KEY}`
  const r = await fetch(url, { cache: 'no-store' })
  if (!r.ok) throw new Error(`Polygon ${r.status}`)
  return r.json()
}
async function resolveTradingDay(preferred?: string) {
  if (!POLYGON_API_KEY) throw new Error('POLYGON_API_KEY missing')
  if (preferred) {
    const j = await fetchGrouped(preferred)
    if (Array.isArray(j?.results) && j.results.length > 200) return { dateEt: preferred, results: j.results }
  }
  // 오늘~과거 7일 내에서 "데이터 있는 날" 자동 탐색
  for (let back = 0; back < 7; back++) {
    const cand = formatEtYmd(new Date(Date.now() - back * 86400000))
    try {
      const j = await fetchGrouped(cand)
      if (Array.isArray(j?.results) && j.results.length > 200) return { dateEt: cand, results: j.results }
    } catch { /* skip */ }
    await sleep(150)
  }
  throw new Error('No trading day found in last 7 days')
}

// ====== 표 렌더러 ======
function renderTable(rows: AnyRow[], withTheme = false) {
  const head = `| Rank | Ticker | o→c | Chg% | Vol | $Vol(M)${withTheme ? ' | Themes' : ''} |
|---:|---|---|---:|---:|---:${withTheme ? '|---|' : '|'}`

  const body = rows.map((r: AnyRow, i: number) => {
    const sym = r.symbol || r.ticker || r.T || '—'
    const theme = ETF_SET.has(String(sym)) ? 'インデックス/ETF' : (r.theme ?? 'その他/テーマ不明')
    return `| ${i+1} | ${sym} | ${fmt.o2c(r.open, r.close)} | ${fmt.pct(r.chgPct)} | ${fmt.int(r.volume)} | ${fmt.moneyM(r.dollar)}${withTheme ? ` | ${theme}` : ''} |`
  }).join('\n')
  return `${head}\n${body}\n`
}

// ====== LLM 기사 생성(없어도 표는 출력됨) ======
async function writeStoryJa(model: string, cards: AnyRow[], tablesMd: string, dateEt: string) {
  if (!OPENAI_API_KEY) {
    // LLM 키 없으면 간단 헤더만
    return [
      `# 米国 夜間警備員 日誌 | ${dateEt}`,
      `本文生成はスキップ（LLMキー未設定）。下の表をご覧ください。`,
      tablesMd
    ].join('\n\n')
  }
  const client = new OpenAI({ apiKey: OPENAI_API_KEY })
  const sys =
    'あなたは金融マーケットの夜間警備員。日本語で、臨場感のあるが冷静なEODレポートを書く。' +
    '数値は表にある o→c / Chg% / Vol のみを使用。将来予測・目標価格・未出所の数値は書かない。' +
    'ETFは「インデックス/ETF」と明記し、創作はメタファー程度に留める。'

  const cardLines = cards.map(r => {
    const sym = r.symbol
    const etf = ETF_SET.has(sym) ? '（インデックス/ETF）' : ''
    return `- ${sym}${etf}: o→c ${fmt.o2c(r.open, r.close)}, Chg% ${fmt.pct(r.chgPct)}, Vol ${fmt.int(r.volume)}`
  }).join('\n')

  const prompt =
`# タスク
以下のカードと表（Markdown）だけを根拠に、EODレポートを日本語で作成。
- 見出し、カード解説（各2~3文）、30分リプレイ（事実ベース）、EOD総括、明日のチェックリスト(5項)、テーマ・クラスター(簡潔)、最後に表をそのまま掲載。
- 数値はカード/表の o→c, Chg%, Vol のみ。予測/未出所の数値は禁止。
- 文体は「夜間警備員」一人称。メタファーは軽く。

## カード（事実データ）
${cardLines}

## 表（根拠データ）
${tablesMd}
`

  const completion = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: prompt }
    ]
  })
  const content = completion.choices?.[0]?.message?.content || ''
  return content.trim() || [
    `# 米国 夜間警備員 日誌 | ${dateEt}`,
    tablesMd
  ].join('\n\n')
}

// ====== 메인 핸들러 ======
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url)
    const qDate  = url.searchParams.get('date') || undefined
    const qModel = url.searchParams.get('model') || OPENAI_MODEL

    // 1) 집계 데이터 가져오기(휴장 자동 스킵)
    const { dateEt, results } = await resolveTradingDay(qDate)

    // 2) 유니버스 표준화
    const universeRaw: AnyRow[] = Array.isArray(results) ? results : []
    const seen = new Set<string>()
    const universe = universeRaw.map(normalizeRow).filter(r => {
      const sym = (r.symbol || '').trim()
      if (!sym || seen.has(sym)) return false
      seen.add(sym); return true
    })

    // 3) Top 리스트 만들기
    const topDollar = buildTopN(universe, 'dollar', 10)
    const topVolume = buildTopN(universe, 'volume', 10)

    const is10plus = (r: AnyRow) => r.px && r.px >= 10
    const gainers10 = universe
      .filter(r => is10plus(r) && r.chgPct !== null && r.chgPct! > 0)
      .sort((a, b) => (b.chgPct! - a.chgPct!))
      .slice(0, 10)
    const losers10 = universe
      .filter(r => is10plus(r) && r.chgPct !== null && r.chgPct! < 0)
      .sort((a, b) => (a.chgPct! - b.chgPct!))
      .slice(0, 10)

    // 4) 카드용 대표 티커 선정: 메가캡/ETF 우선 + 급등 상위 일부
    const want = ['SPY','QQQ','NVDA','TSLA','AMZN','GOOGL','AAPL','AVGO']
    const bySym = new Map(universe.map(r => [r.symbol, r]))
    const cards: AnyRow[] = []
    for (const s of want) if (bySym.has(s)) cards.push(bySym.get(s)!)
    // 보충: $10+ 급등 상위 2개
    for (const r of gainers10.slice(0, 2)) if (!cards.find(x => x.symbol === r.symbol)) cards.push(r)
    // 보충: 거래대금 상위 2개
    for (const r of topDollar.slice(0, 2)) if (!cards.find(x => x.symbol === r.symbol)) cards.push(r)

    // 5) 표 Markdown
    const tablesMd = [
      '## 📊 データ(Top10)',
      '### Top 10 — 取引代金（ドル）',
      renderTable(topDollar, true),
      '### Top 10 — 出来高（株数）',
      renderTable(topVolume, true),
      '### Top 10 — 上昇株（$10+）',
      renderTable(gainers10, true),
      '### Top 10 — 下落株（$10+）',
      renderTable(losers10, true),
      '\n#米国株 #夜間警備員 #米株マーケット #ナスダック #S&P500 #テーマ #上昇株 #下落株 #出来高'
    ].join('\n\n')

    // 6) 본문(LLM) 작성 또는 폴백
    const model = qModel || OPENAI_MODEL
    const markdown = await writeStoryJa(model, cards, tablesMd, dateEt)

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
    }, { headers: { 'Cache-Control': 'no-store' }})
  } catch (err: any) {
    return Response.json({ ok: false, error: String(err?.message || err) }, { status: 500 })
  }
}
