// src/app/api/jpx-eod-md/route.ts
import { NextRequest } from "next/server";

/** ─────────────────────────────
 * 타입 ( /api/jpx-eod 응답과 일치 )
 * ───────────────────────────── */
type Row = {
  code: string;
  ticker: string; // yahooSymbol
  name: string;
  theme: string;
  brief: string;
  open: number | null;
  close: number | null;
  previousClose: number | null;
  chgPctPrev: number | null;      // (close / prevClose - 1)*100
  chgPctIntraday: number | null;  // (close / open - 1)*100
  volume: number | null;
  yenVolM: number | null;         // close * volume / 1e6
  currency: string;
};

type Rankings = {
  byValue: Row[];
  byVolume: Row[];
  topGainers: Row[];
  topLosers: Row[];
};

type EodJson = {
  ok: boolean;
  date?: string;
  source?: string;
  universeCount?: number;
  quotes?: Row[];
  rankings?: Rankings;
  note?: string;
  error?: string;
  message?: string;
};

/** ─────────────────────────────
 * 런타임/캐시
 * ───────────────────────────── */
export const dynamic = "force-dynamic";

/** ─────────────────────────────
 * 유틸 (포맷)
 * ───────────────────────────── */
function fmtNum(x: number | null | undefined): string {
  if (x == null || !Number.isFinite(Number(x))) return "-";
  return Number(x).toLocaleString("ja-JP");
}
function fmtAbs(x: number | null | undefined, digits = 2): string {
  if (x == null || !Number.isFinite(Number(x))) return "-";
  return Math.abs(Number(x)).toFixed(digits);
}
function fmtPct(x: number | null | undefined, digits = 2): string {
  if (x == null || !Number.isFinite(Number(x))) return "-";
  const v = Number(x);
  const sign = v > 0 ? "" : ""; // 부호는 값 자체에 포함시키지 않음(표시는 + 생략)
  return `${sign}${v.toFixed(digits)}`;
}
function fmtO2C(open: number | null | undefined, close: number | null | undefined): string {
  if (open == null || close == null) return "-→-";
  return `${fmtNum(open)}→${fmtNum(close)}`;
}
function take<T>(arr: T[] | undefined, n: number): T[] {
  return Array.isArray(arr) ? arr.slice(0, n) : [];
}

/** ─────────────────────────────
 * 테이블 빌더
 * ───────────────────────────── */
function tableByValue(rows: Row[]): string {
  const head =
    "| Rank | Ticker | o→c | Chg% | Vol | ¥Vol(M) | Theme | Brief |\n" +
    "|---:|---:|---:|---:|---:|---:|---|---|\n";
  const body = take(rows, 10)
    .map((r, i) => {
      const chg = fmtPct(r.chgPctPrev);
      return [
        i + 1,
        r.code,
        fmtO2C(r.open, r.close),
        chg,
        fmtNum(r.volume),
        fmtNum(r.yenVolM),
        r.theme || "-",
        r.brief || "-",
      ]
        .map(String)
        .join(" | ");
    })
    .join("\n");
  return head + body + (body ? "\n" : "");
}

function tableByVolume(rows: Row[]): string {
  const head =
    "| Rank | Ticker | o→c | Chg% | Vol | Theme | Brief |\n" +
    "|---:|---:|---:|---:|---:|---|---|\n";
  const body = take(rows, 10)
    .map((r, i) =>
      [
        i + 1,
        r.code,
        fmtO2C(r.open, r.close),
        fmtPct(r.chgPctPrev),
        fmtNum(r.volume),
        r.theme || "-",
        r.brief || "-",
      ].join(" | ")
    )
    .join("\n");
  return head + body + (body ? "\n" : "");
}

function tableGainers(rows: Row[]): string {
  const head =
    "| Rank | Ticker | o→c | Chg% | Vol | Theme | Brief |\n" +
    "|---:|---:|---:|---:|---:|---|---|\n";
  const body = take(rows, 10)
    .map((r, i) =>
      [
        i + 1,
        r.code,
        fmtO2C(r.open, r.close),
        fmtPct(r.chgPctPrev),
        fmtNum(r.volume),
        r.theme || "-",
        r.brief || "-",
      ].join(" | ")
    )
    .join("\n");
  return head + body + (body ? "\n" : "");
}

