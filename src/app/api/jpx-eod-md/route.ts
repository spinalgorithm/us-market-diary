// src/app/api/jpx-eod-md/route.ts
import { NextRequest } from "next/server";
import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* ─ Types ( /api/jpx-eod 과 동일 ) ─ */
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

/* ─ Utils ─ */
const take = <T,>(a: T[] | undefined, n: number) => (Array.isArray(a) ? a.slice(0, n) : []);
const fmtNum = (x: number | null | undefined) =>
  x == null || !Number.isFinite(Number(x)) ? "-" : Number(x).toLocaleString("ja-JP");
const fmtPct = (x: number | null | undefined, d = 2) =>
  x == null || !Number.isFinite(Number(x)) ? "-" : Number(x).toFixed(d);
const fmtO2C = (o: number | null | undefined, c: number | null | undefined) =>
  o == null || c == null ? "-→-" : `${fmtNum(o)}→${fmtNum(c)}`;

/* ─ Tables (이름 컬럼 포함) ─ */
function tableByValue(rows: Row[]): string {
  const head =
    "| Rank | Ticker | Name | o→c | Chg% | Vol | ¥Vol(M) | Theme | Brief |\n" +
    "|---:|---:|---|---:|---:|---:|---:|---|---|\n";
  const body = take(rows, 10)
    .map((r, i) =>
      [
        i + 1,
        r.code,
        r.name || r.code,
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
        r.name || r.code,
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
        r.name || r.code,
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
        r.name || r.code,
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

/* ─ Cards ─ */
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

/* ─ 집계 → LLM 컨텍스트 만들기 ─ */
function makeContext(date: string, rows: Row[], rnk: Rankings) {
  const totalValM = rows.reduce((s, r) => s + (r.yenVolM ?? 0), 0);
  const adv = rows.filter((r) => (r.chgPctPrev ?? 0) > 0).length;
  const dec = rows.filter((r) => (r.chgPctPrev ?? 0) < 0).length;
  const byValTop = take(rnk.byValue, 10);
  const byValTop50 = take(rnk.byValue, 50);

  const concPct =
    totalValM > 0
      ? (byValTop.reduce((s, r) => s + (r.yenVolM ?? 0), 0) / totalValM) * 100
      : 0;

  const themeMap = new Map<string, number>();
  for (const r of byValTop50) {
    const key = r.theme && r.theme !== "-" ? r.theme : "その他";
    themeMap.set(key, (themeMap.get(key) ?? 0) + (r.yenVolM ?? 0));
  }
  const themeTop = Array.from(themeMap.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([k, v]) => `${k}:${Math.round(v)}M`);

  const fmtRow = (r: Row) =>
    `${r.code} ${r.name} ${r.theme !== "-" ? `[${r.theme}]` : ""} Chg:${fmtPct(
      r.chgPctPrev
    )}% VolM:${fmtNum(r.yenVolM)}`;

  return {
    date,
    breadth: { adv, dec, total: rows.length },
    concentrationPct: Number(concPct.toFixed(1)),
    themesTop: themeTop,
    topValue: byValTop.map(fmtRow),
    topVolume: take(rnk.byVolume, 10).map(fmtRow),
    gainers: take(rnk.topGainers, 10).map(fmtRow),
    losers: take(rnk.topLosers, 10).map(fmtRow),
  };
}

/* ─ 규칙 기반(폴백) ─ */
function narrativeRules(date: string, rows: Row[], rnk: Rankings): string {
  const totalValM = rows.reduce((s, r) => s + (r.yenVolM ?? 0), 0);
  const top10ValM = take(rnk.byValue, 10).reduce((s, r) => s + (r.yenVolM ?? 0), 0);
  const conc = totalValM > 0 ? (top10ValM / totalValM) * 100 : 0;
  const adv = rows.filter((r) => (r.chgPctPrev ?? 0) > 0).length;
  const dec = rows.filter((r) => (r.chgPctPrev ?? 0) < 0).length;

  const mood =
    adv / Math.max(1, adv + dec) >= 0.55
      ? "買い先行"
      : dec / Math.max(1, adv + dec) >= 0.55
      ? "売り優勢"
      : "方向感に乏しい";

  const tl = `### TL;DR
市場のムードは**${mood}**。売買代金Top10集中度 **${conc.toFixed(1)}%**、上げ下げ **${adv}:${dec}**。`;

  const body = `### 本日のストーリー
- Top10/全体の集中度は **${conc.toFixed(1)}%**。主力周辺にフロー集中。
- ブレッドス **${adv}:${dec}**、指数は${mood === "方向感に乏しい" ? "横ばい" : "一方向"}に傾斜。
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

  return `${tl}\n\n${body}\n\n${replay}\n\n${eod}\n\n${checklist}\n\n${scenarios}`;
}

/* ─ LLM 내러티브 ─ */
async function llmNarrative(eod: Required<EodJson>): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const client = new OpenAI({ apiKey });

  const rows = Array.isArray(eod.quotes) ? eod.quotes : [];
  const rnk = eod.rankings!;
  const ctx = makeContext(eod.date || "", rows, rnk);

  // ⬇️ 타입을 명시 (둘 중 하나 택1)

  // 방법 A: 명시적 타입 주석
  const messages: ChatCompletionMessageParam[] = [
    {
      role: "system",
      content:
        "あなたは日本株の市況コメントを作るプロの記者です。データドリブンで、短文・具体的・簡潔に。過度な断定は避けつつ、指摘は明確に。Markdownで出力します。",
    },
    {
      role: "user",
      content:
        `データはJPXユニバースの「売買代金上位600銘柄」を対象にしています。\n` +
        `日付: ${ctx.date}\n` +
        `ブレッドス(上昇/下落/総数): ${ctx.breadth.adv}/${ctx.breadth.dec}/${ctx.breadth.total}\n` +
        `Top10集中度(売買代金/全体): ${ctx.concentrationPct}%\n` +
        `上位テーマ(概算 売買代金M): ${ctx.themesTop.join(", ")}\n\n` +
        `売買代金上位(Top10):\n- ${ctx.topValue.join("\n- ")}\n\n` +
        `出来高上位(Top10):\n- ${ctx.topVolume.join("\n- ")}\n\n` +
        `上昇(Top10):\n- ${ctx.gainers.join("\n- ")}\n\n` +
        `下落(Top10):\n- ${ctx.losers.join("\n- ")}\n\n` +
        `以下の見出しで日本語Markdownを生成してください。\n` +
        `### TL;DR\n### 本日のストーリー\n### 30分リプレイ\n### EOD総括\n### 明日のチェック\n### シナリオ（反発継続/もみ合い/反落）\n` +
        `- ブレッドス/集中度/テーマの示唆を必ず含める。\n- 過度な断定NG。`,
    },
  ];

  // // 방법 B: TS 4.9+라면 satisfies 사용도 가능
  // const messages = [
  //   { role: "system", content: "..." },
  //   { role: "user", content: "..." },
  // ] satisfies ChatCompletionMessageParam[];

  try {
    const resp = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL_MD || "gpt-4o-mini", // 여기로 모델 바꿔도 됨
      temperature: 0.4,
      messages,
    });
    return resp.choices[0]?.message?.content ?? null;
  } catch {
    return null; // 실패 시 규칙 기반 폴백으로 내려감
  }
}

