// src/app/api/jpx-eod/route.ts
import { NextRequest } from "next/server";

/** ===== Runtime / Cache ===== */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

/** ===== 유틸 ===== */
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

const JP_TZ_OFFSET = 9 * 60 * 60 * 1000;

function toJstDate(d: Date) {
  return new Date(d.getTime() + JP_TZ_OFFSET);
}
function fromJstDate(jst: Date) {
  return new Date(jst.getTime() - JP_TZ_OFFSET);
}
function ymd(dateLike: Date) {
  const d = toJstDate(dateLike);
  const y = d.getUTCFullYear();
  const m = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = d.getUTCDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function isWeekendJst(d: Date) {
  const wd = toJstDate(d).getUTCDay(); // 0 Sun ... 6 Sat
  return wd === 0 || wd === 6;
}
function previousWeekdayJst(d: Date) {
  let t = new Date(d);
  while (isWeekendJst(t)) t = new Date(t.getTime() - 24 * 60 * 60 * 1000);
  return t;
}
function numberfmt(n: number | null | undefined) {
  if (n == null || Number.isNaN(n)) return null;
  return Math.round(n * 100) / 100;
}

/** ===== 일본 주요 유니버스 (확장) =====
 *  sym: 야후 심볼(.T), ticker: 숫자 티커 표기, theme/brief: 표와 카드에 사용
 */
type JPItem = { sym: string; ticker: string; name: string; theme: string; brief: string };
const JP_LIST: JPItem[] = [
  { sym: "1321.T", ticker: "1321", name: "日経225連動型上場投信", theme: "インデックス/ETF", brief: "日経225連動ETF" },
  { sym: "1306.T", ticker: "1306", name: "TOPIX連動型上場投信", theme: "インデックス/ETF", brief: "TOPIX連動ETF" },

  { sym: "7203.T", ticker: "7203", name: "トヨタ自動車", theme: "自動車", brief: "世界最大級の自動車メーカー" },
  { sym: "6758.T", ticker: "6758", name: "ソニーグループ", theme: "エレクトロニクス", brief: "ゲーム/画像センサー/音楽" },
  { sym: "8035.T", ticker: "8035", name: "東京エレクトロン", theme: "半導体製造装置", brief: "製造装置大手" },
  { sym: "6861.T", ticker: "6861", name: "キーエンス", theme: "計測/FA", brief: "センサー/FA機器" },
  { sym: "6501.T", ticker: "6501", name: "日立製作所", theme: "総合電機", brief: "社会インフラ/IT" },
  { sym: "4063.T", ticker: "4063", name: "信越化学工業", theme: "素材/化学", brief: "半導体用シリコン" },
  { sym: "9432.T", ticker: "9432", name: "日本電信電話(NTT)", theme: "通信", brief: "国内通信大手" },
  { sym: "6954.T", ticker: "6954", name: "ファナック", theme: "FA/ロボット", brief: "産業用ロボット" },
  { sym: "8306.T", ticker: "8306", name: "三菱UFJフィナンシャルG", theme: "金融", brief: "メガバンク" },
  { sym: "8316.T", ticker: "8316", name: "三井住友フィナンシャルG", theme: "金融", brief: "メガバンク" },

  // 유니버스 확장 (가독/테마 강화를 위해 30~40개 권장)
  { sym: "9984.T", ticker: "9984", name: "ソフトバンクグループ", theme: "投資/テック", brief: "投資持株/通信" },
  { sym: "9983.T", ticker: "9983", name: "ファーストリテイリング", theme: "アパレル/SPA", brief: "ユニクロ" },
  { sym: "8031.T", ticker: "8031", name: "三井物産", theme: "商社", brief: "総合商社" },
  { sym: "8058.T", ticker: "8058", name: "三菱商事", theme: "商社", brief: "総合商社" },
  { sym: "8001.T", ticker: "8001", name: "伊藤忠商事", theme: "商社", brief: "総合商社" },
  { sym: "6594.T", ticker: "6594", name: "日本電産(ニデック)", theme: "電機/モーター", brief: "小型モーター/EV" },
  { sym: "6920.T", ticker: "6920", name: "レーザーテック", theme: "半導体検査", brief: "EUV検査" },
  { sym: "7735.T", ticker: "7735", name: "SCREEN HD", theme: "半導体製造装置", brief: "洗浄/成膜等" },
  { sym: "6981.T", ticker: "6981", name: "村田製作所", theme: "電子部品", brief: "コンデンサ等" },
  { sym: "6762.T", ticker: "6762", name: "TDK", theme: "電子部品", brief: "受動部品/二次電池" },
  { sym: "6367.T", ticker: "6367", name: "ダイキン工業", theme: "空調", brief: "空調世界大手" },
  { sym: "7751.T", ticker: "7751", name: "キヤノン", theme: "精密機器", brief: "映像/事務機" },
  { sym: "7974.T", ticker: "7974", name: "任天堂", theme: "ゲーム", brief: "ゲーム機/ソフト" },
  { sym: "9433.T", ticker: "9433", name: "KDDI", theme: "通信", brief: "au/通信" },
  { sym: "9434.T", ticker: "9434", name: "ソフトバンク", theme: "通信", brief: "携帯通信" },
  { sym: "5401.T", ticker: "5401", name: "日本製鉄", theme: "鉄鋼", brief: "高炉大手" },
  { sym: "6098.T", ticker: "6098", name: "リクルートHD", theme: "人材/プラットフォーム", brief: "Indeed等" },
  { sym: "9020.T", ticker: "9020", name: "JR東日本", theme: "鉄道", brief: "関東/東北のJR" },
  { sym: "7752.T", ticker: "7752", name: "ローム", theme: "半導体", brief: "パワー半導体" },
  { sym: "6857.T", ticker: "6857", name: "アドバンテスト", theme: "半導体検査", brief: "テスタ大手" },
  { sym: "6902.T", ticker: "6902", name: "デンソー", theme: "自動車部品", brief: "車載/半導体" },
];

/** ===== 야후 응답 타입(필요한 필드만) ===== */
type QuoteRow = {
  symbol: string;
  regularMarketOpen?: number;
  regularMarketPrice?: number;
  regularMarketPreviousClose?: number;
  regularMarketChangePercent?: number;
  regularMarketVolume?: number;
  currency?: string;
  longName?: string;
  shortName?: string;
  regularMarketTime?: number; // epoch
};
type ChartRow = {
  chart: {
    result: Array<{
      timestamp: number[];
      indicators: { quote: Array<{ open?: number[]; close?: number[]; volume?: number[] }> };
    }>;
    error: any;
  };
};

/** ===== Fetch Helpers ===== */
async function fetchYahooQuote(symbols: string[]): Promise<QuoteRow[]> {
  if (symbols.length === 0) return [];
  const url =
    "https://query1.finance.yahoo.com/v7/finance/quote?region=JP&lang=ja-JP&symbols=" +
    encodeURIComponent(symbols.join(","));
  const r = await fetch(url, { headers: { "User-Agent": UA }, cache: "no-store" });
  if (!r.ok) throw new Error(`Yahoo quote HTTP ${r.status}`);
  const j = await r.json();
  return (j?.quoteResponse?.result ?? []) as QuoteRow[];
}

async function fetchYahooChart(symbol: string): Promise<{ o?: number; c?: number; v?: number }> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=5d&interval=1d&region=JP&lang=ja-JP`;
  const r = await fetch(url, { headers: { "User-Agent": UA }, cache: "no-store" });
  if (!r.ok) return {};
  const j = (await r.json()) as ChartRow;
  const res = j?.chart?.result?.[0];
  if (!res) return {};
  const q = res.indicators?.quote?.[0];
  const ts = res.timestamp || [];
  const close = q?.close || [];
  const open = q?.open || [];
  const volume = q?.volume || [];

  // 마지막 유효 캔들
  let idx = close.length - 1;
  while (idx >= 0 && (close[idx] == null || Number.isNaN(close[idx]!))) idx--;
  if (idx < 0) return {};
  return { o: open?.[idx], c: close?.[idx], v: volume?.[idx] };
}

/** 심볼 단일 계산 (Quote 우선, 부족 시 Chart 폴백) */
async function getOne(symbol: string) {
  let row: QuoteRow | undefined;
  try {
    const rr = await fetchYahooQuote([symbol]);
    row = rr?.[0];
  } catch {
    // ignore
  }

  let o = row?.regularMarketOpen;
  let c = row?.regularMarketPrice;
  const prev = row?.regularMarketPreviousClose;
  let v = row?.regularMarketVolume;
  if (c == null || v == null) {
    const fb = await fetchYahooChart(symbol);
    o = o ?? fb.o;
    c = c ?? fb.c;
    v = v ?? fb.v;
  }
  let chgPct =
    row?.regularMarketChangePercent != null
      ? row!.regularMarketChangePercent
      : prev && c
      ? ((c - prev) / prev) * 100
      : o && c
      ? ((c - o) / o) * 100
      : undefined;

  return {
    symbol,
    o: numberfmt(o ?? null),
    c: numberfmt(c ?? null),
    v: Math.round((v ?? 0) as number),
    chgPct: numberfmt(chgPct ?? null),
  };
}

/** 멀티 심볼 병렬 (적당히 청크 처리) */
async function getMany(symbols: string[]) {
  const out: Record<string, Awaited<ReturnType<typeof getOne>>> = {};
  const CHUNK = 20;
  for (let i = 0; i < symbols.length; i += CHUNK) {
    const part = symbols.slice(i, i + CHUNK);
    const arr = await Promise.all(part.map((s) => getOne(s)));
    for (const row of arr) out[row.symbol] = row;
  }
  return out;
}

/** ===== 메인 핸들러 ===== */
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const dateQ = url.searchParams.get("date"); // YYYY-MM-DD (선택)
    const now = new Date();
    const jstNow = toJstDate(now);

    // 타겟 날짜: 장 마감(15:10 JST) 전엔 전영업일로 자동 회귀
    let targetJst = dateQ ? toJstDate(new Date(dateQ + "T00:00:00")) : jstNow;
    // 15:10 이전이라면 전일로
    const hhmm = toJstDate(now);
    const isBeforeClose = hhmm.getUTCHours() < 6 || (hhmm.getUTCHours() === 6 && hhmm.getUTCMinutes() < 10); // 06:10 UTC ≒ 15:10 JST
    if (!dateQ && isBeforeClose) targetJst = new Date(targetJst.getTime() - 24 * 60 * 60 * 1000);
    // 주말 보정
    targetJst = previousWeekdayJst(targetJst);

    const usedDate = ymd(targetJst);

    const symbols = JP_LIST.map((x) => x.sym);
    const rows = await getMany(symbols);

    // 머지: JP_LIST 메타 + 시세 합치기
    type Row = {
      ticker: string;
      symbol: string;
      name: string;
      theme: string;
      brief: string;
      o?: number | null;
      c?: number | null;
      chgPct?: number | null;
      v: number;
      jpyVolM?: number | null; // ¥Vol(M) = c * v / 1e6
    };
    const merged: Row[] = JP_LIST.map((m) => {
      const r = rows[m.sym];
      const jpyVolM = r?.c != null && r?.v != null ? numberfmt((r.c! * r.v!) / 1_000_000) : null;
      return {
        ticker: m.ticker,
        symbol: m.sym,
        name: m.name,
        theme: m.theme,
        brief: m.brief,
        o: r?.o ?? null,
        c: r?.c ?? null,
        chgPct: r?.chgPct ?? null,
        v: r?.v ?? 0,
        jpyVolM,
      };
    });

    // Top10: 売買代金(¥VolM), 出来高(Vol), 上昇/下落(종가 ¥1,000 이상 필터)
    const byValue = merged
      .filter((r) => (r.jpyVolM ?? 0) > 0)
      .sort((a, b) => (b.jpyVolM ?? 0) - (a.jpyVolM ?? 0))
      .slice(0, 10);

    const byVolume = merged
      .filter((r) => r.v > 0)
      .sort((a, b) => b.v - a.v)
      .slice(0, 10);

    const priceGE1000 = merged.filter((r) => (r.c ?? 0) >= 1000);
    const risers = priceGE1000
      .filter((r) => (r.chgPct ?? 0) > 0)
      .sort((a, b) => (b.chgPct ?? 0) - (a.chgPct ?? 0))
      .slice(0, 10);

    const fallers = priceGE1000
      .filter((r) => (r.chgPct ?? 0) < 0)
      .sort((a, b) => (a.chgPct ?? 0) - (b.chgPct ?? 0))
      .slice(0, 10);

    // 카드(요약): 대표 12개 고정
    const CARD_TICKERS = new Set([
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
    ]);
    const cards = merged.filter((r) => CARD_TICKERS.has(r.ticker));

    // 스토리(숫자→간단 요약)
    const upCnt = byValue.filter((r) => (r.chgPct ?? 0) > 0).length;
    const dnCnt = byValue.filter((r) => (r.chgPct ?? 0) < 0).length;
    const semi = merged.filter((r) => ["半導体製造装置", "半導体", "半導体検査"].includes(r.theme));
    const fin = merged.filter((r) => r.theme === "金融");
    const avg = (arr: number[]) => (arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0);
    const semiAvg = avg(semi.map((x) => x.chgPct ?? 0));
    const finAvg = avg(fin.map((x) => x.chgPct ?? 0));
    const story = {
      headline:
        semiAvg - finAvg > 0.4
          ? "半導体/電子部品が主役、選別オン継続"
          : finAvg - semiAvg > 0.4
          ? "金融が相対強、指数は持ち合い傾向"
          : "主力はまちまち、物色は循環的",
      breadth: `売買代金上位では 上昇${upCnt} : 下落${dnCnt}。`,
      sectors: `セクター平均: 半導体系 ${numberfmt(semiAvg)}%、金融 ${numberfmt(finAvg)}%。`,
    };

    return Response.json({
      ok: true,
      market: "JPX",
      dateJst: ymd(now),
      usedDate, // 集計基準（休場/前場時は自動回帰）
      universe: merged.length,
      note: "Source: Yahoo Finance (quote→chart fallback). Times in JST. Free source特性上、厳密なEODと微差あり得ます。",
      story,
      cards,
      topByValue: byValue,
      topByVolume: byVolume,
      topGainers: risers,
      topLosers: fallers,
    });
  } catch (err: any) {
    const msg = err?.message || String(err);
    return new Response(`JPX EOD error: ${msg}`, { status: 500 });
  }
}
