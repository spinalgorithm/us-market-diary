/* eslint-disable @typescript-eslint/no-explicit-any */
// src/app/api/eod-deep/route.ts
import { NextRequest } from "next/server";

/** ─────────────────────────────────────────────────────────────────
 * Runtime / Cache
 * ──────────────────────────────────────────────────────────────── */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** ─────────────────────────────────────────────────────────────────
 * Types
 * ──────────────────────────────────────────────────────────────── */
type Quote = {
  symbol: string;
  shortName?: string;
  longName?: string;
  currency?: string;
  regularMarketOpen?: number;
  regularMarketPrice?: number;
  regularMarketPreviousClose?: number;
  regularMarketVolume?: number;
};

type Row = {
  ticker: string;
  name: string;
  theme: string;  // 간단 태그(섹터 추정)
  brief: string;  // 한줄 설명(룰/휴리스틱)
  open: number | null;
  close: number | null;
  previousClose: number | null;
  chgPctPrev: number | null;      // (close/prevClose -1)*100
  chgPctIntraday: number | null;  // (close/open -1)*100
  volume: number | null;
  usdVolM: number | null;         // close*volume/1e6
  currency: string;
};

type Rankings = {
  byValue: Row[];
  byVolume: Row[];
  topGainers: Row[];
  topLosers: Row[];
};

type EodJson = {
  ok: boolean;
  date: string;
  source: string;
  universeCount: number;
  quotes: Row[];
  rankings: Rankings;
  note?: string;
  narrative?: string;
  error?: string;
};

/** ─────────────────────────────────────────────────────────────────
 * Utils
 * ──────────────────────────────────────────────────────────────── */
