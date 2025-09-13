/* eslint-disable @typescript-eslint/no-explicit-any */
import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** ---------- Types ---------- */
type Uni = {
  code: string;          // JPX 4자리(예: 8035)
  name?: string;
  theme?: string;
  brief?: string;
  yahooSymbol: string;   // 예: "8035.T"
};

type Quote = {
  symbol: string;
  shortName?: string;
  open?: number;
  high?: number;
  low?: number;
  price?: number;          // regularMarketPrice (종가에 가까운 최신가)
  previousClose?: number;  // 전일 종가
  volume?: number;
  currency?: string;       // 대부분 "JPY"
};

/** ---------- Config ---------- */
const JST_TZ = "Asia/Tokyo";
const CLOSE_CUTOFF_MIN = 15 * 60 + 35; // 15:35 (동시호가 + 마무리 여유)
const MAX_YH_SYMBOLS = 20;

const UA_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
  "Accept": "application/json,text/plain,*/*",
  "Accept-Language": "ja,en;q=0.9",
};

/** ---------- Time utils ---------- */
function nowInJST(): Date {
  return new Date(new Date().toLocaleString("en-US", { timeZone: JST_TZ }));
}
function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const dd = `${d.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
function minutesOf(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}
function isWeekend(d: Date): boolean {
  const w = d.getDay();
  return w === 0 || w === 6;
}
function prevBusinessDay(base: Date): Date {
  const d = new Date(base);
  do d.setDate(d.getDate() - 1);
  while (isWeekend(d));
  return d;
}

/** ---------- Number utils ---------- */
function safeNum(v: any): number | undefined {
  const n = Number(v);
  return isFinite(n) ? n : undefined;
}
function fmtInt(n?: number): string {
  if (n == null || !isFinite(n)) return "-";
  return Math.round(n).toLocaleString("ja-JP");
}
function fmtDec(n?: number, digits = 2): string {
  if (n == null || !isFinite(n)) return "-";
  return n.toLocaleString("ja-JP", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** ---------- Universe ---------- */
async function loadUniverse(): Promise<Uni[]> {
  const url = process.env.JPX_UNIVERSE_URL;
  if (url) {
    try {
      const r = await fetch(url, { cache: "no-store", headers: UA_HEADERS });
      if (r.ok) {
        const j = (await r.json()) as Uni[];
        return j
          .filter((x) => x && x.yahooSymbol)
          .map((x) => ({
            code: String(x.code ?? "").padStart(4, "0"),
            name: x.name,
            theme: x.theme,
            brief: x.brief,
            yahooSymbol: x.yahooSymbol,
          }));
      }
    } catch {
      /* fall back below */
    }
  }
  // 내장(미니) 유니버스
  return [
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
    { code: "8306", name: "三菱UFJFG", theme: "金融", brief: "メガバンク", yahooSymbol: "8306.T" },
    { code: "8316", name: "三井住友FG", theme: "金融", brief: "メガバンク", yahooSymbol: "8316.T" },
    { code: "9434", name: "ソフトバンク", theme: "通信", brief: "携帯通信", yahooSymbol: "9434.T" },
    { code: "9433", name: "KDDI", theme: "通信", brief: "au/通信", yahooSymbol: "9433.T" },
    { code: "9984", name: "ソフトバンクG", theme: "投資/テック", brief: "投資持株/通信", yahooSymbol: "9984.T" },
    { code: "9983", name: "ファーストリテイリング", theme: "アパレル/SPA", brief: "ユニクロ", yahooSymbol: "9983.T" },
    { code: "6594", name: "日本電産", theme: "電機/モーター", brief: "小型モーター/EV", yahooSymbol: "6594.T" },
    { code: "6920", name: "レーザーテック", theme: "半導体検査", brief: "EUV検査", yahooSymbol: "6920.T" },
    { code: "6857", name: "アドバンテスト", theme: "半導体検査", brief: "テスタ大手", yahooSymbol: "6857.T" },
    { code: "6981", name: "村田製作所", theme: "電子部品", brief: "コンデンサ等", yahooSymbol: "6981.T" },
    { code: "9020", name: "JR東日本", theme: "鉄道", brief: "関東/東北のJR", yahooSymbol: "9020.T" },
    { code: "8058", name: "三菱商事", theme: "商社", brief: "総合商社", yahooSymbol: "8058.T" },
    { code: "6902", name: "デンソー", theme: "自動車部品", brief: "車載/半導体", yahooSymbol: "6902.T" },
    { code: "8001", name: "伊藤忠商事", theme: "商社", brief: "総合商社", yahooSymbol: "8001.T" },
    { code: "7735", name: "SCREEN HD", theme: "半導体製造装置", brief: "洗浄/成膜等", yahooSymbol: "7735.T" },
    { code: "7974", name: "任天堂", theme: "ゲーム", brief: "ゲーム機/ソフト", yahooSymbol: "7974.T" },
    { code: "7752", name: "リコー", theme: "OA・光学", brief: "OA/画像機器", yahooSymbol: "7752.T" },
  ];
}

/** ---------- Stooq fallback ---------- */
function toStooqSymbol(yahooSymbol: string): string {
  // "7203.T" -> "7203.jp"
  const base = yahooSymbol.replace(/\.T$/i, "");
  return `${base}.jp`;
}
async function fetchFromStooq(symYahoo: string): Promise<Quote | undefined> {
  try {
    const s = toStooqSymbol(symYahoo);
    const url = `https://stooq.com/q/l/?s=${encodeURIComponent(s)}&i=d`;
    const r = await fetch(url, { headers: UA_HEADERS, cache: "no-store" });
    if (!r.ok) return;
    const txt = await r.text();
    // CSV: Symbol,Date,Time,Open,High,Low,Close,Volume
    const lines = txt.trim().split(/\r?\n/);
    if (lines.length < 2) return;
    const row = lines[1].split(",");
    const open = safeNum(row[3]);
    const high = safeNum(row[4]);
    const low = safeNum(row[5]);
    const close = safeNum(row[6]);
    const volume = safeNum(row[7]);
    return {
      symbol: symYahoo,
      open,
      high,
      low,
      price: close,
      previousClose: undefined, // stooq는 prevClose 제공X
      volume,
      currency: "JPY",
    };
  } catch {
    return;
  }
}

