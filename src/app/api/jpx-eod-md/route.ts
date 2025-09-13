import { NextRequest } from "next/server";
import OpenAI from "openai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

/* ========== formatters (top-level로 선언: ES5 strict 에러 방지) ========== */
function fmt(n: number | null | undefined, d = 2) {
  if (n == null || Number.isNaN(n)) return "—";
  return n.toLocaleString("ja-JP", { minimumFractionDigits: d, maximumFractionDigits: d });
}
function fmt0(n: number | null | undefined) {
  if (n == null || Number.isNaN(n)) return "—";
  return n.toLocaleString("ja-JP");
}
function oc(o?: number | null, c?: number | null) {
  if (o == null || c == null) return "—";
  return `${fmt(o)}→${fmt(c)}`;
}
function pct(p?: number | null) {
  if (p == null || Number.isNaN(p)) return "—";
  return fmt(p, 2);
}

function mdH1(s: string) { return `# ${s}\n`; }
function mdSection(title: string) { return `\n---\n\n## ${title}\n`; }

/* 카드 */
function buildCards(cards: any[]): string {
  if (!cards?.length) return "（データを取得できませんでした）\n";
  const lines: string[] = [];
  for (const r of cards) {
    lines.push(
      `- ${r.ticker} — ${r.name}\n` +
      `  - o→c: ${oc(r.o, r.c)} / Chg%: ${pct(r.chgPct)} / Vol: ${fmt0(r.v)} / ¥Vol(M): ${fmt(r.jpyVolM, 0)} / ${r.theme} — ${r.brief}`
    );
  }
  return lines.join("\n") + "\n";
}

/* 표 공통 */
function tableHead(cols: string[]): string {
  const head = `| ${cols.join(" | ")} |\n`;
  const sep = `|${cols.map((_c, i) => (i === 1 ? "---" : "---:")).join("|")}|`; // Ticker는 좌정렬
  return head + sep + "\n";
}
function rowByValue(r: any, i: number) {
  return `| ${i} | ${r.ticker} | ${oc(r.o, r.c)} | ${pct(r.chgPct)} | ${fmt0(r.v)} | ${fmt(r.jpyVolM, 0)} | ${r.theme} | ${r.brief} |`;
}
function rowByVolume(r: any, i: number) {
  return `| ${i} | ${r.ticker} | ${oc(r.o, r.c)} | ${pct(r.chgPct)} | ${fmt0(r.v)} | ${r.theme} | ${r.brief} |`;
}
function rowMover(r: any, i: number) {
  return `| ${i} | ${r.ticker} | ${oc(r.o, r.c)} | ${pct(r.chgPct)} | ${fmt0(r.v)} | ${r.theme} | ${r.brief} |`;
}
function buildTableByValue(rows: any[]): string {
  const cols = ["Rank", "Ticker", "o→c", "Chg%", "Vol", "¥Vol(M)", "Theme", "Brief"];
  if (!rows?.length) return tableHead(cols);
  const body = rows.map((r, idx) => rowByValue(r, idx + 1)).join("\n");
  return tableHead(cols) + body + "\n";
}
function buildTableByVolume(rows: any[]): string {
  const cols = ["Rank", "Ticker", "o→c", "Chg%", "Vol", "Theme", "Brief"];
  if (!rows?.length) return tableHead(cols);
  const body = rows.map((r, idx) => rowByVolume(r, idx + 1)).join("\n");
  return tableHead(cols) + body + "\n";
}
function buildTableMovers(rows: any[]): string {
  const cols = ["Rank", "Ticker", "o→c", "Chg%", "Vol", "Theme", "Brief"];
  if (!rows?.length) return tableHead(cols);
  const body = rows.map((r, idx) => rowMover(r, idx + 1)).join("\n");
  return tableHead(cols) + body + "\n";
}

