// src/app/api/eod-deep/route.ts
// "거래대금/거래량 표는 그대로" + "급등/급락은 종가 $10 이상만" 필터 버전 (풀코드)
// - Top 표: 거래대금(달러), 거래량, 급등(>=10$), 급락(>=10$)
// - 종목 카드: 프로필/뉴스/테마 추론 + 링크, LLM 기사화
// - ?lang=ko|ja|en 파라미터 지원 (기본 ko)

import { NextRequest, NextResponse } from 'next/server'
import { DateTime } from 'luxon'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const POLYGON_KEY = process.env.POLYGON_API_KEY || ''
const NEWS_PER_TICKER = Number(process.env.NEWS_PER_TICKER || 2) // 1~3 권장
const MAX_UNION_TICKERS = Number(process.env.MAX_UNION_TICKERS || 12)
const PRICE_MIN_FOR_GAIN_LOSS = Number(process.env.PRICE_MIN_FOR_GAIN_LOSS || 10)

let openai: any = null
async function getOpenAI() {
  if (!process.env.OPENAI_API_KEY) return null
  if (!openai) {
    const { OpenAI } = await import('openai')
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  }
  return openai
}

// ────────────────────────────────────────────────────────────
// 날짜/데이터 수집
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
// 가공/정렬
// ────────────────────────────────────────────────────────────
const EXCLUDE_RE = /(\.WS$|WS$|W$|\.U$|U$|WT$|UN$|\.RT$|\.W$)/ // 워런트/유닛 등 제외

type Row = {
  ticker: string
  open: number
  close: number
  volume: number
  vw: number
  dollar: number // 거래대금(추정, USD)
  changePct: number
  themes?: string[]
}

