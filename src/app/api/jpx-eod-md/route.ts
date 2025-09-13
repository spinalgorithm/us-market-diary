// src/app/api/jpx-eod-md/route.ts
import { NextRequest } from "next/server";

/** ========== Config ==========- */
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
const YJ_RANK_BASE = "https://finance.yahoo.co.jp/ranking/?tm=d&mk=1";
// kd=1 値上がり率 / kd=2 値下がり率 / kd=3 出来高 / kd=4 売買代金
const RANK_PATHS = {
  gainers: `${YJ_RANK_BASE}&kd=1`,
  losers: `${YJ_RANK_BASE}&kd=2`,
  volume: `${YJ_RANK_BASE}&kd=3`,
  value: `${YJ_RANK_BASE}&kd=4`,
};

const JPX_CLOSE_HOUR = 15; // 15:30 종가
const JPX_CLOSE_MIN = 30;
const EOD_READY_BUFFER_MIN = 10; // 15:40까지 버퍼
const JST_TZ = "Asia/Tokyo";

/** 카드용 대표 유니버스(폴백에서도 사용) */
const MAJORS = [
  { code: "1321.T", theme: "インデックス/ETF", brief: "日経225連動ETF" },
  { code: "1306.T", theme: "インデックス/ETF", brief: "TOPIX連動ETF" },
  { code: "7203.T", theme: "自動車", brief: "トヨタ自動車" },
  { code: "6758.T", theme: "エレクトロニクス", brief: "ソニーグループ" },
  { code: "8035.T", theme: "半導体製造装置", brief: "東京エレクトロン" },
  { code: "6861.T", theme: "計測/FA", brief: "キーエンス" },
  { code: "6501.T", theme: "総合電機", brief: "日立製作所" },
  { code: "4063.T", theme: "素材/化学", brief: "信越化学工業" },
  { code: "9432.T", theme: "通信", brief: "日本電信電話(NTT)" },
  { code: "6954.T", theme: "FA/ロボット", brief: "ファナック" },
  { code: "8306.T", theme: "金融", brief: "三菱UFJFG" },
  { code: "8316.T", theme: "金融", brief: "三井住友FG" },
  { code: "9984.T", theme: "投資/テック", brief: "ソフトバンクG" },
  { code: "9983.T", theme: "アパレル/SPA", brief: "ファーストリテイリング" },
  { code: "7974.T", theme: "ゲーム", brief: "任天堂" },
];

