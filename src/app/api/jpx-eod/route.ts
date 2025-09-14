// src/app/api/jpx-eod/route.ts
import { NextRequest } from "next/server";

/**
 * ENV
 * - TWELVEDATA_API_KEY: Twelve Data API Key (optional)
 * - JPX_UNIVERSE_URL: 유니버스 CSV/JSON URL (optional)
 * - JPX_HOLIDAYS_URL: 일본 휴장일(YYYY-MM-DD[]) JSON URL (optional)
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* ──────────────────────────────────────────────────────────────────────
 * Types
 * ──────────────────────────────────────────────────────────────────── */
type UniverseItem = {
  code: string;
  name?: string;
  theme?: string;
  brief?: string;
  yahooSymbol?: string; // 8035.T
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
  // ⬇️ 추가
  sector?: string;
  industry?: string;
  longName?: string;
  shortName?: string;
};

type Row = {
  code: string;
  ticker: string;
  name: string;
  theme: string;
  brief: string;
  open: number | null;
  close: number | null;
  previousClose: number | null;
  chgPctPrev: number | null;
  chgPctIntraday: number | null;
  volume: number | null;
  yenVolM: number | null;
  currency: string;
};

/* ──────────────────────────────────────────────────────────────────────
 * JST utils
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
  const wd = d.getDay();
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
 * math helpers
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
  if (!q?.volume) return undefined;
  const price = q.close ?? q.previousClose ?? q.open;
  if (!price) return undefined;
  return (price * q.volume) / 1_000_000;
}

/* ──────────────────────────────────────────────────────────────────────
 * safe fetch
 * ──────────────────────────────────────────────────────────────────── */
const UA = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36",
};

async function safeJson<T = any>(url: string, init?: RequestInit): Promise<T | null> {
  try {
    const r = await fetch(url, { ...init, headers: { ...(init?.headers || {}), ...UA }, cache: "no-store" });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}
async function safeText(url: string, init?: RequestInit): Promise<string | null> {
  try {
    const r = await fetch(url, { ...init, headers: { ...(init?.headers || {}), ...UA }, cache: "no-store" });
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  }
}

/* ──────────────────────────────────────────────────────────────────────
 * robust CSV → universe
 * ──────────────────────────────────────────────────────────────────── */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQ = false;
      } else cur += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ",") {
        out.push(cur);
        cur = "";
      } else cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function csvToUniverse(csv: string): UniverseItem[] {
  const lines = csv.replace(/\r\n?/g, "\n").trim().split("\n");
  if (lines.length <= 1) return [];
  const header = parseCsvLine(lines[0]).map((s) => s.toLowerCase());
  const idx = (k: string) => header.findIndex((h) => h === k.toLowerCase());
  const iCode = idx("code");
  const iName = idx("name");
  const iTheme = idx("theme");
  const iBrief = idx("brief");
  const iY = idx("yahoosymbol");

  const out: UniverseItem[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const code = cols[iCode];
    if (!code) continue;
    out.push({
      code,
      name: cols[iName],
      theme: cols[iTheme],
      brief: cols[iBrief],
      yahooSymbol: cols[iY] && cols[iY] !== "-" ? cols[iY].toUpperCase() : `${code}.T`,
    });
  }
  return out;
}

