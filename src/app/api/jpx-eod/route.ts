// src/app/api/jpx-eod/route.ts
import { NextRequest, NextResponse } from "next/server";

export const runtime = "edge";
export const preferredRegion = ["hnd1", "icn1", "sin1"]; // Tokyo / Seoul / Singapore

// =========================
// Types
// =========================
type UniverseItem = {
  code: string;         // "7203" (JPX 4자리 숫자)
  name: string;         // "トヨタ自動車"
  theme: string;        // "自動車"
  brief: string;        // "世界最大級の自動車メーカー"
  yahooSymbol?: string; // "7203.T" (없으면 code+".T")
};

type Quote = {
  symbol: string;         // "7203.T"
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  previousClose?: number;
  volume?: number;
  currency?: string;      // "JPY"
  name?: string;
};

// =========================
// Helpers
// =========================
function safeNum(v: any): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function jstNow(): Date {
  // JST = UTC+9
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  return new Date(utc + 9 * 3600 * 1000);
}

function isBeforeJst1535(d: Date): boolean {
  const y = d.getFullYear();
  const m = d.getMonth();
  const day = d.getDate();
  const cutoff = new Date(Date.UTC(y, m, day, 6, 35)); // 15:35 JST == 06:35 UTC
  // d is JST-based Date, so compare by timestamps
  const jstTs = d.getTime();
  const cutoffTs = cutoff.getTime() + 9 * 3600 * 1000; // align to JST epoch
  return jstTs < cutoffTs;
}

function toYahooSymbol(code: string): string {
  return `${code}.T`;
}

function calcChgPct(q: Quote): number | undefined {
  if (q.close != null && q.previousClose != null && q.previousClose > 0) {
    return ((q.close - q.previousClose) / q.previousClose) * 100;
  }
  if (q.open != null && q.open > 0 && q.close != null) {
    // fallback: intraday
    return ((q.close - q.open) / q.open) * 100;
  }
  return undefined;
}

function yenMillions(q: Quote): number | undefined {
  if (q.close != null && q.volume != null) {
    return (q.close * q.volume) / 1_000_000;
  }
  return undefined;
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// 간단 동시성 제한(외부 라이브러리 없이)
async function runLimited<T>(items: string[], limit: number, task: (sym: string) => Promise<T>): Promise<T[]> {
  const results: T[] = [];
  let idx = 0;
  const workers: Promise<void>[] = [];
  for (let c = 0; c < Math.max(1, limit); c++) {
    workers.push((async () => {
      while (true) {
        const i = idx++;
        if (i >= items.length) break;
        const s = items[i];
        try {
          const out = await task(s);
          // @ts-ignore
          results[i] = out;
        } catch {
          // ignore
        }
        // 과도한 폭주 방지
        await sleep(120);
      }
    })());
  }
  await Promise.all(workers);
  return results;
}

// =========================
// Data Sources
// =========================
async function fetchFromTwelveData(sym: string): Promise<Quote | undefined> {
  try {
    const key = process.env.TWELVEDATA_KEY;
    if (!key) return undefined;
    const url = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(sym)}&apikey=${encodeURIComponent(key)}`;
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return undefined;
    const j = await r.json() as any;

    // TwelveData 에러 포맷 가드
    if (j && j.status === "error") return undefined;

    // 정상 포맷 매핑
    const q: Quote = {
      symbol: sym,
      open: safeNum(j.open),
      high: safeNum(j.high),
      low: safeNum(j.low),
      close: safeNum(j.close),
      previousClose: safeNum(j.previous_close),
      volume: safeNum(j.volume),
      currency: (typeof j.currency === "string" ? j.currency : "JPY"),
      name: (typeof j.name === "string" ? j.name : undefined),
    };
    // close/pc 모두 없는 경우 무시
    if (q.close == null && q.previousClose == null) return undefined;
    return q;
  } catch {
    return undefined;
  }
}

async function fetchFromYahooChart(sym: string): Promise<Quote | undefined> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=1d`;
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return undefined;
    const j = await r.json() as any;
    const res = j?.chart?.result?.[0];
    if (!res) return undefined;

    const meta = res.meta || {};
    const ind = res.indicators?.quote?.[0] || {};
    const open = safeNum(ind.open?.[0]);
    const high = safeNum(ind.high?.[0]);
    const low = safeNum(ind.low?.[0]);
    const close = safeNum(ind.close?.[0] ?? meta.regularMarketPrice);
    const volume = safeNum(ind.volume?.[0]);

    const previousClose = safeNum(meta.chartPreviousClose ?? meta.previousClose);

    const q: Quote = {
      symbol: sym,
      open,
      high,
      low,
      close,
      previousClose,
      volume,
      currency: typeof meta.currency === "string" ? meta.currency : "JPY",
    };
    if (q.close == null && q.previousClose == null) return undefined;
    return q;
  } catch {
    return undefined;
  }
}

