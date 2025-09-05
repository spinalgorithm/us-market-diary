// src/app/api/eod-deep/route.ts
// ✅ 기본 모델: gpt-5-mini (ENV: OPENAI_MODEL 로 오버라이드 가능)
// ✅ 일본어 기본 출력(OUTPUT_LANG=ja), 표/섹션/테마 라벨까지 i18n
// ✅ 휴장일(공휴일) 자동 폴백: 데이터가 있는 최근 영업일까지 후퇴
// ✅ Top 표: 거래대금(달러) / 거래량(주식수)
// ✅ 급등/급락 표: "종가 $PRICE_MIN_FOR_GAIN_LOSS 이상" 종목만 포함 (기본 10달러)
// ✅ LLM 기사: 수치 남발/예측 억제(temperature 0.2 + 금지규칙 강화)
// ✅ ETF/지수 라벨 보강(SPY/QQQ/IWM/섹터 ETF 등 → インデックス/ETF)
// ✅ ?lang=ko|ja|en, ?date=YYYY-MM-DD 지원

import { NextRequest, NextResponse } from 'next/server'
import { DateTime } from 'luxon'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// ────────────────────────────────────────────────────────────
// 환경변수
// ────────────────────────────────────────────────────────────
const POLYGON_KEY = process.env.POLYGON_API_KEY || ''
const OPENAI_KEY = process.env.OPENAI_API_KEY || ''
const OUTPUT_LANG = (process.env.OUTPUT_LANG || 'ja') as Lang // 기본 ja
const SITE_TITLE_PREFIX_ENV = process.env.SITE_TITLE_PREFIX || ''
const NEWS_PER_TICKER = Number(process.env.NEWS_PER_TICKER || 2)
const MAX_UNION_TICKERS = Number(process.env.MAX_UNION_TICKERS || 12)
const PRICE_MIN_FOR_GAIN_LOSS = Number(process.env.PRICE_MIN_FOR_GAIN_LOSS || 10)
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5-mini'

// ────────────────────────────────────────────────────────────
// i18n 라벨/해시태그
// ────────────────────────────────────────────────────────────
const I18N = {
  ko: {
    prefix: '미국 야간경비원 일지',
    cluster: '🧩 테마 클러스터',
    dataTop: '📊 데이터(Top10)',
    dollar: 'Top 10 — 거래대금(달러)',
    volume: 'Top 10 — 거래많은주 (주식수)',
    gainers: (min: number) => `Top 10 — 급등주 ($${min}+ )`,
    losers: (min: number) => `Top 10 — 하락주 ($${min}+ )`,
    unknown: '기타/테마불명',
    etf: '지수/ETF',
    hashtags: '#미국주식 #미국야간경비원 #장마감 #나스닥 #S&P500 #증시브리핑 #테마 #상승주 #하락주 #MostActive',
  },
  ja: {
    prefix: '米国 夜間警備員 日誌',
    cluster: '🧩 テーマ・クラスター',
    dataTop: '📊 データ(Top10)',
    dollar: 'Top 10 — 取引代金（ドル）',
    volume: 'Top 10 — 出来高（株数）',
    gainers: (min: number) => `Top 10 — 上昇株（$${min}+）`,
    losers: (min: number) => `Top 10 — 下落株（$${min}+）`,
    unknown: 'その他/テーマ不明',
    etf: 'インデックス/ETF',
    hashtags: '#米国株 #夜間警備員 #米株マーケット #ナスダック #S&P500 #テーマ #上昇株 #下落株 #出来高',
  },
  en: {
    prefix: 'US Night Guard Diary',
    cluster: '🧩 Theme Clusters',
    dataTop: '📊 Data (Top10)',
    dollar: 'Top 10 — Dollar Volume',
    volume: 'Top 10 — Most Active (Shares)',
    gainers: (min: number) => `Top 10 — Gainers ($${min}+ )`,
    losers: (min: number) => `Top 10 — Losers ($${min}+ )`,
    unknown: 'Other/Unclassified',
    etf: 'Index/ETF',
    hashtags: '#USstocks #NightGuard #MarketWrap #NASDAQ #SP500 #Themes #Gainers #Losers #MostActive',
  },
} as const

type Lang = keyof typeof I18N

