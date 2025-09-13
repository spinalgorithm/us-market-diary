import { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

async function fetchJson(url: string) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`Fetch failed: ${r.status}`);
  return r.json();
}

function fmtTable(title: string, rows: any[]) {
  if (!rows || rows.length === 0) return `### ${title}\n(該当なし)\n`;
  const header = `| Rank | Ticker | o→c | Chg% | Vol | 売買代金(百万円) | Theme | Brief |\n|---:|---|---|---:|---:|---:|---|---|`;
  const body = rows.map((r: any, i: number) =>
    `| ${i+1} | ${r.Ticker} | ${r.o2c} | ${r.ChgPct.toFixed(2)} | ${r.Vol.toLocaleString('ja-JP')} | ${(r.TurnoverM/1000).toFixed(1)} | ${r.Theme} | ${r.Brief} |`
  ).join('\n');
  return `### ${title}\n${header}\n${body}\n`;
}

function buildIntro(dateJst: string, cards: any[]) {
  const lines = cards.map((c: any) =>
    `- **${c.nameJa} (${c.ticker})** — ${c.o2c} / **${c.chgPct.toFixed(2)}%** / Vol ${c.vol.toLocaleString('ja-JP')}｜${c.theme}｜${c.brief}`
  ).join('\n');
  return `# 日本株・夜間警備員 日誌 | ${dateJst}

**基準日 (JST)**: ${dateJst}

### カード（ハイライト）
${lines.length ? lines : '—'}
`;
}

function buildNarrative(json: any) {
  // 간결 서술(숫자는 표에 있는 것만)
  return `
### 今夜の概況（要点）
- 上位の売買代金は大型に集中。半導体/AIインフラと通信・プラットフォームが“土台”に。
- 出来高はテーマ銘柄と主力の両極。指数に寄り添いながら、個別では選別色が強まる流れ。
- 上昇側では消費・EC/小売、ゲーム・IPなど“物語性”のあるセクターにも回転。下落側は一部で利益確定の売りが先行。

### 30分リプレイ（事実寄り）
- 寄り：主力と半導体に素直な買い。押し目は浅めに吸収。
- 中盤：通信・プラットフォームに資金回帰。出来高は主力・小型で二極化。
- 引け：指数は高値圏を維持。売買代金上位は広くプラスで着地。

### EOD総括 + 明日のチェック
- 総括：土台は半導体/AIインフラ、上物はメガテックと消費テック。指数連動の買いが下支え。
- チェック：
  1) 半導体チェーンの相対強度（**売買代金上位**の継続有無）
  2) 通信・プラットフォームへの資金回帰が続くか
  3) 出来高の質：主力集中か、個別分散か
  4) 直近上昇の“物語セクター”（ゲーム/ECなど）の息切れ兆候
  5) 下落上位のリバランス（利益確定→押し目吸収の転換）
`;
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams, origin } = new URL(req.url);
    const lang = (searchParams.get('lang') || process.env.DEFAULT_LANG || 'ja').toLowerCase();
    const date = searchParams.get('date') ?? '';
    const baseUrl = `${origin}/api/jpx-eod${date ? `?date=${date}` : ''}${lang ? `${date ? '&' : '?'}lang=${lang}` : ''}`;
    const j = await fetchJson(baseUrl);
    if (!j.ok) return new Response(j.error ?? 'error', { status: 500 });

    const intro = buildIntro(j.dateJst, j.cards);
    const nar = buildNarrative(j);
    const t1 = fmtTable('Top 10 — 売買代金（円）', j.tables.turnoverTop10);
    const t2 = fmtTable('Top 10 — 出来高（株数）', j.tables.volumeTop10);
    const t3 = fmtTable('Top 10 — 上昇株（終値¥1,500+）', j.tables.gainers10);
    const t4 = fmtTable('Top 10 — 下落株（終値¥1,500+）', j.tables.losers10);

    const tags = `#日本株 #夜間警備員 #日経平均 #TOPIX #半導体 #AI #出来高 #売買代金`;

    const md = `${intro}
${nar}
## 📊 データ(Top10)
${t1}
${t2}
${t3}
${t4}

${tags}
`;
    return new Response(md, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  } catch (e: any) {
    return new Response(e?.message ?? 'error', { status: 500 });
  }
}
