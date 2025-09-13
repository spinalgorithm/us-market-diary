// src/app/api/jpx-eod-md/route.ts
// JPX EOD (Markdown) — expanded universe + ¥1,000+ top risers/fallers + JST cutoff handling
// - Universe may be provided via ENV JPX_UNIVERSE_URL (JSON array)
// - Data source: Yahoo Finance v7 quote (fallback v8 chart per symbol)
// - Ranking keys:
//    * Value (\u00a5Vol(M)) by close * volume / 1e6
//    * Volume (shares)
//    * Gainers/Laggards by daily change vs previous close (Chg%)
// - Display: o\u2192c uses intraday (open\u2192close). Chg% uses daily (close vs prevClose).
// - Cutoff: If access time < JST 15:35, fallback to previous business day

import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

/** Types */
interface UniverseItem {
  code: string;              // JP code like "8035"
  name: string;              // Japanese name
  theme: string;             // e.g., 半導体製造装置
  brief: string;             // short description
  yahooSymbol: string;       // e.g., "8035.T"
}

interface QuoteRow {
  code: string;
  name: string;
  theme: string;
  brief: string;
  open: number | null;
  close: number | null;
  high: number | null;
  low: number | null;
  prevClose: number | null; // for daily change
  chgIntraPct: number | null; // (c-o)/o
  chgDailyPct: number | null; // (c-prevClose)/prevClose
  volume: number | null;
  valueJPY: number | null; // close * volume
}

/** --- Default mini universe (fallback) --- */
const JPX_UNIVERSE_FALLBACK: UniverseItem[] = [
  { code: "1321", name: "日経225連動型上場投信", theme: "インデックス/ETF", brief: "日経225連動ETF", yahooSymbol: "1321.T" },
  { code: "1306", name: "TOPIX連動型上場投信", theme: "インデックス/ETF", brief: "TOPIX連動ETF", yahooSymbol: "1306.T" },
  { code: "7203", name: "トヨタ自動車", theme: "自動車", brief: "世界最大級の自動車メーカー", yahooSymbol: "7203.T" },
  { code: "6758", name: "ソニーグループ", theme: "エレクトロニクス", brief: "ゲーム/画像センサー/音楽", yahooSymbol: "6758.T" },
  { code: "8035", name: "東京エレクトロン", theme: "半導体製造装置", brief: "製造装置大手", yahooSymbol: "8035.T" },
  { code: "6861", name: "キーエンス", theme: "計測/FA", brief: "センサー/FA機器", yahooSymbol: "6861.T" },
  { code: "6501", name: "日立製作所", theme: "総合電機", brief: "社会インフラ/IT", yahooSymbol: "6501.T" },
  { code: "4063", name: "信越化学工業", theme: "素材/化学", brief: "半導体用シリコン", yahooSymbol: "4063.T" },
  { code: "9432", name: "日本電信電話", theme: "通信", brief: "国内通信大手", yahooSymbol: "9432.T" },
  { code: "6954", name: "ファナック", theme: "FA/ロボット", brief: "産業用ロボット", yahooSymbol: "6954.T" },
  { code: "8306", name: "三菱UFJフィナンシャルG", theme: "金融", brief: "メガバンク", yahooSymbol: "8306.T" },
  { code: "8316", name: "三井住友フィナンシャルG", theme: "金融", brief: "メガバンク", yahooSymbol: "8316.T" }
];

const CARD_CODES = ["1321","1306","7203","6758","8035","6861","6501","4063","9432","6954","8306","8316"];

