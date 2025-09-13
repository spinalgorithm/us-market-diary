// src/app/api/jpx-eod-md/route.ts
import { NextRequest } from "next/server";
export const dynamic = "force-dynamic";

/* ===================== Types ===================== */
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
  code: string;
  name: string;
  theme: Theme;
  brief: string;
  yahooSymbol: string; // e.g., "8035.T"
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

  prevClose: number | null;     // 전일 종가(전일비 계산용)
  chgIntraPct: number | null;   // (close-open)/open * 100
  chgDailyPct: number | null;   // (close-prevClose)/prevClose * 100

  volume: number | null;        // 주식수
  valueJPY: number | null;      // close * volume (엔)
}

/* ===================== Utils ===================== */
const JPY = (n: number, digits = 0) =>
  n.toLocaleString("ja-JP", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const NUM = (v: unknown): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const ymdJST = (d: Date) => {
  const y = d.getFullYear();
  const m = (d.getMonth() + 1).toString().padStart(2, "0");
  const da = d.getDate().toString().padStart(2, "0");
  return `${y}-${m}-${da}`;
};
const addDays = (d: Date, k: number) => {
  const nd = new Date(d.getTime());
  nd.setDate(nd.getDate() + k);
  return nd;
};
const prevBizDayJST = (d: Date) => {
  let nd = new Date(d.getTime());
  while ([0, 6].includes(nd.getDay())) nd = addDays(nd, -1); // Sun/Sat → Fri
  return nd;
};
// 종가 15:30지만, 무료 소스(야후) 딜레이 감안해 15:35 전이면 전영업일로 회귀
const usePrevSession = (jstNow: Date) => {
  const h = jstNow.getHours();
  const m = jstNow.getMinutes();
  return h < 15 || (h === 15 && m < 35);
};
const chunk = <T,>(arr: T[], size: number) => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

/* ===================== Universe (확장 가능) ===================== */
const JPX_UNIVERSE: UniverseItem[] = [
  // ETF
  { code: "1321", name: "日経225連動型上場投信", theme: "インデックス/ETF", brief: "日経225連動ETF", yahooSymbol: "1321.T" },
  { code: "1306", name: "TOPIX連動型上場投信", theme: "インデックス/ETF", brief: "TOPIX連動ETF", yahooSymbol: "1306.T" },

  // 금융
  { code: "8306", name: "三菱UFJフィナンシャルG", theme: "金融", brief: "メガバンク", yahooSymbol: "8306.T" },
  { code: "8316", name: "三井住友フィナンシャルG", theme: "金融", brief: "メガバンク", yahooSymbol: "8316.T" },

  // 통신
  { code: "9432", name: "日本電信電話(NTT)", theme: "通信", brief: "国内通信大手", yahooSymbol: "9432.T" },
  { code: "9433", name: "KDDI", theme: "通信", brief: "au/通信", yahooSymbol: "9433.T" },
  { code: "9434", name: "ソフトバンク", theme: "通信", brief: "携帯通信", yahooSymbol: "9434.T" },

  // 자동차/부품
  { code: "7203", name: "トヨタ自動車", theme: "自動車", brief: "世界最大級の自動車メーカー", yahooSymbol: "7203.T" },
  { code: "6902", name: "デンソー", theme: "自動車部品", brief: "車載/半導体", yahooSymbol: "6902.T" },

  // 일렉트로닉스/부품
  { code: "6758", name: "ソニーグループ", theme: "エレクトロニクス", brief: "ゲーム/画像センサー/音楽", yahooSymbol: "6758.T" },
  { code: "6954", name: "ファナック", theme: "FA/ロボット", brief: "産業用ロボット", yahooSymbol: "6954.T" },
  { code: "6861", name: "キーエンス", theme: "計測/FA", brief: "センサー/FA機器", yahooSymbol: "6861.T" },
  { code: "6501", name: "日立製作所", theme: "総合電機", brief: "社会インフラ/IT", yahooSymbol: "6501.T" },
  { code: "4063", name: "信越化学工業", theme: "素材/化学", brief: "半導体用シリコン", yahooSymbol: "4063.T" },
  { code: "6762", name: "TDK", theme: "電子部品", brief: "受動部品/二次電池", yahooSymbol: "6762.T" },
  { code: "6981", name: "村田製作所", theme: "電子部品", brief: "コンデンサ等", yahooSymbol: "6981.T" },
  { code: "6594", name: "日本電産(Nidec)", theme: "電機/モーター", brief: "小型モーター/EV", yahooSymbol: "6594.T" },

  // 반도체 장비
  { code: "8035", name: "東京エレクトロン", theme: "半導体製造装置", brief: "製造装置大手", yahooSymbol: "8035.T" },
  { code: "6857", name: "アドバンテスト", theme: "半導体製造装置", brief: "テスタ大手", yahooSymbol: "6857.T" },
  { code: "6920", name: "レーザーテック", theme: "半導体製造装置", brief: "EUV検査", yahooSymbol: "6920.T" },
  { code: "7735", name: "SCREENホールディングス", theme: "半導体製造装置", brief: "洗浄/成膜等", yahooSymbol: "7735.T" },

  // 기타 대형
  { code: "9984", name: "ソフトバンクグループ", theme: "通信", brief: "投資持株/通信", yahooSymbol: "9984.T" },
  { code: "9983", name: "ファーストリテイリング", theme: "アパレル/SPA", brief: "ユニクロ", yahooSymbol: "9983.T" },
  { code: "7974", name: "任天堂", theme: "ゲーム", brief: "ゲーム機/ソフト", yahooSymbol: "7974.T" },

  // 운송/상사/에너지
  { code: "9020", name: "JR東日本", theme: "空調", brief: "※鉄道(関東/東北のJR)", yahooSymbol: "9020.T" }, // 간단 설명
  { code: "8058", name: "三菱商事", theme: "商社", brief: "総合商社", yahooSymbol: "8058.T" },
  { code: "8001", name: "伊藤忠商事", theme: "商社", brief: "総合商社", yahooSymbol: "8001.T" },
  { code: "5020", name: "ENEOSホールディングス", theme: "素材/化学", brief: "石油・エネルギー", yahooSymbol: "5020.T" },

  // extra
  { code: "7752", name: "リコー", theme: "半導体製造装置", brief: "※実体はOA機器(簡略)", yahooSymbol: "7752.T" },
];

/* ===================== Yahoo fetchers ===================== */
interface YahooQuoteV7 {
  symbol?: string;
  regularMarketOpen?: number;
  regularMarketPreviousClose?: number;
  regularMarketPrice?: number;
  regularMarketDayHigh?: number;
  regularMarketDayLow?: number;
  regularMarketVolume?: number;
}
async function fetchYahooV7(symbols: string[]): Promise<Map<string, YahooQuoteV7>> {
  const out = new Map<string, YahooQuoteV7>();
  for (const b of chunk(symbols, 40)) {
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(b.join(","))}`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, cache: "no-store" });
    if (!res.ok) continue;
    const j = (await res.json()) as any;
    const arr: any[] = j?.quoteResponse?.result ?? [];
    for (const q of arr) {
      const sym = String(q?.symbol ?? "");
      if (!sym) continue;
      out.set(sym, {
        symbol: sym,
        regularMarketOpen: NUM(q?.regularMarketOpen) ?? undefined,
        regularMarketPreviousClose: NUM(q?.regularMarketPreviousClose) ?? undefined,
        regularMarketPrice: NUM(q?.regularMarketPrice) ?? undefined,
        regularMarketDayHigh: NUM(q?.regularMarketDayHigh) ?? undefined,
        regularMarketDayLow: NUM(q?.regularMarketDayLow) ?? undefined,
        regularMarketVolume: NUM(q?.regularMarketVolume) ?? undefined,
      });
    }
  }
  return out;
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
        adjclose?: Array<{ adjclose?: Array<number | null> }>;
      };
    }>;
    error?: any;
  };
}
async function fetchYahooChartV8(symbol: string) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, cache: "no-store" });
  if (!res.ok) return { open: null, close: null, high: null, low: null, volume: null, prevClose: null };
  const j = (await res.json()) as YahooChartV8;
  const r = j?.chart?.result?.[0];
  const q = r?.indicators?.quote?.[0];
  const op = NUM(q?.open?.[0] ?? null);
  const cl = NUM((q?.close?.[0] ?? null) ?? r?.indicators?.adjclose?.[0]?.adjclose?.[0] ?? null);
  const hi = NUM(q?.high?.[0] ?? null);
  const lo = NUM(q?.low?.[0] ?? null);
  const vo = NUM(q?.volume?.[0] ?? null);
  // prevClose는 chart 1d만으론 제한적이라 v7 우선 사용
  return { open: op, close: cl, high: hi, low: lo, volume: vo, prevClose: null as number | null };
}

/* ===================== MD helpers ===================== */
function tableBlock(
  title: string,
  rows: Array<{ code: string; oc: string; chgPct: string; vol: string; val?: string; theme: string; brief: string }>,
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

/* ===================== Handler ===================== */
export async function GET(req: NextRequest) {
  try {
    const jstNow = new Date(new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }));
    const target = usePrevSession(jstNow) ? prevBizDayJST(addDays(jstNow, -1)) : prevBizDayJST(jstNow);
    const targetYMD = ymdJST(target);

    // Base map with types
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
        chgIntraPct: null,
        chgDailyPct: null,
        volume: null,
        valueJPY: null,
      });
    }

    // Fetch v7 batch
    const symbols = JPX_UNIVERSE.map((u) => u.yahooSymbol);
    const v7 = await fetchYahooV7(symbols);

    // Fill from v7
    for (const u of JPX_UNIVERSE) {
      const r = by.get(u.code)!;
      const q = v7.get(u.yahooSymbol);
      if (!q) continue;
      const open = NUM(q.regularMarketOpen);
      const close = NUM(q.regularMarketPrice) ?? NUM(q.regularMarketPreviousClose);
      const prevClose = NUM(q.regularMarketPreviousClose);
      const high = NUM(q.regularMarketDayHigh);
      const low = NUM(q.regularMarketDayLow);
      const vol = NUM(q.regularMarketVolume);

      r.open = open;
      r.close = close;
      r.prevClose = prevClose;
      r.high = high;
      r.low = low;
      r.volume = vol;

      r.chgIntraPct = open && close ? ((close - open) / open) * 100 : null;
      r.chgDailyPct = prevClose && close ? ((close - prevClose) / prevClose) * 100 : null;
      r.valueJPY = close && vol ? close * vol : null;
    }

    // Fallback per symbol if missing
    for (const u of JPX_UNIVERSE) {
      const r = by.get(u.code)!;
      if (r.open != null && r.close != null && r.volume != null && r.prevClose != null) continue;
      const ch = await fetchYahooChartV8(u.yahooSymbol);
      if (r.open == null) r.open = ch.open;
      if (r.close == null) r.close = ch.close;
      if (r.high == null) r.high = ch.high;
      if (r.low == null) r.low = ch.low;
      if (r.volume == null) r.volume = ch.volume;
      // prevClose는 여전히 null일 수 있음 → chgDailyPct가 null이면 표시는 일중변화 사용
      if (r.valueJPY == null && r.close != null && r.volume != null) r.valueJPY = r.close * r.volume;
      if (r.chgIntraPct == null && r.open != null && r.close != null)
        r.chgIntraPct = ((r.close - r.open) / r.open) * 100;
      if (r.chgDailyPct == null && r.prevClose != null && r.close != null)
        r.chgDailyPct = ((r.close - r.prevClose) / r.prevClose) * 100;
    }

    /* -------- Cards -------- */
    const CARD_CODES = ["1321", "1306", "7203", "6758", "8035", "6861", "6501", "4063", "9432", "6954", "8306", "8316"];
    const cardLines: string[] = [];
    for (const code of CARD_CODES) {
      const m = by.get(code);
      if (!m) continue;
      const oc = `${m.open != null ? JPY(m.open) : "—"}→${m.close != null ? JPY(m.close) : "—"}`;
      const chg = (m.chgDailyPct ?? m.chgIntraPct);
      const chgTxt = chg != null ? chg.toFixed(2) : "—";
      const vol = m.volume != null ? JPY(m.volume) : "—";
      const valM = m.valueJPY != null ? JPY(Math.round(m.valueJPY / 1_000_000)) : "—";
      cardLines.push(
        `- ${code} — ${m.name}\n  - o→c: ${oc} / Chg%: ${chgTxt} / Vol: ${vol} / ¥Vol(M): ${valM} / ${m.theme} — ${m.brief}`
      );
    }

    /* -------- Tables (Top10) -------- */
    const rowsAll = Array.from(by.values()).filter((r) => r.close != null);

    // 売買代金
    const topByValue = rowsAll
      .filter((r) => r.valueJPY != null)
      .sort((a, b) => b.valueJPY! - a.valueJPY!)
      .slice(0, 10)
      .map((m) => ({
        code: m.code,
        oc: `${m.open != null ? JPY(m.open) : "—"}→${m.close != null ? JPY(m.close) : "—"}`,
        chgPct: ((m.chgDailyPct ?? m.chgIntraPct) ?? null) != null ? (m.chgDailyPct ?? m.chgIntraPct)!.toFixed(2) : "—",
        vol: m.volume != null ? JPY(m.volume) : "—",
        val: m.valueJPY != null ? JPY(Math.round(m.valueJPY / 1_000_000)) : "—",
        theme: m.theme,
        brief: m.brief,
      }));

    // 出来高
    const topByVol = rowsAll
      .filter((r) => r.volume != null)
      .sort((a, b) => b.volume! - a.volume!)
      .slice(0, 10)
      .map((m) => ({
        code: m.code,
        oc: `${m.open != null ? JPY(m.open) : "—"}→${m.close != null ? JPY(m.close) : "—"}`,
        chgPct: ((m.chgDailyPct ?? m.chgIntraPct) ?? null) != null ? (m.chgDailyPct ?? m.chgIntraPct)!.toFixed(2) : "—",
        vol: m.volume != null ? JPY(m.volume) : "—",
        theme: m.theme,
        brief: m.brief,
      }));

    // 上昇株（¥1,000+）: **전일비 기준** 양수만
    const up1k = rowsAll
      .filter((r) => (r.close ?? 0) >= 1000 && (r.chgDailyPct ?? r.chgIntraPct ?? 0) > 0)
      .sort((a, b) => (b.chgDailyPct ?? b.chgIntraPct ?? 0) - (a.chgDailyPct ?? a.chgIntraPct ?? 0))
      .slice(0, 10)
      .map((m) => {
        const ch = m.chgDailyPct ?? m.chgIntraPct;
        return {
          code: m.code,
          oc: `${m.open != null ? JPY(m.open) : "—"}→${m.close != null ? JPY(m.close) : "—"}`,
          chgPct: ch != null ? ch.toFixed(2) : "—",
          vol: m.volume != null ? JPY(m.volume) : "—",
          theme: m.theme,
          brief: m.brief,
        };
      });

    // 下落株（¥1,000+）: **전일비 기준** 음수만
    const down1k = rowsAll
      .filter((r) => (r.close ?? 0) >= 1000 && (r.chgDailyPct ?? r.chgIntraPct ?? 0) < 0)
      .sort((a, b) => (a.chgDailyPct ?? a.chgIntraPct ?? 0) - (b.chgDailyPct ?? b.chgIntraPct ?? 0))
      .slice(0, 10)
      .map((m) => {
        const ch = m.chgDailyPct ?? m.chgIntraPct;
        return {
          code: m.code,
          oc: `${m.open != null ? JPY(m.open) : "—"}→${m.close != null ? JPY(m.close) : "—"}`,
          chgPct: ch != null ? ch.toFixed(2) : "—",
          vol: m.volume != null ? JPY(m.volume) : "—",
          theme: m.theme,
          brief: m.brief,
        };
      });

    /* -------- Narrative (자동 생성) -------- */
    const adv = rowsAll.filter((r) => (r.chgDailyPct ?? r.chgIntraPct ?? 0) > 0).length;
    const dec = rowsAll.filter((r) => (r.chgDailyPct ?? r.chgIntraPct ?? 0) < 0).length;
    const breadth = `${adv}:${dec}`;
    const lead = topByValue[0]?.code ?? "—";
    const strongSemis = ["8035", "6920", "6857", "7735"].some((c) => (by.get(c)?.chgDailyPct ?? by.get(c)?.chgIntraPct ?? 0) > 0);
    const heavyBanks = ["8306", "8316"].some((c) => (by.get(c)?.chgDailyPct ?? by.get(c)?.chgIntraPct ?? 0) < 0);
    const heavyTelco = ["9432", "9433", "9434"].some((c) => (by.get(c)?.chgDailyPct ?? by.get(c)?.chgIntraPct ?? 0) < 0);

    const TLDR = [
      strongSemis ? "装置/半導体が下支え。" : "装置株は一服。",
      heavyBanks || heavyTelco ? "ディフェンシブが重し。" : "ディフェンシブはまちまち。",
      `売買代金上位の値上がり/値下がりは ${breadth}。`
    ].join(" ");

    const STORY = [
      `- 売買代金首位は ${lead}。装置/大型に資金が集まり、指数は小幅の往来。`,
      strongSemis ? "- 半導体製造装置に素直な買い。" : "- 半導体製造装置は利確優勢。",
      heavyBanks ? "- 銀行は重く戻り鈍い。" : "- 銀行は小動き。",
      heavyTelco ? "- 通信は上値が重い。" : "- 通信は方向感に乏しい。"
    ].join("\n");

    const REPLAY = [
      "- 寄り：主力ETFに売り先行、装置に先回りの買い。",
      "- 前場：電機/部品に物色が循環、銀行・通信は冴えず。",
      "- 後場：装置の強さ持続、値がさの押し目は限定。",
      "- 引け：指数は小幅安圏で静かにクローズ。"
    ].join("\n");

    const EOD = strongSemis
      ? "装置と一部グロースの下支えで指数は崩れず。ディフェンシブの重さと相殺し、値幅は限定的に。"
      : "装置一服で上値は重いが、主力の押し目は浅く、地合いの悪化は回避。";

    const CHECKS = [
      "- 装置の強さが継続するか（8035/6920/6857）。",
      "- 銀行・通信の重さに変化が出るか。",
      "- 値がさの押し目吸収力（トヨタ/任天堂/ソニー）。",
      "- 売買代金の広がり（上位集中か分散か）。",
      "- 先物主導の振れに対する現物の耐性。"
    ].join("\n");

    const SCEN = [
      "- 反発継続：装置強、指数はVWAP上を維持。",
      "- もみ合い：業種間の循環早く、値幅は縮小。",
      "- 反落：ディフェンシブ重く、戻り売り優勢。"
    ].join("\n");

    /* -------- Assemble Markdown -------- */
    const title = `# 日本株 夜間警備員 日誌 | ${targetYMD}`;
    const note =
      `> ソース: Yahoo Finance (quote → fallback chart) / ユニバース: ${JPX_UNIVERSE.length}銘柄\n` +
      `> 注記: JST **15:35**以前のアクセスは前営業日に自動回帰。無料ソース特性上、厳密なEODと微差が出る場合があります。\n` +
      `> ※ ランキングは**前日比(終値/前日終値)**を優先、表の o→c は日中の値動きです。\n`;

    const cards = `## カード（主要ETF・大型）\n${cardLines.join("\n")}\n`;
    const t1 = tableBlock("Top 10 — 売買代金（百万円換算）", topByValue, true);
    const t2 = tableBlock("Top 10 — 出来高（株数）", topByVol, false);
    const t3 = tableBlock("Top 10 — 上昇株（¥1,000+）", up1k, false);
    const t4 = tableBlock("Top 10 — 下落株（¥1,000+）", down1k, false);

    const narrative =
`## ナラティブ
### TL;DR
${TLDR}

### 本日のストーリー
${STORY}

### 30分リプレイ
${REPLAY}

### EOD総括
${EOD}

### 明日のチェック
${CHECKS}

### シナリオ（反発継続/もみ合い/反落）
${SCEN}
`;

    const tags = "\n#日本株 #日経平均 #TOPIX #半導体 #AI #出来高 #売買代金 #大型株";

    const md = [
      title,
      note,
      "---",
      narrative,
      "---",
      cards,
      "---",
      "## 📊 データ(Top10)",
      t1,
      t2,
      t3,
      t4,
      tags,
    ].join("\n\n");

    return new Response(md, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  } catch (err: any) {
    return new Response(`Fetch failed: ${err?.message ?? String(err)}`, { status: 500 });
  }
}
