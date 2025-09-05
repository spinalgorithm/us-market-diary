// app/api/eod-deep/route.ts
import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';

export const dynamic = 'force-dynamic';

type Row = {
  ticker: string;
  open?: number;
  close?: number;
  chgPct?: number;
  volume?: number;
};

type BaseEod = {
  ok: boolean;
  dateEt: string;                      // 'YYYY-MM-DD'
  // 아래 세 개 배열은 당신의 /api/eod가 제공하는 키에 맞춰 사용
  mostActive?: Row[];                  // 거래량 상위 (가능하면 30개)
  topGainers?: Row[];                  // 급등 상위 (가능하면 30개)
  topLosers?: Row[];                   // 급락 상위 (가능하면 30개)
  // 과거 버전 호환: markdown만 있고 배열이 없을 수 있어 LLM 추출 fallback을 둠
  markdown?: string;
};

const ETF_SET = new Set([
  'SPY','QQQ','DIA','IWM','VTI','VOO','VT','SMH','SOXL','SOXS','SQQQ','TQQQ','TSLL','UVXY','SVXY','ARKK','XLF','XLE','XLK','XLY','XLI','XLV','XLP','XLRE','XLB','XLU'
]);

const LEV_INV_SET = new Set([
  'SQQQ','TQQQ','SOXL','SOXS','TSLL','UVXY','SVXY','SPXL','SPXS','SDOW','UPRO','SDS','TNA','TZA'
]);

function isEtf(t: string) {
  return ETF_SET.has(t.toUpperCase());
}
function isLevInv(t: string) {
  return LEV_INV_SET.has(t.toUpperCase());
}

// 통화/숫자 포맷
const fmt = (n: number | undefined) =>
  (typeof n === 'number' && isFinite(n)) ? n.toLocaleString('en-US') : '-';

const toMillions = (v: number) => Math.round((v / 1_000_000) * 10) / 10;

// 달러거래대금 $Vol(M) = close * volume
const dollarVol = (r: Row) =>
  (r.close && r.volume) ? (r.close * r.volume) : 0;

// $10 이상 필터
const is10up = (r: Row) => (r.close ?? 0) >= 10;

// 테마 라벨
function themeOf(t: string): string {
  if (isLevInv(t)) return 'インバース/レバレッジETF';
  if (isEtf(t)) return 'インデックス/ETF';
  const U = t.toUpperCase();
  if (['NVDA','AVGO','AMD','TSM','ASML','INTC','MU','QCOM','SMCI'].includes(U)) return 'AI/半導体';
  if (['TSLA','RIVN','LCID','NIO','LI','XPEV','FSRN','CHPT'].includes(U)) return 'EV/モビリティ';
  if (['AMZN','NEGG','MELI','SHOP'].includes(U)) return 'Eコマース';
  if (['AAPL','MSFT','GOOGL','META','NFLX'].includes(U)) return 'メガテック';
  return 'その他/テーマ不明';
}

function asTable(
  title: string,
  rows: Row[],
  withDollarVol = false,
  addTheme = true
) {
  const header = withDollarVol
    ? `| Rank | Ticker | o→c | Chg% | Vol | $Vol(M) | Themes |\n|---:|---|---|---:|---:|---:|---|`
    : `| Rank | Ticker | o→c | Chg% | Vol | Themes |\n|---:|---|---|---:|---:|---|`;
  const body = rows.slice(0, 10).map((r, i) => {
    const oc = `${fmt(r.open)}→${fmt(r.close)}`;
    const ch = (typeof r.chgPct === 'number') ? r.chgPct.toFixed(2) : '-';
    const vol = fmt(r.volume);
    const th = addTheme ? themeOf(r.ticker) : '';
    if (withDollarVol) {
      const dv = toMillions(dollarVol(r));
      return `| ${i+1} | ${r.ticker} | ${oc} | ${ch} | ${vol} | ${fmt(dv)} | ${th} |`;
    }
    return `| ${i+1} | ${r.ticker} | ${oc} | ${ch} | ${vol} | ${th} |`;
  }).join('\n');

  return `#### ${title}\n${header}\n${body}\n`;
}

function sortByDollarVol(rows: Row[]) {
  return [...rows].sort((a,b) => dollarVol(b) - dollarVol(a));
}
function sortByVolume(rows: Row[]) {
  return [...rows].sort((a,b) => (b.volume ?? 0) - (a.volume ?? 0));
}