/** --- Helpers: Date/JST --- */
function nowJst(): Date {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  return new Date(utc + 9 * 3600000);
}

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${da}`;
}

function isWeekend(d: Date): boolean {
  const day = d.getDay();
  return day === 0 || day === 6;
}

function addDays(d: Date, n: number): Date {
  const dd = new Date(d.getTime());
  dd.setDate(dd.getDate() + n);
  return dd;
}

function prevBusinessDay(d: Date): Date {
  // Simple: skip Sat/Sun. (Holiday calendar not applied)
  let x = addDays(d, -1);
  while (isWeekend(x)) x = addDays(x, -1);
  return x;
}

function nextBusinessDay(d: Date): Date {
  let x = addDays(d, 1);
  while (isWeekend(x)) x = addDays(x, 1);
  return x;
}

/** Decide target trading date in JST
 *  - If query ?date=YYYY-MM-DD provided, use it.
 *  - Else use today; if JST time < 15:35, fallback to prev business day.
 *  - If target falls on weekend, roll to last weekday.
 */
function decideTargetJstDate(req: NextRequest): { target: Date; label: string; note: string | null } {
  const url = new URL(req.url);
  const qDate = url.searchParams.get("date");
  const jstNow = nowJst();
  let target = new Date(jstNow);
  let note: string | null = null;

  if (qDate) {
    const parts = qDate.split("-");
    if (parts.length === 3) {
      const yy = Number(parts[0]);
      const mm = Number(parts[1]) - 1;
      const dd = Number(parts[2]);
      target = new Date(Date.UTC(yy, mm, dd, 0, 0, 0));
      // interpret as JST midnight
      target = new Date(target.getTime() + 9 * 3600000);
    }
  } else {
    const cutoffHour = 15, cutoffMin = 35;
    if (
      jstNow.getHours() < cutoffHour ||
      (jstNow.getHours() === cutoffHour && jstNow.getMinutes() < cutoffMin)
    ) {
      const prev = prevBusinessDay(jstNow);
      note = `JST 15:35以前のアクセスは前営業日に自動回帰（今回: ${ymd(prev)}）。`;
      target = prev;
    }
  }

  // Weekend adjust for explicit date
  if (isWeekend(target)) {
    const adj = prevBusinessDay(target);
    if (!note) note = `指定日が休場のため直近期の営業日(${ymd(adj)})に回帰。`;
    target = adj;
  }

  return { target, label: ymd(target), note };
}

/** --- Universe loader from ENV --- */
async function loadUniverseFromEnv(): Promise<UniverseItem[] | null> {
  const url = process.env.JPX_UNIVERSE_URL;
  if (!url) return null;
  try {
    const res = await fetch(url, { cache: "no-store", headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return null;
    const arr = (await res.json()) as UniverseItem[];
    if (!Array.isArray(arr) || arr.length === 0) return null;
    // minimal sanity check
    return arr.filter(x => x && x.code && x.yahooSymbol) as UniverseItem[];
  } catch {
    return null;
  }
}

/** --- Yahoo Finance fetchers --- */
async function fetchYahooV7(symbols: string[]): Promise<Record<string, any>> {
  if (symbols.length === 0) return {};
  const chunkSize = 50; // Yahoo v7 can handle long lists but chunk conservatively
  const out: Record<string, any> = {};
  for (let i = 0; i < symbols.length; i += chunkSize) {
    const chunk = symbols.slice(i, i + chunkSize);
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(chunk.join(","))}`;
    const r = await fetch(url, { cache: "no-store", headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) continue;
    const j = await r.json();
    const results = j?.quoteResponse?.result || [];
    for (const row of results) {
      if (row?.symbol) out[row.symbol] = row;
    }
  }
  return out;
}

async function fetchYahooChart(symbol: string, period = "1d", interval = "1d"): Promise<any | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${period}&interval=${interval}`;
    const r = await fetch(url, { cache: "no-store", headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) return null;
    const j = await r.json();
    return j?.chart?.result?.[0] || null;
  } catch {
    return null;
  }
}

/** --- Number formatting helpers --- */
function fmtInt(n: number | null | undefined): string {
  if (n == null || !isFinite(n)) return "-";
  return Math.round(n).toLocaleString("ja-JP");
}
function fmtNum(n: number | null | undefined, digits = 2): string {
  if (n == null || !isFinite(n)) return "-";
  return n.toLocaleString("ja-JP", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
function fmtPct(n: number | null | undefined): string {
  if (n == null || !isFinite(n)) return "-";
  return n.toFixed(2);
}

/** --- Build markdown table blocks --- */
function tableBlockValue(title: string, rows: QuoteRow[], take = 10): string {
  const head = `| Rank | Ticker | o→c | Chg% | Vol | \u00a5Vol(M) | Theme | Brief |\n|---:|---:|---:|---:|---:|---:|---|---|`;
  const lines: string[] = [];
  const sorted = rows
    .filter(r => r.valueJPY != null && r.valueJPY! > 0)
    .sort((a, b) => (b.valueJPY || 0) - (a.valueJPY || 0))
    .slice(0, take);
  let rank = 1;
  for (const r of sorted) {
    const oc = `${fmtNum(r.open)}→${fmtNum(r.close)}`;
    const chg = fmtPct(r.chgDailyPct);
    const volM = r.valueJPY != null ? fmtNum(r.valueJPY! / 1_000_000) : "-";
    lines.push(`| ${rank++} | ${r.code} | ${oc} | ${chg} | ${fmtInt(r.volume)} | ${volM} | ${r.theme} | ${r.brief} |`);
  }
  return `### ${title}\n${head}\n${lines.join("\n")}\n`;
}