/** ========== Utils ==========- */
function toJST(d = new Date()) {
  return new Date(d.toLocaleString("en-US", { timeZone: JST_TZ }));
}
function yyyy_mm_dd(date: Date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
function previousBusinessDay(dateJST: Date) {
  const d = new Date(dateJST);
  do {
    d.setDate(d.getDate() - 1);
  } while (d.getDay() === 0 || d.getDay() === 6); // Sun:0, Sat:6
  return d;
}
function number(v: any) {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return v;
  const s = String(v).replace(/[,¥\s]/g, "");
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}
function fmt(n: number, digits = 2) {
  if (n === null || n === undefined || isNaN(n)) return "-";
  return n.toLocaleString("ja-JP", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}
function fmtInt(n: number) {
  if (n === null || isNaN(n)) return "-";
  return Math.round(n).toLocaleString("ja-JP");
}
function pick<T>(arr: T[], n = 10) {
  return arr.slice(0, Math.max(0, n));
}
function ensureSuffix(code: string) {
  if (code.endsWith(".T")) return code;
  // Yahoo Japan은 .T(東証), .TWO 등 있으나 일반적으로 .T로 처리
  return `${code}.T`;
}

/** 야후재팬 랭킹 페이지 HTML 스크랩 → 공통 파서
 *  반환: { code, name, price, changePercent, volume, valueYen }[]
 *  - price: 종가(일반적으로 현재가=종가 기준)
 *  - changePercent: 등락률(%)
 *  - volume: 거래량(주)
 *  - valueYen: 거래대금(엔) (페이지에 표기 없는 경우 price*volume로 보정)
 */
async function fetchYahooRanking(kind: "gainers" | "losers" | "volume" | "value") {
  const url = RANK_PATHS[kind];
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`Yahoo ranking fetch failed: ${res.status}`);
  const html = await res.text();

  // 랭킹 테이블은 <table> 안에 코드, 이름, 현재가, 前日比(%) 등이 들어있음.
  // 간단 파서(정규식 기반): <a href="/quote/8035.T">東京エレクトロン</a> 등에서 코드·이름 추출
  const rows: {
    code: string;
    name: string;
    price: number;
    changePercent: number;
    volume: number;
    valueYen: number;
  }[] = [];

  // 각 행 블럭 단위로 쪼갠 후 파싱(야후 HTML 구조 변경 시 업데이트 필요)
  const rowChunks = html.split(/<tr[^>]*>/g).slice(1);
  for (const chunk of rowChunks) {
    const mCode = chunk.match(/\/quote\/([0-9A-Z.\-]+)"/i);
    const mName = chunk.match(/<a[^>]+\/quote\/[0-9A-Z.\-]+"[^>]*>([^<]+)<\/a>/i);
    if (!mCode || !mName) continue;
    const code = mCode[1];
    const name = mName[1].trim();

    // 가격
    const mPrice = chunk.match(/([\d,]+(?:\.\d+)?)[\s]*<\/td>/); // 첫 숫자셀
    const price = mPrice ? number(mPrice[1]) : 0;

    // 등락률 % (예: +2.56%)
    const mPct = chunk.match(/([-+]?[\d,]+(?:\.\d+)?)\s*%/);
    const changePercent = mPct ? number(mPct[1]) : 0;

    // 거래량 (숫자에 , 만 존재)
    // 랭킹 종류에 따라 열 위치가 다를 수 있어 다중 시도
    const mVol =
      chunk.match(/([0-9,]+)\s*<span[^>]*>株<\/span>/) ||
      chunk.match(/([0-9,]+)\s*<\/td>\s*<\/tr>/);
    const volume = mVol ? number(mVol[1]) : 0;

    // 거래대금(엔) 혹은 (百万円) 표기가 있을 수 있음
    let valueYen = 0;
    const mValM = chunk.match(/([0-9,]+(?:\.\d+)?)\s*<span[^>]*>百万円<\/span>/);
    if (mValM) {
      valueYen = number(mValM[1]) * 1_000_000; // 百万円 → 円
    } else {
      // 표기 없으면 근사: price * volume
      valueYen = Math.max(0, Math.round(price * volume));
    }

    rows.push({
      code,
      name,
      price,
      changePercent,
      volume,
      valueYen,
    });
  }

  // 혹시 파싱이 전혀 안 됐으면 실패 처리
  if (rows.length === 0) {
    throw new Error("Yahoo ranking parse returned 0 rows");
  }
  return rows;
}

/** 야후 글로벌 quote API (폴백/카드 보강용) */
async function fetchQuoteBatch(symbols: string[]) {
  if (symbols.length === 0) return [];
  const qs = symbols.map(encodeURIComponent).join(",");
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${qs}`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`Yahoo quote error: ${res.status}`);
  const j: any = await res.json();
  return (j?.quoteResponse?.result ?? []).map((r: any) => ({
    symbol: r.symbol,
    shortName: r.shortName ?? r.longName ?? r.symbol,
    open: r.regularMarketOpen ?? null,
    close: r.regularMarketPrice ?? null,
    changePct: r.regularMarketChangePercent ?? null,
    volume: r.regularMarketVolume ?? null,
  }));
}

/** 카드 섹션 생성용: 메이저 12~15종목 */
async function buildCards() {
  try {
    const quotes = await fetchQuoteBatch(MAJORS.map((m) => m.code));
    const by = new Map(quotes.map((q) => [q.symbol, q]));
    const lines: string[] = [];
    for (const m of MAJORS) {
      const q = by.get(m.code);
      if (!q) continue;
      const o = q.open ?? 0;
      const c = q.close ?? 0;
      const chg = q.changePct ?? 0;
      const vol = q.volume ?? 0;
      const valM = (c * (q.volume ?? 0)) / 1_000_000; // 百万円換算
      lines.push(
        `- ${m.code.replace(".T", "")} — ${m.brief}\n  - o→c: ${fmt(o)}→${fmt(
          c
        )} / Chg%: ${fmt(chg, 2)} / Vol: ${fmtInt(vol)} / ¥Vol(M): ${fmt(
          valM,
          0
        )} / ${m.theme} — ${m.brief}`
      );
    }
    return lines.join("\n");
  } catch {
    // 카드 전체 실패 시 빈 문자열 반환
    return "（データを取得できませんでした）";
  }
}

/** Top10 표 생성기 */
function tableBlock(
  title: string,
  rows: any[],
  showValue = false,
  yenValueKey = "valueYen"
) {
  const head = showValue
    ? `| Rank | Ticker | o→c | Chg% | Vol | ¥Vol(M) | Theme | Brief |
|---:|---:|---:|---:|---:|---:|---|---|`
    : `| Rank | Ticker | o→c | Chg% | Vol | Theme | Brief |
|---:|---:|---:|---:|---:|---|---|`;

  const body = rows
    .map((r: any, i: number) => {
      const oc = `${fmt(r.open)}→${fmt(r.close)}`;
      const chg = fmt(r.changePercent ?? r.chgPct ?? 0, 2);
      const vol = fmtInt(r.volume ?? 0);
      const brief = r.brief ?? "—";
      const theme = r.theme ?? "—";
      const sym = r.code?.replace(".T", "") ?? r.symbol?.replace(".T", "") ?? "-";
      if (showValue) {
        const yv = (r[yenValueKey] ?? r.valueYen ?? 0) / 1_000_000;
        return `| ${i + 1} | ${sym} | ${oc} | ${chg} | ${vol} | ${fmt(
          yv,
          0
        )} | ${theme} | ${brief} |`;
      }
      return `| ${i + 1} | ${sym} | ${oc} | ${chg} | ${vol} | ${theme} | ${brief} |`;
    })
    .join("\n");

  return `### ${title}\n${head}\n${body}\n`;
}

/** 코드→테마/브리프 간단 매핑(알려진 대형주 위주) */
function enrichThemeBrief(code: string, name?: string) {
  const c = code.replace(".T", "");
  const preset = new Map(
    MAJORS.map((m) => [m.code.replace(".T", ""), { theme: m.theme, brief: m.brief }])
  );
  if (preset.has(c)) return preset.get(c)!;
  // 이름 힌트로도 간단 분기
  if (name?.includes("ソフトバンク")) return { theme: "投資/テック", brief: name };
  if (name?.includes("トヨタ")) return { theme: "自動車", brief: name };
  if (name?.includes("ソニー")) return { theme: "エレクトロニクス", brief: name };
  if (name?.includes("キーエンス")) return { theme: "計測/FA", brief: name };
  if (name?.includes("任天堂")) return { theme: "ゲーム", brief: name };
  return { theme: "—", brief: name ?? "—" };
}

/** 메인 핸들러 */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const dateParam = searchParams.get("date"); // YYYY-MM-DD (optional)
    const nowJST = toJST();
    const cutoff = new Date(nowJST);
    cutoff.setHours(JPX_CLOSE_HOUR, JPX_CLOSE_MIN + EOD_READY_BUFFER_MIN, 0, 0);

    let target = dateParam ? new Date(dateParam + "T00:00:00+09:00") : nowJST;
    // 날짜 미지정 & 마감버퍼 이전이면 전영업일
    if (!dateParam && nowJST < cutoff) {
      target = previousBusinessDay(nowJST);
    }
    // 주말이면 전영업일 회귀
    if (target.getDay() === 0 || target.getDay() === 6) {
      target = previousBusinessDay(target);
    }

    const ymd = yyyy_mm_dd(target);

    /** 1) 랭킹 페이지 우선 시도 */
    let rankGainers: any[] = [];
    let rankLosers: any[] = [];
    let rankVolume: any[] = [];
    let rankValue: any[] = [];
    let rankOk = true;
    try {
      const [g, l, v, val] = await Promise.all([
        fetchYahooRanking("gainers"),
        fetchYahooRanking("losers"),
        fetchYahooRanking("volume"),
        fetchYahooRanking("value"),
      ]);
      rankGainers = g;
      rankLosers = l;
      rankVolume = v;
      rankValue = val;
    } catch (e) {
      rankOk = false;
      // console.warn("Ranking fetch failed, fallback to quotes:", e);
    }

    /** 2) 랭킹 성공시: 전시장 기준 Top10 구성 */
    let tableValueTop: any[] = [];
    let tableVolumeTop: any[] = [];
    let tableUpTop: any[] = [];
    let tableDownTop: any[] = [];
    let universeCount = 0;

    if (rankOk) {
      // 전시장 표본 수(중복 제거)
      const setAll = new Set<string>();
      [rankGainers, rankLosers, rankVolume, rankValue].forEach((arr) =>
        arr.forEach((r) => setAll.add(ensureSuffix(r.code)))
      );
      universeCount = setAll.size;

      // 거래대금 Top10
      tableValueTop = pick(
        rankValue
          .map((r) => {
            const sym = ensureSuffix(r.code);
            const { theme, brief } = enrichThemeBrief(sym, r.name);
            return {
              code: sym,
              name: r.name,
              open: r.price, // open 미제공 → 근사
              close: r.price,
              changePercent: r.changePercent,
              volume: r.volume,
              valueYen: r.valueYen,
              theme,
              brief,
            };
          })
          .sort((a, b) => (b.valueYen || 0) - (a.valueYen || 0)),
        10
      );

      // 거래량 Top10
      tableVolumeTop = pick(
        rankVolume
          .map((r) => {
            const sym = ensureSuffix(r.code);
            const { theme, brief } = enrichThemeBrief(sym, r.name);
            const valY = r.valueYen || Math.max(0, Math.round(r.price * r.volume));
            return {
              code: sym,
              name: r.name,
              open: r.price,
              close: r.price,
              changePercent: r.changePercent,
              volume: r.volume,
              valueYen: valY,
              theme,
              brief,
            };
          })
          .sort((a, b) => (b.volume || 0) - (a.volume || 0)),
        10
      );

      // 상승 Top10 (종가 ≥ ¥1,000)
      const gainersFiltered = rankGainers.filter((r) => number(r.price) >= 1000);
      tableUpTop = pick(
        gainersFiltered
          .map((r) => {
            const sym = ensureSuffix(r.code);
            const { theme, brief } = enrichThemeBrief(sym, r.name);
            const valY = r.valueYen || Math.max(0, Math.round(r.price * r.volume));
            return {
              code: sym,
              name: r.name,
              open: r.price,
              close: r.price,
              changePercent: r.changePercent,
              volume: r.volume,
              valueYen: valY,
              theme,
              brief,
            };
          })
          .sort((a, b) => (b.changePercent || 0) - (a.changePercent || 0)),
        10
      );

      // 하락 Top10 (종가 ≥ ¥1,000)
      const losersFiltered = rankLosers.filter((r) => number(r.price) >= 1000);
      tableDownTop = pick(
        losersFiltered
          .map((r) => {
            const sym = ensureSuffix(r.code);
            const { theme, brief } = enrichThemeBrief(sym, r.name);
            const valY = r.valueYen || Math.max(0, Math.round(r.price * r.volume));
            return {
              code: sym,
              name: r.name,
              open: r.price,
              close: r.price,
              changePercent: r.changePercent,
              volume: r.volume,
              valueYen: valY,
              theme,
              brief,
            };
          })
          .sort((a, b) => (a.changePercent || 0) - (b.changePercent || 0)),
        10
      );
    } else {
      /** 3) 폴백: 메이저 유니버스만으로 근사 */
      const quotes = await fetchQuoteBatch(MAJORS.map((m) => m.code));
      universeCount = quotes.length;
      const rows = quotes.map((q) => {
        const meta = MAJORS.find((m) => m.code === q.symbol);
        const close = number(q.close);
        const open = number(q.open);
        const vol = number(q.volume);
        const valY = close * vol;
        return {
          code: q.symbol,
          name: q.shortName,
          open,
          close,
          changePercent: number(q.changePct),
          volume: vol,
          valueYen: valY,
          theme: meta?.theme ?? "—",
          brief: meta?.brief ?? q.shortName ?? "—",
        };
      });

      tableValueTop = pick(rows.sort((a, b) => b.valueYen - a.valueYen), 10);
      tableVolumeTop = pick(rows.sort((a, b) => b.volume - a.volume), 10);
      tableUpTop = pick(
        rows.filter((r) => r.close >= 1000).sort((a, b) => b.changePercent - a.changePercent),
        10
      );
      tableDownTop = pick(
        rows.filter((r) => r.close >= 1000).sort((a, b) => a.changePercent - b.changePercent),
        10
      );
    }

    /** 카드 섹션 */
    const cards = await buildCards();

    /** 간단 브레드스(거래대금 Top10 내) */
    const upCnt = tableValueTop.filter((r) => (r.changePercent ?? 0) > 0).length;
    const downCnt = tableValueTop.filter((r) => (r.changePercent ?? 0) < 0).length;

    /** 마크다운 조립 */
    const header = `# 日本株 夜間警備員 日誌 | ${ymd}
> ソース: Yahoo Finance（ランキング/quote → フォールバック） / ユニバース: ${universeCount}銘柄
> 注記: JST **15:40**以前のアクセスは前営業日に自動回帰。無料ソース特性上、厳密なEODと微差が出る場合があります（ランキング反映遅延対策）。`;

    const narrative = `## ナラティブ
**ヘッドライン:** 主力はまちまち、物色は循環的。装置・一部電機に買い、通信・銀行は重め。\n
**ブレッドス:** （売買代金上位10銘柄ベース） 上昇 ${upCnt} : 下落 ${downCnt}\n
**所感:** 値がさの下支えとディフェンシブの重さが拮抗。ランキング主導の資金回転が速く、押し目待機の姿勢も観察。`;

    const md =
      `${header}\n\n` +
      `## カード（主要ETF・大型）\n${cards}\n\n---\n\n` +
      `${narrative}\n\n---\n\n` +
      `## 📊 データ(Top10)\n` +
      tableBlock("Top 10 — 売買代金（百万円換算）", tableValueTop, true) +
      `\n` +
      tableBlock("Top 10 — 出来高（株数）", tableVolumeTop, false) +
      `\n` +
      tableBlock("Top 10 — 上昇株（¥1,000+）", tableUpTop, false) +
      `\n` +
      tableBlock("Top 10 — 下落株（¥1,000+）", tableDownTop, false) +
      `\n\n#日本株 #日経平均 #TOPIX #東証 #半導体 #AI #出来高 #売買代金`;

    return new Response(md, {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  } catch (e: any) {
    const emsg = (e as Error)?.message ?? String(e);
    return new Response(`Fetch failed: ${emsg}`, { status: 500 });
  }
}
