// src/app/api/jpx-eod/route.ts
import { NextRequest } from 'next/server'
export const dynamic = 'force-dynamic'

type Row = {
  ticker: string
  name?: string
  theme?: string
  brief?: string
  o?: number
  c?: number
  vol?: number
  chgPct?: number
  jpyValueM?: number // ¥(백만)
}

type Payload = {
  ok: true
  dateJst: string
  isHoliday: boolean
  reason?: string
  cards: Row[]
  tables: {
    byValue: Row[]
    byVolume: Row[]
    gainers: Row[]
    losers: Row[]
  }
} | { ok: false; error: string }

const JP_TZ = 'Asia/Tokyo'

// ---- 휴장/거래일 판정 ----
const JP_HOLIDAYS_2025 = new Set<string>([
  // 2025년 일본 공휴일(주요) — 필요시 추가
  '2025-01-01','2025-01-13','2025-02-11','2025-02-23','2025-03-20',
  '2025-04-29','2025-05-03','2025-05-04','2025-05-05','2025-05-06',
  '2025-07-21','2025-08-11','2025-09-15','2025-09-23',
  '2025-10-13','2025-11-03','2025-11-23','2025-11-24'
])
function fmtDateJst(d: Date) {
  const f = new Intl.DateTimeFormat('ja-JP', { timeZone: JP_TZ, year:'numeric', month:'2-digit', day:'2-digit' })
  const p = f.formatToParts(d)
  const y = p.find(x=>x.type==='year')!.value
  const m = p.find(x=>x.type==='month')!.value
  const dd= p.find(x=>x.type==='day')!.value
  return `${y}-${m}-${dd}`
}
function getNowJst() {
  const now = new Date()
  const str = new Intl.DateTimeFormat('en-CA', { timeZone: JP_TZ, hour12:false,
    year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }).format(now)
  // "YYYY-MM-DD, HH:MM"
  const [date, time] = str.split(', ').map(s=>s.trim())
  return { date, time }
}
function isWeekend(dateStr: string) {
  // JST 자정 기준 요일 계산
  const [y,m,d] = dateStr.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m-1, d, 15)) // UTC 15시는 JST 0시
  const day = dt.getUTCDay()
  return day===0 || day===6
}
function isJpHoliday(dateStr: string) {
  return JP_HOLIDAYS_2025.has(dateStr) || isWeekend(dateStr)
}
function prevBusinessDay(dateStr: string): string {
  let [y,m,d] = dateStr.split('-').map(Number)
  let dt = new Date(y, m-1, d)
  do {
    dt.setDate(dt.getDate()-1)
  } while (isJpHoliday(fmtDateJst(dt)))
  return fmtDateJst(dt)
}
function resolveTargetDate(req: NextRequest): { target: string, isHoliday: boolean, reason?: string } {
  const q = req.nextUrl.searchParams.get('date') // YYYY-MM-DD (JST)
  if (q) {
    const holiday = isJpHoliday(q)
    return { target: holiday ? prevBusinessDay(q) : q, isHoliday: holiday, reason: holiday ? 'holiday_or_weekend_input' : undefined }
  }
  const { date, time } = getNowJst()
  // 장 마감 15:00 JST 이후만 "당일" EOD 확정. 이전이면 직전 영업일로 굴림
  const afterClose = time >= '15:10'
  if (isJpHoliday(date)) {
    return { target: prevBusinessDay(date), isHoliday: true, reason: 'holiday_or_weekend' }
  }
  return { target: afterClose ? date : prevBusinessDay(date), isHoliday: false, reason: afterClose ? undefined : 'before_close' }
}