function computeLists(rows: any[]) {
  const enriched: Row[] = rows
    .map((r) => {
      const vw = typeof r.vw === 'number' && isFinite(r.vw) ? r.vw : r.c ?? r.o ?? 0
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

  // 기본 노이즈 제거(워런트/초저가/초저거래량 제외)
  const cleaned = enriched.filter((r) => r.volume >= 300_000 && r.open >= 0.5)

  // 거래량/거래대금은 "그대로" 보여줌
  const mostActive: Row[] = [...cleaned].sort((a, b) => b.volume - a.volume).slice(0, 30)
  const mostDollar: Row[] = [...cleaned].sort((a, b) => b.dollar - a.dollar).slice(0, 30)

  // 급등/급락은 종가 $10 이상만 포함
  const priceFiltered = cleaned.filter((r) => r.close >= PRICE_MIN_FOR_GAIN_LOSS)
  const gainers: Row[] = [...priceFiltered].sort((a, b) => b.changePct - a.changePct).slice(0, 30)
  const losers: Row[] = [...priceFiltered].sort((a, b) => a.changePct - b.changePct).slice(0, 30)

  // 분석 대상 티커: 돈의 흐름 우선(거래대금) + 급등/급락(10$+) + 거래량 일부
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
// 기업 프로필 & 뉴스
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

// ────────────────────────────────────────────────────────────
// 테마 추론(규칙 기반)
// ────────────────────────────────────────────────────────────
function inferThemes(name: string, sector: string, headlines: string[]): string[] {
  const text = [name, sector, ...headlines].join(' ').toLowerCase()
  const has = (kws: string[]) => kws.some((k) => text.includes(k))

  const tags: string[] = []
  if (has(['nvidia', 'gpu', 'semiconductor', 'chip', 'ai', 'compute', 'data center', 'h100'])) tags.push('AI/반도체')
  if (has(['software', 'cloud', 'saas', 'subscription', 'platform'])) tags.push('소프트웨어/클라우드')
  if (has(['retail', 'e-commerce', 'store', 'consumer', 'brand'])) tags.push('리테일/소비')
  if (has(['oil', 'gas', 'energy', 'crude', 'refinery'])) tags.push('에너지/원자재')
  if (has(['biotech', 'therapy', 'fda', 'clinical', 'drug', 'healthcare'])) tags.push('헬스케어/바이오')
  if (has(['ev', 'electric vehicle', 'battery', 'charging', 'tesla'])) tags.push('EV/모빌리티')
  if (has(['mining', 'uranium', 'gold', 'silver', 'copper'])) tags.push('광물/원자재')
  if (has(['bank', 'fintech', 'credit', 'loan', 'broker', 'insurance'])) tags.push('금융')
  if (has(['utility', 'grid', 'power', 'electricity'])) tags.push('유틸리티/전력')
  if (tags.length === 0) tags.push('기타/테마불명')
  return Array.from(new Set(tags)).slice(0, 3)
}

function investingSearchUrl(t: string) {
  return `https://www.investing.com/search/?q=${encodeURIComponent(t)}`
}
function yahooUrl(t: string) {
  return `https://finance.yahoo.com/quote/${encodeURIComponent(t)}`
}

// ────────────────────────────────────────────────────────────
// LLM + 마크다운 생성
// ────────────────────────────────────────────────────────────
function mdTableWithThemes(rows: Row[], title: string, top = 10) {
  const header = `### ${title}\n| Rank | Ticker | o→c | Chg% | Vol | $Vol(M) | Themes |\n|---:|---|---|---:|---:|---:|---|`
  const body = rows
    .slice(0, top)
    .map(
      (r, i) =>
        `| ${i + 1} | ${r.ticker} | ${r.open.toFixed(2)}→${r.close.toFixed(2)} | ${r.changePct.toFixed(
          2
        )} | ${r.volume.toLocaleString()} | ${(r.dollar / 1e6).toFixed(1)} | ${(r.themes || []).join(', ')} |`
    )
    .join('\n')
  return `${header}\n${body}`
}

function buildLLMUserPrompt(
  dateEt: string,
  cards: any[],
  lists: { mostActive: Row[]; mostDollar: Row[]; gainers: Row[]; losers: Row[] },
  lang: 'ko' | 'ja' | 'en'
) {
  const kst = DateTime.now().setZone('Asia/Seoul').toFormat('yyyy-LL-dd HH:mm')
  const cardText = cards
    .map((c: any) => {
      const headlines = c.news.map((n: any) => `- ${n.title} (${n.publisher})`).join('\n')
      const links = [c.homepage_url ? `홈페이지: ${c.homepage_url}` : '', `Yahoo: ${yahooUrl(c.ticker)}`, `Investing: ${investingSearchUrl(c.ticker)}`]
        .filter(Boolean)
        .join(' | ')
      return `* ${c.ticker} — ${c.name} | ${c.changePct.toFixed(1)}% | Vol ${c.volume.toLocaleString()} | 섹터:${
        c.sector || '-'
      } | 테마:${(c.themes || []).join(', ')}\n${headlines || '- 관련 뉴스 감지 안됨'}\n${links}`
    })
    .join('\n\n')

  const tt = (k: string) => k // 간단화(표 제목은 한국어 유지)
  const listDigest = [
    mdTableWithThemes(lists.mostDollar, tt('Top 10 — 거래대금(달러)')),
    mdTableWithThemes(lists.mostActive, tt('Top 10 — 거래많은주 (주식수)')),
    mdTableWithThemes(lists.gainers, tt(`Top 10 — 급등주 ($${PRICE_MIN_FOR_GAIN_LOSS}+ )`)),
    mdTableWithThemes(lists.losers, tt(`Top 10 — 하락주 ($${PRICE_MIN_FOR_GAIN_LOSS}+ )`)),
  ].join('\n\n')

  const langLine =
    lang === 'ja' ? '言語: 日本語で書く。' : lang === 'en' ? 'Language: English.' : '언어: 한국어.'

  return `미국 야간경비원 마켓 일지 작성.\n${langLine}\n- 기준일(ET): ${dateEt}\n- 발행(KST): ${kst}\n\n[티커 카드]\n${cardText}\n\n[표 요약]\n${listDigest}\n\n요구사항:\n1) 데이터 근거 위주. 표/헤드라인에 없는 지수·가격 수치는 쓰지 말 것.\n2) 카드마다 1~2문단으로 '왜 움직였는가' 서술(뉴스가 없으면 기술적/단기 수급으로 명시).\n3) 테마/섹터 묶음 흐름(자금 이동) 스토리로 정리.\n4) 30분 리플레이: 사건 중심 4~6줄.\n5) EOD 총평 + 내일 체크리스트 3~5개.\n캐릭터: '미국 야간경비원'(1인칭). 신뢰감 90%, 위트 10%.`
}

function clusterThemes(cards: any[]) {
  const map = new Map<string, string[]>()
  for (const c of cards) for (const t of c.themes || ['기타/테마불명']) {
    if (!map.has(t)) map.set(t, [])
    map.get(t)!.push(c.ticker)
  }
  return Array.from(map.entries())
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 6)
    .map(([theme, arr]) => `- **${theme}**: ${arr.slice(0, 8).join(', ')} (${arr.length}종목)`) // 노출 상위
    .join('\n')
}

async function composeDeepMarkdown(dateEt: string, lists: any, lang: 'ko' | 'ja' | 'en') {
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
      const themes = inferThemes(details?.name || t, details?.sector || '', headlines)

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

  // LLM 본문
  const cards = pick.map((t) => metaMap[t]).filter(Boolean)
  const client = await getOpenAI()
  let body = ''
  if (client) {
    const prompt = buildLLMUserPrompt(dateEt, cards, lists, lang)
    const sys = '너는 신뢰도 높은 마켓 라이터다. 투자 권유/수익 보장/허위 수치 금지.'
    const completion = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.6,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: prompt },
      ],
    })
    body = completion.choices?.[0]?.message?.content || ''
  } else {
    body = `## 🎙️ 오프닝\nLLM 키가 없어 간단 요약만 제공합니다.`
  }

  const clusters = clusterThemes(cards)
  const prefix =
    process.env.SITE_TITLE_PREFIX || (lang === 'ja' ? '米国 夜間警備員 日誌' : '미국 야간경비원 일지')

  const md = `# ${prefix} | ${dateEt}\n\n${body}\n\n---\n\n## 🧩 테마 클러스터\n${clusters || '(테마 데이터 부족)'}\n\n---\n\n## 📊 데이터(Top10)\n${mdTableWithThemes(
    lists.mostDollar,
    'Top 10 — 거래대금(달러)'
  )}\n\n${mdTableWithThemes(lists.mostActive, 'Top 10 — 거래많은주 (주식수)')}\n\n${mdTableWithThemes(lists.gainers, `Top 10 — 급등주 ($${PRICE_MIN_FOR_GAIN_LOSS}+ )`)}\n\n${mdTableWithThemes(lists.losers, `Top 10 — 하락주 ($${PRICE_MIN_FOR_GAIN_LOSS}+ )`)}\n\n---\n\n#미국주식 #미국야간경비원 #장마감 #나스닥 #S&P500 #증시브리핑 #테마 #상승주 #하락주 #MostActive`

  return { markdown: md, cards }
}

// ────────────────────────────────────────────────────────────
// 핸들러
// ────────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  try {
    if (!POLYGON_KEY) return NextResponse.json({ ok: false, error: 'Missing POLYGON_API_KEY' }, { status: 500 })

    const lang = (req.nextUrl.searchParams.get('lang') || process.env.OUTPUT_LANG || 'ko') as 'ko' | 'ja' | 'en'

    const now = DateTime.utc()
    const dateEt = previousUsTradingDate(now)
    const daily = await fetchGroupedDaily(dateEt)
    const rows = daily?.results || []
    if (!rows.length) throw new Error('No EOD data returned')

    const lists = computeLists(rows)
    const { markdown, cards } = await composeDeepMarkdown(dateEt, lists, lang)

    return NextResponse.json({ ok: true, dateEt, markdown, analyzed: cards.length })
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 })
  }
}