// ────────────────────────────────────────────────────────────
// OpenAI lazy import
// ────────────────────────────────────────────────────────────
let openai: any = null
async function getOpenAI() {
  if (!OPENAI_KEY) return null
  if (!openai) {
    const { OpenAI } = await import('openai')
    openai = new OpenAI({ apiKey: OPENAI_KEY })
  }
  return openai
}

// ────────────────────────────────────────────────────────────
// 날짜/시장 도우미
// ────────────────────────────────────────────────────────────
function previousUsTradingDate(nowUtc: DateTime): string {
  let et = nowUtc.setZone('America/New_York')
  const beforeClose = et < et.set({ hour: 16, minute: 10 })
  let d = beforeClose ? et.minus({ days: 1 }) : et
  while (d.weekday > 5) d = d.minus({ days: 1 }) // 주말 스킵
  return d.toFormat('yyyy-LL-dd')
}

async function fetchGroupedDaily(dateStr: string) {
  const url = `https://api.polygon.io/v2/aggs/grouped/locale/us/market/stocks/${dateStr}?adjusted=true&apiKey=${POLYGON_KEY}`
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) throw new Error(`Polygon grouped daily failed: ${res.status}`)
  return (await res.json()) as any
}

// ────────────────────────────────────────────────────────────
// 데이터 정제/정렬
// ────────────────────────────────────────────────────────────
const EXCLUDE_RE = /(\.WS$|WS$|W$|\.U$|U$|WT$|UN$|\.RT$|\.W$)/ // 워런트/유닛 등 제외

type Row = {
  ticker: string
  open: number
  close: number
  volume: number
  vw: number
  dollar: number // 거래대금 추정(USD)
  changePct: number
  themes?: string[]
}

function computeLists(rows: any[]) {
  const enriched: Row[] = rows
    .map((r) => {
      const vw = typeof r.vw === 'number' && isFinite(r.vw) ? r.vw : (r.c ?? r.o ?? 0)
      const volume: number = r.v ?? 0
      const dollar = vw * volume
      return {
        ticker: r.T as string,
        open: r.o as number,
        close: r.c as number,
        volume,
        vw,
        dollar,
        changePct: r.o ? ((r.c - r.o) / r.o) * 100 : 0,
      }
    })
    .filter(
      (r) =>
        r.ticker &&
        !EXCLUDE_RE.test(r.ticker) &&
        typeof r.open === 'number' &&
        typeof r.close === 'number' &&
        typeof r.volume === 'number' &&
        isFinite(r.changePct)
    )

  // 기본 노이즈 컷
  const cleaned = enriched.filter((r) => r.volume >= 300_000 && r.open >= 0.5)

  // 거래량/거래대금 표(있는 그대로)
  const mostActive: Row[] = [...cleaned].sort((a, b) => b.volume - a.volume).slice(0, 30)
  const mostDollar: Row[] = [...cleaned].sort((a, b) => b.dollar - a.dollar).slice(0, 30)

  // 급등/급락: 종가 $10 이상만
  const priceFiltered = cleaned.filter((r) => r.close >= PRICE_MIN_FOR_GAIN_LOSS)
  const gainers: Row[] = [...priceFiltered].sort((a, b) => b.changePct - a.changePct).slice(0, 30)
  const losers: Row[] = [...priceFiltered].sort((a, b) => a.changePct - b.changePct).slice(0, 30)

  // 분석 타깃: 돈의 흐름 우선 + 급등/급락(10$+) + 거래량 일부
  const unionTickers: string[] = []
  for (const r of [
    ...mostDollar.slice(0, 8),
    ...gainers.slice(0, 8),
    ...losers.slice(0, 6),
    ...mostActive.slice(0, 4),
  ]) {
    if (!unionTickers.includes(r.ticker)) unionTickers.push(r.ticker)
    if (unionTickers.length >= MAX_UNION_TICKERS) break
  }

  return { mostActive, mostDollar, gainers, losers, unionTickers }
}

// ────────────────────────────────────────────────────────────
// 프로필/뉴스/테마
// ────────────────────────────────────────────────────────────
async function fetchTickerDetails(ticker: string) {
  const url = `https://api.polygon.io/v3/reference/tickers/${ticker}?apiKey=${POLYGON_KEY}`
  const r = await fetch(url, { cache: 'no-store' })
  if (!r.ok) return null
  const j = await r.json()
  const d = j?.results || {}
  return {
    name: d.name || ticker,
    primary_exchange: d.primary_exchange || '',
    sector: d.sic_description || d.industry || '',
    homepage_url: d.homepage_url || '',
    market_cap: d.market_cap || null,
  }
}