const US_TZ_OFFSET_EST = -5 * 60; // 단순 표기용(서머타임 보정 X). EOD는 날짜 문자열만 사용
function fmtDateUTC(d = new Date()): string {
  // UTC 기준 YYYY-MM-DD
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function num(x: any): number | undefined {
  const n = Number(x);
  return Number.isFinite(n) ? n : undefined;
}

function chgPctPrev(q: { close?: number; previousClose?: number }): number | undefined {
  const c = num(q.close);
  const p = num(q.previousClose);
  if (c != null && p != null && p > 0) return ((c - p) / p) * 100;
  return undefined;
}

function chgPctIntraday(q: { open?: number; close?: number }): number | undefined {
  const o = num(q.open);
  const c = num(q.close);
  if (o != null && o > 0 && c != null) return ((c - o) / o) * 100;
  return undefined;
}

function usdMillions(price?: number, vol?: number): number | undefined {
  if (price == null || vol == null) return undefined;
  return (price * vol) / 1_000_000;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function delay(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

/** ─────────────────────────────────────────────────────────────────
 * Data sources
 *  - Yahoo Screener(사전정의): most_actives / day_gainers / day_losers
 *  - Yahoo Batch quote: v7/finance/quote
 *  - TwelveData(옵션): 부족 시 제한 수 내 폴백
 * OpenAI(옵션): 내러티브 요약
 * ──────────────────────────────────────────────────────────────── */

/** Yahoo predefined screener fetcher
 * ex) https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?count=100&scrIds=most_actives&start=0
 */
async function safeJson<T=any>(url: string): Promise<T|null> {
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return null;
    return await r.json() as T;
  } catch {
    return null;
  }
}

async function fetchScreener(scrId: string, count: number, start = 0): Promise<string[]> {
  const url =
    `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved` +
    `?count=${count}&scrIds=${encodeURIComponent(scrId)}&start=${start}`;
  const j = await safeJson<any>(url);
  const arr = j?.finance?.result?.[0]?.quotes ?? [];
  const syms: string[] = [];
  for (const q of arr) {
    const s = String(q?.symbol ?? "").toUpperCase();
    if (s) syms.push(s);
  }
  return syms;
}

/** Batch quotes */
async function fetchYahooBatchQuotes(symbols: string[]): Promise<Map<string, Quote>> {
  const out = new Map<string, Quote>();
  if (!symbols.length) return out;
  const batches = chunk(symbols, 60);
  for (const b of batches) {
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(b.join(","))}`;
    const j = await safeJson<any>(url);
    const arr = j?.quoteResponse?.result ?? [];
    for (const r of arr) {
      const symbol = String(r?.symbol ?? "").toUpperCase();
      if (!symbol) continue;
      const open = num(r?.regularMarketOpen ?? r?.open);
      const close = num(r?.regularMarketPrice ?? r?.regularMarketPreviousClose ?? r?.postMarketPrice);
      const prev = num(r?.regularMarketPreviousClose);
      const vol = num(r?.regularMarketVolume ?? r?.volume);
      const currency = r?.currency ?? "USD";
      const name = r?.shortName ?? r?.longName ?? symbol;
      out.set(symbol, {
        symbol, shortName: name, longName: r?.longName,
        currency, regularMarketOpen: open, regularMarketPrice: close,
        regularMarketPreviousClose: prev, regularMarketVolume: vol,
      });
    }
    // 짧은 텀 (우발적 레이트 제한 방지)
    await delay(80);
  }
  return out;
}

/** TwelveData fallback (optional) */
const TD_ENDPOINT = "https://api.twelvedata.com/quote";
async function fetchTwelveDataQuote(symbol: string, apikey: string) {
  const url = `${TD_ENDPOINT}?symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(apikey)}`;
  const j = await safeJson<any>(url);
  if (!j || j.status === "error" || j.code || j.message) return null;
  const open = num(j.open);
  const close = num(j.close);
  const prev = num(j.previous_close ?? j.previousClose);
  const vol  = num(j.volume);
  const name = j.name ?? symbol;
  const currency = j.currency ?? "USD";
  if (close == null && prev == null && vol == null) return null;
  return {
    symbol, shortName: name, longName: name, currency,
    regularMarketOpen: open, regularMarketPrice: close,
    regularMarketPreviousClose: prev, regularMarketVolume: vol,
  } as Quote;
}

/** Combine: primary + limited fallback */
async function fetchAllQuotes(
  symbols: string[],
  tdApiKey?: string,
  fallbackMax = 50,   // TwelveData 폴백 최대 갯수(타임아웃/요금 보호)
): Promise<Map<string, Quote>> {
  const primary = await fetchYahooBatchQuotes(symbols);
  if (!tdApiKey || fallbackMax <= 0) return primary;

  const out = new Map(primary);
  let used = 0;
  for (const s of symbols) {
    if (used >= fallbackMax) break;
    const q = out.get(s);
    const missing = !q || (
      (q.regularMarketPrice == null || q.regularMarketPreviousClose == null) &&
      (q.regularMarketVolume == null)
    );
    if (missing) {
      const td = await fetchTwelveDataQuote(s, tdApiKey);
      if (td) out.set(s, td);
      used++;
      await delay(40);
    }
  }
  return out;
}

/** ─────────────────────────────────────────────────────────────────
 * Light theming (US): 심플 휴리스틱 태깅
 * ──────────────────────────────────────────────────────────────── */
function inferThemeBrief(name?: string, symbol?: string): { theme: string; brief: string } {
  const n = (name ?? "").toLowerCase();
  const s = (symbol ?? "").toUpperCase();
  const hit = (...ws: string[]) => ws.some(w => n.includes(w));
  // 초간단 룰 (확장 원하면 여기에 추가)
  if (hit("semiconductor","foundry","chips","nvidia","amd","intel","broadcom","qualcomm")) return { theme:"半導体", brief:"半導体/設計・製造" };
  if (hit("software","cloud","saas","microsoft","salesforce","service now","workday")) return { theme:"ITサービス", brief:"ソフト/クラウド" };
  if (hit("alphabet","google")) return { theme:"ネット", brief:"検索/広告" };
  if (hit("meta","facebook","instagram","whatsapp")) return { theme:"ネット", brief:"SNS/広告" };
  if (hit("apple","iphon","mac","ios")) return { theme:"電子機器", brief:"端末/エコシステム" };
  if (hit("amazon")) return { theme:"ネット", brief:"EC/クラウド" };
  if (hit("tesla","ev","electric vehicle","motors")) return { theme:"自動車", brief:"EV/テック" };
  if (hit("bank","financial","sachs","jp morgan","bank of america","wells fargo")) return { theme:"金融", brief:"銀行/金融" };
  if (hit("energy","exxon","chevron","oil","petroleum","refining")) return { theme:"エネルギー", brief:"原油/ガス" };
  if (hit("biotech","pharma","pharmaceutical","therapeutics","genomics")) return { theme:"医薬", brief:"製薬/バイオ" };
  if (s.endsWith("-USD")) return { theme:"暗号資産", brief:"USDペア" };
  return { theme: "-", brief: "-" };
}

/** rows / rankings */
function buildRows(symbols: string[], qmap: Map<string, Quote>): Row[] {
  return symbols.map((sym) => {
    const q = qmap.get(sym);
    const close = num(q?.regularMarketPrice);
    const prev  = num(q?.regularMarketPreviousClose);
    const open  = num(q?.regularMarketOpen);
    const vol   = num(q?.regularMarketVolume);
    const name  = (q?.shortName || q?.longName || sym).toString();
    const { theme, brief } = inferThemeBrief(name, sym);
    const row: Row = {
      ticker: sym,
      name,
      theme,
      brief,
      open: open ?? null,
      close: close ?? null,
      previousClose: prev ?? null,
      chgPctPrev: chgPctPrev({ close, previousClose: prev }) ?? null,
      chgPctIntraday: chgPctIntraday({ open, close }) ?? null,
      volume: vol ?? null,
      usdVolM: usdMillions(close, vol) ?? null,
      currency: q?.currency ?? "USD",
    };
    return row;
  });
}

function buildRankings(rows: Row[]): Rankings {
  const byValue = [...rows]
    .filter(r => r.usdVolM != null)
    .sort((a,b)=> (b.usdVolM! - a.usdVolM!))
    .slice(0, 10);

  const byVolume = [...rows]
    .filter(r => r.volume != null)
    .sort((a,b)=> (b.volume! - a.volume!))
    .slice(0, 10);

  const price = (r: Row) => (r.close ?? r.previousClose ?? r.open ?? 0);
  const elig = rows.filter(r => price(r) >= 5 && r.chgPctPrev != null);

  const topGainers = [...elig]
    .filter(r => (r.chgPctPrev as number) > 0)
    .sort((a,b)=> (b.chgPctPrev! - a.chgPctPrev!))
    .slice(0, 10);

  const topLosers = [...elig]
    .filter(r => (r.chgPctPrev as number) < 0)
    .sort((a,b)=> (a.chgPctPrev! - b.chgPctPrev!))
    .slice(0, 10);

  return { byValue, byVolume, topGainers, topLosers };
}

/** ─────────────────────────────────────────────────────────────────
 * Markdown helpers
 * ──────────────────────────────────────────────────────────────── */
function n(x: number | null | undefined): string {
  if (x == null || !Number.isFinite(Number(x))) return "-";
  return Number(x).toLocaleString("en-US");
}
function p(x: number | null | undefined, digits=2): string {
  if (x == null || !Number.isFinite(Number(x))) return "-";
  return Number(x).toFixed(digits);
}
function oc(o: number | null | undefined, c: number | null | undefined): string {
  if (o == null || c == null) return "-→-";
  return `${n(o)}→${n(c)}`;
}
function take<T>(arr: T[] | undefined, k=10): T[] {
  return Array.isArray(arr) ? arr.slice(0, k) : [];
}

function tableByValue(rows: Row[]): string {
  const head = `| Rank | Ticker | Name | o→c | Chg% | Vol | $Vol(M) | Theme | Brief |
|---:|---:|---|---:|---:|---:|---:|---|---|
`;
  const body = take(rows, 10).map((r,i)=>[
    i+1, r.ticker, r.name, oc(r.open,r.close), p(r.chgPctPrev),
    n(r.volume), n(r.usdVolM), r.theme||"-", r.brief||"-"
  ].join(" | ")).join("\n");
  return head + body + (body? "\n":"");
}
function tableByVolume(rows: Row[]): string {
  const head = `| Rank | Ticker | Name | o→c | Chg% | Vol | Theme | Brief |
|---:|---:|---|---:|---:|---:|---|---|
`;
  const body = take(rows, 10).map((r,i)=>[
    i+1, r.ticker, r.name, oc(r.open,r.close), p(r.chgPctPrev),
    n(r.volume), r.theme||"-", r.brief||"-"
  ].join(" | ")).join("\n");
  return head + body + (body? "\n":"");
}
function tableGainers(rows: Row[]): string {
  const head = `| Rank | Ticker | Name | o→c | Chg% | Vol | Theme | Brief |
|---:|---:|---|---:|---:|---:|---|---|
`;
  const body = take(rows, 10).map((r,i)=>[
    i+1, r.ticker, r.name, oc(r.open,r.close), p(r.chgPctPrev),
    n(r.volume), r.theme||"-", r.brief||"-"
  ].join(" | ")).join("\n");
  return head + body + (body? "\n":"");
}
function tableLosers(rows: Row[]): string {
  const head = `| Rank | Ticker | Name | o→c | Chg% | Vol | Theme | Brief |
|---:|---:|---|---:|---:|---:|---|---|
`;
  const body = take(rows, 10).map((r,i)=>[
    i+1, r.ticker, r.name, oc(r.open,r.close), p(r.chgPctPrev),
    n(r.volume), r.theme||"-", r.brief||"-"
  ].join(" | ")).join("\n");
  return head + body + (body? "\n":"");
}

/** ─────────────────────────────────────────────────────────────────
 * LLM Narrative (optional, no SDK; REST only)
 *  - Set OPENAI_API_KEY (and OPENAI_MODEL optional)
 * ──────────────────────────────────────────────────────────────── */
async function llmNarrative(input: {
  date: string;
  source: string;
  universeCount: number;
  rows: Row[];
  rankings: Rankings;
}): Promise<string | null> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  // 집계 숫자(증거 기반)
  const all = input.rows;
  const sumAll = all.reduce((a,c)=> a + (c.usdVolM ?? 0), 0);
  const sumTop10 = input.rankings.byValue.reduce((a,c)=> a + (c.usdVolM ?? 0), 0);
  const breadthUp = all.filter(r => (r.chgPctPrev ?? 0) > 0).length;
  const breadthDn = all.filter(r => (r.chgPctPrev ?? 0) < 0).length;

  const topThemes = (() => {
    const m = new Map<string, number>();
    for (const r of all) {
      if (!r.theme || r.theme === "-") continue;
      m.set(r.theme, (m.get(r.theme) ?? 0) + (r.usdVolM ?? 0));
    }
    return [...m.entries()].sort((a,b)=> b[1]-a[1]).slice(0,3).map(([k,v])=>`${k}`).join("/");
  })();

  const system = `あなたは米国市場のEODレポートを作成する敏腕アナリストです。事実は与えられた数値のみ。過度な断定・誇張を避け、簡潔明瞭に。`;
  const user = `
日付: ${input.date}
ソース: ${input.source}
ユニバース銘柄数: ${input.universeCount}
Top10集中度(売買代金基準): ${sumAll>0 ? (sumTop10/sumAll*100).toFixed(1) : "N/A"}%
ブレッドス(上昇/下落): ${breadthUp}:${breadthDn}
主導テーマ(概算): ${topThemes || "-"}

指示:
- 日本語で、TL;DR・本日のストーリー(3行)・EOD総括(2行)・明日のチェック(3行)・シナリオ(3行) を、Markdownセクションで返す。
- 確認できないこと(ニュース/決算詳細/出来高の時間配分など)は書かない。
- TL;DRにはTop10集中度とブレッドスを必ず含める。`;

  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0.4,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    const j = await resp.json();
    const txt: string | undefined = j?.choices?.[0]?.message?.content;
    return txt ?? null;
  } catch {
    return null;
  }
}

/** ─────────────────────────────────────────────────────────────────
 * GET handler
 * Params:
 *  - max: number (기본 300; 50~600)  … 스크리너에서 최대 몇 종목 수집할지
 *  - screener: csv of scrIds (default: most_actives,day_gainers,day_losers)
 *  - td: TwelveData fallback 사용 최대 갯수 (기본 40)
 *  - llm: "0|1" (기본 1; OPENAI_API_KEY 없으면 자동 비활성)
 * ──────────────────────────────────────────────────────────────── */
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const max = Math.min(Math.max(Number(url.searchParams.get("max") ?? "300"), 50), 600);
    const tdMax = Math.min(Math.max(Number(url.searchParams.get("td") ?? "40"), 0), 200);
    const llmOn = (url.searchParams.get("llm") ?? "1") === "1";
    const scrParam = (url.searchParams.get("screener") || "most_actives,day_gainers,day_losers")
      .split(",").map(s=>s.trim()).filter(Boolean);

    // 1) Universe from Yahoo predefined screeners (병합/중복제거)
    let uni: string[] = [];
    for (const scrId of scrParam) {
      // count는 대략 max의 1.2배로 넉넉히 가져온 후 dedup → 최종 max로 컷
      const got = await fetchScreener(scrId, Math.round(max * 1.2), 0);
      uni.push(...got);
      await delay(60);
    }
    // 미국 외/ETF/선물 심볼 혼재 가능 → 일단 전부 유지. 이후 quote 없으면 자동 탈락.
    uni = Array.from(new Set(uni)).slice(0, max);

    // 2) Quotes (Yahoo primary + TwelveData limited fallback)
    const tdKey = process.env.TWELVEDATA_API_KEY || "";
    const qmap = await fetchAllQuotes(uni, tdKey || undefined, tdMax);

    // 3) Build rows & drop empties
    const rows = buildRows(uni, qmap).filter(r => r.close != null || r.previousClose != null || r.volume != null);
    const rankings = buildRankings(rows);

    // 4) Narrative (optional LLM)
    const dateStr = fmtDateUTC();
    const source = `YahooScreener+YahooBatch${tdKey?"+TwelveData":""}`;
    const universeCount = rows.length;

    let narrative = "";
    if (llmOn && process.env.OPENAI_API_KEY) {
      const nar = await llmNarrative({ date: dateStr, source, universeCount, rows, rankings });
      if (nar) narrative = nar;
    }

    // 5) Markdown compose
    const header =
`# US Market EOD Deep | ${dateStr}

> ソース: ${source} / ユニバース: ${universeCount}銘柄
> 収集: Yahooプリセットスクリーナー（${scrParam.join(", ")}）から上位 **${max}**銘柄を集約。
> 注記: 無料ソースの性質上、厳密なEODとの微差が出る場合があります（USD）。`;

    const mdParts: string[] = [header, ""];

    if (narrative) {
      mdParts.push(narrative.trim(), "---");
    }

    // Cards(대표): SPY/QQQ/AAPL/MSFT/NVDA/AMZN/GOOGL/META/TSLA/AMD
    const CARD_SET = new Set(["SPY","QQQ","AAPL","MSFT","NVDA","AMZN","GOOGL","GOOG","META","TSLA","AMD"]);
    const cards = rows.filter(r => CARD_SET.has(r.ticker));
    const cardLines: string[] = [];
    if (cards.length) {
      cardLines.push("## カード（主要ETF・大型）");
      for (const r of cards) {
        cardLines.push(`- ${r.ticker} — ${r.name}`);
        cardLines.push(`  - o→c: ${oc(r.open,r.close)} / Chg%: ${p(r.chgPctPrev)} / Vol: ${n(r.volume)} / $Vol(M): ${n(r.usdVolM)} / ${r.theme||"-"} — ${r.brief||"-"}`);
      }
      mdParts.push(cardLines.join("\n"), "\n---");
    }

    mdParts.push(
      "## 📊 データ(Top10)",
      "### Top 10 — 売買代金（百万USD換算）",
      tableByValue(rankings.byValue),
      "### Top 10 — 出来高（株数）",
      tableByVolume(rankings.byVolume),
      "### Top 10 — 上昇株（$5+）",
      tableGainers(rankings.topGainers),
      "### Top 10 — 下落株（$5+）",
      tableLosers(rankings.topLosers),
      "\n#米国株 #NASDAQ #NYSE #S&P500 #出来高 #売買代金 #大型株\n"
    );

    const md = mdParts.join("\n");

    const out: EodJson = {
      ok: true,
      date: dateStr,
      source,
      universeCount,
      quotes: rows,
      rankings,
      note: "chgPctPrev=前日比(終値/前日終値), chgPctIntraday=日中変動。Top10は$5以上のみで作成。",
      narrative: narrative || undefined,
    };

    const want = (url.searchParams.get("format")||"md").toLowerCase();
    if (want === "json") {
      return new Response(JSON.stringify(out), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
    return new Response(md, {
      status: 200,
      headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "no-store" },
    });

  } catch (err: any) {
    const body: EodJson = { ok: false, date: fmtDateUTC(), source: "-", universeCount: 0, quotes: [], rankings: { byValue:[], byVolume:[], topGainers:[], topLosers:[] }, error: err?.message || "unknown" };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
}
