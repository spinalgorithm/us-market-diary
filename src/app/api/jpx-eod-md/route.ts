// src/app/api/jpx-eod-md/route.ts
import { NextRequest } from "next/server";
import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

/** Runtime/Cache */
export const runtime = "edge";       // ← Edge로 전환
export const dynamic = "force-dynamic";

/** Types (EOD) */
type Row = {
  code: string;
  ticker: string;
  name: string;
  theme: string;
  brief: string;
  open: number | null;
  close: number | null;
  previousClose: number | null;
  chgPctPrev: number | null;
  chgPctIntraday: number | null;
  volume: number | null;
  yenVolM: number | null;
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
  page?: { start: number; count: number; returned: number };
};

/** utils */
const N = (x: any) => (Number.isFinite(Number(x)) ? Number(x) : undefined);
const n0 = (x: any) => (Number.isFinite(Number(x)) ? Number(x) : 0);

function fmtNum(x: number | null | undefined): string {
  if (x == null || !Number.isFinite(Number(x))) return "-";
  return Number(x).toLocaleString("ja-JP");
}
function fmtPct(x: number | null | undefined, digits = 2): string {
  if (x == null || !Number.isFinite(Number(x))) return "-";
  return Number(x).toFixed(digits);
}
function fmtO2C(open: number | null | undefined, close: number | null | undefined): string {
  if (open == null || close == null) return "-→-";
  return `${fmtNum(open)}→${fmtNum(close)}`;
}
function take<T>(arr: T[] | undefined, n: number): T[] {
  return Array.isArray(arr) ? arr.slice(0, n) : [];
}

/** tables */
function tableByValue(rows: Row[]): string {
  const head =
    "| Rank | Ticker | Name | o→c | Chg% | Vol | ¥Vol(M) | Theme | Brief |\n" +
    "|---:|---:|---|---:|---:|---:|---:|---|---|\n";
  const body = take(rows, 10).map((r, i) =>
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
  ).join("\n");
  return head + body + (body ? "\n" : "");
}
function tableByVolume(rows: Row[]): string {
  const head =
    "| Rank | Ticker | Name | o→c | Chg% | Vol | Theme | Brief |\n" +
    "|---:|---:|---|---:|---:|---:|---|---|\n";
  const body = take(rows, 10).map((r, i) =>
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
  ).join("\n");
  return head + body + (body ? "\n" : "");
}
function tableGainers(rows: Row[]): string {
  const head =
    "| Rank | Ticker | Name | o→c | Chg% | Vol | Theme | Brief |\n" +
    "|---:|---:|---|---:|---:|---:|---|---|\n";
  const body = take(rows, 10).map((r, i) =>
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
  ).join("\n");
  return head + body + (body ? "\n" : "");
}
function tableLosers(rows: Row[]): string {
  const head =
    "| Rank | Ticker | Name | o→c | Chg% | Vol | Theme | Brief |\n" +
    "|---:|---:|---|---:|---:|---:|---|---|\n";
  const body = take(rows, 10).map((r, i) =>
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
  ).join("\n");
  return head + body + (body ? "\n" : "");
}

/** cards */
function cardsBlock(core: Row[]): string {
  if (!core.length) return "（データを取得できませんでした）\n";
  const lines: string[] = [];
  for (const r of core) {
    lines.push(`- ${r.code} — ${r.name}`);
    lines.push(
      `  - o→c: ${fmtO2C(r.open, r.close)} / Chg%: ${fmtPct(r.chgPctPrev)} / Vol: ${fmtNum(r.volume)} / ¥Vol(M): ${fmtNum(r.yenVolM)} / ${r.theme || "-"} — ${r.brief || "-"}`
    );
  }
  return lines.join("\n") + "\n";
}