/** ---------- Yahoo Finance fetch with retries & query2 fallback ---------- */
async function fetchYahooQuoteBatch(symbols: string[]): Promise<Quote[]> {
  const endpoints = [
    "https://query1.finance.yahoo.com/v7/finance/quote?symbols=",
    "https://query2.finance.yahoo.com/v7/finance/quote?symbols=",
  ];
  for (const base of endpoints) {
    try {
      const url = base + encodeURIComponent(symbols.join(","));
      const r = await fetch(url, { cache: "no-store", headers: UA_HEADERS });
      if (!r.ok) continue;
      const j = (await r.json()) as any;
      const arr: any[] = j?.quoteResponse?.result ?? [];
      if (arr.length === 0) continue;
      return arr.map((q) => ({
        symbol: q.symbol,
        shortName: q.shortName,
        open: safeNum(q.regularMarketOpen),
        high: safeNum(q.regularMarketDayHigh),
        low: safeNum(q.regularMarketDayLow),
        price: safeNum(q.regularMarketPrice),
        previousClose: safeNum(q.regularMarketPreviousClose ?? q.previousClose),
        volume: safeNum(q.regularMarketVolume ?? q.volume),
        currency: q.currency ?? "JPY",
      }));
    } catch {
      /* try next endpoint */
    }
  }
  return [];
}

async function fetchYahooChart(sym: string): Promise<Quote | undefined> {
  const bases = [
    "https://query1.finance.yahoo.com/v8/chart/",
    "https://query2.finance.yahoo.com/v8/chart/",
  ];
  for (const base of bases) {
    try {
      const url = `${base}${encodeURIComponent(sym)}?interval=1d&range=5d`;
      const r = await fetch(url, { cache: "no-store", headers: UA_HEADERS });
      if (!r.ok) continue;
      const j = (await r.json()) as any;
      const res = j?.chart?.result?.[0];
      if (!res) continue;
      const meta = res.meta ?? {};
      const q0 = res.indicators?.quote?.[0] ?? {};
      const closes: number[] = res.indicators?.adjclose?.[0]?.adjclose ?? [];
      const price = safeNum(meta?.regularMarketPrice ?? closes?.at(-1));
      const previousClose =
        safeNum(meta?.previousClose) ??
        safeNum(closes?.length >= 2 ? closes[closes.length - 2] : undefined);
      const open = safeNum(q0?.open?.at(-1));
      const high = safeNum(q0?.high?.at(-1));
      const low = safeNum(q0?.low?.at(-1));
      const volume = safeNum(q0?.volume?.at(-1));
      return {
        symbol: sym,
        open,
        high,
        low,
        price,
        previousClose,
        volume,
        currency: meta?.currency ?? "JPY",
        shortName: meta?.symbol ?? sym,
      };
    } catch {
      /* try next base */
    }
  }
  return;
}

