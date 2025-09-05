import { NextRequest } from 'next/server'

// --- Config ----------------------------------------------------
export const dynamic = 'force-dynamic'

// 읽을 환경변수(로컬은 .env, 배포는 Vercel 프로젝트 변수 사용)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!
const POLYGON_API_KEY = process.env.POLYGON_API_KEY || ''
const OPENAI_MODEL_DEFAULT = process.env.OPENAI_MODEL || 'gpt-5' // gpt-5 / gpt-5-mini

// --- Helpers ---------------------------------------------------
async function jfetch<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { ...init, cache: 'no-store' })
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}: ${await r.text()}`)
  return r.json() as Promise<T>
}

function safeNum(n: any, d = 0): number {
  const x = Number(n)
  return Number.isFinite(x) ? x : d
}
function pct(a: number, b: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return 0
  return (a / b - 1) * 100
}

type Row = {
  Ticker: string
  o: number
  c: number
  chgPct: number
  vol: number
  dollarVolM: number
}

type EodShape = {
  dateEt: string
  mostActive: Row[]
  topDollar: Row[]
  topGainers10: Row[]
  topLosers10: Row[]
}

// --- Theme tagging (light) ------------------------------------
const ETF_INV = new Set(['SQQQ','SOXS','SPXS','TZA','FAZ','LABD','TBT','UVXY'])
const ETF_IDX = new Set(['SPY','QQQ','DIA','IWM','VTI','VOO','XLK','XLF','XLE','XLY','XLI','XLV','XLP','XLU','XLC','SMH','SOXL','SOXS','TSLL'])

const SEMIS = new Set(['NVDA','AVGO','AMD','TSM','ASML','AMAT','LRCX','MU','INTC','SOXL','SOXS','SMH'])
const MEGA_SOFT_AI = new Set(['MSFT','GOOGL','AMZN','META','CRM','ADBE','ORCL','PLTR'])
const EV_MOB = new Set(['TSLA','NIO','LI','RIVN','F','GM','TSLL'])
const EC_RETAIL = new Set(['AMZN','SHOP','MELI','NEGG','AEO','DLTH','WMT','COST'])
const BIO_HEALTH = new Set(['NVO','PFE','MRK','BMY','AZN','REGN','VRTX','NBY','IONS','RAPT','STSS'])

function labelTheme(t: string): string {
  if (ETF_INV.has(t)) return 'インバース/レバレッジETF'
  if (ETF_IDX.has(t)) return 'インデックス/ETF'
  if (SEMIS.has(t)) return '半導体/AIインフラ'
  if (MEGA_SOFT_AI.has(t)) return 'ソフトウェア/AI'
  if (EV_MOB.has(t)) return 'EV/モビリティ'
  if (EC_RETAIL.has(t)) return 'EC/小売'
  if (BIO_HEALTH.has(t)) return 'バイオ/ヘルスケア'
  return 'その他/テーマ不明'
}

// --- Polygon News (optional; auto-skip on failure) -------------
async function fetchPolygonNews(tickers: string[], dateEt: string) {
  if (!POLYGON_API_KEY) return []
  try {
    // 2日前~当日 범위로 가볍게
    const to = new Date(dateEt + 'T23:59:59Z')
    const from = new Date(to); from.setUTCDate(from.getUTCDate() - 2)
    const qs = new URLSearchParams({
      apiKey: POLYGON_API_KEY,
      order: 'desc',
      limit: '40',
      sort: 'published_utc',
      'published_utc.gte': from.toISOString(),
      'published_utc.lte': to.toISOString(),
      // 일부만 붙여서 길이 제한 회피
      ticker: tickers.slice(0, 10).join(',')
    })
    const url = `https://api.polygon.io/v2/reference/news?${qs.toString()}`
    const j = await jfetch<any>(url)
    const items = Array.isArray(j.results) ? j.results : []
    return items.map((x: any) => ({
      ticker: (x.tickers?.[0] || '').toUpperCase(),
      title: String(x.title || '').slice(0, 140),
      publisher: x.publisher?.name || '',
    }))
  } catch {
    return []
  }
}

