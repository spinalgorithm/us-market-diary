/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ===== 설정 =====
const JST_OFFSET_MIN = 9 * 60;

type JPItem = { sym: string; name: string; theme: string; brief: string };
const JP_LIST: JPItem[] = [
  { sym: '1321.T', name: '日経225連動型上場投資信託', theme: 'インデックス/ETF', brief: '日経225連動ETF' },
  { sym: '1306.T', name: 'TOPIX連動型上場投資信託', theme: 'インデックス/ETF', brief: 'TOPIX連動ETF' },
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

// ===== 유틸 =====
const toJst = (d: Date) => new Date(d.getTime() + (JST_OFFSET_MIN - d.getTimezoneOffset()) * 60000);
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const prevBiz = (d: Date) => { const x=new Date(d); do { x.setDate(x.getDate()-1); } while (x.getDay()===0||x.getDay()===6); return x; };

type Quote = { symbol: string; open?: number; close?: number; volume?: number; currency?: string };

const num = (v: any) => (Number.isFinite(Number(v)) ? Number(v) : undefined);
const isNum = (v: any) => Number.isFinite(Number(v));

async function fetchYahooQuoteBatch(symbols: string[]): Promise<Record<string, Quote>> {
  if (!symbols.length) return {};
  const url = 'https://query1.finance.yahoo.com/v7/finance/quote?symbols=' + encodeURIComponent(symbols.join(','));
  const r = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Accept': 'application/json,text/plain,*/*',
      'Accept-Language': 'ja,en;q=0.9',
    },
    cache: 'no-store',
  });
  if (!r.ok) throw new Error(`quote ${r.status}`);
  const j = await r.json();
  const arr: any[] = j?.quoteResponse?.result ?? [];
  const out: Record<string, Quote> = {};
  for (const o of arr) {
    out[o.symbol] = {
      symbol: o.symbol,
      open: num(o.regularMarketOpen),
      close: num(o.regularMarketPrice ?? o.regularMarketPreviousClose),
      volume: num(o.regularMarketVolume),
      currency: o.currency,
    };
  }
  return out;
}

async function fetchYahooChartLast(sym: string): Promise<Quote | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=5d&interval=1d`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, cache: 'no-store' });
  if (!r.ok) return null;
  const j = await r.json();
  const res = j?.chart?.result?.[0];
  if (!res) return null;
  const q = res?.indicators?.quote?.[0] || {};
  const opens: number[] = q.open || [];
  const closes: number[] = q.close || [];
  const vols: number[] = q.volume || [];
  let i = Math.min(closes.length, opens.length, vols.length) - 1;
  while (i >= 0 && (!isNum(opens[i]) || !isNum(closes[i]) || !isNum(vols[i]))) i--;
  if (i < 0) return null;
  return { symbol: sym, open: opens[i], close: closes[i], volume: vols[i], currency: res?.meta?.currency || 'JPY' };
}

type Row = {
  rank?: number;
  ticker: string;
  name: string;
  theme: string;
  brief: string;
  o2c: string;
  chgPct: string;
  vol: string;
  jpyVolM: string;
};

function toRow(meta: JPItem, q?: Quote | null): Row | null {
  if (!q || !isNum(q.open) || !isNum(q.close) || !isNum(q.volume)) return null;
  const o = Number(q.open);
  const c = Number(q.close);
  const v = Number(q.volume);
  const chg = o > 0 ? ((c - o) / o) * 100 : 0;
  const turnoverM = c * v / 1_000_000; // 엔화(가정) 백만단위
  return {
    ticker: meta.sym.replace('.T',''),
    name: meta.name,
    theme: meta.theme,
    brief: meta.brief,
    o2c: `${o.toFixed(2)}→${c.toFixed(2)}`,
    chgPct: chg.toFixed(2),
    vol: v.toLocaleString('en-US'),
    jpyVolM: Math.round(turnoverM).toLocaleString('en-US'),
  };
}

function topBy(rows: Row[], selector: (r: Row)=>number, n=10) {
  return rows.slice().sort((a,b)=>selector(b)-selector(a)).slice(0,n).map((r,i)=>({...r,rank:i+1}));
}
function asNumber(s: string){ return Number(String(s).replace(/,/g,'')) || 0; }
function priceC(row: Row){ const c = row.o2c.split('→')[1]; return Number(c)||0; }
function gainers(rows: Row[], n=10){ return topBy(rows.filter(r=>priceC(r)>=1000), r=>Number(r.chgPct), n).filter(r=>Number(r.chgPct)>0); }
function losers(rows: Row[], n=10){ return topBy(rows.filter(r=>priceC(r)>=1000), r=>-Number(r.chgPct), n).filter(r=>Number(r.chgPct)<0); }

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const date = url.searchParams.get('date');
    const nowJst = toJst(new Date());
    let target = date ? new Date(date+'T00:00:00+09:00') : nowJst;
    const cutoff = new Date(`${ymd(nowJst)}T15:10:00+09:00`);
    if (!date && nowJst < cutoff) target = prevBiz(nowJst);

    let map: Record<string, Quote> | null = null;
    try { map = await fetchYahooQuoteBatch(JP_LIST.map(x=>x.sym)); } catch { map = null; }

    const rows: Row[] = [];
    for (const meta of JP_LIST) {
      let q: Quote | null | undefined = map ? map[meta.sym] : null;
      if (!q || !isNum(q.open) || !isNum(q.close) || !isNum(q.volume)) {
        q = await fetchYahooChartLast(meta.sym);
      }
      const row = toRow(meta, q);
      if (row) rows.push(row);
    }

    if (!rows.length) {
      return Response.json({ ok:false, error:'JPX data not available from Yahoo (quote/chart both failed).' }, { status: 502 });
    }

    const turnoverTop = topBy(rows, r => asNumber(r.jpyVolM));
    const volumeTop   = topBy(rows, r => asNumber(r.vol));
    const ups         = gainers(rows);
    const downs       = losers(rows);

    return Response.json({
      ok: true,
      dateJst: ymd(target),
      source: 'Yahoo Finance (quote → fallback chart)',
      universe: JP_LIST.length,
      notice: 'JST 15:10以前のアクセスは前営業日に自動回帰。無料ソース特性上、厳密なEODと微差が出る場合があります。',
      cards: rows.slice(0, 12),
      tables: { turnover: turnoverTop, volume: volumeTop, gainers: ups, losers: downs }
    });
  } catch (e: any) {
    return Response.json({ ok:false, error: String(e?.message || e) }, { status: 500 });
  }
}