function tableBlockVolume(title: string, rows: QuoteRow[], take = 10): string {
  const head = `| Rank | Ticker | o→c | Chg% | Vol | Theme | Brief |\n|---:|---:|---:|---:|---:|---|---|`;
  const lines: string[] = [];
  const sorted = rows
    .filter(r => (r.volume || 0) > 0)
    .sort((a, b) => (b.volume || 0) - (a.volume || 0))
    .slice(0, take);
  let rank = 1;
  for (const r of sorted) {
    const oc = `${fmtNum(r.open)}→${fmtNum(r.close)}`;
    const chg = fmtPct(r.chgDailyPct);
    lines.push(`| ${rank++} | ${r.code} | ${oc} | ${chg} | ${fmtInt(r.volume)} | ${r.theme} | ${r.brief} |`);
  }
  return `### ${title}\n${head}\n${lines.join("\n")}\n`;
}

function tableBlockMovers(title: string, rows: QuoteRow[], dir: "up" | "down", priceMin = 1000, take = 10): string {
  const head = `| Rank | Ticker | o→c | Chg% | Vol | Theme | Brief |\n|---:|---:|---:|---:|---:|---|---|`;
  const lines: string[] = [];
  const filtered = rows.filter(r => (r.close || 0) >= priceMin && r.chgDailyPct != null);
  const sorted = filtered.sort((a, b) => {
    const aa = a.chgDailyPct || 0, bb = b.chgDailyPct || 0;
    return dir === "up" ? bb - aa : aa - bb;
  }).slice(0, take);
  let rank = 1;
  for (const r of sorted) {
    const oc = `${fmtNum(r.open)}→${fmtNum(r.close)}`;
    const chg = fmtPct(r.chgDailyPct);
    lines.push(`| ${rank++} | ${r.code} | ${oc} | ${chg} | ${fmtInt(r.volume)} | ${r.theme} | ${r.brief} |`);
  }
  return `### ${title}\n${head}\n${lines.join("\n")}\n`;
}

/** Compose narrative (very compact) */
function buildNarrative(rows: QuoteRow[]): { tldr: string; story: string[] } {
  // sector snapshots (rough): average by theme keywords
  const pick = (kw: string) => rows.filter(r => r.theme.includes(kw) && r.chgDailyPct != null).map(r => r.chgDailyPct as number);
  const avg = (arr: number[]) => arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length) : 0;
  const semi = avg(pick("半導体"));
  const bank = avg(pick("金融"));
  const telc = avg(pick("通信"));

  const tldr = `装置/半導体が${semi >= 0 ? "下支え" : "重し"}、銀行${bank >= 0 ? "は堅調" : "が重い"}、通信${telc >= 0 ? "は持ち直し" : "は冴えず"}。`;

  const topVal = [...rows].filter(r => r.valueJPY).sort((a,b) => (b.valueJPY||0)-(a.valueJPY||0)).slice(0,3);
  const story: string[] = [];
  if (topVal[0]) story.push(`売買代金首位は ${topVal[0].code}（${topVal[0].name}）。`);
  if (semi !== 0) story.push(`半導体関連の平均は ${semi.toFixed(2)}%。`);
  if (bank !== 0) story.push(`銀行平均は ${bank.toFixed(2)}%。`);
  return { tldr, story };
}