async function fetchNews(ticker: string, limit = NEWS_PER_TICKER) {
  const url = `https://api.polygon.io/v2/reference/news?ticker=${encodeURIComponent(
    ticker
  )}&limit=${limit}&order=desc&sort=published_utc&apiKey=${POLYGON_KEY}`
  const r = await fetch(url, { cache: 'no-store' })
  if (!r.ok) return [] as any[]
  const j = await r.json()
  const arr = j?.results || []
  return arr.map((n: any) => ({
    title: n.title,
    url: n.article_url,
    publisher: n.publisher?.name || '',
    published: n.published_utc,
  }))
}

function inferThemes(ticker: string, name: string, sector: string, headlines: string[], lang: Lang): string[] {
  const text = [ticker, name, sector, ...headlines].join(' ').toLowerCase()
  const has = (kws: string[]) => kws.some((k) => text.includes(k))

  const tags: string[] = []

  // 지수/ETF 라벨 (대표 ETF 및 섹터 ETF 포함)
  const ETF_SET = new Set([
    'SPY','QQQ','DIA','IWM','IVV','VOO','VTI','VT',
    'XLK','XLF','XLE','XLV','XLY','XLP','XLI','XLU','XLB','XLC',
    'SOXX','SMH','EEM','EFA','TLT','HYG','LQD'
  ])
  if (ETF_SET.has(ticker.toUpperCase())) tags.push(I18N[lang].etf)

  if (has(['nvidia','gpu','semiconductor','chip','ai','compute','data center','h100'])) tags.push('AI/반도체')
  if (has(['software','cloud','saas','subscription','platform'])) tags.push('소프트웨어/클라우드')
  if (has(['retail','e-commerce','store','consumer','brand'])) tags.push('리테일/소비')
  if (has(['oil','gas','energy','crude','refinery'])) tags.push('에너지/원자재')
  if (has(['biotech','therapy','fda','clinical','drug','healthcare'])) tags.push('헬스케어/바이오')
  if (has(['ev','electric vehicle','battery','charging','tesla'])) tags.push('EV/모빌리티')
  if (has(['mining','uranium','gold','silver','copper'])) tags.push('광물/원자재')
  if (has(['bank','fintech','credit','loan','broker','insurance'])) tags.push('금융')
  if (has(['utility','grid','power','electricity'])) tags.push('유틸리티/전력')
  if (tags.length === 0) tags.push('기타/테마불명')
  return Array.from(new Set(tags)).slice(0, 3)
}

function translateThemes(tags: string[], lang: Lang) {
  if (lang !== 'ja') return tags
  return tags.map((t) =>
    t === '기타/테마불명' ? I18N.ja.unknown :
    t === 'AI/반도체' ? 'AI/半導体' :
    t === '소프트웨어/클라우드' ? 'ソフトウェア/クラウド' :
    t === '리테일/소비' ? '小売/消費' :
    t === '에너지/원자재' ? 'エネルギー/資源' :
    t === '헬스케어/바이오' ? 'ヘルスケア/バイオ' :
    t === 'EV/모빌리티' ? 'EV/モビリティ' :
    t === '광물/원자재' ? '素材/鉱山' :
    t === '금융' ? '金融' :
    t === '유틸리티/전력' ? '公益/電力' : t
  )
}

function investingSearchUrl(t: string) { return `https://www.investing.com/search/?q=${encodeURIComponent(t)}` }
function yahooUrl(t: string) { return `https://finance.yahoo.com/quote/${encodeURIComponent(t)}` }

// ────────────────────────────────────────────────────────────
// 마크다운/LLM
// ────────────────────────────────────────────────────────────
function mdTableWithThemes(rows: Row[], title: string, top = 10) {
  const header = `### ${title}\n| Rank | Ticker | o→c | Chg% | Vol | $Vol(M) | Themes |\n|---:|---|---|---:|---:|---:|---|`
  const body = rows
    .slice(0, top)
    .map((r, i) =>
      `| ${i + 1} | ${r.ticker} | ${fmt2(r.open)}→${fmt2(r.close)} | ${fmt2(r.changePct)} | ${r.volume.toLocaleString()} | ${fmt1(r.dollar / 1e6)} | ${(r.themes || []).join(', ')} |`
    )
    .join('\n')
  return `${header}\n${body}`
}

