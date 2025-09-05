// src/app/api/eod-deep/route.ts
// 더 깊은 분석 버전: Top 리스트 + 기업 프로필 + 뉴스 요약을 바탕으로
// '미국 야간경비원' 톤의 장문 기사 생성 (Markdown)

import { NextRequest, NextResponse } from "next/server";
import { DateTime } from "luxon";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const POLYGON_KEY = process.env.POLYGON_API_KEY || "";
const NEWS_PER_TICKER = Number(process.env.NEWS_PER_TICKER || 2); // 1~3 권장
const MAX_UNION_TICKERS = Number(process.env.MAX_UNION_TICKERS || 12); // 분석용 티커 수(너무 크면 느려짐)

let openai: any = null;
async function getOpenAI() {
  if (!process.env.OPENAI_API_KEY) return null;
  if (!openai) {
    const { OpenAI } = await import("openai");
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openai;
}

// ──────────────────────────────────────────────────────────────────────────────
// 날짜/데이터 수집
// ──────────────────────────────────────────────────────────────────────────────
function previousUsTradingDate(nowUtc: DateTime): string {
  let et = nowUtc.setZone("America/New_York");
  const beforeClose = et < et.set({ hour: 16, minute: 10 });
  let d = beforeClose ? et.minus({ days: 1 }) : et;
  while (d.weekday > 5) d = d.minus({ days: 1 }); // 주말 스킵
  return d.toFormat("yyyy-LL-dd");
}

async function fetchGroupedDaily(dateStr: string) {
  const url = `https://api.polygon.io/v2/aggs/grouped/locale/us/market/stocks/${dateStr}?adjusted=true&apiKey=${POLYGON_KEY}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Polygon grouped daily failed: ${res.status}`);
  const json = await res.json();
  return json as any; // { results: Array<{ T, o, c, v, ... }> }
}

// ──────────────────────────────────────────────────────────────────────────────
// 가공/정렬
// ──────────────────────────────────────────────────────────────────────────────
const EXCLUDE_RE = /(\.WS$|WS$|W$|\.U$|U$|WT$|UN$|\.RT$|\.W$)/; // 워런트/유닛 등 제외

function computeLists(rows: any[]) {
  const enriched = rows
    .map((r) => ({
      ticker: r.T as string,
      open: r.o as number,
      close: r.c as number,
      volume: r.v as number,
      changePct: r.o ? ((r.c - r.o) / r.o) * 100 : 0,
    }))
    .filter((r) =>
      r.ticker && !EXCLUDE_RE.test(r.ticker) &&
      typeof r.open === "number" && typeof r.close === "number" &&
      typeof r.volume === "number" && isFinite(r.changePct)
    );

  // (선택) 거래량/가격 필터로 노이즈 제거
  const cleaned = enriched.filter((r) => r.volume >= 300_000 && r.open >= 0.5);

  const mostActive = [...cleaned].sort((a, b) => b.volume - a.volume).slice(0, 30);
  const gainers = [...cleaned].sort((a, b) => b.changePct - a.changePct).slice(0, 30);
  const losers = [...cleaned].sort((a, b) => a.changePct - b.changePct).slice(0, 30);

  const unionTickers: string[] = [];
  for (const r of [...gainers.slice(0, 8), ...losers.slice(0, 6), ...mostActive.slice(0, 6)]) {
    if (!unionTickers.includes(r.ticker)) unionTickers.push(r.ticker);
    if (unionTickers.length >= MAX_UNION_TICKERS) break;
  }

  return { mostActive, gainers, losers, unionTickers };
}

// ──────────────────────────────────────────────────────────────────────────────
// 기업 프로필 & 뉴스
// ──────────────────────────────────────────────────────────────────────────────
async function fetchTickerDetails(ticker: string) {
  // v3 Reference (권장)
  const url = `https://api.polygon.io/v3/reference/tickers/${ticker}?apiKey=${POLYGON_KEY}`;
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) return null;
  const j = await r.json();
  const d = j?.results || {};
  return {
    name: d.name || ticker,
    primary_exchange: d.primary_exchange || "",
    sector: d.sic_description || d.industry || "",
    homepage_url: d.homepage_url || "",
    market_cap: d.market_cap || null,
  };
}

async function fetchNews(ticker: string, limit = NEWS_PER_TICKER) {
  const url = `https://api.polygon.io/v2/reference/news?ticker=${encodeURIComponent(ticker)}&limit=${limit}&order=desc&sort=published_utc&apiKey=${POLYGON_KEY}`;
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) return [] as any[];
  const j = await r.json();
  const arr = j?.results || [];
  return arr.map((n: any) => ({
    title: n.title,
    url: n.article_url,
    publisher: n.publisher?.name || "",
    published: n.published_utc,
    // description: n.description, // 토큰 아끼려면 생략 가능
  }));
}

// ──────────────────────────────────────────────────────────────────────────────
// LLM 본문 생성
// ──────────────────────────────────────────────────────────────────────────────
function mdTable(rows: any[], title: string, top = 10) {
  const header = `### ${title}\n| Rank | Ticker | o→c | Chg% | Vol |` + "\n|---:|---|---|---:|---:|";
  const body = rows.slice(0, top).map((r: any, i: number) => `| ${i + 1} | ${r.ticker} | ${r.open.toFixed(2)}→${r.close.toFixed(2)} | ${r.changePct.toFixed(2)} | ${r.volume.toLocaleString()} |`).join("\n");
  return `${header}\n${body}`;
}

