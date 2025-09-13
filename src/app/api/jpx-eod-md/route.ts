/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Row = { rank?: number; ticker: string; o2c: string; chgPct: string; vol: string; jpyVolM?: string; theme: string; brief: string; name?: string };

function tableBlock(title: string, rows: Row[] = [], showTurnover = false): string {
  const head = showTurnover
    ? `| Rank | Ticker | o→c | Chg% | Vol | ¥Vol(M) | Theme | Brief |
|---:|---|---|---:|---:|---:|---|---|`
    : `| Rank | Ticker | o→c | Chg% | Vol | Theme | Brief |
|---:|---|---|---:|---:|---|---|`;
  const body = (rows || []).map(r =>
    showTurnover
      ? `| ${r.rank ?? ''} | ${r.ticker} | ${r.o2c} | ${r.chgPct} | ${r.vol} | ${r.jpyVolM ?? ''} | ${r.theme} | ${r.brief} |`
      : `| ${r.rank ?? ''} | ${r.ticker} | ${r.o2c} | ${r.chgPct} | ${r.vol} | ${r.theme} | ${r.brief} |`
  ).join('\n');
  return [`### ${title}`, head, body || '(該当なし)', ''].join('\n');
}

export async function GET(req: NextRequest) {
  try {
    const u = new URL(req.url);
    const date = u.searchParams.get('date');
    const origin = u.origin.replace(/\/$/,'');
    const apiUrl = `${origin}/api/jpx-eod${date ? `?date=${encodeURIComponent(date)}` : ''}`;

    // 내부 API 호출
    const r = await fetch(apiUrl, { cache: 'no-store' });
    const txt = await r.text();
    let j: any;
    try { j = JSON.parse(txt); } catch {
      const md = `# 日本株 夜間警備員 日誌

> JPX EOD: 上流が非JSONで応答しました  
\`\`\`
${txt.slice(0, 500)}
\`\`\`

しばらくしてからもう一度お試しください。`;
      return new Response(md, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }

    if (!j?.ok) {
      const md = `# 日本株 夜間警備員 日誌 | ${j?.dateJst ?? ''}

> データ取得エラー: ${j?.error || 'unknown'}  
> ソース: ${j?.source || 'Yahoo Finance'}  
> 注記: JST 15:10以前は前営業日に自動回帰します。

— 少し時間を空けて再試行してください —`;
      return new Response(md, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }

    const cards: Row[] = j.cards || [];
    const t = j.tables || {};

    const md = [
      `# 日本株 夜間警備員 日誌 | ${j.dateJst}`,
      `> ソース: ${j.source} / ユニバース: ${j.universe}銘柄`,
      `> 注記: ${j.notice}`,
      '',
      '## カード（主要ETF・大型）',
      (cards.length
        ? cards.map((c:any) => `- ${c.ticker} — ${c.name}\n  - o→c: ${c.o2c} / Chg%: ${c.chgPct} / Vol: ${c.vol}${c.jpyVolM ? ` / ¥Vol(M): ${c.jpyVolM}` : ''} / ${c.theme} — ${c.brief}`).join('\n')
        : '（データを取得できませんでした）'),
      '',
      '---',
      '',
      '## 📊 データ(Top10)',
      tableBlock('Top 10 — 売買代金（百万円換算）', t.turnover, true),
      tableBlock('Top 10 — 出来高（株数）', t.volume, false),
      tableBlock('Top 10 — 上昇株（¥1,000+）', t.gainers, false),
      tableBlock('Top 10 — 下落株（¥1,000+）', t.losers, false),
      '',
      '#日本株 #夜間警備員 #日経平均 #TOPIX #半導体 #AI #出来高 #売買代金'
    ].join('\n');

    return new Response(md, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  } catch (e: any) {
    const md = `# 日本株 夜間警備員 日誌

> 例外エラー: ${String(e?.message || e)}

アプリ側の一時的な問題です。`;
    return new Response(md, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
}