function tableLosers(rows: Row[]): string {
  const head =
    "| Rank | Ticker | o→c | Chg% | Vol | Theme | Brief |\n" +
    "|---:|---:|---:|---:|---:|---|---|\n";
  const body = take(rows, 10)
    .map((r, i) =>
      [
        i + 1,
        r.code,
        fmtO2C(r.open, r.close),
        fmtPct(r.chgPctPrev),
        fmtNum(r.volume),
        r.theme || "-",
        r.brief || "-",
      ].join(" | ")
    )
    .join("\n");
  return head + body + (body ? "\n" : "");
}

/** 카드(상단) */
function cardsBlock(core: Row[]): string {
  if (!core.length) return "（データを取得できませんでした）\n";
  const lines: string[] = [];
  for (const r of core) {
    lines.push(`- ${r.code} — ${r.name}`);
    lines.push(
      `  - o→c: ${fmtO2C(r.open, r.close)} / Chg%: ${fmtPct(
        r.chgPctPrev
      )} / Vol: ${fmtNum(r.volume)} / ¥Vol(M): ${fmtNum(r.yenVolM)} / ${r.theme || "-"} — ${r.brief || "-"}`
    );
  }
  return lines.join("\n") + "\n";
}

/** 간단 나레이티브 생성(랭킹 기반) */
function narrativeBlock(date: string, rnk: Rankings | undefined, quotes: Row[] | undefined): string {
  const r = rnk;
  const q = quotes ?? [];
  let tl1 = "主力は小幅レンジ、方向感は限定。";
  let tl2 = "装置/半導体が相対強く、ディフェンシブは重い。";
  let tl3 = "売買代金は主力周辺に集中。";

  if (r?.topGainers?.some(x => (x.theme || "").includes("半導体"))) {
    tl2 = "装置/半導体が相対強く、指数の下支え。";
  }
  if (r?.topLosers?.some(x => (x.theme || "").includes("通信") || (x.theme || "").includes("金融"))) {
    tl3 = "ディフェンシブ系の重さが上値を抑制。";
  }

  // byValue에서 상승/하락 개수 집계
  const byVal = r?.byValue ?? [];
  const up = byVal.filter(x => (x.chgPctPrev ?? 0) > 0).length;
  const dn = byVal.filter(x => (x.chgPctPrev ?? 0) < 0).length;

  const tl = `### TL;DR\n${tl1} ${tl2} 売買代金上位の上げ下げは **${up}:${dn}**。`;

  const story = `### 本日のストーリー
- 売買代金上位は装置/大型に資金集中、指数は方向感に乏しいが下値は限定。
- 半導体製造装置の買い優勢が続き、押し目は浅め。
- 銀行・通信は戻り鈍く、板の上では重さが残存。
- 値がさの押し目は拾われやすい一方、広がりは限定。`;

  const replay = `### 30分リプレイ
- 寄り：指数連動に静かな売り先行、装置に先回りの買い。
- 前場：電機/部品へ循環、ディフェンシブは弱含み。
- 後場：装置の強さ継続、押し目は浅い。
- 引け：指数は小幅安圏でクローズ、翌日に宿題を残す。`;

  const eod = `### EOD総括
装置/選別グロースの下支えと、ディフェンシブの重さが相殺。指数は崩れず、流動性は主力周辺に集中。`;

  const checklist = `### 明日のチェック
- 装置の強さ継続（8035/6920/6857）か循環一服か
- 銀行・通信の重さに変化（フロー反転/ニュース）有無
- 値がさの押し目吸収力（トヨタ/任天堂/ソニー）
- 売買代金の分散/集中バランス
- 先物主導の振れとVWAP攻防`;

  const scenarios = `### シナリオ（反発継続/もみ合い/反落）
- 反発継続：装置強、指数はVWAP上を維持
- もみ合い：業種間の循環が速く、値幅は縮小
- 反落：ディフェンシブ重く、戻り売り優勢`;

  return `${tl}\n\n${story}\n\n${replay}\n\n${eod}\n\n${checklist}\n\n${scenarios}`;
}

