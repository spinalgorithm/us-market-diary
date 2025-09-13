import { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

// ===== 유니버스 (필요 시 자유롭게 추가/수정) =====
type JpxSymbol = {
  symbol: string;          // Twelve Data 심볼 (예: '7203.TSE')
  nameJa: string;          // 기업명(일본어)
  brief: string;           // 한 줄 설명
  theme: string;           // 테마(표기 일관)
};
const JPX_UNIVERSE: JpxSymbol[] = [
  { symbol: '7203.TSE', nameJa: 'トヨタ自動車', brief: '自動車・モビリティ(トヨタグループ)', theme: '自動車/モビリティ' },
  { symbol: '6758.TSE', nameJa: 'ソニーグループ', brief: 'エンタメ・半導体イメージセンサー', theme: 'ソフト/AI・半導体' },
  { symbol: '9984.TSE', nameJa: 'ソフトバンクグループ', brief: '投資持株(テック中心)', theme: '投資持株/テック' },
  { symbol: '8035.TSE', nameJa: '東京エレクトロン', brief: '半導体製造装置', theme: '半導体/AIインフラ' },
  { symbol: '9983.TSE', nameJa: 'ファーストリテイリング', brief: 'アパレル(ユニクロ)', theme: '消費/小売' },
  { symbol: '6861.TSE', nameJa: 'キーエンス', brief: 'FAセンサー・計測制御', theme: '産業/自動化' },
  { symbol: '7974.TSE', nameJa: '任天堂', brief: 'ゲーム・IP', theme: 'エンタメ/ゲーム' },
  { symbol: '6594.TSE', nameJa: '日本電産(ニデック)', brief: 'モーター・EV部品', theme: '自動車/モビリティ' },
  { symbol: '6098.TSE', nameJa: 'リクルートHD', brief: '求人・人材プラットフォーム', theme: 'インターネット/プラットフォーム' },
  { symbol: '9433.TSE', nameJa: 'KDDI', brief: '通信(au)', theme: '通信' },
  { symbol: '9432.TSE', nameJa: '日本電信電話(NTT)', brief: '通信基盤', theme: '通信' },
  { symbol: '2914.TSE', nameJa: '日本たばこ産業(JT)', brief: '食品・たばこ', theme: '消費/ディフェンシブ' },
  { symbol: '6501.TSE', nameJa: '日立製作所', brief: '社会インフラ・IT', theme: '産業/IT' },
  { symbol: '6723.TSE', nameJa: 'ルネサスエレクトロニクス', brief: '半導体(車載MCU等)', theme: '半導体/AIインフラ' },
  { symbol: '6857.TSE', nameJa: 'アドバンテスト', brief: '半導体テスター', theme: '半導体/AIインフラ' },
  { symbol: '7270.TSE', nameJa: 'SUBARU', brief: '自動車', theme: '自動車/モビリティ' },
  { symbol: '8058.TSE', nameJa: '三菱商事', brief: '総合商社', theme: '商社/資源' },
  { symbol: '8031.TSE', nameJa: '三井物産', brief: '総合商社', theme: '商社/資源' },
  { symbol: '8001.TSE', nameJa: '伊藤忠商事', brief: '総合商社', theme: '商社/資源' },
  { symbol: '6367.TSE', nameJa: 'ダイキン工業', brief: '空調・環境', theme: '産業/機械' },
  { symbol: '4755.TSE', nameJa: '楽天グループ', brief: 'EC/フィンテック', theme: 'インターネット/フィンテック' },
  { symbol: '9434.TSE', nameJa: 'ソフトバンク(通信)', brief: '通信(MNO)', theme: '通信' },
  { symbol: '7741.TSE', nameJa: 'HOYA', brief: '精密・医療', theme: '医療/精密' },
  { symbol: '8591.TSE', nameJa: 'オリックス', brief: '金融・リース', theme: '金融' },
  { symbol: '4502.TSE', nameJa: '武田薬品工業', brief: '製薬', theme: '医薬' },
  { symbol: '4503.TSE', nameJa: 'アステラス製薬', brief: '製薬', theme: '医薬' },
  { symbol: '8316.TSE', nameJa: '三井住友FG', brief: '銀行', theme: '金融' },
  { symbol: '8411.TSE', nameJa: 'みずほFG', brief: '銀行', theme: '金融' },
  { symbol: '9501.TSE', nameJa: '東京電力HD', brief: '電力', theme: 'エネルギー/公益' },
  { symbol: '4063.TSE', nameJa: '信越化学工業', brief: '半導体材料/化学', theme: '素材/半導体材料' },
  // ... 필요하면 더 추가
];

// ===== 유틸 =====
function toDateStrJst(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function addDays(d: Date, delta: number) {
  const nd = new Date(d);
  nd.setDate(nd.getDate() + delta);
  return nd;
}
function isWeekendJst(d: Date) {
  const wd = d.getDay(); // 0:Sun ... 6:Sat
  return wd === 0 || wd === 6;
}

// Twelve Data batch 호출(최대 30~50개 심볼까지는 한 번에 가능)
// 너무 길면 청크로 나눔
async function fetchDailyForSymbols(dateStr: string, symbols: string[], apiKey: string) {
  const OUT: Record<string, any> = {};
  const chunkSize = 24; // 무료 플랜 안전범위
  for (let i = 0; i < symbols.length; i += chunkSize) {
    const chunk = symbols.slice(i, i + chunkSize);
    const url = new URL('https://api.twelvedata.com/time_series');
    url.searchParams.set('symbol', chunk.join(','));
    url.searchParams.set('interval', '1day');
    url.searchParams.set('start_date', dateStr);
    url.searchParams.set('end_date', dateStr);
    url.searchParams.set('outputsize', '1');
    url.searchParams.set('timezone', 'Asia/Tokyo');
    url.searchParams.set('apikey', apiKey);

    const r = await fetch(url.toString(), { next: { revalidate: 0 }, cache: 'no-store' });
    const j = await r.json();
    // 단일/복수 응답 형식 모두 대응
    if (j && typeof j === 'object') {
      if (j.values && j.meta) {
        // 단일
        const sym = j.meta.symbol;
        OUT[sym] = j;
      } else {
        // 복수(심볼 키)
        for (const k of Object.keys(j)) {
          OUT[k] = j[k];
        }
      }
    }
  }
  return OUT;
}

type Row = {
  symbol: string;
  nameJa: string;
  brief: string;
  theme: string;
  o: number;
  c: number;
  chgPct: number;
  vol: number;
  turnoverJPY: number;
};

function parseRows(dateStr: string, raw: Record<string, any>) : Row[] {
  const rows: Row[] = [];
  for (const s of JPX_UNIVERSE) {
    const v = raw[s.symbol];
    if (!v || !v.values || !Array.isArray(v.values) || v.values.length === 0) continue;
    const rec = v.values[0];
    // Twelve Data volume는 문자열일 수 있음
    const o = Number(rec.open);
    const c = Number(rec.close);
    const vol = Number(rec.volume);
    if (Number.isFinite(o) && Number.isFinite(c) && Number.isFinite(vol)) {
      const chgPct = ((c - o) / o) * 100;
      const turnoverJPY = c * vol;
      rows.push({
        symbol: s.symbol,
        nameJa: s.nameJa,
        brief: s.brief,
        theme: s.theme,
        o, c, chgPct, vol, turnoverJPY,
      });
    }
  }
  return rows;
}

function topN<T>(arr: T[], n = 10, cmp: (a: T, b: T) => number) {
  return [...arr].sort(cmp).slice(0, n);
}

function formatNumber(n: number) {
  return new Intl.NumberFormat('ja-JP').format(n);
}

function asTableItem(r: Row) {
  return {
    Ticker: r.symbol,
    o2c: `${r.o.toFixed(2)}→${r.c.toFixed(2)}`,
    ChgPct: Number(r.chgPct.toFixed(2)),
    Vol: r.vol,
    TurnoverM: Number((r.turnoverJPY / 1_000_000).toFixed(1)),
    Theme: r.theme,
    Brief: r.brief,
    Name: r.nameJa,
  };
}

async function ensureTradingDate(dateStr: string, apiKey: string) {
  // 요청일이 주말이면 자동으로 직전 금요일로
  let d = new Date(`${dateStr}T15:00:00+09:00`);
  if (isWeekendJst(d)) {
    while (isWeekendJst(d)) d = addDays(d, -1);
    return toDateStrJst(d);
  }
  // 데이터가 비었으면 최대 5영업일 후진
  for (let i = 0; i < 5; i++) {
    // probe 하나만 체크(도요타)
    const probe = await fetchDailyForSymbols(toDateStrJst(d), ['7203.TSE'], apiKey);
    const rows = parseRows(toDateStrJst(d), probe);
    if (rows.length > 0) return toDateStrJst(d);
    d = addDays(d, -1);
    if (isWeekendJst(d)) {
      while (isWeekendJst(d)) d = addDays(d, -1);
    }
  }
  return dateStr;
}

export async function GET(req: NextRequest) {
  try {
    const apiKey = process.env.TWELVEDATA_API_KEY!;
    if (!apiKey) return Response.json({ ok: false, error: 'Missing TWELVEDATA_API_KEY' }, { status: 500 });

    const { searchParams, origin } = new URL(req.url);
    const lang = (searchParams.get('lang') || process.env.DEFAULT_LANG || 'ja').toLowerCase();
    const dateParam = searchParams.get('date'); // 'YYYY-MM-DD' (JST)
    const nowJst = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
    const dateStr = dateParam ?? toDateStrJst(nowJst);

    // 유효한 거래일 보정
    const validDate = await ensureTradingDate(dateStr, apiKey);

    // 배치 수집
    const raw = await fetchDailyForSymbols(validDate, JPX_UNIVERSE.map(s => s.symbol), apiKey);
    const rows = parseRows(validDate, raw);
    if (rows.length === 0) {
      return Response.json({ ok: false, error: 'No JPX data rows for date.', dateJst: validDate }, { status: 200 });
    }

    // 랭킹
    const turnoverTop10 = topN(rows, 10, (a, b) => b.turnoverJPY - a.turnoverJPY).map(asTableItem);
    const volumeTop10   = topN(rows, 10, (a, b) => b.vol - a.vol).map(asTableItem);
    // ¥1,500 이상(대충 $10+) 기준
    const bigPrice = rows.filter(r => r.c >= 1500);
    const gainers10 = topN(bigPrice, 10, (a, b) => b.chgPct - a.chgPct).map(asTableItem);
    const losers10  = topN(bigPrice, 10, (a, b) => a.chgPct - b.chgPct).map(asTableItem);

    // 카드용 하이라이트 (상위 몇 개만)
    const cards = turnoverTop10.slice(0, 6).map(t => ({
      ticker: t.Ticker, nameJa: rows.find(r => r.symbol === t.Ticker)?.nameJa ?? t.Ticker,
      chgPct: t.ChgPct, vol: t.Vol, o2c: t.o2c, theme: t.Theme, brief: t.Brief,
    }));

    return Response.json({
      ok: true,
      market: 'JPX',
      dateJst: validDate,
      lang,
      counts: { universe: rows.length },
      tables: { turnoverTop10, volumeTop10, gainers10, losers10 },
      cards,
    });
  } catch (e: any) {
    return Response.json({ ok: false, error: e?.message ?? 'error' }, { status: 500 });
  }
}
