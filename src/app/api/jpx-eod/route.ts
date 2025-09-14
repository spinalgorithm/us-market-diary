// src/app/api/jpx-eod/route.ts
import { NextRequest } from "next/server";

/**
 * ENV
 * - TWELVEDATA_API_KEY: Twelve Data API Key (optional but recommended)
 * - JPX_UNIVERSE_URL: 유니버스 CSV/JSON URL (optional)
 * - JPX_HOLIDAYS_URL: 일본 휴장일(YYYY-MM-DD[]) JSON URL (optional)
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* ──────────────────────────────────────────────────────────────────────
 * Types
 * ──────────────────────────────────────────────────────────────────── */
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

/* ──────────────────────────────────────────────────────────────────────
 * JST Date Utils
 * ──────────────────────────────────────────────────────────────────── */
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

/* ──────────────────────────────────────────────────────────────────────
 * Math/Calc
 * ──────────────────────────────────────────────────────────────────── */
function num(x: any): number | undefined {
  const n = Number(x);
  return Number.isFinite(n) ? n : undefined;
}
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

/* ──────────────────────────────────────────────────────────────────────
 * Safe fetch
 * ──────────────────────────────────────────────────────────────────── */
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

/* ──────────────────────────────────────────────────────────────────────
 * Robust CSV Parser (quotes, commas safe)
 * ──────────────────────────────────────────────────────────────────── */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"'; i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        out.push(cur); cur = "";
      } else {
        cur += ch;
      }
    }
  }
  out.push(cur);
  return out.map(s => s.trim());
}

function csvToUniverse(csv: string): UniverseItem[] {
  const lines = csv.replace(/\r\n?/g, "\n").trim().split("\n");
  if (lines.length <= 1) return [];
  const header = parseCsvLine(lines[0]);
  const findIdx = (keys: string[]) => {
    const lower = header.map(h => h.toLowerCase());
    for (const k of keys) {
      const idx = lower.indexOf(k.toLowerCase());
      if (idx >= 0) return idx;
    }
    return -1;
  };

  const iCode  = findIdx(["code"]);
  const iName  = findIdx(["name"]);
  const iTheme = findIdx(["theme"]);
  const iBrief = findIdx(["brief"]);
  const iYsym  = findIdx(["yahooSymbol", "yahoosymbol"]);

  const out: UniverseItem[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const code = cols[iCode] ?? "";
    if (!/^\d{4,5}$/.test(code)) continue;

    const name = cols[iName] && cols[iName] !== "-" ? cols[iName] : code;
    const theme = cols[iTheme] && cols[iTheme] !== "-" ? cols[iTheme] : "-";
    const brief = cols[iBrief] && cols[iBrief] !== "-" ? cols[iBrief] : "-";
    let yahooSymbol = cols[iYsym];

    if (!yahooSymbol || yahooSymbol === "-") {
      yahooSymbol = `${code}.T`;
    }

    out.push({ code, name, theme, brief, yahooSymbol });
  }
  return out;
}

/* ──────────────────────────────────────────────────────────────────────
 * Universe loaders
 * ──────────────────────────────────────────────────────────────────── */
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
  { code: "7974", name: "任天堂", theme: "ゲーム", brief: "ゲーム機/ソフト" },
  { code: "9433", name: "KDDI", theme: "通信", brief: "au/通信" },
  { code: "9434", name: "ソフトバンク", theme: "通信", brief: "携帯通信" },
];

async function loadUniverse(fallbackUrl?: string): Promise<UniverseItem[]> {
  const url = process.env.JPX_UNIVERSE_URL ?? fallbackUrl;

  if (!url) {
    return DEFAULT_UNIVERSE.map(u => ({ ...u, yahooSymbol: u.yahooSymbol ?? `${u.code}.T` }));
  }

  if (url.endsWith(".csv")) {
    const text = await safeText(url);
    const parsed = text ? csvToUniverse(text) : [];
    if (parsed.length > 0) {
      return parsed.map(u => ({ ...u, yahooSymbol: u.yahooSymbol ?? `${u.code}.T` }));
    }
    return DEFAULT_UNIVERSE.map(u => ({ ...u, yahooSymbol: u.yahooSymbol ?? `${u.code}.T` }));
  }

  const data = await safeJson<UniverseItem[]>(url);
  if (Array.isArray(data) && data.length > 0) {
    return data.map(u => ({ ...u, yahooSymbol: u.yahooSymbol ?? `${u.code}.T` }));
  }
  return DEFAULT_UNIVERSE.map(u => ({ ...u, yahooSymbol: u.yahooSymbol ?? `${u.code}.T` }));
}

async function loadJpxHolidays(): Promise<Set<string>> {
  const url = process.env.JPX_HOLIDAYS_URL;
  if (!url) return new Set();
  const data = await safeJson<string[]>(url);
  if (!Array.isArray(data)) return new Set();
  return new Set(data);
}

