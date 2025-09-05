import { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

// ===== ENV =====
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5' // gpt-5 / gpt-5-mini
const POLYGON_API_KEY = process.env.POLYGON_API_KEY || ''

// ===== Utils =====
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

type PolygonGrouped = {
  results?: Array<{ T: string; v: number; o: number; c: number }>
}
type PolygonTickerProfile = {
  results?: {
    ticker?: string
    name?: string
    description?: string
    sic_description?: string
  }
}

// ===== Theme tags =====
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

// 主要 티커 일본어 브리프(있으면 우선 사용)
const BRIEFS_JP: Record<string,string> = {
  SPY: 'S&P500連動ETF',
  QQQ: 'NASDAQ100連動ETF',
  SQQQ: 'NASDAQ100ベア3倍ETF',
  SOXS: '半導体指数ベア3倍ETF',
  TSLL: 'テスラ連動レバレッジETF',
  NVDA: 'GPU/AI半導体大手',
  AVGO: '半導体・通信インフラ',
  AMD: 'CPU/GPUの半導体',
  INTC: '米半導体大手',
  ASML: 'EUV露光装置',
  TSM: '半導体受託製造(ファウンドリ)',
  TSLA: 'EVとエネルギー',
  AMZN: 'ECとクラウド(AWS)',
  GOOGL: '検索・広告・クラウド',
  AAPL: 'デバイスとサービス',
  META: 'SNSと広告',
  MSFT: 'OS/クラウド/AI',
  PLTR: 'データ分析プラットフォーム',
  OPEN: '不動産売買プラットフォーム',
  NEGG: 'PC・家電EC',
  AEO: '衣料小売',
  SMR: '小型モジュール原子炉'
}

// ===== Dates =====
function prevWeekdayETISO(today = new Date()): string {
  const d = new Date(today)
  d.setUTCDate(d.getUTCDate() - 1)
  while ([0,6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0,10)
}

// ===== Polygon grouped aggs fallback =====
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

// ===== Try internal base endpoints first =====
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
    } catch { /* try next */ }
  }
  return null
}

// ===== Profiles (Polygon v3/reference) =====
async function fetchProfile(t: string) {
  try {
    const url = `https://api.polygon.io/v3/reference/tickers/${encodeURIComponent(t)}?apiKey=${POLYGON_API_KEY}`
    const j = await jfetch<PolygonTickerProfile>(url)
    const r = j.results || {}
    const name = (r.name || '').trim()
    const desc = (r.sic_description || r.description || '').trim()
    return { name, desc }
  } catch {
    return { name: '', desc: '' }
  }
}

async function getProfiles(tickers: string[]) {
  const unique = Array.from(new Set(tickers.map(t=>t.toUpperCase())))
  const out: Record<string,{name:string,desc:string}> = {}
  // 순차 호출(서버리스 타임아웃 방지용). 필요하면 병렬로 바꿔도 됨.
  for (const t of unique) out[t] = await fetchProfile(t)
  return out
}

function makeBriefJP(t: string, name: string, theme: string, desc: string) {
  // 우선 사전
  if (BRIEFS_JP[t]) return BRIEFS_JP[t]
  // ETF 계열
  if (theme === 'インデックス/ETF') return '指数連動ETF'
  if (theme === 'インバース/レバレッジETF') return '反対/レバレッジ型ETF'
  // 대분류 힌트
  if (theme === '半導体/AIインフラ') return '半導体/AI向けインフラ'
  if (theme === 'ソフトウェア/AI') return 'ソフトウェア/AI関連'
  if (theme === 'EV/モビリティ') return 'EV/モビリティ関連'
  if (theme === 'EC/小売') return 'EC・小売関連'
  if (theme === 'バイオ/ヘルスケア') return 'バイオ/ヘルスケア'
  // 폴리곤 이름/설명 단축
  const base = name || t
  if (desc) {
    const s = desc.split(/[.;。]/)[0] || desc
    return `${base}（${s.slice(0,30)}）`
  }
  return base
}

// ===== Signals =====
function buildSignals(eod: EOD) {
  const find = (arr: Row[], t: string) => arr.find(x => x.Ticker === t)
  const spy = find(eod.topDollar, 'SPY') || find(eod.mostActive, 'SPY')
  const qqq = find(eod.topDollar, 'QQQ') || find(eod.mostActive, 'QQQ')
  const soxs = find(eod.mostActive, 'SOXS') || find(eod.topDollar, 'SOXS')
  const nvda = find(eod.topDollar, 'NVDA') || find(eod.mostActive, 'NVDA')

  const riskOn = (spy?.chgPct ?? 0) > 0 && (qqq?.chgPct ?? 0) > 0 && (soxs?.chgPct ?? 0) < 0
  const semiStrong = (nvda?.chgPct ?? 0) >= 0 && (nvda?.vol ?? 0) > 5e7
  const adv = eod.topDollar.filter(x => x.chgPct > 0).length
  const dec = eod.topDollar.length - adv
  return { riskOn, semiStrong, adv, dec }
}

