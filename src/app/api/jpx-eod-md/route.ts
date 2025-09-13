// src/app/api/jpx-eod-md/route.ts
import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

/** ========== Utils ========== */
function fmt(n: number | null | undefined, d: number = 2): string {
  if (n == null || Number.isNaN(n)) return "—";
  return n.toLocaleString("ja-JP", { minimumFractionDigits: d, maximumFractionDigits: d });
}
function fmt0(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  return n.toLocaleString("ja-JP");
}
function oc(o?: number | null, c?: number | null): string {
  if (o == null || c == null) return "—";
  return `${fmt(o)}→${fmt(c)}`;
}
function pct(p?: number | null): string {
  if (p == null || Number.isNaN(p)) return "—";
  return fmt(p, 2);
}
function mdH1(s: string) { return `# ${s}\n`; }
function mdSection(title: string) { return `\n---\n\n## ${title}\n`; }

/** 카드(불릿) 섹션 */
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

/** 표 공통 */
function tableHead(cols: string[]): string {
  const head = `| ${cols.join(" | ")} |\n`;
  const sep = `|${cols.map(() => "---:").join("|")}|`;
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

/** 표 섹션들 */
function buildTableByValue(rows: any[]): string {
  const cols = ["Rank", "Ticker", "o→c", "Chg%", "Vol", "¥Vol(M)", "Theme", "Brief"];
  if (!rows?.length) return tableHead(cols); // 빈 헤더만
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

/** ========== Handler ========== */
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const date = url.searchParams.get("date"); // YYYY-MM-DD (optional)

    // 내부 JSON 엔드포인트 호출
    const base = url.origin;
    const qs = new URLSearchParams();
    if (date) qs.set("date", date);
    const r = await fetch(`${base}/api/jpx-eod?${qs.toString()}`, { cache: "no-store" });
    if (!r.ok) {
      const txt = await r.text();
      return new Response(`Fetch failed: ${txt}`, { status: 500 });
    }
    const j: any = await r.json();
    if (!j?.ok) {
      return new Response(j?.error || "JPX json not ok", { status: 500 });
    }

    // 헤더
    let md = "";
    md += mdH1(`日本株 夜間警備員 日誌 | ${j.usedDate}`);
    md += `> ソース: Yahoo Finance (quote → fallback chart) / ユニバース: ${j.universe}銘柄\n`;
    md += `> 注記: JST 15:10以前のアクセスは前営業日に自動回帰。無料ソース特性上、厳密なEODと微差が出る場合があります。\n`;

    // 카드
    md += mdSection("カード（主要ETF・大型）");
    md += buildCards(j.cards);

    // 간단 스토리
    if (j.story) {
      md += `\n**ヘッドライン:** ${j.story.headline}\n\n`;
      md += `**ブレッドス:** ${j.story.breadth}\n\n`;
      md += `**セクター概観:** ${j.story.sectors}\n`;
    }

    // 표들
    md += mdSection("📊 データ(Top10)");
    md += `### Top 10 — 売買代金（百万円換算）\n`;
    md += buildTableByValue(j.topByValue);
    md += `\n### Top 10 — 出来高（株数）\n`;
    md += buildTableByVolume(j.topByVolume);
    md += `\n### Top 10 — 上昇株（¥1,000+）\n`;
    md += buildTableMovers(j.topGainers);
    md += `\n### Top 10 — 下落株（¥1,000+）\n`;
    md += buildTableMovers(j.topLosers);

    // 태그
    md += `\n\n#日本株 #夜間警備員 #日経平均 #TOPIX #半導体 #AI #出来高 #売買代金\n`;

    return new Response(md, {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  } catch (err: any) {
    return new Response(`JPX MD error: ${err?.message || String(err)}`, { status: 500 });
  }
}