/* ──────────────────────────────────────────────────────────────────────
 * universe/holidays loaders
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
  if (!url) return DEFAULT_UNIVERSE.map((u) => ({ ...u, yahooSymbol: u.yahooSymbol ?? `${u.code}.T` }));

  if (url.endsWith(".csv")) {
    const text = await safeText(url);
    const parsed = text ? csvToUniverse(text) : [];
    return (parsed.length ? parsed : DEFAULT_UNIVERSE).map((u) => ({
      ...u,
      yahooSymbol: u.yahooSymbol ?? `${u.code}.T`,
    }));
  }

  const data = await safeJson<UniverseItem[]>(url);
  if (Array.isArray(data) && data.length > 0) {
    return data.map((u) => ({ ...u, yahooSymbol: u.yahooSymbol ?? `${u.code}.T` }));
  }
  return DEFAULT_UNIVERSE.map((u) => ({ ...u, yahooSymbol: u.yahooSymbol ?? `${u.code}.T` }));
}

async function loadJpxHolidays(): Promise<Set<string>> {
  const url = process.env.JPX_HOLIDAYS_URL;
  if (!url) return new Set();
  const data = await safeJson<string[]>(url);
  return Array.isArray(data) ? new Set(data) : new Set();
}

/* ──────────────────────────────────────────────────────────────────────
 * Yahoo Quote v7 (batch)
 * ──────────────────────────────────────────────────────────────────── */
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function fetchYahooBatchQuotes(symbols: string[]): Promise<Map<string, Quote>> {
  const out = new Map<string, Quote>();
  if (symbols.length === 0) return out;
  const batches = chunk(symbols, 60);
  for (const b of batches) {
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(b.join(","))}`;
    const j = await safeJson<any>(url);
    const arr = j?.quoteResponse?.result ?? [];
    for (const r of arr) {
      const symbol = String(r?.symbol ?? "");
      if (!symbol) continue;
      const open   = num(r?.regularMarketOpen ?? r?.open);
      const close  = num(r?.regularMarketPrice ?? r?.regularMarketPreviousClose ?? r?.postMarketPrice);
      const prev   = num(r?.regularMarketPreviousClose);
      const volume = num(r?.regularMarketVolume ?? r?.volume);
      const currency  = r?.currency ?? "JPY";
      const longName  = r?.longName;
      const shortName = r?.shortName;
      const name      = longName ?? shortName ?? symbol;
      const sector    = r?.sector;
      const industry  = r?.industry;

      out.set(symbol.toUpperCase(), {
        symbol, open, close, previousClose: prev, volume, currency,
        name, longName, shortName, sector, industry,
      });
    }
    await delay(120);
  }
  return out;
}


/* ──────────────────────────────────────────────────────────────────────
 * Yahoo Chart (per-symbol fallback)
 * ──────────────────────────────────────────────────────────────────── */
async function fetchYahooChartQuote(symbol: string): Promise<Quote | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol
  )}?range=5d&interval=1d`;
  const j = await safeJson<any>(url);
  try {
    const res = j?.chart?.result?.[0];
    if (!res) return null;
    const meta = res.meta ?? {};
    const ind = res.indicators?.quote?.[0] ?? {};
    const closes: any[] = ind.close ?? [];
    const opens: any[] = ind.open ?? [];
    const vols: any[] = ind.volume ?? [];
    const n = closes.length;
    if (!n) return null;

    const close = num(closes[n - 1]);
    const open = num(opens[n - 1]);
    const volume = num(vols[n - 1]);
    const prev =
      meta.regularMarketPreviousClose != null
        ? num(meta.regularMarketPreviousClose)
        : n >= 2
        ? num(closes[n - 2])
        : undefined;

    if (close == null && prev == null && volume == null) return null;
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

/* ──────────────────────────────────────────────────────────────────────
 * Twelve Data (fallback) + 심볼 포맷 보정
 * ──────────────────────────────────────────────────────────────────── */
const TD_ENDPOINT = "https://api.twelvedata.com/quote";

function tdCandidatesFromYahoo(sym: string): string[] {
  // "8035.T" → ["8035", "8035:JP", "8035:TSE"]
  const m = sym.match(/^(\d{4,5})\.T$/i);
  if (m) {
    const code = m[1];
    return [code, `${code}:JP`, `${code}:TSE`];
  }
  return [sym];
}

async function fetchTwelveDataOne(symbol: string, apikey: string): Promise<Quote | null> {
  const url = `${TD_ENDPOINT}?symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(apikey)}`;
  const r = await safeJson<any>(url);
  if (!r || r.status === "error" || r.code || r.message) return null;

  const open = num(r.open);
  const close = num(r.close);
  const prev = num(r.previous_close ?? r.previousClose);
  const volume = num(r.volume);
  const currency = r.currency ?? "JPY";
  const name = r.name ?? symbol;

  if (close == null && prev == null && volume == null) return null;
  return { symbol, open, close, previousClose: prev, volume, currency, name };
}

async function fetchTwelveDataQuote(sym: string, apikey: string): Promise<Quote | null> {
  for (const cand of tdCandidatesFromYahoo(sym)) {
    const q = await fetchTwelveDataOne(cand, apikey);
    if (q) return q;
    await delay(60);
  }
  return null;
}

/* ──────────────────────────────────────────────────────────────────────
 * Combiner (batch → TD → chart)
 * ──────────────────────────────────────────────────────────────────── */
async function fetchAllQuotes(symbols: string[], apikey?: string): Promise<Map<string, Quote>> {
  const out = await fetchYahooBatchQuotes(symbols);

  // 보강 루프: TD → Yahoo Chart
  for (const s of symbols) {
    const sym = s.toUpperCase();
    const q = out.get(sym);
    const missing = !q || ((q.close == null || q.previousClose == null) && q.volume == null);
    if (!missing) continue;

    // 1) TwelveData (있으면)
    if (apikey) {
      const td = await fetchTwelveDataQuote(sym, apikey);
      if (td) {
        out.set(sym, td);
        await delay(60);
        continue;
      }
    }
    // 2) Yahoo Chart per-symbol
    const yc = await fetchYahooChartQuote(sym);
    if (yc) out.set(sym, yc);
    await delay(60);
  }
  return out;
}

/* ──────────────────────────────────────────────────────────────────────
 * rows/rankings
 * ──────────────────────────────────────────────────────────────────── */
function buildRows(univ: UniverseItem[], by: Map<string, Quote>): Row[] {
  return univ.map((u) => {
    const sym = (u.yahooSymbol ?? `${u.code}.T`).toUpperCase();
    const q   = by.get(sym);

    const name = u.name ?? q?.longName ?? q?.shortName ?? q?.name ?? u.code;

    let theme = (u.theme && u.theme !== "-") ? u.theme : (q?.industry || q?.sector || "-");
    let brief = (u.brief && u.brief !== "-")
      ? u.brief
      : (q?.sector && q?.industry) ? `${q.sector}/${q.industry}` : (q?.sector || q?.industry || "-");

    const row: Row = {
      code: u.code,
      ticker: sym,
      name,
      theme,
      brief,
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
    .filter((r) => r.yenVolM != null)
    .sort((a, b) => b.yenVolM! - a.yenVolM!)
    .slice(0, 10);

  const byVolume = [...rows]
    .filter((r) => r.volume != null)
    .sort((a, b) => b.volume! - a.volume!)
    .slice(0, 10);

  const price = (r: Row) => r.close ?? r.previousClose ?? r.open ?? 0;
  const elig = rows.filter((r) => price(r) >= 1000 && r.chgPctPrev != null);

  const topGainers = [...elig]
    .filter((r) => (r.chgPctPrev as number) > 0)
    .sort((a, b) => b.chgPctPrev! - a.chgPctPrev!)
    .slice(0, 10);

  const topLosers = [...elig]
    .filter((r) => (r.chgPctPrev as number) < 0)
    .sort((a, b) => a.chgPctPrev! - b.chgPctPrev!)
    .slice(0, 10);

  return { byValue, byVolume, topGainers, topLosers };
}

function delay(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

/* ──────────────────────────────────────────────────────────────────────
 * GET
 * ──────────────────────────────────────────────────────────────────── */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const apikey = process.env.TWELVEDATA_API_KEY || "";
    const holidays = await loadJpxHolidays();

    // paging
    const start = Math.max(0, Number(searchParams.get("start") ?? "0"));
    const count = Math.min(Math.max(1, Number(searchParams.get("count") ?? "120")), 300);
    const focusParam = searchParams.get("focus") === "1";

    // base date
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

    // origin + universe URLs
    const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
    const proto = req.headers.get("x-forwarded-proto") || "https";
    const origin = host ? `${proto}://${host}` : new URL(req.url).origin;

    const universeUrl = focusParam ? `${origin}/jpx_focus.csv` : `${origin}/jpx_universe.csv`;

    // load + slice
    const universeAll = await loadUniverse(universeUrl);
    const universe = universeAll.slice(start, start + count);
    const symbols = universe.map((u) => (u.yahooSymbol ?? `${u.code}.T`).toUpperCase());

    // quotes (batch → TD → chart)
    const quoteMap = await fetchAllQuotes(symbols, apikey || undefined);

    // rows/rankings
    const rows = buildRows(universe, quoteMap);
    const rankings = buildRankings(rows);

    const body = {
      ok: true,
      date: baseYmd,
      source: apikey
        ? "YahooBatch+YahooChart+TwelveData"
        : "YahooBatch+YahooChart",
      universeCount: universeAll.length,
      page: { start, count, returned: rows.length },
      quotes: rows,
      rankings,
      note:
        "chgPctPrev=前日比, chgPctIntraday=日中変動。Top10は前日比(終値/前日終値)のみで作成、価格>=1,000円フィルタ。",
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