// ===== OpenAI (필수 파라미터만) =====
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

// ===== Route =====
export async function GET(req: NextRequest) {
  try {
    const { origin, searchParams } = req.nextUrl
    const model = searchParams.get('model') || OPENAI_MODEL
    const dateParam = searchParams.get('date') // YYYY-MM-DD

    // 1) 표 데이터 확보
    let eod = await getBaseEOD(origin, dateParam)
    if (!eod) {
      const dateEt = dateParam || prevWeekdayETISO()
      eod = await pullFromPolygonOrThrow(dateEt)
    }

    // 2) 테마 라벨
    const addTheme = (r: Row) => ({ ...r, theme: labelTheme(r.Ticker) })
    eod.topDollar = eod.topDollar.map(addTheme)
    eod.mostActive = eod.mostActive.map(addTheme)
    eod.topGainers10 = eod.topGainers10.map(addTheme)
    eod.topLosers10 = eod.topLosers10.map(addTheme)

    // 3) 프로필 -> Brief
    const allTickers = [
      ...eod.topDollar, ...eod.mostActive, ...eod.topGainers10, ...eod.topLosers10
    ].map(r => r.Ticker)
    const profiles = POLYGON_API_KEY ? await getProfiles(allTickers) : {}
    const addBrief = (r: Row) => {
      const p = profiles[r.Ticker] || { name: '', desc: '' }
      return { ...r, brief: makeBriefJP(r.Ticker, p.name, r.theme || '', p.desc) }
    }
    eod.topDollar = eod.topDollar.map(addBrief)
    eod.mostActive = eod.mostActive.map(addBrief)
    eod.topGainers10 = eod.topGainers10.map(addBrief)
    eod.topLosers10 = eod.topLosers10.map(addBrief)

    // 4) 시그널
    const sig = buildSignals(eod)

    // 5) 표 생성
    const header = `| Rank | Ticker | o→c | Chg% | Vol | $Vol(M) | Themes | Brief |
|---:|---|---|---:|---:|---:|---|---|`
    const rowline = (r: Row & {theme?: string, brief?: string}, i: number) =>
      `| ${i+1} | ${r.Ticker} | ${r.o.toFixed(2)}→${r.c.toFixed(2)} | ${r.chgPct.toFixed(2)} | ${r.vol.toLocaleString()} | ${r.dollarVolM.toFixed(1)} | ${r.theme} | ${r.brief || ''} |`
    const table = (rows: (Row & {theme?:string, brief?:string})[]) => rows.map(rowline).join('\n')

    const mdTables = `
### Top 10 — 取引代金（ドル）
${header}
${table(eod.topDollar)}

### Top 10 — 出来高（株数）
${header}
${table(eod.mostActive)}

### Top 10 — 上昇株（$10+）
${header}
${table(eod.topGainers10)}

### Top 10 — 下落株（$10+）
${header}
${table(eod.topLosers10)}
`.trim()

    // 6) 프롬프트(일본어 기사 길게, 예측 금지)
    const sys = `
あなたはnote.comで毎晩配信する「夜間警備員」の筆者です。出力は必ず日本語。
禁止: 価格の予測/目標・確率の断定・未根拠の数値。数値の引用は表の o→c / Chg% / Vol / $Vol(M) のみ。
記事構成: 見出し(1行)→カード解説(12銘柄前後、各2行以内)→30分リプレイ→EOD総括→明日のチェック(5項目)→シナリオ(反発継続/もみ合い/反落; 各サイン2つ)→構造テーマのメモ(中期的観点)→テーマ・クラスター→表(Top10×4)。
` .trim()

    const briefList = Array.from(new Set(allTickers))
      .map(t => {
        const p = profiles[t] || { name: '', desc: '' }
        return `${t}: ${p.name || ''} | ${p.desc || ''}`.trim()
      }).join('\n')

    const user = `
# 米国 夜間警備員 日誌 | ${eod.dateEt}

■ 取引代金 上位: ${eod.topDollar.slice(0,5).map(x=>x.Ticker).join(', ')}
■ 出来高 上位: ${eod.mostActive.slice(0,5).map(x=>x.Ticker).join(', ')}
■ 上昇($10+): ${eod.topGainers10.slice(0,5).map(x=>x.Ticker).join(', ')}
■ 下落($10+): ${eod.topLosers10.slice(0,5).map(x=>x.Ticker).join(', ')}

■ シグナル
- リスクオン傾向: ${sig.riskOn ? 'あり' : '未確定'}
- 半導体の下支え: ${sig.semiStrong ? '確認' : '弱め/中立'}
- 取引代金上位の広がり: 上昇${sig.adv} / 下落${sig.dec}

■ 銘柄プロフィール(英→要約OK)
${briefList}

■ テーブルは本文末尾に付す。カード解説の各行に「(テーマ) + 1行ブリーフ」を添えること。
${mdTables}
` .trim()

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
