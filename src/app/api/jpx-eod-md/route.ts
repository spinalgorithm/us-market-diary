// src/app/api/jpx-eod-md/route.ts
import { NextRequest } from "next/server";

/** ─────────────────────────────
 * 런타임/캐시
 * ───────────────────────────── */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
  const sign = v > 0 ? "" : "";
  return `${sign}${v.toFixed(digits)}`;
}
function fmtO2C(open: number | null | undefined, close: number | null | undefined): string {
  if (open == null || close == null) return "-→-";
  return `${fmtNum(open)}→${fmtNum(close)}`;
}
function take<T>(arr: T[] | undefined, n: number): T[] {
  return Array.isArray(arr) ? arr.slice(0, n) : [];
}
function sum(arr: Array<number | null | undefined>): number {
  let s = 0;
  for (const v of arr) if (v != null && Number.isFinite(Number(v))) s += Number(v);
  return s;
}

/** ─────────────────────────────
 * 랭킹 재계산 (단일 호출 결과로)
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
 * 표(테이블) 빌더 — Name 컬럼 포함
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

/** ─────────────────────────────
 * 규칙 기반 요약(LLM 실패시 사용)
 * ───────────────────────────── */
function ruleNarrative(date: string, rows: Row[], rnk: Rankings | undefined): string {
  const all = Array.isArray(rows) ? rows : [];
  const up = all.filter(x => (x.chgPctPrev ?? 0) > 0).length;
  const dn = all.filter(x => (x.chgPctPrev ?? 0) < 0).length;

  const totalVal = sum(all.map(x => x.yenVolM));
  const topVal = sum((rnk?.byValue ?? []).map(x => x.yenVolM));
  const topShare = totalVal > 0 ? (topVal / totalVal) * 100 : 0;

  const tl = `### TL;DR
市場のムードは**${dn > up ? "売り優勢" : up > dn ? "買い優勢" : "拮抗"}**。売買代金Top10集中度 **${topShare.toFixed(1)}%**、上げ下げ **${up}:${dn}**。`;

  const story = `### 本日のストーリー
- Top10/全体の集中度は **${topShare.toFixed(1)}%**。主力周辺にフロー${topShare >= 40 ? "集中" : "分散"}。
- ブレッドス **${up}:${dn}**、指数は${dn > up ? "一方向に傾斜" : "持ち合い気味"}。
- テーマは売買代金上位寄りで回遊、広がりは限定。`;

  const replay = `### 30分リプレイ
- 寄り：様子見/指標待ち。
- 前場：主力に資金回帰、二番手は選別。
- 後場：方向感鈍化、値がさは押し目拾い優勢。
- 引け：上下に往来しつつ高値/安値圏でクローズ。`;

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
 * LLM 보강(선택) — 타입 충돌 방지를 위해 any 사용
 * OPENAI_API_KEY 없으면 null 반환
 * ───────────────────────────── */
async function llmNarrative(eod: {
  date: string;
  rows: Row[];
  rankings: Rankings;
  topShare: number;
  breadthUp: number;
  breadthDn: number;
}) {
  if (!process.env.OPENAI_API_KEY) return null;
  try {
    // 동적 import + any 캐스팅으로 타입 문제 회피
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const OpenAI: any = (await import("openai")).default || (await import("openai"));
    const client: any = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const topVal = eod.rankings.byValue ?? [];
    const topVol = eod.rankings.byVolume ?? [];
    const gain = eod.rankings.topGainers ?? [];
    const lose = eod.rankings.topLosers ?? [];

    const lines = [
      `日付: ${eod.date}`,
      `Top10集中度: ${eod.topShare.toFixed(1)}%`,
      `Breadth: Up ${eod.breadthUp} / Down ${eod.breadthDn}`,
      `売買代金上位: ${topVal.map(r => `${r.code} ${r.name}(${r.theme}) ${fmtPct(r.chgPctPrev)}%`).join(", ")}`,
      `出来高上位: ${topVol.map(r => `${r.code} ${r.name}`).join(", ")}`,
      `上昇: ${gain.map(r => r.code).join(", ")}`,
      `下落: ${lose.map(r => r.code).join(", ")}`
    ].join("\n");

    const messages: any = [
      { role: "system", content: "あなたは日本株の市況コメントを作るプロ記者。短文で歯切れよく、過度な断定は避けるが具体的に。Markdownで出力。" },
      { role: "user", content:
`以下のデータを要約して、見出しをこの順でMarkdown整形:
### TL;DR
### 本日のストーリー
### 30分リプレイ
### EOD総括
### 明日のチェック
### シナリオ（反発継続/もみ合い/反落）

データ:
${lines}

制約:
- 数値や銘柄は嘘を作らない
- 箇条書きは各見出し2-4行
- 語尾は簡潔に` }
    ];

    const resp: any = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.4,
      messages: messages as any,
    });
    return resp.choices?.[0]?.message?.content ?? null;
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

    // 기본 파라미터(필요시 쿼리로 오버라이드 가능)
    const focus = url.searchParams.get("focus") ?? "1";
    const count = url.searchParams.get("count") ?? "600";      // 600이 무거우면 400으로
    const fallbackMax = url.searchParams.get("fallbackMax") ?? "60"; // TwelveData 보강 상한
    const chartMax = url.searchParams.get("chartMax") ?? "200";      // Yahoo-Chart 보강 상한

    // 기원(도메인)
    const origin =
      (req as any).nextUrl?.origin ??
      `${url.protocol}//${url.host}`;

    // 내부 JSON API 호출 URL (단일 호출)
    const qs = new URLSearchParams({
      focus,
      start: "0",
      count,
      fallbackMax,
      chartMax,
    });
    if (date) qs.set("date", date);
    const apiUrl = `${origin}/api/jpx-eod?${qs.toString()}`;

    // 타임아웃 세이프 fetch (예: 12초)
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 12_000);
    const resp = await fetch(apiUrl, { cache: "no-store", signal: ac.signal }).catch(() => null as any);
    clearTimeout(t);

    let data: EodJson | null = null;
    try { data = await resp?.json(); } catch { data = null; }

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
    const quotes = Array.isArray(d.quotes) ? d.quotes : [];

    // 데이터 유효성 체크(모두 빈 값이면 안내 후 종료)
    const anyValue = quotes.some(r => (r.yenVolM != null) || (r.volume != null) || (r.close != null) || (r.previousClose != null));
    if (!quotes.length || !anyValue) {
      const md =
        `# 日本株 夜間警備員 日誌 | ${dateStr}\n\n` +
        `> データが取得できません（提供元の一時制限）。数分後に再試行してください。\n`;
      return new Response(md, {
        status: 200,
        headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "no-store" },
      });
    }

    // 랭킹 재계산
    const rankings = buildRankings(quotes);

    // 상단 카드(대표 종목)
    const CARD_CODES = new Set([
      "1321","1306","7203","6758","8035","6861","6501","4063","9432",
      "6954","8306","8316","9984","9983","7974","9433","9434"
    ]);
    const cards = quotes.filter(r => CARD_CODES.has(r.code));

    // 헤더/주석
    const header =
      `# 日本株 夜間警備員 日誌 | ${dateStr}\n\n` +
      `> ソース: ${d.source ?? "-"} / ユニバース: ${universeCount}銘柄\n` +
      `> 集計対象: 売買代金 **上位${count}銘柄** のみ（事前集計CSV）。\n` +
      `> 注記: JST **15:35**以前のアクセスは前営業日に自動回帰。無料ソース特性上、厳密なEODと微差が出る場合があります。\n` +
      `> ※ ランキングは**前日比(終値/前日終値)**を優先、表の o→c は日中の値動きです。\n\n`;

    // 요약 지표 계산
    const totalVal = sum(quotes.map(x => x.yenVolM));
    const topValSum = sum(rankings.byValue.map(x => x.yenVolM));
    const topShare = totalVal > 0 ? (topValSum / totalVal) * 100 : 0;
    const breadthUp = quotes.filter(x => (x.chgPctPrev ?? 0) > 0).length;
    const breadthDn = quotes.filter(x => (x.chgPctPrev ?? 0) < 0).length;

    // LLM 보강(있으면 사용, 실패/미설정시 규칙기반)
    const llm = await llmNarrative({
      date: dateStr,
      rows: quotes,
      rankings,
      topShare,
      breadthUp,
      breadthDn,
    });
    const narrative = llm ?? ruleNarrative(dateStr, quotes, rankings);

    // 카드/테이블
    const cardsSec = `## カード（主要ETF・大型）\n${cardsBlock(cards)}\n---\n`;
    const byValueTable = "### Top 10 — 売買代金（百万円換算）\n" + tableByValue(rankings.byValue) + "\n";
    const byVolumeTable = "### Top 10 — 出来高（株数）\n" + tableByVolume(rankings.byVolume) + "\n";
    const gainersTable  = "### Top 10 — 上昇株（¥1,000+）\n" + tableGainers(rankings.topGainers) + "\n";
    const losersTable   = "### Top 10 — 下落株（¥1,000+）\n" + tableLosers(rankings.topLosers) + "\n";
    const tags = "\n#日本株 #日経平均 #TOPIX #半導体 #AI #出来高 #売買代金 #大型株\n";

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
