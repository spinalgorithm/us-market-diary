// src/app/api/jpx-eod-md/route.ts
import { NextRequest } from "next/server";
import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

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
  page?: { start: number; count: number; returned: number };
};

/** ─────────────────────────────
 * 유틸 (숫자/포맷)
 * ───────────────────────────── */
const N = (x: any) => (Number.isFinite(Number(x)) ? Number(x) : undefined);
const n0 = (x: any) => (Number.isFinite(Number(x)) ? Number(x) : 0);

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
 * 표(테이블) 빌더 — Name/Theme 포함
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
 * 랭킹 재계산 (600개 합산 기준)
 * ───────────────────────────── */
function buildRankings(rows: Row[]): Rankings {
  // yenVolM 누락은 price*vol 로 보정
  const withY = rows.map((r) => {
    const price = n0(r.close ?? r.previousClose ?? r.open ?? 0);
    const vol = n0(r.volume ?? 0);
    const y = Number.isFinite(Number(r.yenVolM)) && r.yenVolM != null ? Number(r.yenVolM) : (price * vol) / 1e6;
    return { ...r, _price: price, _yenVolM: y };
  });

  const byValue = [...withY]
    .filter(r => r._yenVolM > 0)
    .sort((a, b) => (b._yenVolM - a._yenVolM))
    .slice(0, 10)
    .map(({ _price, _yenVolM, ...rest }) => ({ ...rest, yenVolM: _yenVolM }));

  const byVolume = [...withY]
    .filter(r => (r.volume ?? 0) > 0)
    .sort((a, b) => (n0(b.volume) - n0(a.volume)))
    .slice(0, 10)
    .map(({ _price, _yenVolM, ...rest }) => ({ ...rest, yenVolM: _yenVolM }));

  const priceOf = (r: any) => (r.close ?? r.previousClose ?? r.open ?? 0);
  const elig = withY.filter(r => priceOf(r) >= 1000 && r.chgPctPrev != null);

  const topGainers = [...elig]
    .filter(r => (r.chgPctPrev as number) > 0)
    .sort((a, b) => (n0(b.chgPctPrev) - n0(a.chgPctPrev)))
    .slice(0, 10)
    .map(({ _price, _yenVolM, ...rest }) => ({ ...rest, yenVolM: _yenVolM }));

  const topLosers = [...elig]
    .filter(r => (r.chgPctPrev as number) < 0)
    .sort((a, b) => (n0(a.chgPctPrev) - n0(b.chgPctPrev)))
    .slice(0, 10)
    .map(({ _price, _yenVolM, ...rest }) => ({ ...rest, yenVolM: _yenVolM }));

  return { byValue, byVolume, topGainers, topLosers };
}

/** ─────────────────────────────
 * 규칙 기반 간단 나레이티브 (LLM 실패시 fallback)
 * ───────────────────────────── */
function narrativeBlock(date: string, rnk: Rankings | undefined, quotes: Row[] | undefined): string {
  const r = rnk;
  const byVal = r?.byValue ?? [];
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

/** ─────────────────────────────
 * LLM 서술 보강 (600개 풀셋 통계 기반)
 * OPENAI_API_KEY 필요, OPENAI_MODEL_MD 지정 가능(없으면 gpt-4o)
 * ───────────────────────────── */
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "-");
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "-");

