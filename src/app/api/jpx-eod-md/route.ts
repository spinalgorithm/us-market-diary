// src/app/api/jpx-eod-md/route.ts
import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

/** ===== Types ===== */
type Theme =
  | "インデックス/ETF"
  | "自動車"
  | "エレクトロニクス"
  | "半導体製造装置"
  | "計測/FA"
  | "総合電機"
  | "素材/化学"
  | "通信"
  | "FA/ロボット"
  | "金融"
  | "アパレル/SPA"
  | "ゲーム"
  | "電子部品"
  | "電機/モーター"
  | "空調"
  | "商社"
  | "自動車部品";

interface UniverseItem {
  code: string;           // 4-digit JP code (e.g., "8035")
  name: string;           // label
  theme: Theme;
  brief: string;          // short description
  yahooSymbol: string;    // e.g., "8035.T"
}

interface QuoteRow {
  code: string;
  name: string;
  theme: Theme;
  brief: string;

  open: number | null;
  close: number | null;
  high: number | null;
  low: number | null;
  prevClose: number | null;
  changePct: number | null;   // (close - open) / open * 100
  volume: number | null;      // shares
  valueJPY: number | null;    // close * volume
}

interface YahooQuoteV7 {
  symbol?: string;
  longName?: string;
  shortName?: string;
  regularMarketOpen?: number;
  regularMarketPreviousClose?: number;
  regularMarketPrice?: number;
  regularMarketDayHigh?: number;
  regularMarketDayLow?: number;
  regularMarketVolume?: number;
  currency?: string;
}

interface YahooChartV8 {
  chart: {
    result?: Array<{
      indicators?: {
        quote?: Array<{
          open?: Array<number | null>;
          close?: Array<number | null>;
          high?: Array<number | null>;
          low?: Array<number | null>;
          volume?: Array<number | null>;
        }>;
        adjclose?: Array<{
          adjclose?: Array<number | null>;
        }>;
      };
    }>;
    error?: any;
  };
}

/** ===== Utilities ===== */
const JPY = (n: number, digits = 0) =>
  n.toLocaleString("ja-JP", { maximumFractionDigits: digits, minimumFractionDigits: digits });
const num = (v: unknown): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// YYYY-MM-DD (JST)
const ymdJST = (d: Date) => {
  const y = d.getFullYear();
  const m = (d.getMonth() + 1).toString().padStart(2, "0");
  const day = d.getDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
};

// JST date with offset days
const addDaysJST = (d: Date, diff: number) => {
  const nd = new Date(d.getTime());
  nd.setDate(nd.getDate() + diff);
  return nd;
};

// simple weekend roll-back for JP markets
const prevBizDayJST = (d: Date): Date => {
  // roll back Sat/Sun
  let nd = new Date(d.getTime());
  while (true) {
    const wd = nd.getDay(); // 0 Sun, 6 Sat
    if (wd === 0) {
      nd = addDaysJST(nd, -2); // Sun -> Fri
    } else if (wd === 6) {
      nd = addDaysJST(nd, -1); // Sat -> Fri
    } else {
      break;
    }
  }
  return nd;
};

// After close buffer: JP market close is 15:30 JST. Give upstream ~5 minutes to settle.
const shouldUsePrevSession = (jstNow: Date) => {
  const hour = jstNow.getHours();
  const min = jstNow.getMinutes();
  // before 15:35 JST ⇒ use previous business day
  return hour < 15 || (hour === 15 && min < 35);
};