function pickTopDollarVol(all: Row[]) {
  const uniq = new Map<string, Row>();
  for (const r of all) {
    if (!uniq.has(r.ticker)) uniq.set(r.ticker, r);
  }
  const arr = Array.from(uniq.values());
  return sortByDollarVol(arr).slice(0, 10);
}

function clampRows(rows: Row[] = []) {
  // 안전: 숫자 아닌 값 방지
  return rows.map(r => ({
    ticker: (r.ticker ?? '').toUpperCase(),
    open: Number(r.open ?? NaN),
    close: Number(r.close ?? NaN),
    chgPct: Number(r.chgPct ?? NaN),
    volume: Number(r.volume ?? NaN),
  }));
}

function langPick(lang: string | null | undefined) {
  const L = (lang ?? process.env.OUTPUT_LANG ?? 'ja').toLowerCase();
  if (L.startsWith('ko')) return 'ko';
  if (L.startsWith('en')) return 'en';
  return 'ja';
}

function brandByLang(lang: 'ja'|'ko'|'en') {
  if (lang === 'ja') return process.env.BRAND_JA || '米国 夜間警備員 日誌';
  if (lang === 'ko') return process.env.BRAND_KO || '미국 야간경비원 일지';
  return 'US Night Watch — Market Log';
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const origin = url.origin;

  const lang = langPick(url.searchParams.get('lang'));
  const date = url.searchParams.get('date') || '';       // YYYY-MM-DD (ET)
  const model = url.searchParams.get('model') || process.env.OPENAI_MODEL || 'gpt-5-mini';

  const allowInference = (url.searchParams.get('allowInference') ?? process.env.ALLOW_INFERENCE ?? 'true') === 'true';
  const commentaryLevel = parseInt(url.searchParams.get('commentary') ?? process.env.COMMENTARY_LEVEL ?? '2', 10);
  const sections = (url.searchParams.get('sections') ?? process.env.NARRATIVE_SECTIONS ?? 'tldr,cards,flow,replay,eod,checklist,tables')
    .split(',').map(s => s.trim()).filter(Boolean);

  // 1) 원자료 가져오기 (당신의 /api/eod가 이미 작동 중)
  const eodRes = await fetch(`${origin}/api/eod${date ? `?date=${date}` : ''}`, { cache: 'no-store' });
  const base: BaseEod = await eodRes.json().catch(() => ({ ok: false } as any));
  if (!base?.ok) {
    return NextResponse.json({ ok: false, error: 'EOD source not ok' }, { status: 500 });
  }

  const dateEt = base.dateEt;

  // 2) 배열 정돈(기존 /api/eod가 주는 키 이름에 맞춰 연결)
  const mostActive = clampRows(base.mostActive || []);
  const topGainers = clampRows(base.topGainers || []);
  const topLosers  = clampRows(base.topLosers  || []);

  // 3) 표 구성 데이터
  const topByDollar = pickTopDollarVol([...mostActive, ...topGainers, ...topLosers]);
  const topByVolume = sortByVolume(mostActive).slice(0, 10);
  const topGainers10 = topGainers.filter(is10up).slice(0, 50).sort((a,b)=> (b.chgPct??0)-(a.chgPct??0)).slice(0,10);
  const topLosers10  = topLosers.filter(is10up).slice(0, 50).sort((a,b)=> (a.chgPct??0)-(b.chgPct??0)).slice(0,10);

  // 4) 마크다운 표 (서버에서 확정 → LLM은 ‘표 밖 숫자 금지’)
  const tableDollar = asTable('Top 10 — 取引代金（ドル）', topByDollar, true, true);
  const tableVolume = asTable('Top 10 — 出来高（株数）', topByVolume, true, true);
  const tableGUp10  = asTable('Top 10 — 上昇株（$10+）', topGainers10, true, true);
  const tableGDown10= asTable('Top 10 — 下落株（$10+）', topLosers10, true, true);

  // 5) LLM 프롬프트
  const brand = brandByLang(lang);

  const sys = [
    `You are a financial analyst writing a daily market log in ${lang}.`,
    `Persona: "夜間警備員(야간경비원)" — 차분하고 관찰 일지 톤, 과장·예측 금지.`,
    `Strict numeric rule: Only use numbers that already appear in the supplied tables (o→c / Chg% / Vol / $Vol(M)).`,
    `Never invent target prices, forward-looking percentages, or un-sourced numerical claims.`,
    `If drawing inferences, mark them with a label: 「仮説: ...」(ja) / 「가설: ...」(ko) / "Hypothesis:" (en).`,
    allowInference ? `Inference allowed at "commentary level ${commentaryLevel}"` : `Inference disabled — facts only.`,
    `Keep paragraphs compact for mobile.`
  ].join('\n');

  const metaBlock = [
    `Brand: ${brand}`,
    `基準日(ET): ${dateEt}`,
    `言語: ${lang}`,
    `Sections: ${sections.join(', ')}`,
    `Commentary Level: ${commentaryLevel}`,
  ].join('\n');

  // 표를 LLM에 그대로 주되, "표 밖 숫자 금지"를 반복
  const tablesForPrompt = [
    tableDollar, tableVolume, tableGUp10, tableGDown10
  ].join('\n\n');

  const outlineJA = {
    tldr: 'TL;DR（3行）で今夜の要点を簡潔に。',
    cards: 'メガテック/ETF/テーマ代表 5〜7枚、各2行。数値は表のもののみ可。',
    flow: '資金フロー俯瞰（5点）。どこから→どこへ、ETFやインバースの動き。',
    replay: '30分リプレイ（事実ベース 4〜5行）。',
    eod: 'EOD総括（短文）。',
    checklist: '明日のチェックリスト（3〜5点）。',
    tables: '下の表はそのまま掲載。'
  };

  const outlineKO = {
    tldr: 'TL;DR(3줄) 요약.',
    cards: '메가캡/ETF/대표테마 5~7카드, 각 2줄. 수치는 표 내 수치만.',
    flow: '자금흐름(5포인트). ETF/인버스 흐름 포함.',
    replay: '30분 리플레이(사실 나열 4~5줄).',
    eod: 'EOD 총평(짧게).',
    checklist: '내일 체크리스트(3~5개).',
    tables: '아래 표 그대로.'
  };

  const outlineEN = {
    tldr: 'TL;DR in 3 lines.',
    cards: '5–7 cards (mega-cap/ETFs/theme leaders), 2 lines each. Use only table numbers.',
    flow: 'Money-flow overview (5 points).',
    replay: '30-min replay (factual, 4–5 lines).',
    eod: 'EOD wrap (short).',
    checklist: 'Checklist for tomorrow (3–5).',
    tables: 'Republish the tables as-is.'
  };

  const outline = lang === 'ja' ? outlineJA : lang === 'ko' ? outlineKO : outlineEN;

  const userPrompt =
`${metaBlock}

【出力方針】
- 数値は必ず下の表の o→c / Chg% / Vol / $Vol(M)に含まれるものだけを使用。
- それ以外の数値、目標価格、将来予測は一切禁止。
- 文章での評価はOKだが、推測は必ず「仮説:/가설:/Hypothesis:」ラベルを付ける。
- ${allowInference ? `解説は COMMENTARY_LEVEL=${commentaryLevel} に合わせて。` : '解説は最小限（事実のみ）。'}

【セクション指示】
- ${sections.includes('tldr') ? outline.tldr : ''}
- ${sections.includes('cards') ? outline.cards : ''}
- ${sections.includes('flow') ? outline.flow : ''}
- ${sections.includes('replay') ? outline.replay : ''}
- ${sections.includes('eod') ? outline.eod : ''}
- ${sections.includes('checklist') ? outline.checklist : ''}
- ${sections.includes('tables') ? outline.tables : ''}

【表（この中の数値だけを使える）】
${tablesForPrompt}
`;

  // 6) LLM 호출 (모델은 env/쿼리 기반, 온도/토큰 파라미터 미전달)
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
  const completion = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: userPrompt }
    ]
  });

  const body = completion.choices[0]?.message?.content?.trim() || '';

  const titleLine =
    lang === 'ja'
      ? `# ${brand} | ${dateEt}\n`
      : lang === 'ko'
      ? `# ${brand} | ${dateEt}\n`
      : `# ${brand} | ${dateEt}\n`;

  // 최종 마크다운(본문 + 표)
  const markdown =
`${titleLine}
${body}

---
## 📊 データ(Top10)
${tableDollar}

${tableVolume}

${tableGUp10}

${tableGDown10}

#米国株 #夜間警備員 #米株マーケット #ナスダック #S&P500 #セクターローテーション #出来高 #取引代金 #半導体 #AI
`;

  return NextResponse.json({
    ok: true,
    dateEt,
    analyzed: {
      mostActive: mostActive.length,
      gainers: topGainers.length,
      losers: topLosers.length
    },
    markdown
  });
}