function makeContext(date: string, rows: Row[], rnk: Rankings) {
  const withP = rows.map(r => {
    const price = n0(r.close ?? r.previousClose ?? r.open ?? 0);
    const vol = n0(r.volume ?? 0);
    const yv = Number.isFinite(n0(r.yenVolM)) && n0(r.yenVolM) > 0 ? n0(r.yenVolM) : (price * vol) / 1e6;
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

  const norm = (s: string) => (s && s !== "-" ? s : "その他");
  const themeMap = new Map<
    string,
    { yv: number; adv: number; dec: number; items: { code: string; name: string; chg: number; yv: number }[] }
  >();
  for (const r of valid) {
    const t = norm(r.theme);
    const g = themeMap.get(t) ?? { yv: 0, adv: 0, dec: 0, items: [] };
    g.yv += r._yv;
    if (r._chg > 0) g.adv++; else if (r._chg < 0) g.dec++;
    g.items.push({ code: r.code, name: r.name, chg: r._chg, yv: r._yv });
    themeMap.set(t, g);
  }
  const themesSorted = [...themeMap.entries()]
    .sort((a, b) => b[1].yv - a[1].yv)
    .slice(0, 8)
    .map(([t, v]) => `${t} ${f1(v.yv)}M (↑${v.adv}/↓${v.dec})`);

  const up2 = valid.filter(r => r._chg >= 2).length;
  const up3 = valid.filter(r => r._chg >= 3).length;
  const dn2 = valid.filter(r => r._chg <= -2).length;
  const dn3 = valid.filter(r => r._chg <= -3).length;

  const topValueList = byVal.slice(0, 10).map(r =>
    `${r.code} ${r.name} (${r.theme || "-"}) Chg:${f2(r._chg)} YV:${f1(r._yv)}M`
  );
  const topVolumeList = (rnk.byVolume ?? []).slice(0, 10).map(r =>
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
    concentrationPct: Number.isFinite(top10Pct) ? f1(top10Pct) : "-",
    themesTop: themesSorted,
    buckets: { up2, up3, dn2, dn3 },
    weightedChg: f2(wchg),
    topValue: topValueList,
    topVolume: topVolumeList,
    gainers,
    losers,
  };
}

async function llmNarrative(eod: { date?: string; quotes?: Row[]; rankings?: Rankings; }): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const client = new OpenAI({ apiKey });
  const rows = Array.isArray(eod.quotes) ? eod.quotes : [];
  const rnk = eod.rankings ?? { byValue: [], byVolume: [], topGainers: [], topLosers: [] };
  const ctx = makeContext(eod.date || "", rows, rnk);

  const messages: ChatCompletionMessageParam[] = [
    {
      role: "system",
      content:
        "あなたは日本株の市況コメント記者。与えられた統計値を必ず引用し、抽象語の多用は禁止。事実→解釈→示唆を短く鋭く。Markdown章立て固定。",
    },
    {
      role: "user",
      content:
        `対象は「売買代金上位600銘柄」。以下の数字を本文に埋め込むこと。\n` +
        `- 日付: ${ctx.date}\n` +
        `- ブレッドス(上昇/下落/総数): ${ctx.breadth.adv}/${ctx.breadth.dec}/${ctx.breadth.total}\n` +
        `- Top10集中度(売買代金): ${ctx.concentrationPct}%\n` +
        `- 値幅バケット: +3%以上=${ctx.buckets.up3}, +2%以上=${ctx.buckets.up2}, -2%以下=${ctx.buckets.dn2}, -3%以下=${ctx.buckets.dn3}\n` +
        `- 売買代金加重 前日比: ${ctx.weightedChg}%\n` +
        `- 上位テーマ: ${ctx.themesTop.join(" / ")}\n` +
        `- 売買代金上位(Top10):\n  - ${ctx.topValue.join("\n  - ")}\n` +
        `- 出来高上位(Top10):\n  - ${ctx.topVolume.join("\n  - ")}\n` +
        `- 上昇(Top10):\n  - ${ctx.gainers.join("\n  - ")}\n` +
        `- 下落(Top10):\n  - ${ctx.losers.join("\n  - ")}\n\n` +
        `出力は日本語Markdownで以下の章立てのみ：\n` +
        `### TL;DR\n### 本日のストーリー\n### 30分リプレイ\n### EOD総括\n### 明日のチェック\n### シナリオ（反発継続/もみ合い/反落）\n\n` +
        `ルール：TL;DRに「ブレッドス(${ctx.breadth.adv}:${ctx.breadth.dec})」「集中度(${ctx.concentrationPct}%)」「加重前日比(${ctx.weightedChg}%)」を必ず入れる。テーマは上位の値動きとAdv/Decの偏りから“流入/逆風/中立”を判定し具体銘柄(コード)を2〜3個添える。曖昧語禁止。`,
    },
  ];

  try {
    const resp = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL_MD || "gpt-4o",
      temperature: 0.2,
      messages,
    });
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

    // /api/jpx-eod 페이지 가져오기 (focus=1, 두 페이지로 600개 집계)
    async function fetchPage(start: number, count: number): Promise<EodJson | null> {
      const qs = new URLSearchParams();
      qs.set("focus", "1");
      qs.set("start", String(start));
      qs.set("count", String(count));
      if (date) qs.set("date", date);
      const resp = await fetch(`${origin}/api/jpx-eod?${qs.toString()}`, { cache: "no-store" });
      try { return (await resp.json()) as EodJson; } catch { return null; }
    }

    const pages: EodJson[] = [];
    const p1 = await fetchPage(0, 300);
    if (p1?.ok) pages.push(p1);
    const p2 = await fetchPage(300, 300);
    if (p2?.ok) pages.push(p2);

    if (pages.length === 0) {
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
    const source = (first.source ? first.source + "+YahooChart" : "YahooBatch+YahooChart") + (process.env.TWELVEDATA_API_KEY ? "+TwelveData" : "");
    const universeCount = 600; // focus=1 집계 의도 명시

    // 카드(대표 코드 추출)
    const CARD_CODES = new Set([
      "1321","1306","7203","6758","8035","6861","6501","4063","9432",
      "6954","8306","8316","9984","9983","7974","9433","9434"
    ]);
    const cards = allRows.filter(r => CARD_CODES.has(r.code));

    // 랭킹 재계산(600개 전체 기준)
    const rankings = buildRankings(allRows);

    // 헤더/주석
    const header =
      `# 日本株 夜間警備員 日誌 | ${dateStr}\n\n` +
      `> ソース: ${source} / ユニバース: ${universeCount}銘柄\n` +
      `> 集計対象: 売買代金 **上位600銘柄** のみ（事前集計CSV）。\n` +
      `> 注記: JST **15:35**以前のアクセスは前営業日に自動回帰。無料ソース特性上、厳密なEODと微差が出る場合があります。\n` +
      `> ※ ランキングは**前日比(終値/前日終値)**を優先、表の o→c は日中の値動きです。\n\n`;

    // LLM 서술 (실패 시 규칙기반)
    const llm = await llmNarrative({ date: dateStr, quotes: allRows, rankings });
    const narrative = llm ?? narrativeBlock(dateStr, rankings, allRows);

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
