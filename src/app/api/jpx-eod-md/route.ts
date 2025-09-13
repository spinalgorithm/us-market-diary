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
  price?: number;
  previousClose?: number;
  volume?: number;
  currency?: string; // 보통 "JPY"
};

/** ---------- Config ---------- */
const JST_TZ = "Asia/Tokyo";
const CLOSE_CUTOFF_MIN = 15 * 60 + 35; // 15:35
const MAX_YH_SYMBOLS = 20;

/** ---------- Utils: time & date ---------- */
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
  do {
    d.setDate(d.getDate() - 1);
  } while (isWeekend(d));
  return d;
}

/** ---------- Utils: number formatting ---------- */
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
function safeNum(v: any): number | undefined {
  const n = Number(v);
  return isFinite(n) ? n : undefined;
}

/** ---------- Data: load universe ---------- */
async function loadUniverse(): Promise<Uni[]> {
  const url = process.env.JPX_UNIVERSE_URL;
  if (url) {
    try {
      const r = await fetch(url, { cache: "no-store" });
      if (r.ok) {
        const j = (await r.json()) as Uni[];
        // 기본 검증 및 정규화
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
      // fall through to default
    }
  }
  // 기본(미니) 유니버스
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
    { code: "7752", name: "リコー", theme: "OA・光学", brief: "OA/画像機器", yahooSymbol: "7752.T" }
  ];
}

/** ---------- Yahoo Finance fetch ---------- */
async function fetchQuotes(symbols: string[]): Promise<Map<string, Quote>> {
  const out = new Map<string, Quote>();
  const chunks: string[][] = [];
  for (let i = 0; i < symbols.length; i += MAX_YH_SYMBOLS) {
    chunks.push(symbols.slice(i, i + MAX_YH_SYMBOLS));
  }

  for (const c of chunks) {
    const url =
      "https://query1.finance.yahoo.com/v7/finance/quote?symbols=" +
      encodeURIComponent(c.join(","));
    try {
      const r = await fetch(url, { cache: "no-store" });
      if (!r.ok) throw new Error(`quote ${r.status}`);
      const j = (await r.json()) as any;
      const arr = j?.quoteResponse?.result ?? [];
      for (const q of arr) {
        const rec: Quote = {
          symbol: q.symbol,
          shortName: q.shortName,
          open: safeNum(q.regularMarketOpen),
          price: safeNum(q.regularMarketPrice),
          previousClose: safeNum(q.regularMarketPreviousClose ?? q.previousClose),
          volume: safeNum(q.regularMarketVolume ?? q.volume),
          currency: q.currency,
        };
        out.set(rec.symbol, rec);
      }
    } catch {
      // chunk 실패 -> chart 폴백(간단)
      for (const sym of c) {
        try {
          const urlChart =
            "https://query1.finance.yahoo.com/v8/chart/" +
            encodeURIComponent(sym) +
            "?interval=1d&range=5d";
          const r2 = await fetch(urlChart, { cache: "no-store" });
          if (!r2.ok) continue;
          const j2 = (await r2.json()) as any;
          const res = j2?.chart?.result?.[0];
          if (!res) continue;
          const meta = res.meta ?? {};
          const ind = res.indicators?.quote?.[0] ?? {};
          const closes: number[] = res.indicators?.adjclose?.[0]?.adjclose ?? [];
          const price = safeNum(meta?.regularMarketPrice ?? closes?.at(-1));
          const previousClose =
            safeNum(meta?.previousClose) ??
            safeNum(closes?.length >= 2 ? closes[closes.length - 2] : undefined);
          const volume = safeNum(ind?.volume?.at(-1));
          const open = safeNum(ind?.open?.at(-1));
          out.set(sym, {
            symbol: sym,
            open,
            price,
            previousClose,
            volume,
            shortName: meta?.symbol ?? sym,
            currency: meta?.currency ?? "JPY",
          });
        } catch {
          // ignore
        }
      }
    }
  }
  return out;
}

/** ---------- Build markdown blocks ---------- */
function headerBlock(dateLabel: string, uniCount: number): string {
  return `# 日本株 夜間警備員 日誌 | ${dateLabel}

> ソース: Yahoo Finance (quote → fallback chart) / ユニバース: ${uniCount}銘柄
> 注記: JST **15:35**以前のアクセスは前営業日に自動回帰。無料ソース特性上、厳密なEODと微差が出る場合があります。
> ※ ランキングは**前日比(終値/前日終値)**を優先、表の o→c は日中の値動きです。

`;
}