// --- Signal extraction (for narrative) -------------------------
function buildSignals(eod: EodShape) {
  const inTopDollar = (t: string) => eod.topDollar.some(r => r.Ticker === t)
  const get = (arr: Row[], t: string) => arr.find(r => r.Ticker === t)

  const spy = get(eod.topDollar, 'SPY') || get(eod.mostActive, 'SPY')
  const qqq = get(eod.topDollar, 'QQQ') || get(eod.mostActive, 'QQQ')
  const soxs = get(eod.mostActive, 'SOXS') || get(eod.topDollar, 'SOXS')
  const nvda = get(eod.topDollar, 'NVDA') || get(eod.mostActive, 'NVDA')

  const riskOn =
    (spy?.chgPct ?? 0) > 0 &&
    (qqq?.chgPct ?? 0) > 0 &&
    (soxs?.chgPct ?? 0) < 0

  const semiStrong = (nvda?.chgPct ?? 0) >= 0 && (nvda?.vol ?? 0) > 5e7

  // 상위 표 내에서 상승:하락 대략 비율
  const advTopDollar = eod.topDollar.filter(r => r.chgPct > 0).length
  const decTopDollar = eod.topDollar.length - advTopDollar

  return {
    riskOn,
    semiStrong,
    advTopDollar,
    decTopDollar,
    inTopDollar: (t: string) => inTopDollar(t),
  }
}

// --- Minimal OpenAI client (no SDK to keep file self-contained)-
async function chatComplete(model: string, system: string, user: string) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      // gpt-5 계열은 temperature/max_output_tokens 지정 시 오류 발생 → 기본값 사용
    }),
  })
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}: ${await r.text()}`)
  const j = await r.json()
  return j.choices?.[0]?.message?.content?.trim() || ''
}

// --- Main ------------------------------------------------------
export async function GET(req: NextRequest) {
  try {
    const { searchParams, origin } = req.nextUrl
    const lang = (searchParams.get('lang') || 'ja').toLowerCase() // ja only 권장
    const date = searchParams.get('date') || '' // ''=latest in your /api/eod
    const model = searchParams.get('model') || OPENAI_MODEL_DEFAULT

    // 1) 베이스 표: 기존 /api/eod 우선 사용
    const eodUrl = `${origin}/api/eod${date ? `?date=${date}` : ''}`
    const base = await jfetch<any>(eodUrl).catch(() => null)

    if (!base || !base.ok || !base.data) {
      return Response.json({
        ok: false,
        error: 'EOD base data not available. Check /api/eod.',
      }, { status: 200 })
    }

    // 2) Row 정규화 + 테마 라벨
    const norm = (rows: any[]): Row[] => (rows || []).map((r: any) => ({
      Ticker: String(r.Ticker || r.ticker || '').toUpperCase(),
      o: safeNum(r.o ?? r.open, 0),
      c: safeNum(r.c ?? r.close, 0),
      chgPct: safeNum(r.chgPct ?? r.ChgPct ?? r.chg ?? r.Chg, 0),
      vol: safeNum(r.vol ?? r.volume, 0),
      dollarVolM: safeNum(r.dollarVolM ?? r.dollarVol ?? r.$VolM, 0),
    }))

    const eod: EodShape = {
      dateEt: String(base.dateEt || base.data?.dateEt || ''),
      mostActive: norm(base.data?.mostActive || base.mostActive),
      topDollar: norm(base.data?.topDollar || base.topDollar),
      topGainers10: norm(base.data?.topGainers10 || base.topGainers10),
      topLosers10: norm(base.data?.topLosers10 || base.topLosers10),
    }

    // 3) Theme 붙이기
    const withTheme = (rows: Row[]) =>
      rows.map(r => ({ ...r, theme: labelTheme(r.Ticker) }))

    const tableDollar = withTheme(eod.topDollar)
    const tableVol = withTheme(eod.mostActive)
    const tableGainers = withTheme(eod.topGainers10)
    const tableLosers = withTheme(eod.topLosers10)

    // 4) (옵션) Polygon 뉴스로 키워드 팩
    const focusTickers = Array.from(
      new Set([
        ...tableDollar.slice(0, 8).map(x => x.Ticker),
        ...tableGainers.slice(0, 5).map(x => x.Ticker),
        ...tableLosers.slice(0, 5).map(x => x.Ticker),
      ])
    )
    const news = await fetchPolygonNews(focusTickers, eod.dateEt)
    const newsPack =
      news.length > 0
        ? news.slice(0, 12).map(n => `• ${n.ticker}: ${n.title}（${n.publisher}）`).join('\n')
        : ''

    // 5) 시그널 계산
    const sig = buildSignals(eod)

    // 6) LLM 프롬프트(일본어 기사; 예측 금지/수치 제한)
    const sys = `
あなたはnote.comで毎晩配信する「夜間警備員」筆者です。
出力は必ず日本語。見出し→カード解説→30分リプレイ→EOD総括→明日のチェック→シナリオ3本→テーマ・クラスター→表(Top10×4)。
価格予測・目標価格・確率や数値の断定は禁止。数値は表中の o→c / Chg% / Vol / $Vol(M) の引用に限定。ニュースは下の“参考見出し”に含まれる範囲だけを一般名詞で触れる(出典やURLは不要)。
`.trim()

    const toLines = (rows: (Row & { theme: string })[], tag: boolean) =>
      rows.map(r =>
        `| ${r.Ticker} | ${r.o.toFixed(2)}→${r.c.toFixed(2)} | ${r.chgPct.toFixed(2)} | ${r.vol.toLocaleString()} | ${r.dollarVolM.toFixed(1)} | ${tag ? r.theme : ''} |`
      ).join('\n')

    const header = (tag: boolean) =>
      `| Rank | Ticker | o→c | Chg% | Vol | $Vol(M) | ${tag ? 'Themes' : ''} |
