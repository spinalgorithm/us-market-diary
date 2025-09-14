// src/app/api/jpx-eod-md/route.ts
import { NextRequest } from "next/server";
import OpenAI from "openai";

/** ─────────────────────────────
 * 런타임/캐시/타임리밋
 * ───────────────────────────── */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Vercel 플랜이 허용하면 약간 여유를 줍니다.
export const maxDuration = 30;

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
 * 유틸 (포맷)
 * ───────────────────────────── */
function fmtNum(x: number | null | undefined): string {
  if (x == null || !Number.isFinite(Number(x))) return "-";
  return Number(x).toLocaleString("ja-JP");
}
function fmtPct(x: number | null | undefined, digits = 2): string {
  if (x == null || !Number.isFinite(Number(x))) return "-";
  const v = Number(x);
  return `${v.toFixed(digits)}`;
}
function fmtO2C(open: number | null | undefined, close: number | null | undefined): string {
  if (open == null || close == null) return "-→-";
  return `${fmtNum(open)}→${fmtNum(close)}`;
}
function take<T>(arr: T[] | undefined, n: number): T[] {
  return Array.isArray(arr) ? arr.slice(0, n) : [];
}

/** ─────────────────────────────
 * 표(테이블) 빌더
 * ───────────────────────────── */
function tableByValue(rows: Row[]): string {
  const head =
    "| Rank | Ticker | Name | o→c | Chg% | Vol | ¥Vol(M) | Theme | Brief |\n" +
    "|---:|---:|---|---:|---:|---:|---:|---|---|\n";
  const body = take(rows, 10)
    .map((r, i) =>
      [
        i + 1,
        r.code,
        r.name || "-",
        fmtO2C(r.open, r.close),
        fmtPct(r.chgPctPrev),
        fmtNum(r.volume),
        fmtNum(r.yenVolM),
        r.theme || "-",
        r.brief || "-",
      ].join(" | ")
    )
    .join("\n");
  return head + body + (body ? "\n" : "");
}