/** rankings */
function buildRankings(rows: Row[]): Rankings {
  const withY = rows.map((r) => {
    const price = n0(r.close ?? r.previousClose ?? r.open ?? 0);
    const vol = n0(r.volume ?? 0);
    const y = (r.yenVolM != null && Number.isFinite(Number(r.yenVolM))) ? Number(r.yenVolM) : (price * vol) / 1e6;
    return { ...r, _price: price, _yenVolM: y };
  });

  const byValue = [...withY]
    .filter(r => r._yenVolM > 0)
    .sort((a, b) => b._yenVolM - a._yenVolM)
    .slice(0, 10)
    .map(({ _yenVolM, ...rest }) => ({ ...rest, yenVolM: _yenVolM }));

  const byVolume = [...withY]
    .filter(r => (r.volume ?? 0) > 0)
    .sort((a, b) => n0(b.volume) - n0(a.volume))
    .slice(0, 10)
    .map(({ _yenVolM, ...rest }) => ({ ...rest, yenVolM: _yenVolM }));

  const priceOf = (r: any) => (r.close ?? r.previousClose ?? r.open ?? 0);
  const elig = withY.filter(r => priceOf(r) >= 1000 && r.chgPctPrev != null);

  const topGainers = [...elig]
    .filter(r => (r.chgPctPrev as number) > 0)
    .sort((a, b) => n0(b.chgPctPrev) - n0(a.chgPctPrev))
    .slice(0, 10)
    .map(({ _yenVolM, ...rest }) => ({ ...rest, yenVolM: _yenVolM }));

  const topLosers = [...elig]
    .filter(r => (r.chgPctPrev as number) < 0)
    .sort((a, b) => n0(a.chgPctPrev) - n0(b.chgPctPrev))
    .slice(0, 10)
    .map(({ _yenVolM, ...rest }) => ({ ...rest, yenVolM: _yenVolM }));

  return { byValue, byVolume, topGainers, topLosers };
}

/** fallback narrative (no-LLM) */
function narrativeBlock(date: string, rnk: Rankings | undefined, quotes: Row[] | undefined): string {
  const byVal = rnk?.byValue ?? [];
  const up = byVal.filter(x => (x.chgPctPrev ?? 0) > 0).length;
  const dn = byVal.filter(x => (x.chgPctPrev ?? 0) < 0).length;

  const tl = `### TL;DR\n主力は小幅レンジ、方向感は限定。 装置/半導体が相対強く、ディフェンシブは重い。 売買代金上位の上げ下げは **${up}:${dn}**。`;

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

/** LLM narrative */
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "-");
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "-");

function makeContext(date: string, rows: Row[], rnk: Rankings) {
  const withP = rows.map(r => {
    const price = n0(r.close ?? r.previousClose ?? r.open ?? 0);
    const vol = n0(r.volume ?? 0);
    const yv = (r.yenVolM != null && Number.isFinite(Number(r.yenVolM))) ? Number(r.yenVolM) : (price * vol) / 1e6;
    const chg = Number.isFinite(n0(r.chgPctPrev)) ? n0(r.chgPctPrev) : 0;
    return { ...r, _price: price, _yv: yv, _chg: chg };
  });
  const valid = withP.filter(r => r._price > 0);
  const total = valid.length;
  const adv = valid.filter(r => r._chg > 0).length;
  const dec = valid.filter(r => r._chg < 0).length;

  const yvAll = valid.reduce((s, r) => s + r._yv, 0);
  const byVal = [...valid].sort((a, b) => b._yv - a._yv);
  const top10 = byVal.slice(0, 10).reduce((s, r) => s + r._yv, 0);
  const top10Pct = yvAll > 0 ? (top10 / yvAll) * 100 : 0;

  const themeMap = new Map<string, { yv: number; adv: number; dec: number }>();
  for (const r of valid) {
    const t = (r.theme && r.theme !== "-") ? r.theme : "その他";
    const g = themeMap.get(t) ?? { yv: 0, adv: 0, dec: 0 };
    g.yv += r._yv;
    if (r._chg > 0) g.adv++; else if (r._chg < 0) g.dec++;
    themeMap.set(t, g);
  }
  const themesTop = [...themeMap.entries()]
    .sort((a, b) => b[1].yv - a[1].yv)
    .slice(0, 8)
    .map(([t, v]) => `${t} ${f1(v.yv)}M (↑${v.adv}/↓${v.dec})`);

  const up2 = valid.filter(r => r._chg >= 2).length;
  const up3 = valid.filter(r => r._chg >= 3).length;
  const dn2 = valid.filter(r => r._chg <= -2).length;
  const dn3 = valid.filter(r => r._chg <= -3).length;

  const topValue = byVal.slice(0, 10).map(r =>
    `${r.code} ${r.name} (${r.theme || "-"}) Chg:${f2(r._chg)} YV:${f1(r._yv)}M`
  );
  const topVolume = (rnk.byVolume ?? []).slice(0, 10).map(r =>
    `${r.code} ${r.name} (${r.theme || "-"}) Chg:${f2(n0(r.chgPctPrev ?? 0))} Vol:${(n0(r.volume)/1_000_000).toFixed(2)}M`
  );
  const gainers = (rnk.topGainers ?? []).slice(0, 10).map(r =>
    `${r.code} ${r.name} (${r.theme || "-"}) ${f2(n0(r.chgPctPrev ?? 0))}%`
  );
  const losers = (rnk.topLosers ?? []).slice(0, 10).map(r =>
    `${r.code} ${r.name} (${r.theme || "-"}) ${f2(n0(r.chgPctPrev ?? 0))}%`
  );
  const wchg = yvAll > 0 ? valid.reduce((s, r) => s + r._chg * (r._yv / yvAll), 0) : 0;

  return {
    date,
    breadth: { adv, dec, total },
    concentrationPct: f1(top10Pct),
    themesTop,
    buckets: { up2, up3, dn2, dn3 },
    weightedChg: f2(wchg),
    topValue,
    topVolume,
    gainers,
    losers,
  };
}