function buildLLMUserPrompt(dateEt: string, cards: any[], lists: any) {
  const kst = DateTime.now().setZone("Asia/Seoul").toFormat("yyyy-LL-dd HH:mm");
  const cardText = cards.map((c: any) => {
    const headlines = c.news.map((n: any) => `- ${n.title} (${n.publisher})`).join("\n");
    return `* ${c.ticker} — ${c.name} | ${c.changePct.toFixed(1)}% | Vol ${c.volume.toLocaleString()} | 섹터:${c.sector||'-'}\n${headlines || "- 관련 뉴스 감지 안됨"}`;
  }).join("\n\n");

  const listDigest = [
    mdTable(lists.gainers, "Top 10 — 급등주 (EOD)"),
    mdTable(lists.losers, "Top 10 — 하락주 (EOD)"),
    mdTable(lists.mostActive, "Top 10 — 거래많은주 (Most Active)"),
  ].join("\n\n");

  return `미국 야간경비원 마켓 일지 작성(한국어).
- 기준일(ET): ${dateEt}
- 발행(KST): ${kst}
- 티커 카드(상세):\n${cardText}

- 표 요약(정량):\n${listDigest}

요구사항:
1) 과장 금지, 데이터 기반 서술. 표에 없는 지수/가격 수치 **새로 만들지 말 것**.
2) 카드의 헤드라인을 근거로 종목별 1~2문단 해석(왜 움직였는지). 뉴스가 없으면 "재료 불명(기술적/단기 수급 가능성)"으로 명시.
3) 섹터/테마 로테이션(예: AI 반도체, 금리민감, 에너지)을 묶어서 이야기처럼 정리.
4) 30분 리플레이는 '하이라이트' 4~6줄로 서술(정확 수치 대신 흐름).
5) EOD 총평 + 내일 체크리스트 3~5개.
캐릭터: '미국 야간경비원'(1인칭). 신뢰감 90%, 위트 10%.
`;
}

async function composeDeepMarkdown(dateEt: string, lists: any) {
  // 분석 대상 티커 합집합을 뽑고, 상세/뉴스 수집
  const pick = lists.unionTickers;
  const metaMap: Record<string, any> = {};

  for (const t of pick) {
    try {
      const [details, news] = await Promise.all([
        fetchTickerDetails(t),
        fetchNews(t, NEWS_PER_TICKER),
      ]);
      // 해당 티커의 changePct/volume 등 기본 수치(리스트에서 재사용)
      const base = lists.gainers.find((x: any) => x.ticker === t) ||
                   lists.losers.find((x: any) => x.ticker === t) ||
                   lists.mostActive.find((x: any) => x.ticker === t) || { changePct: 0, volume: 0 };
      metaMap[t] = {
        ticker: t,
        name: details?.name || t,
        sector: details?.sector || "",
        market_cap: details?.market_cap || null,
        homepage_url: details?.homepage_url || "",
        changePct: base.changePct,
        volume: base.volume,
        news: news || [],
      };
    } catch {}
  }

  // LLM 서술 본문 생성
  const cards = pick.map((t: string) => metaMap[t]).filter(Boolean);
  const client = await getOpenAI();
  let body = "";
  if (client) {
    const prompt = buildLLMUserPrompt(dateEt, cards, lists);
    const sys = "너는 신뢰도 높은 마켓 라이터다. 투자 권유/수익 보장/허위 수치 금지.";
    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.6,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: prompt },
      ],
    });
    body = completion.choices?.[0]?.message?.content || "";
  } else {
    body = `## 🎙️ 오프닝\nLLM 키가 없어 간단 요약만 제공합니다.`;
  }

  // 데이터 표(Top10/Top30)
  const top10 = [
    mdTable(lists.mostActive, "Top 10 — 거래많은주 (Most Active)"),
    mdTable(lists.gainers, "Top 10 — 급등주 (Gainers)"),
    mdTable(lists.losers, "Top 10 — 하락주 (Losers)"),
  ].join("\n\n");

  const top30 = [
    mdTable(lists.mostActive, "Most Active Top 30 (EOD)", 30),
    mdTable(lists.gainers, "Gainers Top 30 (EOD)", 30),
    mdTable(lists.losers, "Losers Top 30 (EOD)", 30),
  ].join("\n\n");

  const prefix = process.env.SITE_TITLE_PREFIX || "미국 야간경비원 일지";
  const md = `# ${prefix} | ${dateEt}\n\n${body}\n\n---\n\n## 📊 데이터(Top10)\n${top10}\n\n---\n\n## 📚 데이터 부록(Top30)\n${top30}\n\n---\n\n#미국주식 #미국야간경비원 #장마감 #나스닥 #S&P500 #증시브리핑 #테마 #상승주 #하락주 #MostActive`;

  return { markdown: md, cards };
}

// ──────────────────────────────────────────────────────────────────────────────
// 핸들러
// ──────────────────────────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  try {
    if (!POLYGON_KEY) return NextResponse.json({ ok: false, error: "Missing POLYGON_API_KEY" }, { status: 500 });

    const now = DateTime.utc();
    const dateEt = previousUsTradingDate(now);
    const daily = await fetchGroupedDaily(dateEt);
    const rows = daily?.results || [];
    if (!rows.length) throw new Error("No EOD data returned");

    const lists = computeLists(rows);
    const { markdown, cards } = await composeDeepMarkdown(dateEt, lists);

    return NextResponse.json({ ok: true, dateEt, markdown, analyzed: cards.length });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