// chunk array
const chunk = <T,>(arr: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

/** ===== Universe (large caps + ETFs) ===== */
const JPX_UNIVERSE: UniverseItem[] = [
  // ETFs
  { code: "1321", name: "日経225連動型上場投信", theme: "インデックス/ETF", brief: "日経225連動ETF", yahooSymbol: "1321.T" },
  { code: "1306", name: "TOPIX連動型上場投信", theme: "インデックス/ETF", brief: "TOPIX連動ETF", yahooSymbol: "1306.T" },

  // Banks
  { code: "8306", name: "三菱UFJフィナンシャルG", theme: "金融", brief: "メガバンク", yahooSymbol: "8306.T" },
  { code: "8316", name: "三井住友フィナンシャルG", theme: "金融", brief: "メガバンク", yahooSymbol: "8316.T" },

  // Telcos
  { code: "9432", name: "日本電信電話(NTT)", theme: "通信", brief: "国内通信大手", yahooSymbol: "9432.T" },
  { code: "9433", name: "KDDI", theme: "通信", brief: "au/通信", yahooSymbol: "9433.T" },
  { code: "9434", name: "ソフトバンク", theme: "通信", brief: "携帯通信", yahooSymbol: "9434.T" },

  // Auto & parts
  { code: "7203", name: "トヨタ自動車", theme: "自動車", brief: "世界最大級の自動車メーカー", yahooSymbol: "7203.T" },
  { code: "6902", name: "デンソー", theme: "自動車部品", brief: "車載/半導体", yahooSymbol: "6902.T" },

  // Electronics / components
  { code: "6758", name: "ソニーグループ", theme: "エレクトロニクス", brief: "ゲーム/画像センサー/音楽", yahooSymbol: "6758.T" },
  { code: "6954", name: "ファナック", theme: "FA/ロボット", brief: "産業用ロボット", yahooSymbol: "6954.T" },
  { code: "6861", name: "キーエンス", theme: "計測/FA", brief: "センサー/FA機器", yahooSymbol: "6861.T" },
  { code: "6501", name: "日立製作所", theme: "総合電機", brief: "社会インフラ/IT", yahooSymbol: "6501.T" },
  { code: "4063", name: "信越化学工業", theme: "素材/化学", brief: "半導体用シリコン", yahooSymbol: "4063.T" },
  { code: "6762", name: "TDK", theme: "電子部品", brief: "受動部品/二次電池", yahooSymbol: "6762.T" },
  { code: "6981", name: "村田製作所", theme: "電子部品", brief: "コンデンサ等", yahooSymbol: "6981.T" },
  { code: "6594", name: "日本電産(Nidec)", theme: "電機/モーター", brief: "小型モーター/EV", yahooSymbol: "6594.T" },

  // Semi equipment
  { code: "8035", name: "東京エレクトロン", theme: "半導体製造装置", brief: "製造装置大手", yahooSymbol: "8035.T" },
  { code: "6857", name: "アドバンテスト", theme: "半導体製造装置", brief: "テスタ大手", yahooSymbol: "6857.T" },
  { code: "6920", name: "レーザーテック", theme: "半導体製造装置", brief: "EUV検査", yahooSymbol: "6920.T" },
  { code: "7735", name: "SCREENホールディングス", theme: "半導体製造装置", brief: "洗浄/成膜等", yahooSymbol: "7735.T" },

  // Conglomerate / retail / others
  { code: "9984", name: "ソフトバンクグループ", theme: "通信", brief: "投資持株/通信", yahooSymbol: "9984.T" },
  { code: "9983", name: "ファーストリテイリング", theme: "アパレル/SPA", brief: "ユニクロ", yahooSymbol: "9983.T" },
  { code: "7974", name: "任天堂", theme: "ゲーム", brief: "ゲーム機/ソフト", yahooSymbol: "7974.T" },

  // Transport / trading houses / energy
  { code: "9020", name: "JR東日本", theme: "空調", brief: "※鉄道(関東/東北のJR)", yahooSymbol: "9020.T" }, // briefに鉄道説明
  { code: "8058", name: "三菱商事", theme: "商社", brief: "総合商社", yahooSymbol: "8058.T" },
  { code: "8001", name: "伊藤忠商事", theme: "商社", brief: "総合商社", yahooSymbol: "8001.T" },
  { code: "5020", name: "ENEOSホールディングス", theme: "素材/化学", brief: "石油・エネルギー", yahooSymbol: "5020.T" },

  // extra few
  { code: "7752", name: "リコー", theme: "半導体製造装置", brief: "※実体はOA機器(ここでは簡略)", yahooSymbol: "7752.T" },
];

/** ===== Yahoo fetchers ===== */

// Try quote v7 batch (faster). Falls back per-symbol to chart v8 if v7 fails or missing fields.
async function fetchYahooV7(symbols: string[]): Promise<Map<string, YahooQuoteV7>> {
  const out = new Map<string, YahooQuoteV7>();
  const batches = chunk(symbols, 40); // keep query URL reasonable
  for (const b of batches) {
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(
      b.join(",")
    )}`;
    const res = await fetch(url, {
      // lightweight header to reduce chance of 401 on some edges
      headers: { "User-Agent": "Mozilla/5.0" },
      // no-cache: keep it dynamic
      cache: "no-store",
    });
    if (!res.ok) continue;
    const j = (await res.json()) as any;
    const arr: any[] = j?.quoteResponse?.result ?? [];
    for (const q of arr) {
      const sym = String(q?.symbol ?? "");
      if (!sym) continue;
      out.set(sym, {
        symbol: sym,
        longName: q?.longName,
        shortName: q?.shortName,
        regularMarketOpen: num(q?.regularMarketOpen) ?? undefined,
        regularMarketPreviousClose: num(q?.regularMarketPreviousClose) ?? undefined,
        regularMarketPrice: num(q?.regularMarketPrice) ?? undefined,
        regularMarketDayHigh: num(q?.regularMarketDayHigh) ?? undefined,
        regularMarketDayLow: num(q?.regularMarketDayLow) ?? undefined,
        regularMarketVolume: num(q?.regularMarketVolume) ?? undefined,
        currency: q?.currency,
      });
    }
  }
  return out;
}

async function fetchYahooChartV8(symbol: string): Promise<{
  open: number | null;
  close: number | null;
  high: number | null;
  low: number | null;
  volume: number | null;
}> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol
  )}?range=1d&interval=1d`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, cache: "no-store" });
  if (!res.ok) {
    return { open: null, close: null, high: null, low: null, volume: null };
  }
  const j = (await res.json()) as YahooChartV8;
  const r = j?.chart?.result?.[0];
  const q = r?.indicators?.quote?.[0];
  if (!q) return { open: null, close: null, high: null, low: null, volume: null };

  const op = num(q.open?.[0] ?? null);
  const clRaw = q.close?.[0] ?? null;
  const clAdj = r?.indicators?.adjclose?.[0]?.adjclose?.[0] ?? null;
  const cl = num(clRaw) ?? num(clAdj);
  const hi = num(q.high?.[0] ?? null);
  const lo = num(q.low?.[0] ?? null);
  const vol = num(q.volume?.[0] ?? null);
  return { open: op, close: cl, high: hi, low: lo, volume: vol };
}