function buildLLMUserPrompt(dateEt: string, cards: any[], lists: { mostActive: Row[]; mostDollar: Row[]; gainers: Row[]; losers: Row[] }, lang: Lang) {
  const kst = DateTime.now().setZone('Asia/Seoul').toFormat('yyyy-LL-dd HH:mm')
  const cardText = cards
    .map((c: any) => {
      const headlines = c.news.map((n: any) => `- ${n.title} (${n.publisher})`).join('\n')
      const links = [c.homepage_url ? `HP: ${c.homepage_url}` : '', `Yahoo: ${yahooUrl(c.ticker)}`, `Investing: ${investingSearchUrl(c.ticker)}`]
        .filter(Boolean)
        .join(' | ')
      return `* ${c.ticker} — ${c.name} | ${fmt1(c.changePct)}% | Vol ${c.volume.toLocaleString()} | Sec:${c.sector || '-'} | Themes:${(c.themes || []).join(', ')}\n${headlines || '- news not detected'}\n${links}`
    })
    .join('\n\n')

  const L = I18N[lang]
  const listDigest = [
    mdTableWithThemes(lists.mostDollar, L.dollar),
    mdTableWithThemes(lists.mostActive, L.volume),
    mdTableWithThemes(lists.gainers, L.gainers(PRICE_MIN_FOR_GAIN_LOSS)),
    mdTableWithThemes(lists.losers, L.losers(PRICE_MIN_FOR_GAIN_LOSS)),
  ].join('\n\n')

  const langLine = lang === 'ja' ? '言語: 日本語で書く。' : lang === 'en' ? 'Language: English.' : '언어: 한국어.'

  return `マーケット日誌を作成。${langLine}\n- 基準日(ET): ${dateEt}\n- 発行(KST): ${kst}\n\n[カード]\n${cardText}\n\n[表]\n${listDigest}\n\n要件:\n1) 数値は表にある o→c / Chg% / Vol のみ引用。目標値/予測/未出所の価格数値は禁止。\n2) 各カード 1~2段落: 上下の要因をニュース/テーマで説明。ニュース無はテクニカル/需給と明記。\n3) テーマ/セクターの資金移動を俯瞰して物語化。\n4) 30分リプレイ: 事実ベースで4~6行。\n5) EOD総括 + 明日のチェックリスト(3~5)。\nキャラクター: 『米国 夜間警備員』(一人称)。信頼90%, ウィット10%.`
}

function clusterThemes(cards: any[]) {
  const map = new Map<string, string[]>()
  for (const c of cards) for (const t of c.themes || [I18N.ja.unknown]) {
    if (!map.has(t)) map.set(t, [])
    map.get(t)!.push(c.ticker)
  }
  return Array.from(map.entries())
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 6)
    .map(([theme, arr]) => `- **${theme}**: ${arr.slice(0, 8).join(', ')} (${arr.length}銘柄)`) // ja 기준 표기
    .join('\n')
}

function fmt1(n: number) { return isFinite(n) ? n.toFixed(1) : '0.0' }
function fmt2(n: number) { return isFinite(n) ? n.toFixed(2) : '0.00' }