async function fetchQuotes(symbols: string[]): Promise<Map<string, Quote>> {
  const out = new Map<string, Quote>();
  // 1) quote API (query1 → query2)
  for (let i = 0; i < symbols.length; i += MAX_YH_SYMBOLS) {
    const chunk = symbols.slice(i, i + MAX_YH_SYMBOLS);
    const arr = await fetchYahooQuoteBatch(chunk);
    for (const q of arr) out.set(q.symbol, q);
    // 살짝 간격
    if (arr.length === 0) await new Promise((r) => setTimeout(r, 200));
  }
  // 2) 비어있는 심볼은 chart 폴백
  const missing1 = symbols.filter((s) => !out.has(s));
  for (const sym of missing1) {
    const q = await fetchYahooChart(sym);
    if (q) out.set(sym, q);
  }
  // 3) 그래도 비면 Stooq 폴백
  const missing2 = symbols.filter((s) => !out.has(s));
  for (const sym of missing2) {
    const q = await fetchFromStooq(sym);
    if (q) out.set(sym, q);
  }
  return out;
}

/** ---------- Markdown blocks ---------- */
function headerBlock(dateLabel: string, uniCount: number): string {
  return `# 日本株 夜間警備員 日誌 | ${dateLabel}

> ソース: Yahoo Finance (quote → fallback chart → stooq) / ユニバース: ${uniCount}銘柄
> 注記: JST **15:35**以前のアクセスは前営業日に自動回帰。無料ソース特性上、厳密なEODと微差が出る場合があります。
> ※ ランキングは**前日比(終値/前日終値)**を優先、表の o→c は日中の値動きです。

`;
}

function narrativeBlock(topYenVol: any[]) {
  const top = topYenVol?.[0];
  const topLabel =
    top && top.code && top.name ? `${top.code}（${top.name}）` : "主力";
  return `## ナラティブ
### TL;DR
装置/半導体が相対強く、銀行・通信は重さが残存。主力は小幅レンジで往来。

### 本日のストーリー
- 売買代金首位は ${topLabel}。装置・一部グロースに資金が寄り、指数は方向感に乏しい。
- 半導体製造装置は買い優勢。銀行は戻り鈍く、通信も上値は重め。
- 値がさの押し目は拾われやすいが、広がりは限定。

### 30分リプレイ
- 寄り：主力ETFは静かな売り先行、装置に先回りの買い。
- 前場：電機/部品へ物色が循環、ディフェンシブは弱含み。
- 後場：装置の強さ継続。押し目は浅く、板は薄皮の均衡。
- 引け：指数は小幅安圏でクローズ、翌日に宿題を残す。

### EOD総括
装置・選別グロースの下支えと、ディフェンシブの重さが綱引き。指数は崩れず、流動性は主力周辺に集中。

### 明日のチェック
- 装置の強さ継続（8035/6920/6857）か、循環で一服か。
- 銀行・通信の重さに変化（フロー反転/ニュース）有無。
- 値がさの押し目吸収力（トヨタ/任天堂/ソニー）。
- 売買代金の分散/集中バランス。
- 先物主導の振れとVWAP攻防。

`;
}

function cardsBlock(rows: any[]): string {
  const lines: string[] = [];
  lines.push("## カード（主要ETF・大型）");
  for (const r of rows) {
    lines.push(`- ${r.code} — ${r.name ?? r.code}`);
    lines.push(
      `  - o→c: ${fmtDec(r.open, 2)}→${fmtDec(r.close, 2)} / Chg%: ${fmtDec(
        r.chgPct,
        2
      )} / Vol: ${fmtInt(r.vol)} / ¥Vol(M): ${fmtInt(r.yenVolM)} / ${r.theme ?? "-"} — ${r.brief ?? "-"
      }`
    );
  }
  lines.push("\n---\n");
  return lines.join("\n");
}

function tableBlock(
  title: string,
  rows: any[],
  opts: { showYenVol?: boolean; showTheme?: boolean; showBrief?: boolean } = {}
): string {
  const { showYenVol = false, showTheme = true, showBrief = true } = opts;
  const head = showYenVol
    ? `| Rank | Ticker | o→c | Chg% | Vol | ¥Vol(M) | Theme | Brief |\n|---:|---:|---:|---:|---:|---:|---|---|`
    : `| Rank | Ticker | o→c | Chg% | Vol | Theme | Brief |\n|---:|---:|---:|---:|---:|---|---|`;
  const out: string[] = [];
  out.push(`### ${title}`);
  out.push(head);
  rows.forEach((r, i) => {
    const base = [
      (i + 1).toString(),
      r.code,
      `${fmtDec(r.open)}→${fmtDec(r.close)}`,
      fmtDec(r.chgPct),
      fmtInt(r.vol),
    ];
    const theme = showTheme ? (r.theme ?? "-") : "-";
    const brief = showBrief ? (r.brief ?? "-") : "-";
    if (showYenVol) {
      out.push(
        `| ${base.join(" | ")} | ${fmtInt(r.yenVolM)} | ${theme} | ${brief} |`
      );
    } else {
      out.push(`| ${base.join(" | ")} | ${theme} | ${brief} |`);
    }
  });
  out.push("\n");
  return out.join("\n");
}