/** ===== Markdown builders ===== */
const td = (v: string) => v;
const tdNum = (v: number | null, digits = 0) => (v == null ? "—" : JPY(v, digits));
const tdPct = (v: number | null) => (v == null ? "—" : `${v >= 0 ? "" : ""}${v.toFixed(2)}`);

function tableBlock(
  title: string,
  rows: Array<{
    code: string;
    oc: string;
    chgPct: string;
    vol: string;
    val?: string;
    theme: string;
    brief: string;
  }>,
  showValue = false
) {
  const head = showValue
    ? `| Rank | Ticker | o→c | Chg% | Vol | ¥Vol(M) | Theme | Brief |\n|---:|---:|---:|---:|---:|---:|---|---|`
    : `| Rank | Ticker | o→c | Chg% | Vol | Theme | Brief |\n|---:|---:|---:|---:|---:|---|---|`;
  const body = rows
    .map((r, i) =>
      showValue
        ? `| ${i + 1} | ${r.code} | ${r.oc} | ${r.chgPct} | ${r.vol} | ${r.val ?? "—"} | ${r.theme} | ${r.brief} |`
        : `| ${i + 1} | ${r.code} | ${r.oc} | ${r.chgPct} | ${r.vol} | ${r.theme} | ${r.brief} |`
    )
    .join("\n");
  return `### ${title}\n${head}\n${body}\n`;
}

