// src/app/api/us-eod-deep/route.ts
import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** ───────────────── Types ───────────────── **/
type Quote = {
  symbol: string;
  open?: number;
  close?: number;
  previousClose?: number;
  volume?: number;
  currency?: string; // "USD"
  shortName?: string;
  longName?: string;
};

type Row = {
  ticker: string;
  name: string;
  theme: string;
  brief: string;
  open: number | null;
  close: number | null;
  previousClose: number | null;
  chgPctPrev: number | null;      // (close / prevClose - 1)*100
  chgPctIntraday: number | null;  // (close / open - 1)*100
  volume: number | null;
  usdVolM: number | null;         // close * volume / 1e6
  currency: string;
};

type Rankings = {
  byValue: Row[];
  byVolume: Row[];
  topGainers: Row[];
  topLosers: Row[];
};

type JsonOut = {
  ok: boolean;
  date: string;
  source: string;
  universeCount: number;
  tickers: string[];
  rankings: Rankings;
  quotes: Row[];
  note: string;
  error?: string;
};

/** ───────────────── Utils ───────────────── **/
const US_TZ = "America/New_York";

function toYmd(d = new Date()): string {
  const yy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}
function delay(ms: number) { return new Promise(res => setTimeout(res, ms)); }

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

/** ───────────────── Safe fetch with timeout ───────────────── **/
async function safeJson<T=any>(url: string, init?: RequestInit, timeoutMs=10000): Promise<T | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...init, signal: ctrl.signal, cache: "no-store" });
    if (!r.ok) return null;
    return await r.json() as T;
  } catch {
    return null;
  } finally { clearTimeout(t); }
}
async function safeText(url: string, init?: RequestInit, timeoutMs=10000): Promise<string | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...init, signal: ctrl.signal, cache: "no-store" });
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  } finally { clearTimeout(t); }
}

/** ───────────────── Yahoo Screener fetchers ─────────────────
 * 1) JSON API (안정적일 때가 많음)
 *    https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=most_actives&count=100
 * 2) HTML 폴백(헤더 페이지)
 *    https://finance.yahoo.com/screener/predefined/most_actives
 *    data-symbol="AAPL" 류 추출
 */
async function fetchScreenerJson(scrId: string, count=120): Promise<string[]> {
  // count는 최대 250 근처까지, 두 번 호출해서 합치기도 가능
  const url = `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=${encodeURIComponent(scrId)}&count=${count}`;
  const j = await safeJson<any>(url);
  const list: string[] = [];
  const items = j?.finance?.result?.[0]?.quotes ?? [];
  for (const it of items) {
    const s = (it?.symbol || "").toUpperCase();
    if (s) list.push(s);
  }
  return list;
}

async function fetchScreenerHtml(scrId: string): Promise<string[]> {
  const url = `https://finance.yahoo.com/screener/predefined/${encodeURIComponent(scrId)}`;
  const html = await safeText(url);
  if (!html) return [];
  // 매우 단순한 파서: data-symbol="XXXX"
  const out: string[] = [];
  const re = /data-symbol="([A-Z0-9\.\-:]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    out.push(m[1].toUpperCase());
  }
  return out;
}

async function fetchUniverse(limit=300): Promise<string[]> {
  const scrIds = ["most_actives", "day_gainers", "day_losers"];
  const bag = new Set<string>();
  // JSON 우선
  for (const id of scrIds) {
    const lst = await fetchScreenerJson(id, Math.min(limit, 150));
    lst.forEach(t => bag.add(t));
    await delay(120);
  }
  // 보강: JSON이 빈 경우 HTML 폴백
  if (bag.size < 30) {
    for (const id of scrIds) {
      const lst = await fetchScreenerHtml(id);
      lst.forEach(t => bag.add(t));
      await delay(120);
    }
  }
  // 뉴욕 거래所만 대충 남기기 (옵션): 너무 과격하면 주석
  // const filtered = [...bag].filter(t => !t.endsWith(".L") && !t.endsWith(".T"));
  const arr = [...bag];
  // 상위 limit로 슬라이스
  return arr.slice(0, limit);
}

/** ───────────────── Yahoo Batch Quote ───────────────── **/
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i=0;i<arr.length;i+=size) out.push(arr.slice(i,i+size));
  return out;
}