/* 프롬프트에 넣을 안전한 데이터 문자열 생성 (숫자만) */
function buildDataForPrompt(j: any): string {
  const take = (arr: any[], n = 10) => Array.isArray(arr) ? arr.slice(0, n) : [];
  const line = (r: any) =>
    `${r.ticker} o→c ${oc(r.o, r.c)}, Chg% ${pct(r.chgPct)}, Vol ${fmt0(r.v)}`;

  const blocks: string[] = [];
  blocks.push(`日付: ${j.usedDate}`);
  if (j.cards?.length) {
    blocks.push(`Cards:\n- ` + take(j.cards).map(line).join("\n- "));
  }
  if (j.topByValue?.length) {
    blocks.push(`TopByValue:\n- ` + take(j.topByValue).map(line).join("\n- "));
  }
  if (j.topByVolume?.length) {
    blocks.push(`TopByVolume:\n- ` + take(j.topByVolume).map(line).join("\n- "));
  }
  if (j.topGainers?.length) {
    blocks.push(`Gainers:\n- ` + take(j.topGainers).map(line).join("\n- "));
  }
  if (j.topLosers?.length) {
    blocks.push(`Losers:\n- ` + take(j.topLosers).map(line).join("\n- "));
  }
  return blocks.join("\n\n");
}

/* GPT가 작성할 섹션 템플릿 */
function analysisInstructions() {
  return [
    "あなたはnote.com向けの日本株マーケット編集者です。",
    "禁止：将来の価格予測、目標株価、未出所の数値、確率の断定。",
    "許可：本文では数値は o→c / Chg% / Vol のみ。見出し・解説は定性的に。",
    "トーン：『夜間警備員』らしく、読みやすい比喩を1文に1つまで。煽らず淡々、でも退屈にしない。",
    "出力構成：",
    "### TL;DR（3行）",
    "### 本日のストーリー（3-5項目の箇条書き）",
    "### 30分リプレイ（寄り/前場/後場/引け）",
    "### EOD総括（3-4文）",
    "### 明日のチェック（5項目）",
    "### シナリオ（反発継続/もみ合い/反落 各2シグナル）",
    "必ずデータに合致する範囲で書くこと。"
  ].join("\n");
}

/* ========== Handler ========== */
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const date = url.searchParams.get("date") || ""; // 옵션
    const base = url.origin;

    // 1) JPX JSON 가져오기
    const qs = new URLSearchParams();
    if (date) qs.set("date", date);
    const res = await fetch(`${base}/api/jpx-eod?${qs.toString()}`, { cache: "no-store" });
    if (!res.ok) {
      const txt = await res.text();
      return new Response(`Fetch failed: ${txt}`, { status: 500 });
    }
    const j: any = await res.json();
    if (!j?.ok) {
      return new Response(j?.error || "JPX json not ok", { status: 500 });
    }

    // 2) 분석 텍스트 생성 (OpenAI)
    let prose = "";
    try {
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const model = process.env.OPENAI_MODEL || "gpt-5-mini"; // gpt-5 사용시도 OK
      const promptData = buildDataForPrompt(j);
      const completion = await client.chat.completions.create({
        model,
        messages: [
          { role: "system", content: analysisInstructions() },
          { role: "user", content: promptData }
        ],
      });
      prose = completion.choices?.[0]?.message?.content?.trim() || "";
    } catch (e) {
      // GPT가 실패해도 표/카드만이라도 반환
      prose = "";
    }

    // 3) 마크다운 조립
    let md = "";
    md += mdH1(`日本株 夜間警備員 日誌 | ${j.usedDate}`);
    md += `> ソース: Yahoo Finance (quote → fallback chart) / ユニバース: ${j.universe}銘柄\n`;
    md += `> 注記: JST 15:10以前のアクセスは前営業日に自動回帰。無料ソース特性上、厳密なEODと微差が出る場合があります。\n`;

    md += mdSection("カード（主要ETF・大型）");
    md += buildCards(j.cards);

    if (prose) {
      md += mdSection("ナラティブ");
      md += prose + "\n";
    }

    md += mdSection("📊 データ(Top10)");
    md += `### Top 10 — 売買代金（百万円換算）\n` + buildTableByValue(j.topByValue);
    md += `\n### Top 10 — 出来高（株数）\n` + buildTableByVolume(j.topByVolume);
    md += `\n### Top 10 — 上昇株（¥1,000+）\n` + buildTableMovers(j.topGainers);
    md += `\n### Top 10 — 下落株（¥1,000+）\n` + buildTableMovers(j.topLosers);

    md += `\n\n#日本株 #夜間警備員 #日経平均 #TOPIX #半導体 #AI #出来高 #売買代金\n`;

    return new Response(md, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  } catch (err: any) {
    return new Response(`JPX MD error: ${err?.message || String(err)}`, { status: 500 });
  }
}