/** ===== Handler ===== */
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const sp = url.searchParams;
    const dateParam = sp.get("date"); // YYYY-MM-DD (optional)
    const jstNow = new Date(new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }));
    // if no date specified, use prev biz day before 15:35 JST
    const target = dateParam
      ? new Date(dateParam + "T00:00:00+09:00")
      : shouldUsePrevSession(jstNow)
      ? prevBizDayJST(addDaysJST(jstNow, -1)) // same-day before 15:35 -> previous biz day
      : prevBizDayJST(jstNow); // after 15:35 -> today unless weekend

    const targetYMD = ymdJST(prevBizDayJST(target));

    // 1) Build base map with static metadata (typed!)
    const by = new Map<string, QuoteRow>();
    for (const u of JPX_UNIVERSE) {
      by.set(u.code, {
        code: u.code,
        name: u.name,
        theme: u.theme,
        brief: u.brief,
        open: null,
        close: null,
        high: null,
        low: null,
        prevClose: null,
        changePct: null,
        volume: null,
        valueJPY: null,
      });
    }

    // 2) Fetch Yahoo v7 quotes (batch)
    const symbols = JPX_UNIVERSE.map((u) => u.yahooSymbol);
    const v7 = await fetchYahooV7(symbols);

    // 3) Fill from v7 first, then fallback with chart v8 if missing
    for (const u of JPX_UNIVERSE) {
      const q = v7.get(u.yahooSymbol);
      if (q) {
        const row = by.get(u.code)!;
        const open = num(q.regularMarketOpen);
        const close = num(q.regularMarketPrice) ?? num(q.regularMarketPreviousClose);
        const high = num(q.regularMarketDayHigh);
        const low = num(q.regularMarketDayLow);
        const vol = num(q.regularMarketVolume);

        row.open = open;
        row.close = close;
        row.high = high;
        row.low = low;
        row.prevClose = num(q.regularMarketPreviousClose);
        row.volume = vol;
        row.changePct = open && close ? ((close - open) / open) * 100 : null;
        row.valueJPY = close && vol ? close * vol : null;
      }
    }

    // Fallback chart v8 for any rows with missing core fields
    for (const u of JPX_UNIVERSE) {
      const row = by.get(u.code)!;
      if (row.open != null && row.close != null && row.volume != null) continue;
      const ch = await fetchYahooChartV8(u.yahooSymbol);
      if (row.open == null) row.open = ch.open;
      if (row.close == null) row.close = ch.close;
      if (row.high == null) row.high = ch.high;
      if (row.low == null) row.low = ch.low;
      if (row.volume == null) row.volume = ch.volume;
      if (row.changePct == null && row.open != null && row.close != null) {
        row.changePct = ((row.close - row.open) / row.open) * 100;
      }
      if (row.valueJPY == null && row.close != null && row.volume != null) {
        row.valueJPY = row.close * row.volume;
      }
    }

    // 4) Build Cards (key large caps + ETFs)
    const CARD_CODES = [
      "1321",
      "1306",
      "7203",
      "6758",
      "8035",
      "6861",
      "6501",
      "4063",
      "9432",
      "6954",
      "8306",
      "8316",
    ];
    const cards: string[] = [];
    for (const code of CARD_CODES) {
      const m = by.get(code);
      if (!m) continue;
      const oc = `${m.open != null ? JPY(m.open) : "—"}→${m.close != null ? JPY(m.close) : "—"}`;
      const chg = m.changePct != null ? m.changePct.toFixed(2) : "—";
      const vol = m.volume != null ? JPY(m.volume) : "—";
      const valM = m.valueJPY != null ? JPY(Math.round(m.valueJPY / 1_000_000)) : "—";
      cards.push(
        `- ${code} — ${m.name}\n  - o→c: ${oc} / Chg%: ${chg} / Vol: ${vol} / ¥Vol(M): ${valM} / ${m.theme} — ${m.brief}`
      );
    }

    // 5) Build Top tables
    const rowsAll = Array.from(by.values()).filter((r) => r.close != null);

    // 売買代金
    const topByValue = rowsAll
      .filter((r) => r.valueJPY != null)
      .sort((a, b) => (b.valueJPY! - a.valueJPY!))
      .slice(0, 10)
      .map((m) => ({
        code: m.code,
        oc: `${m.open != null ? JPY(m.open) : "—"}→${m.close != null ? JPY(m.close) : "—"}`,
        chgPct: m.changePct != null ? m.changePct.toFixed(2) : "—",
        vol: m.volume != null ? JPY(m.volume) : "—",
        val: m.valueJPY != null ? JPY(Math.round(m.valueJPY / 1_000_000)) : "—",
        theme: m.theme,
        brief: m.brief,
      }));

    // 出来高
    const topByVol = rowsAll
      .filter((r) => r.volume != null)
      .sort((a, b) => (b.volume! - a.volume!))
      .slice(0, 10)
      .map((m) => ({
        code: m.code,
        oc: `${m.open != null ? JPY(m.open) : "—"}→${m.close != null ? JPY(m.close) : "—"}`,
        chgPct: m.changePct != null ? m.changePct.toFixed(2) : "—",
        vol: m.volume != null ? JPY(m.volume) : "—",
        theme: m.theme,
        brief: m.brief,
      }));

    // 上昇株（¥1,000+）
    const up1k = rowsAll
      .filter((r) => (r.close ?? 0) >= 1000 && r.changePct != null)
      .sort((a, b) => (b.changePct! - a.changePct!))
      .slice(0, 10)
      .map((m) => ({
        code: m.code,
        oc: `${m.open != null ? JPY(m.open) : "—"}→${m.close != null ? JPY(m.close) : "—"}`,
        chgPct: m.changePct != null ? m.changePct.toFixed(2) : "—",
        vol: m.volume != null ? JPY(m.volume) : "—",
        theme: m.theme,
        brief: m.brief,
      }));

    // 下落株（¥1,000+）
    const down1k = rowsAll
      .filter((r) => (r.close ?? 0) >= 1000 && r.changePct != null)
      .sort((a, b) => (a.changePct! - b.changePct!))
      .slice(0, 10)
      .map((m) => ({
        code: m.code,
        oc: `${m.open != null ? JPY(m.open) : "—"}→${m.close != null ? JPY(m.close) : "—"}`,
        chgPct: m.changePct != null ? m.changePct.toFixed(2) : "—",
        vol: m.volume != null ? JPY(m.volume) : "—",
        theme: m.theme,
        brief: m.brief,
      }));

    // header
    const title = `# 日本株 夜間警備員 日誌 | ${targetYMD}`;
    const note =
      `> ソース: Yahoo Finance (quote → fallback chart) / ユニバース: ${JPX_UNIVERSE.length}銘柄\n` +
      `> 注記: JST **15:35**以前のアクセスは前営業日に自動回帰。無料ソース特性上、厳密なEODと微差が出る場合があります。\n`;

    const cardBlock = `## カード（主要ETF・大型）\n${cards.join("\n")}\n`;

    // tables
    const tbl1 = tableBlock("Top 10 — 売買代金（百万円換算）", topByValue, true);
    const tbl2 = tableBlock("Top 10 — 出来高（株数）", topByVol, false);
    const tbl3 = tableBlock("Top 10 — 上昇株（¥1,000+）", up1k, false);
    const tbl4 = tableBlock("Top 10 — 下落株（¥1,000+）", down1k, false);

    const tags =
      "\n\n#日本株 #日経平均 #TOPIX #半導体 #AI #出来高 #売買代金 #大型株";

    const md = [title, note, "---", cardBlock, "---", "## 📊 データ(Top10)", tbl1, tbl2, tbl3, tbl4, tags].join(
      "\n\n"
    );

    return new Response(md, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    return new Response(`Fetch failed: ${msg}`, { status: 500 });
  }
}