async function fetchYahooBatchQuotes(symbols: string[]): Promise<Map<string, Quote>> {
  const out = new Map<string, Quote>();
  if (!symbols.length) return out;
  const batches = chunk(symbols, 60);
  for (const b of batches) {
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(b.join(","))}`;
    const j = await safeJson<any>(url, undefined, 12000);
    const arr = j?.quoteResponse?.result ?? [];
    for (const r of arr) {
      const symbol = String(r?.symbol ?? "").toUpperCase();
      if (!symbol) continue;
      const open = num(r?.regularMarketOpen ?? r?.open);
      const close = num(r?.regularMarketPrice ?? r?.regularMarketPreviousClose ?? r?.postMarketPrice);
      const prev  = num(r?.regularMarketPreviousClose);
      const volume= num(r?.regularMarketVolume ?? r?.volume);
      const currency = r?.currency ?? "USD";
      const shortName = r?.shortName;
      const longName  = r?.longName;
      out.set(symbol, { symbol, open, close, previousClose: prev, volume, currency, shortName, longName });
    }
    await delay(100);
  }
  return out;
}

/** ───────────────── Polygon fallback (optional) ─────────────────
 * open/close/prevClose/volume 가져오기
 * /v1/open-close/{ticker}/{date}
 */
async function fetchPolygonEod(ticker: string, ymd: string, apikey: string): Promise<Quote | null> {
  const url = `https://api.polygon.io/v1/open-close/${encodeURIComponent(ticker)}/${ymd}?adjusted=true&apiKey=${apikey}`;
  const j = await safeJson<any>(url, undefined, 8000);
  if (!j || j.status !== "OK") return null;
  const open = num(j.open);
  const close= num(j.close);
  const volume= num(j.volume);
  // prevClose는 별도 호출이 정확하지만, 간단히 동일 엔드포인트 prevDay로 대체할 수도 있음.
  return { symbol: ticker.toUpperCase(), open, close, previousClose: undefined, volume, currency: "USD" };
}

async function fetchAllQuotes(
  symbols: string[],
  ymd: string,
  polygonKey?: string,
  fallbackMax: number = Number(process.env.US_POLYGON_FALLBACK_MAX ?? "40")
): Promise<Map<string, Quote>> {
  const primary = await fetchYahooBatchQuotes(symbols);
  if (!polygonKey || fallbackMax <= 0) return primary;

  const out = new Map(primary);
  let used = 0;
  for (const s of symbols) {
    if (used >= fallbackMax) break;
    const q = out.get(s);
    const missing = !q || (
      (q.close == null || q.previousClose == null) &&
      (q.volume == null)
    );
    if (missing) {
      const pj = await fetchPolygonEod(s, ymd, polygonKey);
      if (pj) out.set(s, { ...out.get(s), ...pj });
      used++;
      await delay(60);
    }
  }
  return out;
}