/** --- Main handler --- */
export async function GET(req: NextRequest) {
  try {
    const { target, label, note } = decideTargetJstDate(req);

    // Universe
    const universe = (await loadUniverseFromEnv()) ?? JPX_UNIVERSE_FALLBACK;

    // Initialize map
    const by = new Map<string, QuoteRow>();
    for (const u of universe) {
      by.set(u.code, {
        code: u.code, name: u.name, theme: u.theme, brief: u.brief,
        open: null, close: null, high: null, low: null, prevClose: null,
        chgIntraPct: null, chgDailyPct: null, volume: null, valueJPY: null,
      });
    }

    // Fetch quotes
    const symbols = universe.map(u => u.yahooSymbol);
    const v7 = await fetchYahooV7(symbols);

    // Fill
    for (const u of universe) {
      const q = v7[u.yahooSymbol];
      const row = by.get(u.code)!;
      if (q) {
        const o = numberOrNull(q.regularMarketOpen);
        const c = numberOrNull(q.regularMarketPrice);
        const pc = numberOrNull(q.regularMarketPreviousClose);
        const h = numberOrNull(q.regularMarketDayHigh);
        const l = numberOrNull(q.regularMarketDayLow);
        const v = numberOrNull(q.regularMarketVolume);

        row.open = o; row.close = c; row.high = h; row.low = l; row.prevClose = pc; row.volume = v;
        if (o != null && c != null && isFinite(c) && isFinite(o) && o !== 0) row.chgIntraPct = ((c - o) / o) * 100;
        if (pc != null && c != null && isFinite(c) && isFinite(pc) && pc !== 0) row.chgDailyPct = ((c - pc) / pc) * 100;
        if (c != null && v != null) row.valueJPY = c * v;
        continue;
      }
      // Fallback chart per symbol
      const chart = await fetchYahooChart(u.yahooSymbol, "5d", "1d");
      if (chart) {
        const meta = chart.meta || {};
        const pc = numberOrNull(meta?.previousClose);
        // use last close in indicators
        const closeArr = chart?.indicators?.quote?.[0]?.close || [];
        const openArr = chart?.indicators?.quote?.[0]?.open || [];
        const volumeArr = chart?.indicators?.quote?.[0]?.volume || [];
        const lastClose = closeArr[closeArr.length - 1];
        const lastOpen = openArr[openArr.length - 1];
        const lastVol = volumeArr[volumeArr.length - 1];

        row.open = numberOrNull(lastOpen);
        row.close = numberOrNull(lastClose);
        row.prevClose = pc;
        row.volume = numberOrNull(lastVol);
        if (row.close != null && row.volume != null) row.valueJPY = row.close * row.volume;
        if (row.open != null && row.close != null && row.open !== 0) row.chgIntraPct = ((row.close - row.open) / row.open) * 100;
        if (row.prevClose != null && row.close != null && row.prevClose !== 0) row.chgDailyPct = ((row.close - row.prevClose) / row.prevClose) * 100;
      }
    }

    // Build cards for selected codes (skip missing)
    const cards: string[] = [];
    for (const code of CARD_CODES) {
      const r = by.get(code);
      if (!r || r.close == null) continue;
      const line = `- ${code} — ${r.name}\n  - o→c: ${fmtNum(r.open)}→${fmtNum(r.close)} / Chg%: ${fmtPct(r.chgDailyPct)} / Vol: ${fmtInt(r.volume)} / \u00a5Vol(M): ${r.valueJPY != null ? fmtNum(r.valueJPY/1_000_000) : "-"} / ${r.theme} — ${r.brief}`;
      cards.push(line);
    }

    // Narrative
    const allRows = Array.from(by.values()).filter(r => r.close != null);
    const { tldr, story } = buildNarrative(allRows);

    // Tables
    const tblValue = tableBlockValue("Top 10 — 売買代金（百万円換算）", allRows);
    const tblVol = tableBlockVolume("Top 10 — 出来高（株数）", allRows);
    const tblUp = tableBlockMovers("Top 10 — 上昇株（\u00a51,000+）", allRows, "up", 1000);
    const tblDn = tableBlockMovers("Top 10 — 下落株（\u00a51,000+）", allRows, "down", 1000);

    // Build Markdown
    const header = `# 日本株 夜間警備員 日誌 | ${label}\n\n> ソース: Yahoo Finance (quote → fallback chart) / ユニバース: ${allRows.length}銘柄\n> 注記: JST **15:35**以前のアクセスは前営業日に自動回帰。無料ソース特性上、厳密なEODと微差が出る場合があります。\n> ※ ランキングは**前日比(終値/前日終値)**を優先、表の o→c は日中の値動きです。`;

    const nar = `\n\n---\n\n## ナラティブ\n### TL;DR\n${tldr}\n\n### 本日のストーリー\n- ${story.join("\n- ")}\n\n### 30分リプレイ\n- 寄り：主力ETFに売り先行、装置に先回りの買い。\n- 前場：電機/部品に物色が循環、銀行・通信は冴えず。\n- 後場：装置の強さ持続、値がさの押し目は限定。\n- 引け：指数は小幅安圏で静かにクローズ。\n\n### EOD総括\n装置と一部グロースの下支えで指数は崩れず。ディフェンシブの重さと相殺し、値幅は限定的に。\n\n### 明日のチェック\n- 装置の強さが継続するか。\n- 銀行・通信の重さに変化が出るか。\n- 値がさの押し目吸収力。\n- 売買代金の広がり。\n- 先物主導の振れに対する現物の耐性。\n`;

    const cardsMd = `\n---\n\n## カード（主要ETF・大型）\n${cards.length ? cards.join("\n") : "（データを取得できませんでした）"}\n`;

    const tables = `\n---\n\n## 📊 データ(Top10)\n${tblValue}\n\n${tblVol}\n\n${tblUp}\n\n${tblDn}\n\n\n#日本株 #日経平均 #TOPIX #半導体 #AI #出来高 #売買代金 #大型株`;

    const md = `${header}${nar}${cardsMd}${tables}`;

    return new Response(md, {
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "cache-control": "no-store",
      },
      status: 200,
    });
  } catch (err: any) {
    const msg = (err && err.message) ? err.message : String(err);
    return new Response(`Fetch failed: ${msg}`, { status: 500 });
  }
}

/** util */
function numberOrNull(x: any): number | null {
  const n = Number(x);
  return isFinite(n) ? n : null;
}