function narrativeBlock(topSoldM: any[], sectors: Record<string, { sum: number; n: number }>) {
  const top1 = topSoldM[0];
  const tl = `## ナラティブ
### TL;DR
装置/半導体が相対強く、銀行・通信は重さが残存。主力は小幅レンジで往来。

### 本日のストーリー
- 売買代金首位は ${top1?.code ?? "-"}（${top1?.name ?? "-"}）。装置・一部グロースに資金が寄り、指数は方向感に乏しい。
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
  return tl + "\n";
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
  // 날짜 라벨 (EOD 절체)
  const url = new URL(req.url);
  const dateParam = url.searchParams.get("date"); // YYYY-MM-DD (선택)
  const nowJ = nowInJST();

  let target = nowJ;
  if (!dateParam) {
    // 15:35 이전엔 전영업일로 자동 회귀(주말만 제외)
    if (minutesOf(nowJ) < CLOSE_CUTOFF_MIN) {
      target = prevBusinessDay(nowJ);
    }
  } else {
    const d = new Date(dateParam + "T00:00:00+09:00");
    if (!isNaN(d.getTime())) target = d;
  }
  const dateLabel = ymd(target);

  // 유니버스 로드
  const uni = await loadUniverse();
  if (uni.length === 0) {
    return new Response("# データなし（ユニバース空）", {
      headers: { "content-type": "text/plain; charset=utf-8" },
      status: 200,
    });
  }

  // 시세 조회
  const quotes = await fetchQuotes(uni.map((u) => u.yahooSymbol));
  // 머지 & 계산
  const merged = uni.map((u) => {
    const q = quotes.get(u.yahooSymbol) ?? ({} as Quote);
    const open = safeNum(q.open);
    const close = safeNum(q.price);
    const prev = safeNum(q.previousClose);
    const vol = safeNum(q.volume);
    const chgPct =
      close != null && prev != null && prev !== 0
        ? ((close - prev) / prev) * 100
        : undefined;
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

  // 카드용(주요 12개만, 유니버스의 앞쪽 12개 사용)
  const cardRows = merged.slice(0, 12);

  // 랭킹들
  const byYenVol = merged
    .filter((x) => x.yenVolM != null)
    .sort((a, b) => (b.yenVolM ?? 0) - (a.yenVolM ?? 0))
    .slice(0, 10);

  const byVol = merged
    .filter((x) => x.vol != null)
    .sort((a, b) => (b.vol ?? 0) - (a.vol ?? 0))
    .slice(0, 10);

  // ¥1,000+ 필터 (종가 기준)
  const largeOnly = merged.filter((x) => (x.close ?? 0) >= 1000 && x.chgPct != null);

  const topUp = largeOnly
    .filter((x) => (x.chgPct ?? 0) > 0)
    .sort((a, b) => (b.chgPct ?? 0) - (a.chgPct ?? 0))
    .slice(0, 10);

  const topDown = largeOnly
    .filter((x) => (x.chgPct ?? 0) < 0)
    .sort((a, b) => (a.chgPct ?? 0) - (b.chgPct ?? 0))
    .slice(0, 10);

  // 섹터 간단 집계(나레이티브 힌트)
  const sectors: Record<string, { sum: number; n: number }> = {};
  for (const r of merged) {
    if (r.theme && r.chgPct != null) {
      const k = r.theme.split("/")[0];
      if (!sectors[k]) sectors[k] = { sum: 0, n: 0 };
      sectors[k].sum += r.chgPct;
      sectors[k].n += 1;
    }
  }

  // MD 빌드
  let md = "";
  md += headerBlock(dateLabel, uni.length);
  md += narrativeBlock(byYenVol, sectors);
  md += cardsBlock(cardRows);
  md += "## 📊 データ(Top10)\n";
  md += tableBlock("Top 10 — 売買代金（百万円換算）", byYenVol, {
    showYenVol: true,
  });
  md += tableBlock("Top 10 — 出来高（株数）", byVol);
  md += tableBlock("Top 10 — 上昇株（¥1,000+）", topUp);
  md += tableBlock("Top 10 — 下落株（¥1,000+）", topDown);

  md += "\n#日本株 #日経平均 #TOPIX #半導体 #AI #出来高 #売買代金 #大型株\n";

  return new Response(md, {
    headers: { "content-type": "text/plain; charset=utf-8" },
    status: 200,
  });
}