// =========================
// Universe
// =========================
const DEFAULT_UNIVERSE: UniverseItem[] = [
  // ETF
  { code: "1321", name: "日経225連動型上場投信", theme: "インデックス/ETF", brief: "日経225連動ETF" },
  { code: "1306", name: "TOPIX連動型上場投信", theme: "インデックス/ETF", brief: "TOPIX連動ETF" },
  // 반도체/장비
  { code: "8035", name: "東京エレクトロン", theme: "半導体製造装置", brief: "製造装置大手" },
  { code: "6857", name: "アドバンテスト", theme: "半導体検査", brief: "テスタ大手" },
  { code: "6920", name: "レーザーテック", theme: "半導体検査", brief: "EUV検査" },
  { code: "4063", name: "信越化学工業", theme: "素材/化学", brief: "半導体用シリコン" },
  { code: "6861", name: "キーエンス", theme: "計測/FA", brief: "センサー/FA機器" },
  { code: "6954", name: "ファナック", theme: "FA/ロボット", brief: "産業用ロボット" },
  { code: "7735", name: "SCREEN", theme: "半導体製造装置", brief: "洗浄/成膜等" },
  // 전기전자/부품
  { code: "6758", name: "ソニーグループ", theme: "エレクトロニクス", brief: "ゲーム/画像センサー/音楽" },
  { code: "6981", name: "村田製作所", theme: "電子部品", brief: "コンデンサ等" },
  { code: "6762", name: "TDK", theme: "電子部品", brief: "受動部品/二次電池" },
  { code: "6594", name: "日本電産", theme: "電機/モーター", brief: "小型モーター/EV" },
  { code: "6902", name: "デンソー", theme: "自動車部品", brief: "車載/半導体" },
  { code: "7752", name: "リコー", theme: "OA/成膜装置", brief: "OA/装置(簡略)" },
  // 자동차
  { code: "7203", name: "トヨタ自動車", theme: "自動車", brief: "世界最大級の自動車メーカー" },
  // 금융/통신/상사
  { code: "8306", name: "三菱UFJフィナンシャルG", theme: "金融", brief: "メガバンク" },
  { code: "8316", name: "三井住友フィナンシャルG", theme: "金融", brief: "メガバンク" },
  { code: "9432", name: "日本電信電話", theme: "通信", brief: "国内通信大手" },
  { code: "9433", name: "KDDI", theme: "通信", brief: "au/通信" },
  { code: "9434", name: "ソフトバンク", theme: "通信", brief: "携帯通信" },
  { code: "9984", name: "ソフトバンクグループ", theme: "投資/テック", brief: "投資持株/通信" },
  // 유통/게임/철도/상사
  { code: "9983", name: "ファーストリテイリング", theme: "アパレル/SPA", brief: "ユニクロ" },
  { code: "7974", name: "任天堂", theme: "ゲーム", brief: "ゲーム機/ソフト" },
  { code: "9020", name: "JR東日本", theme: "鉄道", brief: "関東/東北のJR" },
  { code: "8058", name: "三菱商事", theme: "商社", brief: "総合商社" },
  { code: "8001", name: "伊藤忠商事", theme: "商社", brief: "総合商社" },
  // 종합전기/에너지
  { code: "6501", name: "日立製作所", theme: "総合電機", brief: "社会インフラ/IT" },
  { code: "5020", name: "ENEOS", theme: "エネルギー", brief: "石油・エネルギー" }
];

