import { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

// ---- ENV ----
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5' // gpt-5 or gpt-5-mini
const POLYGON_API_KEY = process.env.POLYGON_API_KEY || ''

// ---- Small utils ----
async function jfetch<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { ...init, cache: 'no-store' })
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}: ${await r.text()}`)
  return r.json() as Promise<T>
}
const safeNum = (v: any, d = 0) => (Number.isFinite(+v) ? +v : d)

type Row = {
  Ticker: string
  o: number
  c: number
  chgPct: number
  vol: number
  dollarVolM: number
}
type EOD = {
  dateEt: string
  mostActive: Row[]
  topDollar: Row[]
  topGainers10: Row[]
  topLosers10: Row[]
}

// ---- Theme tagging (coarse) ----
const ETF_INV = new Set(['SQQQ','SOXS','SPXS','TZA','FAZ','LABD','TBT','UVXY'])
const ETF_IDX = new Set(['SPY','QQQ','DIA','IWM','VTI','VOO','XLK','XLF','XLE','XLY','XLI','XLV','XLP','XLU','XLC','SMH','SOXL','SOXS','TSLL'])
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

// ---- Polygon grouped aggs fallback ----
function prevWeekdayETISO(today = new Date()): string {
  // ET 기준으로 전일(주말 건너뛰기), 휴장은 미반영(데이터 없으면 date=쿼리로 지정 권장)
  const d = new Date(today)
  // 현재를 UTC로 보정한 뒤 대략 전일을 반환
  d.setUTCDate(d.getUTCDate() - 1)
  // 주말 건너뛰기
  while ([0,6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0,10)
}

type PolygonGrouped = {
  results?: Array<{
    T: string // ticker
    v: number // volume
    o: number
    c: number
  }>
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

  // 가장 단순한 집계: 액면가 $10+ 기준의 상승/하락
  const byDollar = [...rows].sort((a,b)=> b.dollarVolM - a.dollarVolM).slice(0,10)
  const byVol = [...rows].sort((a,b)=> b.vol - a.vol).slice(0,10)
  const gainers10 = rows.filter(r => r.c >= 10).sort((a,b)=> b.chgPct - a.chgPct).slice(0,10)
  const losers10 = rows.filter(r => r.c >= 10).sort((a,b)=> a.chgPct - b.chgPct).slice(0,10)

  return {
    dateEt,
    mostActive: byVol,
    topDollar: byDollar,
    topGainers10: gainers10,
    topLosers10: losers10
  }
}

// ---- Try base endpoints first ----
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
      // 최소 필드 유효성
      if (eod.topDollar?.length && eod.mostActive?.length) return eod
    } catch { /* try next */ }
  }
  return null
}

// ---- Signals for narrative ----
function buildSignals(eod: EOD) {
  const find = (arr: Row[], t: string) => arr.find(x => x.Ticker === t)
  const spy = find(eod.topDollar, 'SPY') || find(eod.mostActive, 'SPY')
  const qqq = find(eod.topDollar, 'QQQ') || find(eod.mostActive, 'QQQ')
  const soxs = find(eod.mostActive, 'SOXS') || find(eod.topDollar, 'SOXS')
  const nvda = find(eod.topDollar, 'NVDA') || find(eod.mostActive, 'NVDA')

  const riskOn =
    (spy?.chgPct ?? 0) > 0 &&
    (qqq?.chgPct ?? 0) > 0 &&
    (soxs?.chgPct ?? 0) < 0

  const semiStrong = (nvda?.chgPct ?? 0) >= 0 && (nvda?.vol ?? 0) > 5e7
  const adv = eod.topDollar.filter(x => x.chgPct > 0).length
  const dec = eod.topDollar.length - adv
  return { riskOn, semiStrong, adv, dec }
}

// ---- Minimal OpenAI call (no exotic params) ----
async function complete(model: string, system: string, user: string) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  })
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}: ${await r.text()}`)
  const j = await r.json()
  return j.choices?.[0]?.message?.content?.trim() || ''
}