// ---- 간단 테마/브리프 사전 ----
type Info = { name: string; theme: string; brief: string }
const INFO: Record<string, Info> = {
  '1321.T': { name:'iシェアーズ 日経225', theme:'インデックス/ETF', brief:'日経225連動ETF' },
  '1306.T': { name:'NEXT FUNDS TOPIX', theme:'インデックス/ETF', brief:'TOPIX連動ETF' },
  '1570.T': { name:'日経レバ', theme:'インデックス/ETF', brief:'日経平均レバレッジ' },
  '8035.T': { name:'東京エレクトロン', theme:'半導体/装置', brief:'半導体製造装置' },
  '9984.T': { name:'ソフトバンクG', theme:'投資/通信', brief:'投資持株・通信' },
  '7203.T': { name:'トヨタ', theme:'自動車', brief:'自動車' },
  '6758.T': { name:'ソニーG', theme:'エレクトロニクス', brief:'エレクトロニクス/エンタメ' },
  '7974.T': { name:'任天堂', theme:'ゲーム', brief:'家庭用ゲーム' },
  '8306.T': { name:'三菱UFJ', theme:'金融', brief:'メガバンク' },
  '4063.T': { name:'信越化学', theme:'化学/半導体材料', brief:'シリコンウエハ' },
  '8031.T': { name:'三井物産', theme:'商社', brief:'総合商社' },
  '6861.T': { name:'キーエンス', theme:'FA/センサー', brief:'工場自動化' },
  '9432.T': { name:'NTT', theme:'通信', brief:'通信キャリア' },
  '6501.T': { name:'日立', theme:'重電/IT', brief:'社会インフラ/IT' },
  '4502.T': { name:'武田薬品', theme:'医薬', brief:'製薬大手' },
  '9101.T': { name:'日本郵船', theme:'海運', brief:'海運大手' },
  '9501.T': { name:'東電HD', theme:'電力', brief:'電力' },
  '8316.T': { name:'三井住友FG', theme:'金融', brief:'メガバンク' },
}

const UNIVERSE: string[] = [
  '1321.T','1306.T','1570.T',
  '8035.T','9984.T','7203.T','6758.T','7974.T','8306.T','4063.T','8031.T','6861.T',
  '9432.T','6501.T','4502.T','9101.T','9501.T','8316.T'
]

// ---- Stooq에서 일괄 견적 ----
// https://stooq.com/q/l/?s=1321.jp,8035.jp&i=d
function y2s(y: string){ return y.replace(/\.T$/i, '.jp') }
function s2y(s: string){ return s.replace(/\.jp$/i, '.T') }
async function fetchStooqDaily(yahooTickers: string[]): Promise<Row[]> {
  if (!yahooTickers.length) return []
  const url = `https://stooq.com/q/l/?s=${encodeURIComponent(yahooTickers.map(y2s).join(','))}&i=d`
  const res = await fetch(url, { cache:'no-store' })
  if (!res.ok) throw new Error(`Stooq ${res.status}`)
  const txt = await res.text()
  // header: Symbol,Date,Time,Open,High,Low,Close,Volume
  const lines = txt.trim().split('\n')
  const out: Row[] = []
  for (let i=1; i<lines.length; i++){
    const c = lines[i].split(',')
    const symS = (c[0]||'').trim()         // 1321.jp
    const symY = s2y(symS)                 // 1321.T
    const o = num(c[3])
    const close = num(c[6])
    const v = num(c[7])
    const info = INFO[symY]
    out.push({
      ticker: symY,
      name: info?.name,
      theme: info?.theme,
      brief: info?.brief,
      o, c: close, vol: v,
      chgPct: (o && close) ? round2(((close - o)/o)*100) : undefined,
      jpyValueM: (close && v) ? round2((close * v)/1_000_000) : undefined
    })
  }
  return out
}

// ---- 유틸 ----
function num(v:any){ const n=Number(v); return Number.isFinite(n)? n: undefined }
function round2(n:number){ return Math.round(n*100)/100 }
function topN<T>(arr:T[], n=10){ return arr.slice(0, n) }

function makeTables(rows: Row[]){
  const valid = rows.filter(r => r.c && r.vol)
  const byValue = topN([...valid].sort((a,b)=>(b.jpyValueM??0)-(a.jpyValueM??0)))
  const byVolume= topN([...valid].sort((a,b)=>(b.vol??0)-(a.vol??0)))
  const big = valid.filter(r => (r.c ?? 0) >= 1000)
  const gainers = topN([...big].sort((a,b)=>(b.chgPct??-1)-(a.chgPct??-1)))
  const losers  = topN([...big].sort((a,b)=>(a.chgPct??999)-(b.chgPct??999)))
  return { byValue, byVolume, gainers, losers }
}

// ---- 핸들러 ----
export async function GET(req: NextRequest){
  try {
    const { target, isHoliday, reason } = resolveTargetDate(req)

    // 휴일/주말이면 직전 영업일을 타겟으로 자동 설정(위에서 이미 처리됨)
    // 데이터 가져오기 (Stooq 단일 소스, 야후 401 회피)
    let cards: Row[] = []
    try {
      cards = await fetchStooqDaily(UNIVERSE)
    } catch (e){
      // 완전 실패시 빈배열
      cards = []
    }
    const tables = makeTables(cards)

    const body: Payload = {
      ok: true,
      dateJst: target,
      isHoliday,
      reason,
      cards,
      tables
    }
    return Response.json(body)
  } catch (e:any){
    return Response.json({ ok:false, error:String(e?.message||e) }, { status:500 })
  }
}