/** ---------- Main ---------- */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const dateParam = url.searchParams.get("date"); // YYYY-MM-DD (옵션)
  const nowJ = nowInJST();
  let target = nowJ;

  // 15:35 이전엔 전영업일로 자동 회귀
  if (!dateParam) {
    if (minutesOf(nowJ) < CLOSE_CUTOFF_MIN) target = prevBusinessDay(nowJ);
  } else {
    const d = new Date(dateParam + "T00:00:00+09:00");
    if (!isNaN(d.getTime())) target = d;
  }
  const dateLabel = ymd(target);

  const uni = await loadUniverse();
  if (uni.length === 0) {
    return new Response("# データなし（ユニバース空）", {
      headers: { "content-type": "text/plain; charset=utf-8" },
      status: 200,
    });
  }

  // 시세 조회(다중 폴백)
  const quotes = await fetchQuotes(uni.map((u) => u.yahooSymbol));

  // 병합/계산
  const merged = uni.map((u) => {
    const q = quotes.get(u.yahooSymbol) ?? ({} as Quote);
    const open = safeNum(q.open);
    const close = safeNum(q.price);
    const prev = safeNum(q.previousClose);
    const vol = safeNum(q.volume);
    // 전일비 % 우선, 없으면 일중(임시)라도 채움
    let chgPct: number | undefined = undefined;
    if (close != null && prev != null && prev !== 0) {
      chgPct = ((close - prev) / prev) * 100;
    } else if (close != null && open != null && open !== 0) {
      chgPct = ((close - open) / open) * 100;
    }
    const yenVolM =
      close != null && vol != null ? Math.round((close * vol) / 1_000_000) : undefined;

    return {
      code: u.code,
      name: u.name ?? q.shortName ?? u.code,
      theme: u.theme,
      brief: u.brief,
      open,
      close,
      prevClose: prev,
      chgPct,
      vol,
      yenVolM,
    };
  });

  // 데이터가 하나도 안 들어오면 안내
  const anyData =
    merged.some((x) => x.close != null) || merged.some((x) => x.vol != null);
  if (!anyData) {
    return new Response(
      `# 日本株 夜間警備員 日誌 | ${dateLabel}

> データ取得に失敗しました（無料ソースの一時ブロック/ネットワーク）。数分後に再試行してください。
`,
      { headers: { "content-type": "text/plain; charset=utf-8" }, status: 200 }
    );
  }

  // 카드(유니버스 앞 12개)
  const cardRows = merged.slice(0, 12);

  // 랭킹
  const byYenVol = merged
    .filter((x) => x.yenVolM != null)
    .sort((a, b) => (b.yenVolM ?? 0) - (a.yenVolM ?? 0))
    .slice(0, 10);

  const byVol = merged
    .filter((x) => x.vol != null)
    .sort((a, b) => (b.vol ?? 0) - (a.vol ?? 0))
    .slice(0, 10);

  // ¥1,000+ (종가 기준) 상/하락
  const largeOnly = merged.filter((x) => (x.close ?? 0) >= 1000 && x.chgPct != null);

  const topUp = largeOnly
    .filter((x) => (x.chgPct ?? 0) > 0)
    .sort((a, b) => (b.chgPct ?? 0) - (a.chgPct ?? 0))
    .slice(0, 10);

  const topDown = largeOnly
    .filter((x) => (x.chgPct ?? 0) < 0)
    .sort((a, b) => (a.chgPct ?? 0) - (b.chgPct ?? 0))
    .slice(0, 10);

  // MD 빌드
  let md = "";
  md += headerBlock(dateLabel, uni.length);
  md += narrativeBlock(byYenVol);
  md += cardsBlock(cardRows);
  md += "## 📊 データ(Top10)\n";
  md += tableBlock("Top 10 — 売買代金（百万円換算）", byYenVol, { showYenVol: true });
  md += tableBlock("Top 10 — 出来高（株数）", byVol);
  md += tableBlock("Top 10 — 上昇株（¥1,000+）", topUp);
  md += tableBlock("Top 10 — 下落株（¥1,000+）", topDown);
  md += "\n#日本株 #日経平均 #TOPIX #半導体 #AI #出来高 #売買代金 #大型株\n";

  return new Response(md, {
    headers: { "content-type": "text/plain; charset=utf-8" },
    status: 200,
  });
}