|---:|---|---|---:|---:|---:|---|`

    const mdTables = `
### Top 10 — 取引代金（ドル）
${header(true)}
${tableDollar.map((r, i) => `| ${i+1} | ${r.Ticker} | ${r.o.toFixed(2)}→${r.c.toFixed(2)} | ${r.chgPct.toFixed(2)} | ${r.vol.toLocaleString()} | ${r.dollarVolM.toFixed(1)} | ${r.theme} |`).join('\n')}

### Top 10 — 出来高（株数）
${header(true)}
${tableVol.map((r, i) => `| ${i+1} | ${r.Ticker} | ${r.o.toFixed(2)}→${r.c.toFixed(2)} | ${r.chgPct.toFixed(2)} | ${r.vol.toLocaleString()} | ${r.dollarVolM.toFixed(1)} | ${r.theme} |`).join('\n')}

### Top 10 — 上昇株（$10+）
${header(true)}
${tableGainers.map((r, i) => `| ${i+1} | ${r.Ticker} | ${r.o.toFixed(2)}→${r.c.toFixed(2)} | ${r.chgPct.toFixed(2)} | ${r.vol.toLocaleString()} | ${r.dollarVolM.toFixed(1)} | ${r.theme} |`).join('\n')}

### Top 10 — 下落株（$10+）
${header(true)}
${tableLosers.map((r, i) => `| ${i+1} | ${r.Ticker} | ${r.o.toFixed(2)}→${r.c.toFixed(2)} | ${r.chgPct.toFixed(2)} | ${r.vol.toLocaleString()} | ${r.dollarVolM.toFixed(1)} | ${r.theme} |`).join('\n')}
`.trim()

    const user = `
# 米国 夜間警備員 日誌 | ${eod.dateEt}

【基準日(ET): ${eod.dateEt}】

■ 市場の手がかり(機械集計)
- 取引代金上位: ${tableDollar.slice(0,5).map(x=>x.Ticker).join(', ')}
- 出来高上位: ${tableVol.slice(0,5).map(x=>x.Ticker).join(', ')}
- 上昇($10+): ${tableGainers.slice(0,5).map(x=>x.Ticker).join(', ')}
- 下落($10+): ${tableLosers.slice(0,5).map(x=>x.Ticker).join(', ')}

■ シグナル(自動判定)
- リスクオン傾向: ${sig.riskOn ? 'あり' : '未確定'}
- 半導体の下支え: ${sig.semiStrong ? '確認' : '弱めまたは中立'}
- 取引代金上位の広がり: 上昇${sig.advTopDollar} / 下落${sig.decTopDollar}

${newsPack ? `■ 参考見出し(モデルは一般名詞だけ触れる):
${newsPack}
` : ''}

--- ここから記事を作成してください ---

# ルール
- トーン: 「夜間警備員」= 冷静・人間味のある巡回日誌。比喩OKだが短く。結論は控えめ、条件付き表現で。
- 数字の新規創作や未来予測は禁止。表の数値だけ引用可。
- ETF/テーマの流れ(インデックス/ETF・インバース・半導体/AIインフラ・ソフトウェア/AI・EV/モビリティ・EC/小売・バイオ/ヘルスケア・その他)を俯瞰し、カード解説とリプレイを“因果”でつなぐ。
- 最後に「テーマ・クラスター(箇条書き)」と、下の表(そのまま貼る)を配置。

# 構成
- 見出し(一行)
- カード解説(上位8〜12銘柄、各2行以内)
- 30分リプレイ(寄り→中盤→引けの出来事を事実風に)
- EOD総括(今日の絵姿)
- 明日のチェック(5項目以内)
- シナリオ: 反発継続 / もみ合い / 反落 の3本(各サインを2つ程度)
- テーマ・クラスター
- 表(以下をそのまま)
${mdTables}
`.trim()

    const markdown = await chatComplete(model, sys, user)

    return Response.json({
      ok: true,
      dateEt: eod.dateEt,
      markdown,
      analyzed: {
        model,
        riskOn: sig.riskOn,
        semiStrong: sig.semiStrong,
        advVsDecTopDollar: [sig.advTopDollar, sig.decTopDollar],
        newsUsed: news.length,
      },
    })
  } catch (err: any) {
    return Response.json({ ok: false, error: String(err?.message || err) }, { status: 200 })
  }
}
