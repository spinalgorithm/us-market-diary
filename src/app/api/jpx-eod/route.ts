// src/app/api/jpx-eod/route.ts
import { NextRequest } from "next/server";

/**
 * ENV
 * - TWELVEDATA_API_KEY: Twelve Data API Key (optional but recommended)
 * - JPX_UNIVERSE_URL: 유니버스 CSV/JSON URL (optional)
 * - JPX_HOLIDAYS_URL: 일본 휴장일(YYYY-MM-DD[]) JSON URL (optional)
 */

type UniverseItem = {
  code: string;          // 8035
  name?: string;         // 東京エレクトロン
  theme?: string;        // 半導体製造装置
  brief?: string;        // 製造装置大手
  yahooSymbol?: string;  // 8035.T
};

type Quote = {
  symbol: string;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  previousClose?: number;
  volume?: number;
  currency?: string;
  name?: string;
};

type Row = {
  code: string;
  ticker: string;        // yahooSymbol
  name: string;
  theme: string;
  brief: string;
  open: number | null;
  close: number | null;
  previousClose: number | null;
  chgPctPrev: number | null;      // (close / previousClose - 1) * 100
  chgPctIntraday: number | null;  // (close / open - 1) * 100
  volume: number | null;
  yenVolM: number | null;         // close * volume / 1e6
  currency: string;
};

// ---------- 시간 유틸 (JST 기준) ----------
const JST_OFFSET_MIN = 9 * 60;
function toJstDate(d = new Date()): Date {
  const utc = d.getTime() + d.getTimezoneOffset() * 60000;
  return new Date(utc + JST_OFFSET_MIN * 60000);
}
function formatYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function isWeekend(d: Date): boolean {
  const wd = d.getDay(); // 0 Sun, 6 Sat
  return wd === 0 || wd === 6;
}
function addDays(d: Date, n: number): Date {
  const nd = new Date(d);
  nd.setDate(d.getDate() + n);
  return nd;
}
function prevBizDay(d: Date, holidays: Set<string>): Date {
  let cur = addDays(d, -1);
  while (isWeekend(cur) || holidays.has(formatYmd(cur))) {
    cur = addDays(cur, -1);
  }
  return cur;
}

// ---------- 데이터 계산 유틸 ----------
function chgPctPrev(q: Quote | undefined): number | undefined {
  if (!q) return undefined;
  if (q.close != null && q.previousClose != null && q.previousClose > 0) {
    return ((q.close - q.previousClose) / q.previousClose) * 100;
  }
  return undefined;
}
function chgPctIntraday(q: Quote | undefined): number | undefined {
  if (!q) return undefined;
  if (q.open != null && q.open > 0 && q.close != null) {
    return ((q.close - q.open) / q.open) * 100;
  }
  return undefined;
}
function yenMillions(q: Quote | undefined): number | undefined {
  if (!q?.close || !q?.volume) return undefined;
  return (q.close * q.volume) / 1_000_000;
}