async function llmNarrative(eod: { date?: string; quotes?: Row[]; rankings?: Rankings; }): Promise<string | null> {
  if (!process.env.OPENAI_API_KEY) return null;
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 8000 });

  const rows = Array.isArray(eod.quotes) ? eod.quotes : [];
  const rnk = eod.rankings ?? { byValue: [], byVolume: [], topGainers: [], topLosers: [] };
  const ctx = makeContext(eod.date || "", rows, rnk);

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: "あなたは日本株の市況記者。与えられた統計を明示し、具体銘柄・数値を短く提示。Markdown章立て固定。" },
    {
      role: "user",
      content:
        `対象: 売買代金上位600銘柄\n` +
        `- 日付: ${ctx.date}\n` +
        `- ブレッドス(上昇/下落/総数): ${ctx.breadth.adv}/${ctx.breadth.dec}/${ctx.breadth.total}\n` +
        `- Top10集中度: ${ctx.concentrationPct}%\n` +
        `- 加重前日比: ${ctx.weightedChg}%\n` +
        `- バケット: +3%=${ctx.buckets.up3}, +2%=${ctx.buckets.up2}, -2%=${ctx.buckets.dn2}, -3%=${ctx.buckets.dn3}\n` +
        `- 上位テーマ: ${ctx.themesTop.join(" / ")}\n` +
        `- 売買代金上位:\n  - ${ctx.topValue.join("\n  - ")}\n` +
        `- 出来高上位:\n  - ${ctx.topVolume.join("\n  - ")}\n` +
        `- 上昇:\n  - ${ctx.gainers.join("\n  - ")}\n` +
        `- 下落:\n  - ${ctx.losers.join("\n  - ")}\n\n` +
        `出力は日本語Markdownで：\n` +
        `### TL;DR\n### 本日のストーリー\n### 30分リプレイ\n### EOD総括\n### 明日のチェック\n### シナリオ（反発継続/もみ合い/反落）\n` +
        `TL;DRに「ブレッドス(${ctx.breadth.adv}:${ctx.breadth.dec})」「集中度(${ctx.concentrationPct}%)」「加重(${ctx.weightedChg}%)」を必ず含める。抽象語禁止。`,
    },
  ];

  try {
    const resp = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL_MD || "gpt-4o-mini",
      temperature: 0.2,
      messages,
    });
    return resp.choices[0]?.message?.content ?? null;
  } catch {
    return null;
  }
}

/** fetch helper with timeout */
async function fetchJsonWithTimeout<T>(url: string, ms = 12000): Promise<T | null> {
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { cache: "no-store", signal: ac.signal as any });
    if (!r.ok) return null;
    return await r.json() as T;
  } catch {
    return null;
  } finally {
    clearTimeout(to);
  }
}