async function loadUniverse(): Promise<UniverseItem[]> {
  try {
    const url = process.env.JPX_UNIVERSE_URL;
    if (!url) return DEFAULT_UNIVERSE;
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return DEFAULT_UNIVERSE;
    const j = await r.json() as any[];
    const norm: UniverseItem[] = [];
    for (const it of j) {
      if (!it) continue;
      const code = String(it.code ?? "").trim();
      if (!code) continue;
      norm.push({
        code,
        name: String(it.name ?? code),
        theme: String(it.theme ?? ""),
        brief: String(it.brief ?? ""),
        yahooSymbol: typeof it.yahooSymbol === "string" ? it.yahooSymbol : undefined,
      });
    }
    return norm.length ? norm : DEFAULT_UNIVERSE;
  } catch {
    return DEFAULT_UNIVERSE;
  }
}

// =========================
// Fetch & Aggregate
// =========================
async function fetchQuotes(symbols: string[]): Promise<Map<string, Quote>> {
  const out = new Map<string, Quote>();

  // 1차: Twelve Data (동시성 제한)
  const first = await runLimited<Quote | undefined>(symbols, 6, fetchFromTwelveData);
  first.forEach((q, i) => {
    if (q) out.set(symbols[i], q);
  });

  // 2차: Yahoo Chart 폴백
  const missing = symbols.filter((s) => !out.has(s));
  const second = await runLimited<Quote | undefined>(missing, 4, fetchFromYahooChart);
  second.forEach((q, i) => {
    if (q) out.set(missing[i], q);
  });

  return out;
}

function buildResponse(univ: UniverseItem[], by: Map<string, Quote>) {
  const rows = univ.map((u) => {
    const sym = u.yahooSymbol ?? toYahooSymbol(u.code);
    const q = by.get(sym);
    const close = q?.close;
    const pc = q?.previousClose;
    const chgPct = calcChgPct(q ?? { symbol: sym });
    const vol = q?.volume;
    const yVolM = yenMillions(q ?? { symbol: sym });
    return {
      code: u.code,
      ticker: sym,
      name: u.name,
      theme: u.theme,
      brief: u.brief,
      open: q?.open ?? null,
      close: close ?? null,
      previousClose: pc ?? null,
      chgPct: chgPct ?? null,
      volume: vol ?? null,
      yenVolM: yVolM ?? null,
      currency: q?.currency ?? "JPY",
    };
  });

  // 랭킹 만들기
  const byValue = [...rows]
    .filter(r => r.yenVolM != null)
    .sort((a, b) => (b.yenVolM! - a.yenVolM!))
    .slice(0, 10);

  const byVolume = [...rows]
    .filter(r => r.volume != null)
    .sort((a, b) => (b.volume! - a.volume!))
    .slice(0, 10);

  // 1000엔 이상 필터 (상승/하락)
  const priceForFilter = (r: any) => (r.close ?? r.previousClose ?? 0);
  const eligible = rows.filter(r => (priceForFilter(r) ?? 0) >= 1000 && r.chgPct != null);

  const topGainers = [...eligible].sort((a, b) => (b.chgPct! - a.chgPct!)).slice(0, 10);
  const topLosers  = [...eligible].sort((a, b) => (a.chgPct! - b.chgPct!)).slice(0, 10);

  return { rows, byValue, byVolume, topGainers, topLosers };
}

// =========================
// Route
// =========================
export async function GET(req: NextRequest) {
  try {
    const nowJst = jstNow();
    // 정보성 라벨 (마감 이후 캐치)
    const note = isBeforeJst1535(nowJst)
      ? "JST 15:35 이전 접근은 전영업일 기준(무료 소스 특성상 근사치)."
      : "当日EOD基準（無料ソースのため微差可能）。";

    const universe = await loadUniverse();
    const symbols = universe.map(u => u.yahooSymbol ?? toYahooSymbol(u.code));

    const by = await fetchQuotes(symbols);

    const { rows, byValue, byVolume, topGainers, topLosers } = buildResponse(universe, by);

    return NextResponse.json({
      ok: true,
      note,
      count: rows.length,
      asOfJST: nowJst.toISOString().replace("T", " ").slice(0, 19),
      universe,
      quotes: rows,
      rankings: {
        byValue,
        byVolume,
        topGainers,
        topLosers,
      },
    }, { status: 200 });
  } catch (e: any) {
    return NextResponse.json({
      ok: false,
      error: "JPX EOD fetch failed",
      detail: e?.message ?? String(e),
    }, { status: 500 });
  }
}