/* ──────────────────────────────────────────────────────────────────────
 * Yahoo Finance Batch (primary)
 * ──────────────────────────────────────────────────────────────────── */
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function fetchYahooBatchQuotes(symbols: string[]): Promise<Map<string, Quote>> {
  const out = new Map<string, Quote>();
  if (symbols.length === 0) return out;

  // 야후 v7 quote는 심볼을 , 로 연결해 한 번에 요청 (URL 길이 고려해서 60개씩)
  const batches = chunk(symbols, 60);
  for (const b of batches) {
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(b.join(","))}`;
    const j = await safeJson<any>(url);
    const arr = j?.quoteResponse?.result ?? [];
    for (const r of arr) {
      const symbol = String(r?.symbol ?? "");
      if (!symbol) continue;
      const open = num(r?.regularMarketOpen ?? r?.open);
      const close = num(r?.regularMarketPrice ?? r?.regularMarketPreviousClose ?? r?.postMarketPrice);
      const prev = num(r?.regularMarketPreviousClose);
      const volume = num(r?.regularMarketVolume ?? r?.volume);
      const currency = r?.currency ?? "JPY";
      const name = r?.shortName ?? r?.longName ?? symbol;

      out.set(symbol, {
        symbol,
        open: open ?? undefined,
        close: close ?? undefined,
        previousClose: prev ?? undefined,
        volume: volume ?? undefined,
        currency,
        name,
      });
    }
    // 살짝 텀
    await delay(120);
  }
  return out;
}

/* ──────────────────────────────────────────────────────────────────────
 * Twelve Data (fallback for missing)
 * ──────────────────────────────────────────────────────────────────── */
const TD_ENDPOINT = "https://api.twelvedata.com/quote";
async function fetchTwelveDataQuote(symbol: string, apikey: string): Promise<Quote | null> {
  const url = `${TD_ENDPOINT}?symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(apikey)}`;
  const r = await safeJson<any>(url);
  if (!r || r.status === "error" || r.code || r.message) return null;

  const open = num(r.open);
  const close = num(r.close);
  const prev = num(r.previous_close ?? r.previousClose);
  const volume = num(r.volume);
  const currency = r.currency ?? "JPY";
  const name = r.name ?? symbol;

  // 필드가 전부 비어 있으면 무시
  if (close == null && prev == null && volume == null) return null;

  return { symbol, open, close, previousClose: prev, volume, currency, name };
}

/* ──────────────────────────────────────────────────────────────────────
 * Batch + Fallback combiner
 * ──────────────────────────────────────────────────────────────────── */
async function fetchAllQuotes(symbols: string[], apikey?: string): Promise<Map<string, Quote>> {
  const primary = await fetchYahooBatchQuotes(symbols);
  if (!apikey) return primary;

  // 보강: 야후에서 비어 있는(없거나 close/vol 전무) 심볼만 TwelveData로 채움
  const out = new Map(primary);
  for (const s of symbols) {
    const q = out.get(s);
    const missing = !q || (
      (q.close == null || q.previousClose == null) &&
      (q.volume == null)
    );
    if (missing) {
      const td = await fetchTwelveDataQuote(s, apikey);
      if (td) out.set(s, td);
      await delay(80);
    }
  }
  return out;
}

/* ──────────────────────────────────────────────────────────────────────
 * Build rows / rankings
 * ──────────────────────────────────────────────────────────────────── */
function buildRows(univ: UniverseItem[], by: Map<string, Quote>): Row[] {
  return univ.map((u) => {
    const sym = (u.yahooSymbol ?? `${u.code}.T`).toUpperCase();
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

function delay(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

/* ──────────────────────────────────────────────────────────────────────
 * GET handler
 * ──────────────────────────────────────────────────────────────────── */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const apikey = process.env.TWELVEDATA_API_KEY || "";
    const holidays = await loadJpxHolidays();

    // 페이징 (?start, ?count)
    const start = Math.max(0, Number(searchParams.get("start") ?? "0"));
    const count = Math.min(Math.max(1, Number(searchParams.get("count") ?? "120")), 300);

    // 기준 날짜: 15:35 이전이면 전 영업일, 이후면 오늘
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

    // 유니버스 로드 + 슬라이스
// GET 핸들러 내부, origin 계산 뒤에 ↓ 추가
const focusParam = searchParams.get("focus"); // "1"이면 포커스 사용
const focusUrl = `${origin}/jpx_focus.csv`;
const universeUrl = `${origin}/jpx_universe.csv`;

// 유니버스 로드 부분을 아래처럼 교체
const universeAll = await loadUniverse(focusParam === "1" ? focusUrl : universeUrl);
    const universe = universeAll.slice(start, start + count);
    const symbols = universe.map(u => (u.yahooSymbol ?? `${u.code}.T`).toUpperCase());

    // 시세 취득
    const quoteMap = await fetchAllQuotes(symbols, apikey || undefined);

    // 행/랭킹 구성(슬라이스 범위 내)
    const rows = buildRows(universe, quoteMap);
    const rankings = buildRankings(rows);

    const body = {
      ok: true,
      date: baseYmd,
      source: apikey
        ? "YahooBatch(primary)+TwelveData(missing-fallback)"
        : "YahooBatch(only)",
      universeCount: universeAll.length,
      page: { start, count, returned: rows.length },
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