/* ─ Handler ─ */
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const date = url.searchParams.get("date") || undefined;
    const llmOff = (url.searchParams.get("llm") ?? "1") === "0"; // ?llm=0 로 끌 수 있음

    // 현재 도메인
    const origin =
      (req as any).nextUrl?.origin ?? `${url.protocol}//${url.host}`;

    // 600개(포커스) 전량 호출
    const qs = new URLSearchParams({ focus: "1", start: "0", count: "600" });
    if (date) qs.set("date", date);
    const apiUrl = `${origin}/api/jpx-eod?${qs.toString()}`;

    const resp = await fetch(apiUrl, { cache: "no-store" });
    const data = (await resp.json()) as EodJson;

    if (!data?.ok) {
      const msg =
        data?.message ||
        data?.error ||
        "データ取得に失敗しました。数分後に再試行してください。";
      const md = `# 日本株 夜間警備員 日誌 | ${date ?? "N/A"}\n\n> ${msg}\n`;
      return new Response(md, {
        status: 200,
        headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "no-store" },
      });
    }

    const d = data as Required<EodJson>;
    const dateStr = d.date ?? (date ?? "");
    const all = Array.isArray(d.quotes) ? d.quotes : [];

    // 카드(대표)
    const CARD_CODES = new Set([
      "1321","1306","7203","6758","8035","6861","6501","4063","9432",
      "6954","8306","8316","9984","9983","7974","9433","9434"
    ]);
    const cards = all.filter(r => CARD_CODES.has(r.code));

    // LLM → 규칙 폴백
    const narrative =
      (!llmOff ? await llmNarrative(d) : null) ??
      narrativeRules(dateStr, all, d.rankings!);

    // 헤더
    const header =
      `# 日本株 夜間警備員 日誌 | ${dateStr}\n\n` +
      `> ソース: ${d.source ?? "-"} / ユニバース: ${d.universeCount ?? all.length}銘柄\n` +
      `> 集計対象: 売買代金 **上位600銘柄** のみ（事前集計CSV）。\n` +
      `> 注記: JST **15:35**以前のアクセスは前営業日に自動回帰。無料ソース特性上、厳密なEODと微差が出る場合があります。\n` +
      `> ※ ランキングは**前日比(終値/前日終値)**を優先、表の o→c は日中の値動きです。\n\n`;

    const cardsSec = `## カード（主要ETF・大型）\n${cardsBlock(cards)}\n---\n`;

    const byValueTable =
      "### Top 10 — 売買代金（百万円換算）\n" + tableByValue(d.rankings?.byValue ?? []) + "\n";
    const byVolumeTable =
      "### Top 10 — 出来高（株数）\n" + tableByVolume(d.rankings?.byVolume ?? []) + "\n";
    const gainersTable =
      "### Top 10 — 上昇株（¥1,000+）\n" + tableGainers(d.rankings?.topGainers ?? []) + "\n";
    const losersTable =
      "### Top 10 — 下落株（¥1,000+）\n" + tableLosers(d.rankings?.topLosers ?? []) + "\n";

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
    const md = `# 日本株 夜間警備員 日誌 | N/A\n\n> 予期せぬエラー: ${err?.message ?? "unknown"}\n`;
    return new Response(md, {
      status: 200,
      headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
}