async function composeDeepMarkdown(dateEt: string, lists: any, lang: Lang) {
  const pick: string[] = lists.unionTickers
  const metaMap: Record<string, any> = {}

  for (const t of pick) {
    try {
      const [details, news] = await Promise.all([fetchTickerDetails(t), fetchNews(t, NEWS_PER_TICKER)])
      const base: Row =
        lists.gainers.find((x: Row) => x.ticker === t) ||
        lists.losers.find((x: Row) => x.ticker === t) ||
        lists.mostDollar.find((x: Row) => x.ticker === t) ||
        lists.mostActive.find((x: Row) => x.ticker === t)
      const headlines = (news || []).map((n: any) => n.title || '')
      let themes = inferThemes(t, details?.name || t, details?.sector || '', headlines, lang)
      themes = translateThemes(themes, lang)

      metaMap[t] = {
        ticker: t,
        name: details?.name || t,
        sector: details?.sector || '',
        market_cap: details?.market_cap || null,
        homepage_url: details?.homepage_url || '',
        changePct: base?.changePct ?? 0,
        volume: base?.volume ?? 0,
        news: news || [],
        themes,
      }
    } catch {}
  }

  // 표에도 테마 주입
  const inject = (arr: Row[]) => arr.map((r) => ({ ...r, themes: metaMap[r.ticker]?.themes || [] }))
  lists.gainers = inject(lists.gainers)
  lists.losers = inject(lists.losers)
  lists.mostActive = inject(lists.mostActive)
  lists.mostDollar = inject(lists.mostDollar)

  // 본문
  const cards = pick.map((t) => metaMap[t]).filter(Boolean)
  const client = await getOpenAI()
  let body = ''
  if (client) {
    const prompt = buildLLMUserPrompt(dateEt, cards, lists, lang)
    const sys = lang === 'ja'
      ? 'あなたは信頼性の高いマーケットライター。投資助言/利益保証/虚偽数値/予測は禁止。'
      : '너는 신뢰도 높은 마켓 라이터다. 투자 권유/수익 보장/허위 수치/예측 금지.'
const completion = await client.chat.completions.create({
  model: OPENAI_MODEL,               // 기본 gpt-5-mini
  max_output_tokens: 1800,           // 출력 길이 제한
  messages: [
    { role: 'system', content: sys + ' 数値は表の o→c / Chg% / Vol のみ。目標価格・将来予測・根拠のない数値は厳禁。' },
    { role: 'user', content: prompt + '\n\n禁止: 目標価格/予測/未出所の数値。許可: 表中の o→c, Chg%, Vol のみ数値表記。' },
  ],
})
    body = completion.choices?.[0]?.message?.content || ''
  } else {
    body = lang === 'ja' ? '## 🎙️ オープニング\nLLMキーが未設定のため、簡易サマリーのみ表示します。' : '## 🎙️ 오프닝\nLLM 키가 없어 간단 요약만 제공합니다.'
  }

  const L = I18N[lang]
  const clusters = clusterThemes(cards)
  const prefix = SITE_TITLE_PREFIX_ENV || L.prefix

  const topTables = [
    mdTableWithThemes(lists.mostDollar, L.dollar),
    mdTableWithThemes(lists.mostActive, L.volume),
    mdTableWithThemes(lists.gainers, L.gainers(PRICE_MIN_FOR_GAIN_LOSS)),
    mdTableWithThemes(lists.losers, L.losers(PRICE_MIN_FOR_GAIN_LOSS)),
  ].join('\n\n')

  const md = `# ${prefix} | ${dateEt}\n\n${body}\n\n---\n\n## ${L.cluster}\n${clusters || '(' + L.unknown + ')'}\n\n---\n\n## ${L.dataTop}\n${topTables}\n\n---\n\n${L.hashtags}`

  return { markdown: md, cards }
}

// ────────────────────────────────────────────────────────────
// 핸들러 (휴장일 폴백 + 날짜 파라미터)
// ────────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  try {
    if (!POLYGON_KEY) return NextResponse.json({ ok: false, error: 'Missing POLYGON_API_KEY' }, { status: 500 })

    const url = req.nextUrl
    const langParam = (url.searchParams.get('lang') || OUTPUT_LANG) as Lang
    const dateParam = url.searchParams.get('date') // 'YYYY-MM-DD'

    // 1) 기준일 결정(파라미터 우선)
    let dateEt = dateParam || previousUsTradingDate(DateTime.utc())

    // 2) 휴장일/데이터 미생성 대비: 최근 영업일까지 후퇴(최대 7일)
    let probe = DateTime.fromISO(dateEt, { zone: 'America/New_York' })
    let rows: any[] = []
    for (let i = 0; i < 7; i++) {
      const ds = probe.toFormat('yyyy-LL-dd')
      const daily = await fetchGroupedDaily(ds)
      rows = daily?.results || []
      if (rows.length > 0) { dateEt = ds; break }
      probe = probe.minus({ days: 1 })
      while (probe.weekday > 5) probe = probe.minus({ days: 1 }) // 주말 스킵
    }
    if (!rows.length) throw new Error('No EOD data for last 7 days')

    // 3) 계산/기사 생성
    const lists = computeLists(rows)
    const { markdown, cards } = await composeDeepMarkdown(dateEt, lists, langParam)

    return NextResponse.json({ ok: true, dateEt, markdown, analyzed: cards.length })
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 })
  }
}