// ---- Route ----
export async function GET(req: NextRequest) {
  try {
    const { origin, searchParams } = req.nextUrl
    const lang = (searchParams.get('lang') || 'ja').toLowerCase()
    const model = searchParams.get('model') || OPENAI_MODEL
    const dateParam = searchParams.get('date') // YYYY-MM-DD (optional)

    // 1) 베이스 표: 내 엔드포인트들 먼저 시도
    let eod = await getBaseEOD(origin, dateParam)

    // 2) 전혀 없으면 Polygon으로 직접 산출
    if (!eod) {
      const dateEt = dateParam || prevWeekdayETISO()
      eod = await pullFromPolygonOrThrow(dateEt)
    }

    // 3) 테마 태깅
    const tag = (r: Row) => ({ ...r, theme: labelTheme(r.Ticker) })
    const td = eod.topDollar.map(tag)
    const tv = eod.mostActive.map(tag)
    const tg = eod.topGainers10.map(tag)
    const tl = eod.topLosers10.map(tag)

    // 4) 시그널
    const sig = buildSignals(eod)

    // 5) 기사 생성(일본어 고정)
    const table = (rows: (Row & {theme:string})[]) =>
      rows.map((r,i)=>
        `| ${i+1} | ${r.Ticker} | ${r.o.toFixed(2)}→${r.c.toFixed(2)} | ${r.chgPct.toFixed(2)} | ${r.vol.toLocaleString()} | ${r.dollarVolM.toFixed(1)} | ${r.theme} |`
      ).join('\n')
    const header =
`| Rank | Ticker | o→c | Chg% | Vol | $Vol(M) | Themes |
|---:|---|---|---:|---:|---:|---|`

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

    const sys = `
あなたはnote.comで毎晩配信する「夜間警備員」筆者です。
出力は必ず日本語。見出し→カード解説→30分リプレイ→EOD総括→明日のチェック→シナリオ3本→テーマ・クラスター→表(Top10×4)の順。
未来予測・目標価格・確率の断定は禁止。数値は表の o→c / Chg% / Vol / $Vol(M) のみ引用可。
`.trim()

    const user = `
# 米国 夜間警備員 日誌 | ${eod.dateEt}

■ 取引代金上位: ${td.slice(0,5).map(x=>x.Ticker).join(', ')}
■ 出来高上位: ${tv.slice(0,5).map(x=>x.Ticker).join(', ')}
■ 上昇($10+): ${tg.slice(0,5).map(x=>x.Ticker).join(', ')}
■ 下落($10+): ${tl.slice(0,5).map(x=>x.Ticker).join(', ')}

■ シグナル
- リスクオン傾向: ${sig.riskOn ? 'あり' : '未確定'}
- 半導体の下支え: ${sig.semiStrong ? '確認' : '弱めまたは中立'}
- 取引代金上位の広がり: 上昇${sig.adv} / 下落${sig.dec}

# 構成
- 見出し(一行)
- カード解説(上位中心に12銘柄前後、各2行以内。インデックス/半導体/ソフトウェア/EVなどテーマを明示)
- 30分リプレイ(寄り→中盤→引け)
- EOD総括(今日の絵姿)
- 明日のチェック(5項目以内)
- シナリオ: 反発継続 / もみ合い / 反落 (各サインを2つ)
- テーマ・クラスター(箇条書き)
- 表(この下にそのまま貼る)

${mdTables}
`.trim()

    const markdown = await complete(model, sys, user)

    return Response.json({
      ok: true,
      dateEt: eod.dateEt,
      markdown,
      analyzed: {
        model,
        usedPolygonFallback: !await getBaseEOD(req.nextUrl.origin, dateParam),
        riskOn: sig.riskOn,
        semiStrong: sig.semiStrong
      }
    })
  } catch (e: any) {
    return Response.json({ ok: false, error: String(e?.message || e) }, { status: 200 })
  }
}