/** ───────────────── Build rows & rankings ───────────────── **/
function buildRows(symbols: string[], map: Map<string, Quote>): Row[] {
  return symbols.map(sym => {
    const q = map.get(sym);
    const name = q?.shortName ?? q?.longName ?? sym;
    const row: Row = {
      ticker: sym,
      name,
      theme: "-",          // (원하면 간단 규칙/사전으로 태그)
      brief: "-",
      open: q?.open ?? null,
      close: q?.close ?? null,
      previousClose: q?.previousClose ?? null,
      chgPctPrev: chgPctPrev(q) ?? null,
      chgPctIntraday: chgPctIntraday(q) ?? null,
      volume: q?.volume ?? null,
      usdVolM: (q?.close != null && q?.volume != null) ? (q!.close! * q!.volume!) / 1_000_000 : null,
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

/** ───────────────── Markdown builders ───────────────── **/
function fmtNum(x: number | null | undefined): string {
  if (x == null || !Number.isFinite(Number(x))) return "-";
  return Number(x).toLocaleString("en-US");
}
function fmtPct(x: number | null | undefined, d=2): string {
  if (x == null || !Number.isFinite(Number(x))) return "-";
  return Number(x).toFixed(d);
}
function fmtO2C(o: number | null | undefined, c: number | null | undefined): string {
  if (o == null || c == null) return "-→-";
  return `${fmtNum(o)}→${fmtNum(c)}`;
}
function take<T>(arr: T[] | undefined, n=10): T[] { return Array.isArray(arr) ? arr.slice(0,n) : []; }

function tableByValue(rows: Row[]): string {
  const head = "| Rank | Ticker | Name | o→c | Chg% | Vol | $Vol(M) | Theme | Brief |\n|---:|---:|---|---:|---:|---:|---:|---|---|\n";
  const body = take(rows,10).map((r,i)=>[
    i+1, r.ticker, r.name,
    fmtO2C(r.open, r.close),
    fmtPct(r.chgPctPrev),
    fmtNum(r.volume),
    fmtNum(r.usdVolM),
    r.theme || "-", r.brief || "-"
  ].join(" | ")).join("\n");
  return head + (body ? body+"\n" : "");
}
function tableByVolume(rows: Row[]): string {
  const head = "| Rank | Ticker | Name | o→c | Chg% | Vol | Theme | Brief |\n|---:|---:|---|---:|---:|---:|---|---|\n";
  const body = take(rows,10).map((r,i)=>[
    i+1, r.ticker, r.name,
    fmtO2C(r.open, r.close),
    fmtPct(r.chgPctPrev),
    fmtNum(r.volume),
    r.theme || "-", r.brief || "-"
  ].join(" | ")).join("\n");
  return head + (body ? body+"\n" : "");
}
function tableGainers(rows: Row[]): string {
  const head = "| Rank | Ticker | Name | o→c | Chg% | Vol | Theme | Brief |\n|---:|---:|---|---:|---:|---:|---|---|\n";
  const body = take(rows,10).map((r,i)=>[
    i+1, r.ticker, r.name,
    fmtO2C(r.open, r.close),
    fmtPct(r.chgPctPrev),
    fmtNum(r.volume),
    r.theme || "-", r.brief || "-"
  ].join(" | ")).join("\n");
  return head + (body ? body+"\n" : "");
}
function tableLosers(rows: Row[]): string {
  const head = "| Rank | Ticker | Name | o→c | Chg% | Vol | Theme | Brief |\n|---:|---:|---|---:|---:|---:|---|---|\n";
  const body = take(rows,10).map((r,i)=>[
    i+1, r.ticker, r.name,
    fmtO2C(r.open, r.close),
    fmtPct(r.chgPctPrev),
    fmtNum(r.volume),
    r.theme || "-", r.brief || "-"
  ].join(" | ")).join("\n");
  return head + (body ? body+"\n" : "");
}

/** ───────────────── Handler ───────────────── **/
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const format = (url.searchParams.get("format") || "md").toLowerCase();
    const limit = Number(process.env.US_UNIVERSE_LIMIT ?? "300");
    const polyKey = process.env.POLYGON_API_KEY || "";

    // 기준 일자(UTC 날짜로 표기)
    const ymd = toYmd(new Date());

    // 1) 유니버스 수집
    const tickers = await fetchUniverse(limit);

    // 2) 시세 취득 (+ 폴리곤 보강)
    const quotesMap = await fetchAllQuotes(tickers, ymd, polyKey || undefined);

    // 3) 행/랭킹
    const rows = buildRows(tickers, quotesMap);
    const rankings = buildRankings(rows);

    const source = `YahooScreener+YahooBatch${polyKey ? "+Polygon" : ""}`;
    const note = "価格>=$5でGainers/Losers、$Vol(M)=close*volume/1e6。Yahoo JSONが失敗時はHTMLからティッカー抽出。";
    const json: JsonOut = {
      ok: true,
      date: ymd,
      source,
      universeCount: tickers.length,
      tickers,
      rankings,
      quotes: rows,
      note,
    };

    if (format === "json") {
      return new Response(JSON.stringify(json), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
      });
    }

    // Markdown
    const header =
`# US Market EOD Deep | ${ymd}

> ソース: ${source} / ユニバース: ${tickers.length}銘柄
> 収集: Yahooプリセットスクリーナー（most_actives, day_gainers, day_losers）から上位 **${tickers.length}**銘柄を集約。
> 注記: 無料ソースの性質上、厳密なEODとの微差が出る場合があります（USD）。

## 📊 データ(Top10)
### Top 10 — 売買代金（百万USD換算）
${tableByValue(rankings.byValue)}
### Top 10 — 出来高（株数）
${tableByVolume(rankings.byVolume)}
### Top 10 — 上昇株（$5+）
${tableGainers(rankings.topGainers)}
### Top 10 — 下落株（$5+）
${tableLosers(rankings.topLosers)}

#米国株 #NASDAQ #NYSE #S&P500 #出来高 #売買代金 #大型株
`;

    return new Response(header, {
      status: 200,
      headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "no-store" },
    });
  } catch (err: any) {
    const md =
`# US Market EOD Deep | N/A

> 予期せぬエラー: ${err?.message ?? "unknown"}
`;
    return new Response(md, {
      status: 200,
      headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
}