/** ─────────────────────────────
 * 핸들러
 * ───────────────────────────── */
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const date = url.searchParams.get("date"); // 선택적: ?date=YYYY-MM-DD
    const origin = (req as any).nextUrl?.origin ?? `${url.protocol}//${url.host}`;

    // 내부 JSON API 호출
    const qs = date ? `?date=${encodeURIComponent(date)}` : "";
    const apiUrl = `${origin}/api/jpx-eod${qs}`;
    const resp = await fetch(apiUrl, { cache: "no-store" });
    let data: EodJson | null = null;
    try {
      data = (await resp.json()) as EodJson;
    } catch {
      data = null;
    }

    // 실패 시 에러 MD
    if (!data || !data.ok) {
      const msg =
        data?.message ||
        data?.error ||
        "データ取得に失敗しました（無料ソースの一時ブロック/ネットワーク）。数分後に再試行してください。";
      const md =
        `# 日本株 夜間警備員 日誌 | ${date ?? "N/A"}\n\n` +
        `> ${msg}\n`;
      return new Response(md, {
        status: 200,
        headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "no-store" },
      });
    }

    const d = data as Required<EodJson>;
    const dateStr = d.date ?? (date ?? "");
    const universeCount = d.universeCount ?? 0;

    // 카드용 대표 종목: 主要ETF・大型 (유니버스 중 대표 코드 선정)
    const CARD_CODES = new Set([
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
      "9984",
      "9983",
      "7974",
      "9433",
      "9434",
    ]);
    const all = Array.isArray(d.quotes) ? d.quotes : [];
    const cards = all.filter(r => CARD_CODES.has(r.code));

    // 헤더/주석
    const header =
      `# 日本株 夜間警備員 日誌 | ${dateStr}\n\n` +
      `> ソース: ${d.source ?? "-"} / ユニバース: ${universeCount}銘柄\n` +
      `> 注記: JST **15:35**以前のアクセスは前営業日に自動回帰。無料ソース特性上、厳密なEODと微差が出る場合があります。\n` +
      `> ※ ランキングは**前日比(終値/前日終値)**を優先、表の o→c は日中の値動きです。\n\n`;

    // 나레이티브
    const narrative = narrativeBlock(dateStr, d.rankings, all);

    // 카드
    const cardsSec = `## カード（主要ETF・大型）\n${cardsBlock(cards)}\n---\n`;

    // 표(랭킹)
    const byValueTable =
      "### Top 10 — 売買代金（百万円換算）\n" + tableByValue(d.rankings?.byValue ?? []) + "\n";
    const byVolumeTable =
      "### Top 10 — 出来高（株数）\n" + tableByVolume(d.rankings?.byVolume ?? []) + "\n";
    const gainersTable =
      "### Top 10 — 上昇株（¥1,000+）\n" + tableGainers(d.rankings?.topGainers ?? []) + "\n";
    const losersTable =
      "### Top 10 — 下落株（¥1,000+）\n" + tableLosers(d.rankings?.topLosers ?? []) + "\n";

    const tags =
      "\n#日本株 #日経平均 #TOPIX #半導体 #AI #出来高 #売買代金 #大型株\n";

    const md = [
      header,
      narrative,
      "\n---\n",
      cardsSec,
      "## 📊 データ(Top10)\n",
      byValueTable,
      byVolumeTable,
      gainersTable,
      losersTable,
      tags,
    ].join("");

    return new Response(md, {
      status: 200,
      headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "no-store" },
    });
  } catch (err: any) {
    const md =
      `# 日本株 夜間警備員 日誌 | N/A\n\n` +
      `> 予期せぬエラー: ${err?.message ?? "unknown"}\n`;
    return new Response(md, {
      status: 200,
      headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
}
