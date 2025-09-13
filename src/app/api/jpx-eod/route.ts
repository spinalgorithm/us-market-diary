/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

// ====== 設定 ======
const JST_OFFSET = 9 * 60; // minutes
const MIN_ROWS_FOR_TABLE = 6; // 최소 확보 못하면 가능한 만큼만 표 생성

// JPX 대표 티커(야후 포맷, .T)
type JPItem = { sym: string; name: string; theme: string; brief: string };
const JP_LIST: JPItem[] = [
  // ETF
  { sym: '1321.T', name: '日経225連動型上場投資信託', theme: 'インデックス/ETF', brief: '日経225連動ETF' },
  { sym: '1306.T', name: 'TOPIX連動型上場投資信託', theme: 'インデックス/ETF', brief: 'TOPIX連動ETF' },

  // 대형/대표주
  { sym: '7203.T', name: 'トヨタ自動車', theme: '自動車', brief: '世界最大級の自動車メーカー' },
  { sym: '6758.T', name: 'ソニーグループ', theme: 'エレクトロニクス', brief: 'ゲーム・画像センサー・音楽' },
  { sym: '8035.T', name: '東京エレクトロン', theme: '半導体製造装置', brief: '製造装置の大手' },
  { sym: '6861.T', name: 'キーエンス', theme: '計測/FA', brief: 'センサー・FA機器' },
  { sym: '6501.T', name: '日立製作所', theme: '総合電機', brief: '社会インフラ・ITソリューション' },
  { sym: '4063.T', name: '信越化学工業', theme: '素材/化学', brief: '半導体用シリコン等' },
  { sym: '9432.T', name: '日本電信電話(NTT)', theme: '通信', brief: '国内通信大手' },
  { sym: '6954.T', name: 'ファナック', theme: 'FA/ロボット', brief: '産業用ロボット' },
  { sym: '8306.T', name: '三菱UFJフィナンシャルG', theme: '金融', brief: 'メガバンク' },
  { sym: '8316.T', name: '三井住友フィナンシャルG', theme: '金融', brief: 'メガバンク' },
  { sym: '9984.T', name: 'ソフトバンクグループ', theme: '投資/テック', brief: '投資持株・通信' },
  { sym: '5020.T', name: 'ＥＮＥＯＳホールディングス', theme: 'エネルギー', brief: '石油・エネルギー' },
];

// ====== 유틸 ======
const toJst = (d: Date) => new Date(d.getTime() + (JST_OFFSET - d.getTimezoneOffset()) * 60000);

const fmtYmd = (d: Date) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
};

const previousBusinessDayJST = (d: Date) => {
  const x = new Date(d);
  // 하루 전으로 이동 후, 토/일 스킵
  do {
    x.setDate(x.getDate() - 1);
  } while (x.getDay() === 0 || x.getDay() === 6);
  return x;
};

type Quote = {
  symbol: string;
  open?: number;
  price?: number;
  volume?: number;
  currency?: string;
};

// Yahoo Finance quote API (비공식)
async function fetchYahooQuotes(symbols: string[]): Promise<Record<string, Quote>> {
  if (symbols.length === 0) return {};
  const url =
    'https://query1.finance.yahoo.com/v7/finance/quote?symbols=' +
    encodeURIComponent(symbols.join(','));

  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36',
      Accept: 'application/json,text/plain,*/*',
    },
    // 야후는 캐시가 남아있으면 가끔 오래된 값이 돌아올 수 있어요.
    cache: 'no-store',
  });

  if (!res.ok) {
    throw new Error(`Yahoo quote error: ${res.status}`);
  }
  const json = await res.json();
  const results: any[] = json?.quoteResponse?.result || [];

  const out: Record<string, Quote> = {};
  for (const r of results) {
    out[r.symbol] = {
      symbol: r.symbol,
      open: num(r.regularMarketOpen),
      price: num(r.regularMarketPrice ?? r.regularMarketPreviousClose),
      volume: num(r.regularMarketVolume),
      currency: r.currency,
    };
  }
  return out;
}