/** handler */
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const date = url.searchParams.get("date");

    const origin = (req as any).nextUrl?.origin ?? `${url.protocol}//${url.host}`;

    // focus=1, fallbackMax=0(폴백 off)로 600개 병렬 취득
    const qs = (start: number, count: number) => {
      const sp = new URLSearchParams();
      sp.set("focus", "1");
      sp.set("fallbackMax", "0");    // ← 폴백 끔 (원하면 20~40으로)
      sp.set("start", String(start));
      sp.set("count", String(count));
      if (date) sp.set("date", date);
      return sp.toString();
    };

    const [p1, p2] = await Promise.allSettled([
      fetchJsonWithTimeout<EodJson>(`${origin}/api/jpx-eod?${qs(0,300)}`, 12000),
      fetchJsonWithTimeout<EodJson>(`${origin}/api/jpx-eod?${qs(300,300)}`, 12000),
    ]);

    const pages: EodJson[] = [];
    if (p1.status === "fulfilled" && p1.value?.ok) pages.push(p1.value);
    if (p2.status === "fulfilled" && p2.value?.ok) pages.push(p2.value);

    if (pages.length === 0) {
      const md =
        `# 日本株 夜間警備員 日誌 | ${date ?? "N/A"}\n\n` +
        `> データ取得に失敗しました（無料ソースの一時ブロック/ネットワーク）。数分後に再試行してください。\n`;
      return new Response(md, {
        status: 200,
        headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "no-store" },
      });
    }

    // merge by code
    const byCode = new Map<string, Row>();
    for (const p of pages) for (const r of (p.quotes || [])) if (!byCode.has(r.code)) byCode.set(r.code, r);
    const allRows = Array.from(byCode.values());

    // header info
    const first = pages[0];
    const dateStr = first.date ?? (date ?? "");
    const source = (first.source ? first.source + "+YahooChart" : "YahooBatch+YahooChart")
      + (process.env.TWELVEDATA_API_KEY ? "+TwelveData" : "");
    const universeCount = allRows.length; // 300~600 (타임아웃 시 300만 들어올 수도)

    // cards
    const CARD_CODES = new Set(["1321","1306","7203","6758","8035","6861","6501","4063","9432","6954","8306","8316","9984","9983","7974","9433","9434"]);
    const cards = allRows.filter(r => CARD_CODES.has(r.code));

    // rankings
    const rankings = buildRankings(allRows);

    // header
    const header =
      `# 日本株 夜間警備員 日誌 | ${dateStr}\n\n` +
      `> ソース: ${source} / ユニバース: ${universeCount}銘柄\n` +
      `> 集計対象: 売買代金 **上位600銘柄** のみ（事前集計CSV）。\n` +
      (universeCount < 600 ? `> ※ 一部ページがタイムアウトのため先頭${universeCount}銘柄で暫定集計。\n` : "") +
      `> 注記: JST **15:35**以前のアクセスは前営業日に自動回帰。無料ソース特性上、厳密なEODと微差が出る場合があります。\n` +
      `> ※ ランキングは**前日比(終値/前日終値)**を優先、表の o→c は日中の値動きです。\n\n`;

    // narrative (LLM → fallback)
    const llm = await llmNarrative({ date: dateStr, quotes: allRows, rankings });
    const narrative = llm ?? narrativeBlock(dateStr, rankings, allRows);

    // tables
    const md =
      header +
      narrative + "\n---\n" +
      `## カード（主要ETF・大型）\n${cardsBlock(cards)}\n---\n` +
      "## 📊 データ(Top10)\n" +
      "### Top 10 — 売買代金（百万円換算）\n" + tableByValue(rankings.byValue) + "\n" +
      "### Top 10 — 出来高（株数）\n" + tableByVolume(rankings.byVolume) + "\n" +
      "### Top 10 — 上昇株（¥1,000+）\n" + tableGainers(rankings.topGainers) + "\n" +
      "### Top 10 — 下落株（¥1,000+）\n" + tableLosers(rankings.topLosers) + "\n" +
      "\n#日本株 #日経平均 #TOPIX #半導体 #AI #出来高 #売買代金 #大型株\n";

    return new Response(md, {
      status: 200,
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        // Vercel CDN 캐시 (3분), 백그라운드 재검증
        "Cache-Control": "s-maxage=180, stale-while-revalidate=86400",
      },
    });
  } catch (err: any) {
    const md = `# 日本株 夜間警備員 日誌 | N/A\n\n> 予期せぬエラー: ${err?.message ?? "unknown"}\n`;
    return new Response(md, {
      status: 200,
      headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
}