function tableByVolume(rows: Row[]): string {
  const head =
    "| Rank | Ticker | Name | o→c | Chg% | Vol | Theme | Brief |\n" +
    "|---:|---:|---|---:|---:|---:|---|---|\n";
  const body = take(rows, 10)
    .map((r, i) =>
      [
        i + 1,
        r.code,
        r.name || "-",
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
    "| Rank | Ticker | Name | o→c | Chg% | Vol | Theme | Brief |\n" +
    "|---:|---:|---|---:|---:|---:|---|---|\n";
  const body = take(rows, 10)
    .map((r, i) =>
      [
        i + 1,
        r.code,
        r.name || "-",
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
    "| Rank | Ticker | Name | o→c | Chg% | Vol | Theme | Brief |\n" +
    "|---:|---:|---|---:|---:|---:|---|---|\n";
  const body = take(rows, 10)
    .map((r, i) =>
      [
        i + 1,
        r.code,
        r.name || "-",
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

/** ─────────────────────────────
 * 랭킹 재계산 (여러 페이지 합친 뒤)
 * ───────────────────────────── */
function buildRankings(rows: Row[]): Rankings {
  const byValue = [...rows]
    .filter(r => r.yenVolM != null)
    .sort((a, b) => (b.yenVolM! - a.yenVolM!))
    .slice(0, 10);

  const byVolume = [...rows]
    .filter(r => r.volume != null)
    .sort((a, b) => (b.volume! - a.volume!))
    .slice(0, 10);

  const price = (r: Row) => (r.close ?? r.previousClose ?? r.open ?? 0);
  const elig = rows.filter(r => price(r) >= 1000 && r.chgPctPrev != null);

  const topGainers = [...elig]
    .filter(r => (r.chgPctPrev as number) > 0)
    .sort((a, b) => (b.chgPctPrev! - a.chgPctPrev!))
    .slice(0, 10);

  const topLosers = [...elig]
    .filter(r => (r.chgPctPrev as number) < 0)
    .sort((a, b) => (a.chgPctPrev! - b.chgPctPrev!))
    .slice(0, 10);

  return { byValue, byVolume, topGainers, topLosers };
}

/** ─────────────────────────────
 * 카드(상단)
 * ───────────────────────────── */
function cardsBlock(core: Row[]): string {
  if (!core.length) return "（データを取得できませんでした）\n";
  const lines: string[] = [];
  for (const r of core) {
    lines.push(`- ${r.code} — ${r.name || "-"}`);
    lines.push(
      `  - o→c: ${fmtO2C(r.open, r.close)} / Chg%: ${fmtPct(
        r.chgPctPrev
      )} / Vol: ${fmtNum(r.volume)} / ¥Vol(M): ${fmtNum(r.yenVolM)} / ${r.theme || "-"} — ${r.brief || "-"}`
    );
  }
  return lines.join("\n") + "\n";
}

/** ─────────────────────────────
 * 규칙 기반 서술(폴백)
 * ───────────────────────────── */
function ruleNarrative(date: string, rows: Row[], rnk: Rankings): string {
  const adv = rows.filter(r => (r.chgPctPrev ?? 0) > 0).length;
  const dec = rows.filter(r => (r.chgPctPrev ?? 0) < 0).length;

  const sumAll = rows.reduce((s, r) => s + (r.yenVolM ?? 0), 0);
  const sumTop10 = rnk.byValue.reduce((s, r) => s + (r.yenVolM ?? 0), 0);
  const conc = sumAll > 0 ? (sumTop10 / sumAll) * 100 : 0;

  const topThemes = Object.entries(
    rnk.byValue.slice(0, 20).reduce<Record<string, number>>((m, r) => {
      const t = r.theme && r.theme !== "-" ? r.theme : "その他";
      m[t] = (m[t] ?? 0) + 1;
      return m;
    }, {})
  ).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([k])=>k);

  const tl = `### TL;DR
市場のムードは**${adv >= dec ? "買い優勢" : "売り優勢"}**。売買代金Top10集中度 **${conc.toFixed(1)}%**、上げ下げ **${adv}:${dec}**。`;

  const story = `### 本日のストーリー
- Top10/全体の集中度は **${conc.toFixed(1)}%**。主力周辺にフロー${conc >= 40 ? "集中" : "分散"}。
- ブレッドス **${adv}:${dec}**、広範は${adv >= dec ? "堅調" : "軟調"}。
- テーマは ${topThemes.join(" / ")} に回遊。`;

  const replay = `### 30分リプレイ
- 寄り：様子見/指標待ち。
- 前場：主力に資金回帰、二番手は選別。
- 後場：方向感鈍化、値がさは押し目拾い優勢。
- 引け：上下に往来しつつ日中レンジ内でクローズ。`;

  const eod = `### EOD総括
主力集中とブレッドスのバランスで指数は持ち合い気味。翌日は集中の解消/継続が焦点。`;

  const checklist = `### 明日のチェック
- Top10集中度の変化（分散→広がり/継続）
- ブレッドス改善/悪化
- 上下位テーマの入れ替わり`;

  const scenarios = `### シナリオ（反発継続/もみ合い/反落）
- 反発継続：ブレッドス改善、主力外へ回遊
- もみ合い：集中継続、値幅縮小
- 反落：ディフェンシブ主導で戻り売り`;

  return `${tl}\n\n${story}\n\n${replay}\n\n${eod}\n\n${checklist}\n\n${scenarios}`;
}

/** ─────────────────────────────
 * LLM 서술 (2.5s 타임아웃, 실패 시 null)
 * ───────────────────────────── */
async function llmNarrative(date: string, rows: Row[], rnk: Rankings): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const client = new OpenAI({ apiKey });

  // 집계 메트릭
  const adv = rows.filter(r => (r.chgPctPrev ?? 0) > 0).length;
  const dec = rows.filter(r => (r.chgPctPrev ?? 0) < 0).length;
  const sumAll = rows.reduce((s, r) => s + (r.yenVolM ?? 0), 0);
  const sumTop10 = rnk.byValue.reduce((s, r) => s + (r.yenVolM ?? 0), 0);
  const conc = sumAll > 0 ? (sumTop10 / sumAll) * 100 : 0;

  const themeTop = rnk.byValue.slice(0, 20)
    .map(r => r.theme && r.theme !== "-" ? r.theme : "その他");

  const prompt =
`データ(日付: ${date})
- 上げ下げ: ${adv}:${dec}
- Top10集中度: ${conc.toFixed(1)}%
- 売買代金上位(抜粋): ${rnk.byValue.slice(0,10).map(r=>`${r.code} ${r.name}(${r.theme||"-"}) Chg%:${r.chgPctPrev==null?"-":r.chgPctPrev.toFixed(2)}`).join(", ")}
- テーマ頻出: ${themeTop.join("/")}

以下の見出しで、日本株の市況コメントをMarkdownで簡潔に。定量の数字は上記を使い、断定は避けつつ具体的に。
### TL;DR
### 本日のストーリー
### 30分リプレイ
### EOD総括
### 明日のチェック
### シナリオ（反発継続/もみ合い/反落)`;

  // 타입 오류 회피를 위해 any 캐스팅 (openai v4의 union 타입 회피)
  const messages: any = [
    { role: "system", content: "あなたは日本株の市況コメント記者。短文で歯切れよく、過度な断定は避けるが指摘は具体的に。" },
    { role: "user", content: prompt },
  ];

  try {
    const p = client.chat.completions.create({
      model: process.env.OPENAI_MODEL_MD || "gpt-4o-mini",
      temperature: 0.2,
      messages,
    });

    // 2.5초 타임아웃
    const timeout = new Promise<null>(res => setTimeout(() => res(null), 2500));
    const resp: any = await Promise.race([p, timeout]);
    if (!resp || !resp.choices) return null;
    return resp.choices[0]?.message?.content ?? null;
  } catch {
    return null;
  }
}

/** ─────────────────────────────
 * 핸들러
 * ───────────────────────────── */
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const date = url.searchParams.get("date"); // 선택적: ?date=YYYY-MM-DD

    // 기원(도메인)
    const origin =
      (req as any).nextUrl?.origin ??
      `${url.protocol}//${url.host}`;

    // /api/jpx-eod 페이지 가져오기 (focus=1, quick=1)
    async function fetchPage(start: number, count: number): Promise<EodJson | null> {
      const qs = new URLSearchParams();
      qs.set("focus", "1");
      qs.set("quick", "1"); // 빠른 모드
      qs.set("start", String(start));
      qs.set("count", String(count));
      if (date) qs.set("date", date);
      const resp = await fetch(`${origin}/api/jpx-eod?${qs.toString()}`, { cache: "no-store" });
      try {
        return (await resp.json()) as EodJson;
      } catch {
        return null;
      }
    }

    // 600개를 두 구간으로 병렬 수집
    const [p1, p2] = await Promise.all([ fetchPage(0, 300), fetchPage(300, 300) ]);
    const pages: EodJson[] = [];
    if (p1?.ok && Array.isArray(p1.quotes)) pages.push(p1);
    if (p2?.ok && Array.isArray(p2.quotes)) pages.push(p2);

    if (!pages.length) {
      const md =
        `# 日本株 夜間警備員 日誌 | ${date ?? "N/A"}\n\n` +
        `> データ取得に失敗しました（無料ソースの一時ブロック/ネットワーク）。数分後に再試行してください。\n`;
      return new Response(md, {
        status: 200,
        headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "no-store" },
      });
    }

    // 합치기 (code 기준 dedup)
    const byCode = new Map<string, Row>();
    for (const p of pages) {
      for (const r of (p.quotes || [])) {
        if (!byCode.has(r.code)) byCode.set(r.code, r);
      }
    }
    const allRows = Array.from(byCode.values());

    // 소스/유니버스 카운트는 첫 페이지 기준 표기(없으면 계산값)
    const first = pages[0];
    const dateStr = first.date ?? (date ?? "");
    const source = first.source ?? "YahooBatch";
    const universeCount = first.universeCount ?? allRows.length;

    // 카드(대표 코드 추출)
    const CARD_CODES = new Set([
      "1321","1306","7203","6758","8035","6861","6501","4063","9432",
      "6954","8306","8316","9984","9983","7974","9433","9434"
    ]);
    const cards = allRows.filter(r => CARD_CODES.has(r.code));

    // 랭킹 재계산(전 구간 기준)
    const rankings = buildRankings(allRows);

    // 헤더/주석
    const header =
      `# 日本株 夜間警備員 日誌 | ${dateStr}\n\n` +
      `> ソース: ${source} / ユニバース: ${universeCount}銘柄\n` +
      `> 集計対象: 売買代金 **上位600銘柄** のみ（事前集計CSV）。\n` +
      `> 注記: JST **15:35**以前のアクセスは前営業日に自動回帰。無料ソース特性上、厳密なEODと微差が出る場合があります。\n` +
      `> ※ ランキングは**前日比(終値/前日終値)**を優先、表の o→c は日中の値動きです。\n\n`;

    // 서술: LLM 시도 → 실패시 규칙 기반
    const llm = await llmNarrative(dateStr, allRows, rankings);
    const narrative = llm ?? ruleNarrative(dateStr, allRows, rankings);

    // 카드
    const cardsSec = `## カード（主要ETF・大型）\n${cardsBlock(cards)}\n---\n`;

    // 표(랭킹)
    const byValueTable =
      "### Top 10 — 売買代金（百万円換算）\n" + tableByValue(rankings.byValue) + "\n";
    const byVolumeTable =
      "### Top 10 — 出来高（株数）\n" + tableByVolume(rankings.byVolume) + "\n";
    const gainersTable =
      "### Top 10 — 上昇株（¥1,000+）\n" + tableGainers(rankings.topGainers) + "\n";
    const losersTable =
      "### Top 10 — 下落株（¥1,000+）\n" + tableLosers(rankings.topLosers) + "\n";

    const tags = "\n#日本株 #日経平均 #TOPIX #半導体 #出来高 #売買代金 #大型株\n";

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