// ---------- 외부 fetch ----------
async function safeJson<T = any>(url: string, init?: RequestInit): Promise<T | null> {
  try {
    const r = await fetch(url, { ...init, cache: "no-store" });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}
async function safeText(url: string, init?: RequestInit): Promise<string | null> {
  try {
    const r = await fetch(url, { ...init, cache: "no-store" });
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  }
}
function csvToUniverse(csv: string): UniverseItem[] {
  // 기대 헤더: code,name,theme,brief,yahooSymbol
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length <= 1) return [];
  const header = lines[0].split(",").map(s => s.trim());
  const idx = (k: string) => header.findIndex(h => h.toLowerCase() === k.toLowerCase());
  const iCode = idx("code");
  const iName = idx("name");
  const iTheme = idx("theme");
  const iBrief = idx("brief");
  const iY = idx("yahoosymbol");
  const out: UniverseItem[] = [];
  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw) continue;
    const cols = raw.split(",").map(s => s.trim());
    const code = cols[iCode]?.replace(/"/g, "");
    if (!code) continue;
    out.push({
      code,
      name: cols[iName]?.replace(/"/g, ""),
      theme: cols[iTheme]?.replace(/"/g, ""),
      brief: cols[iBrief]?.replace(/"/g, ""),
      yahooSymbol: cols[iY]?.replace(/"/g, ""),
    });
  }
  return out;
}

// ---------- 유니버스 (기본 + 커스텀 URL) ----------
const DEFAULT_UNIVERSE: UniverseItem[] = [
  { code: "1321", name: "日経225連動型上場投信", theme: "インデックス/ETF", brief: "日経225連動ETF" },
  { code: "1306", name: "TOPIX連動型上場投信", theme: "インデックス/ETF", brief: "TOPIX連動ETF" },
  { code: "7203", name: "トヨタ自動車", theme: "自動車", brief: "世界最大級の自動車メーカー" },
  { code: "6758", name: "ソニーグループ", theme: "エレクトロニクス", brief: "ゲーム/画像センサー/音楽" },
  { code: "8035", name: "東京エレクトロン", theme: "半導体製造装置", brief: "製造装置大手" },
  { code: "6861", name: "キーエンス", theme: "計測/FA", brief: "センサー/FA機器" },
  { code: "6501", name: "日立製作所", theme: "総合電機", brief: "社会インフラ/IT" },
  { code: "4063", name: "信越化学工業", theme: "素材/化学", brief: "半導体用シリコン" },
  { code: "9432", name: "日本電信電話", theme: "通信", brief: "国内通信大手" },
  { code: "6954", name: "ファナック", theme: "FA/ロボット", brief: "産業用ロボット" },
  { code: "8306", name: "三菱UFJフィナンシャルG", theme: "金融", brief: "メガバンク" },
  { code: "8316", name: "三井住友フィナンシャルG", theme: "金融", brief: "メガバンク" },
  { code: "9984", name: "ソフトバンクグループ", theme: "投資/テック", brief: "投資持株/通信" },
  { code: "9983", name: "ファーストリテイリング", theme: "アパレル/SPA", brief: "ユニクロ" },
  { code: "7974", name: "任天堂", theme: "ゲーム", brief: "게임機/ソフト" },
  { code: "9433", name: "KDDI", theme: "通信", brief: "au/通信" },
  { code: "9434", name: "ソフトバンク", theme: "通信", brief: "携帯通信" },
  { code: "6594", name: "日本電産", theme: "電機/モーター", brief: "小型モーター/EV" },
  { code: "6920", name: "レーザーテック", theme: "半導体検査", brief: "EUV検査" },
  { code: "6857", name: "アドバンテスト", theme: "半導体検査", brief: "テスタ大手" },
  { code: "6981", name: "村田製作所", theme: "電子部品", brief: "コンデンサ等" },
  { code: "7752", name: "リコー", theme: "OA/機器", brief: "OA/装置" },
  { code: "7735", name: "SCREENホールディングス", theme: "半導体製造装置", brief: "洗浄/成膜等" },
  { code: "6762", name: "TDK", theme: "電子部品", brief: "受動部品/二次電池" },
  { code: "9020", name: "東日本旅客鉄道", theme: "鉄道", brief: "関東/東北のJR" },
  { code: "8058", name: "三菱商事", theme: "商社", brief: "総合商社" },
  { code: "6902", name: "デンソー", theme: "自動車部品", brief: "車載/半導体" },
  { code: "8001", name: "伊藤忠商事", theme: "商社", brief: "総合商社" },
];

async function loadUniverse(fallbackUrl?: string): Promise<UniverseItem[]> {
  // 우선순위: ENV > fallbackUrl > DEFAULT
  const url = process.env.JPX_UNIVERSE_URL ?? fallbackUrl;

  if (!url) {
    return DEFAULT_UNIVERSE.map(u => ({
      ...u,
      yahooSymbol: u.yahooSymbol ?? `${u.code}.T`,
    }));
  }

  // CSV 지원
  if (url.endsWith(".csv")) {
    const text = await safeText(url);
    const parsed = text ? csvToUniverse(text) : [];
    if (parsed.length > 0) {
      return parsed.map(u => ({ ...u, yahooSymbol: u.yahooSymbol ?? `${u.code}.T` }));
    }
    // CSV 파싱 실패 → DEFAULT
    return DEFAULT_UNIVERSE.map(u => ({
      ...u,
      yahooSymbol: u.yahooSymbol ?? `${u.code}.T`,
    }));
  }

  // JSON (기존 포맷)
  const data = await safeJson<UniverseItem[]>(url);
  if (Array.isArray(data) && data.length > 0) {
    return data.map(u => ({ ...u, yahooSymbol: u.yahooSymbol ?? `${u.code}.T` }));
  }

  // 실패 시 기본값
  return DEFAULT_UNIVERSE.map(u => ({
    ...u,
    yahooSymbol: u.yahooSymbol ?? `${u.code}.T`,
  }));
}

async function loadJpxHolidays(): Promise<Set<string>> {
  const url = process.env.JPX_HOLIDAYS_URL;
  if (!url) return new Set();
  const data = await safeJson<string[]>(url);
  if (!Array.isArray(data)) return new Set();
  return new Set(data);
}

// ---------- Twelve Data (primary) ----------
const TD_ENDPOINT = "https://api.twelvedata.com/quote";

async function fetchTwelveDataQuote(symbol: string, apikey: string): Promise<Quote | null> {
  const url = `${TD_ENDPOINT}?symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(apikey)}`;
  const r = await safeJson<any>(url);
  if (!r) return null;
  if (r.status === "error" || r.code || r.message) return null;

  const open = num(r.open);
  const close = num(r.close);
  const prev = num(r.previous_close ?? r.previousClose);
  const volume = num(r.volume);
  const currency = r.currency ?? "JPY";
  const name = r.name;

  if (close == null && prev == null && volume == null) return null;

  return {
    symbol,
    open: open ?? undefined,
    close: close ?? undefined,
    previousClose: prev ?? undefined,
    volume: volume ?? undefined,
    currency,
    name,
  };
}

// ---------- Yahoo Chart (fallback) ----------
async function fetchYahooChartQuote(symbol: string): Promise<Quote | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`;
  const j = await safeJson<any>(url);
  try {
    const res = j?.chart?.result?.[0];
    if (!res) return null;
    const meta = res.meta ?? {};
    const ind = res.indicators?.quote?.[0] ?? {};
    const closes: number[] = ind.close ?? [];
    const opens: number[] = ind.open ?? [];
    const vols: number[] = ind.volume ?? [];

    const n = closes.length;
    if (n === 0) return null;

    const close = num(closes[n - 1]);
    const open = num(opens[n - 1]);
    const volume = num(vols[n - 1]);
    const prev = meta.regularMarketPreviousClose != null
      ? num(meta.regularMarketPreviousClose)
      : (n >= 2 ? num(closes[n - 2]) : undefined);

    return {
      symbol,
      open: open ?? undefined,
      close: close ?? undefined,
      previousClose: prev ?? undefined,
      volume: volume ?? undefined,
      currency: meta.currency ?? "JPY",
      name: meta.symbol ?? symbol,
    };
  } catch {
    return null;
  }
}

// ---------- 숫자 변환 ----------
function num(x: any): number | undefined {
  const n = Number(x);
  return Number.isFinite(n) ? n : undefined;
}

// ---------- 배치 로직 ----------
async function fetchQuoteFor(symbol: string, apiKey?: string): Promise<Quote | null> {
  if (apiKey) {
    const td = await fetchTwelveDataQuote(symbol, apiKey);
    if (td) return td;
  }
  const yh = await fetchYahooChartQuote(symbol);
  if (yh) return yh;
  return null;
}
async function fetchAllQuotes(symbols: string[], apiKey?: string): Promise<Map<string, Quote>> {
  const out = new Map<string, Quote>();
  for (const s of symbols) {
    const q = await fetchQuoteFor(s, apiKey);
    if (q) out.set(s, q);
    await delay(60);
  }
  return out;
}
function delay(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

// ---------- 응답 빌드 ----------
function buildRows(univ: UniverseItem[], by: Map<string, Quote>): Row[] {
  return univ.map((u) => {
    const sym = u.yahooSymbol ?? `${u.code}.T`;
    const q = by.get(sym);
    const row: Row = {
      code: u.code,
      ticker: sym,
      name: u.name ?? u.code,
      theme: u.theme ?? "-",
      brief: u.brief ?? "-",
      open: q?.open ?? null,
      close: q?.close ?? null,
      previousClose: q?.previousClose ?? null,
      chgPctPrev: chgPctPrev(q) ?? null,
      chgPctIntraday: chgPctIntraday(q) ?? null,
      volume: q?.volume ?? null,
      yenVolM: yenMillions(q) ?? null,
      currency: q?.currency ?? "JPY",
    };
    return row;
  });
}
function buildRankings(rows: Row[]) {
  const byValue = [...rows]
    .filter(r => r.yenVolM != null)
    .sort((a, b) => (b.yenVolM! - a.yenVolM!))
    .slice(0, 10);

  const byVolume = [...rows]
    .filter(r => r.volume != null)
    .sort((a, b) => (b.volume! - a.volume!))
    .slice(0, 10);

  const price = (r: Row) => (r.close ?? r.previousClose ?? r.open ?? 0);
  const elig = rows.filter(r => price(r) >= 1000 && r.chgPctPrev != null);

  const topGainers = [...elig]
    .filter(r => (r.chgPctPrev as number) > 0)
    .sort((a, b) => (b.chgPctPrev! - a.chgPctPrev!))
    .slice(0, 10);

  const topLosers = [...elig]
    .filter(r => (r.chgPctPrev as number) < 0)
    .sort((a, b) => (a.chgPctPrev! - b.chgPctPrev!))
    .slice(0, 10);

  return { byValue, byVolume, topGainers, topLosers };
}

// ---------- 메인 핸들러 ----------
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const apikey = process.env.TWELVEDATA_API_KEY || "";
    const holidays = await loadJpxHolidays();

    // 기준 날짜
    const jstNow = toJstDate();
    let baseDate: Date;
    const dateParam = searchParams.get("date");
    if (dateParam) {
      baseDate = new Date(dateParam + "T00:00:00+09:00");
    } else {
      const hh = jstNow.getHours();
      const mm = jstNow.getMinutes();
      const before1535 = hh < 15 || (hh === 15 && mm < 35);
      baseDate = before1535 ? prevBizDay(jstNow, holidays) : jstNow;
      const ymdToday = formatYmd(baseDate);
      if (isWeekend(baseDate) || holidays.has(ymdToday)) {
        baseDate = prevBizDay(baseDate, holidays);
      }
    }
    const baseYmd = formatYmd(baseDate);

    // 현재 배포 도메인 기준 fallback CSV
    const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
    const proto = req.headers.get("x-forwarded-proto") || "https";
    const origin = host ? `${proto}://${host}` : new URL(req.url).origin;
    const urlFromReq = `${origin}/jpx_universe.csv`;

    // 유니버스 로딩
    const universe = await loadUniverse(urlFromReq);
    const symbols = universe.map(u => u.yahooSymbol ?? `${u.code}.T`);

    // 시세 취득
    const quoteMap = await fetchAllQuotes(symbols, apikey || undefined);

    // 행/랭킹 구성
    const rows = buildRows(universe, quoteMap);
    const rankings = buildRankings(rows);

    const body = {
      ok: true,
      date: baseYmd,
      source: apikey ? "TwelveData(primary)->YahooChart(fallback)" : "YahooChart(only)",
      universeCount: universe.length,
      quotes: rows,
      rankings,
      note: "chgPctPrev=前日比, chgPctIntraday=日中変動。Top10は前日比(終値/前日終値)のみで作成、価格>=1,000円フィルタ。",
    };

    return new Response(JSON.stringify(body), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch (err: any) {
    const body = { ok: false, error: "backend_failure", message: err?.message ?? "unknown" };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
}
