
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
