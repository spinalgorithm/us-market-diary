// src/app/api/jpx-eod-md/route.ts
import { NextRequest, NextResponse } from "next/server";

export const runtime = "edge";
export const preferredRegion = ["hnd1", "icn1", "sin1"];

type Row = {
  code: string;
  ticker: string;
  name: string;
  theme: string;
  brief: string;
  open: number | null;
  close: number | null;
  previousClose: number | null;
  chgPct: number | null;
  volume: number | null;
  yenVolM: number | null;
  currency: string;
};

function fmtInt(n: number | null | undefined) {
  return n == null ? "-" : Intl.NumberFormat("ja-JP").format(Math.round(n));
}
function fmtYen(n: number | null | undefined) {
  return n == null ? "-" : Intl.NumberFormat("ja-JP", { maximumFractionDigits: 0 }).format(Math.round(n));
}
function fmtPct(n: number | null | undefined) {
  return n == null ? "-" : `${n >= 0 ? "" : ""}${n.toFixed(2)}`;
}

function mdTableValue(rows: Row[]) {
  const head = `| Rank | Ticker | o→c | Chg% | Vol | ¥Vol(M) | Theme | Brief |
|---:|---|---|---:|---:|---:|---|---|`;
  const lines = rows.map((r, i) => {
    const oc = `${r.open ?? "-"}→${r.close ?? "-"}`;
    return `| ${i + 1} | ${r.code} | ${oc} | ${fmtPct(r.chgPct)} | ${fmtInt(r.volume)} | ${fmtYen(r.yenVolM)} | ${r.theme} | ${r.brief} |`;
  });
  return [head, ...lines].join("\n");
}
function mdTableVolume(rows: Row[]) {
  const head = `| Rank | Ticker | o→c | Chg% | Vol | Theme | Brief |
|---:|---|---|---:|---:|---|---|`;
  const lines = rows.map((r, i) => {
    const oc = `${r.open ?? "-"}→${r.close ?? "-"}`;
    return `| ${i + 1} | ${r.code} | ${oc} | ${fmtPct(r.chgPct)} | ${fmtInt(r.volume)} | ${r.theme} | ${r.brief} |`;
  });
  return [head, ...lines].join("\n");
}

async function askJson(req: NextRequest) {
  const base = new URL(req.url);
  // 같은 프로젝트 내 JSON API 호출
  const url = `${base.origin}/api/jpx-eod`;
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`fetch jpx-eod failed: ${r.status}`);
  const j = await r.json();
  return j as any;
}

export async function GET(req: NextRequest) {
  try {
    const data = await askJson(req);
    if (!data?.ok) {
      return new Response(`# 日本株 夜間警備員 日誌

> データ取得に失敗しました（バックエンド）。時間をおいて再試行してください。`, {
        status: 200,
        headers: { "Content-Type": "text/markdown; charset=utf-8" },
      });
    }

    const rows: Row[] = data.quotes ?? [];
    const byValue: Row[] = data.rankings?.byValue ?? [];
    const byVolume: Row[] = data.rankings?.byVolume ?? [];
    const topGainers: Row[] = data.rankings?.topGainers ?? [];
    const topLosers: Row[] = data.rankings?.topLosers ?? [];

    // 카드(주요 ETF/대형) 목록
    const CARD_CODES = ["1321","1306","7203","6758","8035","6861","6501","4063","9432","6954","8306","8316"];
    const card = rows.filter(r => CARD_CODES.includes(r.code));

    const today = new Date();
    const ymd = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,"0")}-${String(today.getDate()).padStart(2,"0")}`;

    const header = `# 日本株 夜間警備員 日誌 | ${ymd}

> ソース: Twelve Data (primary) → Yahoo Chart (fallback) / ユニバース: ${rows.length}銘柄
> 注記: JST **15:35**以前のアクセスは前営業日に自動回帰。無料ソース特性上、厳密なEODと微差が出る場合があります。
> ※ ランキングは**前日比(終値/前日終値)**を優先、表の o→c は日中の値動きです。`;

    const cardsMd = card.length
      ? `## カード（主要ETF・大型）
${card.map(r => `- ${r.code} — ${r.name}
  - o→c: ${r.open ?? "-"}→${r.close ?? "-"} / Chg%: ${fmtPct(r.chgPct)} / Vol: ${fmtInt(r.volume)} / ¥Vol(M): ${fmtYen(r.yenVolM)} / ${r.theme} — ${r.brief}`).join("\n")}`
      : `## カード（主要ETF・大型）
（データを取得できませんでした）`;

    const narrative = `## ナラティブ
### TL;DR
装置/半導体の相対強弱と、銀行・通信の重さが綱引き。主力は小幅レンジで往来。

### 本日のストーリー
- 売買代金上位は装置/大型中心。指数は方向感に乏しいが下値は限定。
- 半導体製造装置は買い優勢。銀行は戻り鈍く、通信も上値が重い。
- 値がさの押し目は拾われやすい一方、広がりは限定。

### 30分リプレイ
- 寄り：指数連動は静かな売り先行、装置に先回りの買い。
- 前場：電機/部品に物色が循環、ディフェンシブは弱含み。
- 後場：装置の強さ継続、押し目は浅い。
- 引け：指数は小幅安圏でクローズ、翌日に宿題を残す。

### EOD総括
装置・選別グロースの下支えと、ディフェンシブの重さが相殺。指数は崩れず、流動性は主力周辺に集中。

### 明日のチェック
- 装置の強さ継続（8035/6920/6857）か循環一服か
- 銀行・通信の重さに変化（フロー反転/ニュース）有無
- 値がさの押し目吸収力（トヨタ/任天堂/ソニー）
- 売買代金の分散/集中バランス
- 先物主導の振れとVWAP攻防`;

    const tables = `## 📊 データ(Top10)

### Top 10 — 売買代金（百万円換算）
${byValue.length ? mdTableValue(byValue) : "_データなし_"}

### Top 10 — 出来高（株数）
${byVolume.length ? mdTableVolume(byVolume) : "_データなし_"}

### Top 10 — 上昇株（¥1,000+）
${topGainers.length ? mdTableVolume(topGainers) : "_該当なし（ユニバース/価格条件）_"}

### Top 10 — 下落株（¥1,000+）
${topLosers.length ? mdTableVolume(topLosers) : "_該当なし（ユニバース/価格条件）_"}
`;

    const tags = `#日本株 #日経平均 #TOPIX #半導体 #AI #出来高 #売買代金 #大型株`;

    const md = [
      header,
      "",
      narrative,
      "",
      cardsMd,
      "",
      tables,
      "",
      tags
    ].join("\n");

    return new Response(md, {
      status: 200,
      headers: { "Content-Type": "text/markdown; charset=utf-8" },
    });
  } catch (e: any) {
    const md = `# 日本株 夜間警備員 日誌

> データ取得に失敗しました（無料ソースの一時ブロック/ネットワーク）。数分後に再試行してください。`;
    return new Response(md, {
      status: 200,
      headers: { "Content-Type": "text/markdown; charset=utf-8" },
    });
  }
}