const num = (v: any): number | undefined => {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

type Row = {
  rank?: number;
  ticker: string;
  name: string;
  theme: string;
  brief: string;
  o2c: string; // "o→c"
  chgPct: string; // "0.85"
  vol: string; // number as string
  jpyVolM?: string; // 거래대금(백만엔)
};

function toRow(j: JPItem, q?: Quote): Row | null {
  if (!q || q.price == null || q.open == null || q.volume == null) return null;
  const o = q.open!;
  const c = q.price!;
  const v = q.volume!;
  const chgPct = o > 0 ? ((c - o) / o) * 100 : 0;
  const jpyVolM = c * v / 1_000_000;

  return {
    ticker: j.sym.replace('.T', ''),
    name: j.name,
    theme: j.theme,
    brief: j.brief,
    o2c: `${o.toFixed(2)}→${c.toFixed(2)}`,
    chgPct: chgPct.toFixed(2),
    vol: v.toLocaleString('en-US'),
    jpyVolM: Math.round(jpyVolM).toLocaleString('en-US'),
  };
}

function topBy<T>(rows: Row[], key: (r: Row) => number, limit = 10): Row[] {
  return rows
    .slice()
    .sort((a, b) => key(b) - key(a))
    .slice(0, limit)
    .map((r, i) => ({ ...r, rank: i + 1 }));
}

function filterByPrice(rows: Row[], minYen = 1000): Row[] {
  // o→c 의 c를 파싱(마지막 값)
  return rows.filter((r) => {
    const cStr = r.o2c.split('→')[1];
    const c = Number(cStr);
    return Number.isFinite(c) && c >= minYen;
  });
}

function gainers(rows: Row[], limit = 10): Row[] {
  const withPrice = filterByPrice(rows);
  return topBy(
    withPrice,
    (r) => Number(r.chgPct),
    limit,
  ).filter((r) => Number(r.chgPct) > 0);
}

function losers(rows: Row[], limit = 10): Row[] {
  const withPrice = filterByPrice(rows);
  return topBy(
    withPrice,
    (r) => -Number(r.chgPct),
    limit,
  ).filter((r) => Number(r.chgPct) < 0);
}

// ====== 핸들러 ======
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const dateParam = searchParams.get('date'); // YYYY-MM-DD (옵션)
    const nowJst = toJst(new Date());

    // 목표 날짜(표시용). 15:10 JST 이전이면 전 영업일로 자동 보정
    let target = dateParam ? new Date(dateParam + 'T00:00:00+09:00') : nowJst;
    const cutoff = new Date(`${fmtYmd(nowJst)}T15:10:00+09:00`);
    if (!dateParam && nowJst < cutoff) {
      target = previousBusinessDayJST(nowJst);
    }

    // 실 데이터는 야후의 "현재/최종"을 사용(야후는 날짜 쿼리를 받지 않음).
    const quotes = await fetchYahooQuotes(JP_LIST.map((x) => x.sym));

    // 표 변환
    const rows: Row[] = [];
    for (const j of JP_LIST) {
      const row = toRow(j, quotes[j.sym]);
      if (row) rows.push(row);
    }

    // 빈 응답이면 에러 처리
    if (rows.length === 0) {
      return Response.json(
        { ok: false, error: 'JPX data not available (Yahoo quote empty).' },
        { status: 502 },
      );
    }

    // 테이블(샘플 유니버스 내에서 TOP 산출)
    const byTurnover = topBy(rows, (r) => Number(r.jpyVolM || '0'));
    const byVolume = topBy(rows, (r) => Number(r.vol.replace(/,/g, '')));
    const ups = gainers(rows);
    const downs = losers(rows);

    return Response.json({
      ok: true,
      dateJst: fmtYmd(target),
      notice:
        '※ 無料ソース(quote)の性質上、当日クローズ後はEODに一致します。マケ休場/早引け時は前営業日に自動回帰。',
      source: 'Yahoo Finance (quote)',
      universe: JP_LIST.length,
      cards: rows.slice(0, 12), // 상단 카드용(대표 12)
      tables: {
        turnover: byTurnover,
        volume: byVolume,
        gainers: ups,
        losers: downs,
      },
    });
  } catch (err: any) {
    return Response.json(
      { ok: false, error: String(err?.message || err) },
      { status: 500 },
    );
  }
}
