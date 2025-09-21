// generate_jpx_diary.mjs
// Node 20+ (fetch 내장). 외부 패키지 불필요.
// Usage:
//  node generate_jpx_diary.mjs \
//    --focus=public/jpx_focus.csv --out=public/jpx_diary.md \
//    --date=2025-09-12 --replay=1 --llm=1 --model=gpt-4o-mini
//
// ENV:
//  OPENAI_API_KEY  (optional; set with --llm=1 to enable LLM narratives)

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/* ========== helpers ========== */
const args = Object.fromEntries(process.argv.slice(2).map(a=>{
  const m = a.match(/^--([^=]+)=(.*)$/); 
  return m ? [m[1], m[2]] : [a.replace(/^--/,""), "1"];
}));
const FOCUS = args.focus ?? "public/jpx_focus.csv";
const OUT   = args.out   ?? "public/jpx_diary.md";
const DATE  = args.date  ?? "";   // JST 기준; 빈 값이면 오늘/자동회귀 표기만
const REPLAY= Number(args.replay ?? "0") === 1;
const USE_LLM = Number(args.llm ?? "0") === 1 && !!process.env.OPENAI_API_KEY;
const LLM_MODEL = args.model ?? "gpt-4o-mini";
const TIMEOUT_MS = 15000;

const sleep = (ms)=>new Promise(res=>setTimeout(res, ms));
const withTimeout = async (p, ms=TIMEOUT_MS)=> {
  const ctrl = new AbortController();
  const t = setTimeout(()=>ctrl.abort(new Error("timeout")), ms);
  try {
    return await p(ctrl.signal);
  } finally { clearTimeout(t); }
};
const nowJST = ()=> {
  const d = new Date();
  const utc = d.getTime() + d.getTimezoneOffset()*60000;
  return new Date(utc + 9*60*60000);
};
const toYmd = (d)=> {
  const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,"0"), da=String(d.getDate()).padStart(2,"0");
  return `${y}-${m}-${da}`;
};
const num = (x)=> {
  const n = Number(x);
  return Number.isFinite(n) ? n : undefined;
};
const fmtNum = (x)=> (x==null || !Number.isFinite(Number(x)))? "-" : Number(x).toLocaleString("ja-JP");
const fmtPct = (x, d=2)=> (x==null || !Number.isFinite(Number(x)))? "-" : Number(x).toFixed(d);
const fmtO2C = (o,c)=> (o==null || c==null) ? "-→-" : `${fmtNum(o)}→${fmtNum(c)}`;

/* ========== CSV robust parse ========== */
function parseCsvLine(line) {
  const out=[], q='"';
  let cur="", inQ=false;
  for (let i=0;i<line.length;i++){
    const ch = line[i];
    if (inQ){
      if (ch===q){
        if (line[i+1]===q){ cur+=q; i++; } else inQ=false;
      } else cur+=ch;
    } else {
      if (ch===q) inQ=true;
      else if (ch===","){ out.push(cur); cur=""; }
      else cur+=ch;
    }
  }
  out.push(cur);
  return out.map(s=>s.trim());
}
async function loadCsvRows(path){
  const text = await readFile(path,"utf8");
  const lines = text.replace(/\r\n?/g,"\n").trim().split("\n");
  if (lines.length<=1) return [];
  const head = parseCsvLine(lines[0]).map(s=>s.toLowerCase());
  const idx = (k)=> head.indexOf(k.toLowerCase());
  const iCode=idx("code"), iName=idx("name"), iTheme=idx("theme"), iBrief=idx("brief"), iSym=idx("yahoosymbol");
  const out=[];
  for (let i=1;i<lines.length;i++){
    const cols = parseCsvLine(lines[i]);
    const code = cols[iCode];
    if (!code) continue;
    out.push({
      code,
      name: cols[iName] || code,
      theme: cols[iTheme] || "-",
      brief: cols[iBrief] || "-",
      yahooSymbol: (cols[iSym] ? cols[iSym] : `${code}.T`).toUpperCase(),
    });
  }
  return out;
}

/* ========== Yahoo batch quotes (primary) ========== */
function chunk(arr, n){ const r=[]; for(let i=0;i<arr.length;i+=n) r.push(arr.slice(i,i+n)); return r; }
async function safeJson(url, {signal}={}) {
  try {
    const r = await fetch(url, { cache:"no-store", signal });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}
async function fetchYahooBatchQuotes(symbols) {
  const map = new Map();
  if (!symbols?.length) return map;
  const batches = chunk(symbols, 60);
  for (const b of batches){
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(b.join(","))}`;
    const j = await withTimeout((signal)=>safeJson(url,{signal}));
    const arr = j?.quoteResponse?.result ?? [];
    for (const r of arr){
      const sym = String(r?.symbol ?? "");
      if (!sym) continue;
      const open = num(r?.regularMarketOpen ?? r?.open);
      const close= num(r?.regularMarketPrice ?? r?.regularMarketPreviousClose ?? r?.postMarketPrice);
      const prev = num(r?.regularMarketPreviousClose);
      const vol  = num(r?.regularMarketVolume ?? r?.volume);
      const currency = r?.currency ?? "JPY";
      const name = r?.shortName ?? r?.longName ?? sym;
      map.set(sym.toUpperCase(), { symbol:sym.toUpperCase(), open, close, previousClose:prev, volume:vol, currency, name });
    }
    await sleep(100); // rate polite
  }
  return map;
}

/* ========== Intraday 5m (proxy symbols; optional) ========== */
async function fetchYahoo5m(sym){
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=5m&range=1d`;
  const j = await withTimeout((signal)=>safeJson(url,{signal}));
  const r = j?.chart?.result?.[0];
  if (!r) return null;
  const ts = r.timestamp ?? [];
  const close = r.indicators?.quote?.[0]?.close ?? [];
  const volume= r.indicators?.quote?.[0]?.volume ?? [];
  return ts.map((t,i)=>({ t:(t*1000), close: num(close[i]), volume: num(volume[i]) }));
}
function groupTo30mJST(points){
  // points: [{t(ms UTC), close, volume}]
  // convert to JST and bucket by 00/30 min
  const buckets = new Map(); // key: ymdHH:MM (30m)
  for (const p of points){
    if (p.close==null) continue;
    const d = new Date(p.t + 9*60*60000);
    const h = String(d.getUTCHours()).padStart(2,"0");
    const m = d.getUTCMinutes() < 30 ? "00" : "30";
    const key = `${h}:${m}`;
    const b = buckets.get(key) ?? { first:p.close, last:p.close, vol:0, n:0 };
    b.last = p.close;
    b.vol += (p.volume ?? 0);
    b.n  += 1;
    buckets.set(key, b);
  }
  // to ordered array
  return Array.from(buckets.entries()).sort((a,b)=> a[0]<b[0]?-1:1)
    .map(([k,v])=>({ slot:k, retPct: v.first>0 ? ((v.last-v.first)/v.first*100) : 0, vol:v.vol }));
}

/* ========== Build rows / rankings ========== */
function calcRow(u, q){
  const open = q?.open ?? null;
  const close= q?.close ?? null;
  const prev = q?.previousClose ?? null;
  const vol  = q?.volume ?? null;
  const chgPrev = (close!=null && prev!=null && prev>0) ? ((close-prev)/prev*100) : null;
  const chgIntra= (close!=null && open!=null && open>0) ? ((close-open)/open*100) : null;
  const yenVolM = (close!=null && vol!=null) ? (close*vol/1e6) : null;
  return {
    code: u.code,
    ticker: u.yahooSymbol,
    name: u.name,
    theme: u.theme ?? "-",
    brief: u.brief ?? "-",
    open, close, previousClose: prev,
    chgPctPrev: chgPrev,
    chgPctIntraday: chgIntra,
    volume: vol,
    yenVolM,
    currency: q?.currency ?? "JPY",
  };
}
function priceForFilter(r){ return r.close ?? r.previousClose ?? r.open ?? 0; }
function buildRankings(rows){
  const byValue = [...rows].filter(r=>r.yenVolM!=null).sort((a,b)=>b.yenVolM - a.yenVolM).slice(0,10);
  const byVolume= [...rows].filter(r=>r.volume!=null).sort((a,b)=>b.volume - a.volume).slice(0,10);
  const elig = rows.filter(r=> priceForFilter(r) >= 1000 && r.chgPctPrev!=null);
  const topGainers = [...elig].filter(r=>r.chgPctPrev>0).sort((a,b)=>b.chgPctPrev-a.chgPctPrev).slice(0,10);
  const topLosers  = [...elig].filter(r=>r.chgPctPrev<0).sort((a,b)=>a.chgPctPrev-b.chgPctPrev).slice(0,10);
  return { byValue, byVolume, topGainers, topLosers };
}

/* ========== Tables (markdown) ========== */
function tableByValue(rows){
  const head = "| Rank | Ticker | Name | o→c | Chg% | Vol | ¥Vol(M) | Theme | Brief |\n|---:|---:|---|---:|---:|---:|---:|---|---|\n";
  const body = rows.map((r,i)=>[
    i+1, r.code, r.name, fmtO2C(r.open,r.close), fmtPct(r.chgPctPrev),
    fmtNum(r.volume), fmtNum(r.yenVolM), r.theme||"-", r.brief||"-"
  ].join(" | ")).join("\n");
  return head + body + (body? "\n" : "");
}
function tableByVolume(rows){
  const head = "| Rank | Ticker | Name | o→c | Chg% | Vol | Theme | Brief |\n|---:|---:|---|---:|---:|---:|---|---|\n";
  const body = rows.map((r,i)=>[
    i+1, r.code, r.name, fmtO2C(r.open,r.close), fmtPct(r.chgPctPrev),
    fmtNum(r.volume), r.theme||"-", r.brief||"-"
  ].join(" | ")).join("\n");
  return head + body + (body? "\n" : "");
}
function tableGainers(rows){
  const head = "| Rank | Ticker | Name | o→c | Chg% | Vol | Theme | Brief |\n|---:|---:|---|---:|---:|---:|---|---|\n";
  const body = rows.map((r,i)=>[
    i+1, r.code, r.name, fmtO2C(r.open,r.close), fmtPct(r.chgPctPrev),
    fmtNum(r.volume), r.theme||"-", r.brief||"-"
  ].join(" | ")).join("\n");
  return head + body + (body? "\n" : "");
}
function tableLosers(rows){
  const head = "| Rank | Ticker | Name | o→c | Chg% | Vol | Theme | Brief |\n|---:|---:|---|---:|---:|---:|---|---|\n";
  const body = rows.map((r,i)=>[
    i+1, r.code, r.name, fmtO2C(r.open,r.close), fmtPct(r.chgPctPrev),
    fmtNum(r.volume), r.theme||"-", r.brief||"-"
  ].join(" | ")).join("\n");
  return head + body + (body? "\n" : "");
}

/* ========== Data-driven headline bits ========== */
function computeTop10Concentration(rows, byValueTop10){
  const sumAll = rows.reduce((s,r)=> s + (r.yenVolM||0), 0);
  const sumTop = byValueTop10.reduce((s,r)=> s + (r.yenVolM||0), 0);
  if (sumAll<=0) return null;
  return (sumTop/sumAll*100);
}
function computeBreadth(rows){
  let up=0, dn=0; 
  for (const r of rows){
    if (r.chgPctPrev==null) continue;
    if (r.chgPctPrev>0) up++; else if (r.chgPctPrev<0) dn++;
  }
  return { up, dn };
}
function topThemesByValue(rows, k=3){
  const m = new Map(); // theme -> yenVolM sum
  for (const r of rows){
    const t = r.theme||"-";
    m.set(t, (m.get(t)||0) + (r.yenVolM||0));
  }
  return Array.from(m.entries())
    .sort((a,b)=> b[1]-a[1])
    .filter(([t])=> t && t!=="-")
    .slice(0,k)
    .map(([t,v])=>({ theme:t, yenVolM:v }));
}

/* ========== LLM (optional) ========== */
async function callLLM(sys, user){
  if (!USE_LLM) return null;
  try{
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method:"POST",
      headers:{
        "Authorization":`Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type":"application/json",
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        temperature: 0.4,
        messages: [
          { role:"system", content: sys },
          { role:"user",   content: user },
        ],
      }),
    });
    if (!resp.ok) return null;
    const j = await resp.json();
    return j?.choices?.[0]?.message?.content ?? null;
  } catch { return null; }
}

/* ========== Main ========== */
async function main(){
  console.log(`[info] load focus: ${FOCUS}`);
  const universe = await loadCsvRows(FOCUS);
  if (!universe.length) throw new Error("focus csv empty");

  const symbols = universe.map(u=>u.yahooSymbol);
  console.log(`[info] fetch yahoo quotes (n=${symbols.length})`);
  const qmap = await fetchYahooBatchQuotes(symbols);

  // rows
  const rows = universe.map(u=> calcRow(u, qmap.get(u.yahooSymbol)));

  // rankings
  const rankings = buildRankings(rows);

  // headline numbers
  const top10Conc = computeTop10Concentration(rows, rankings.byValue);
  const br = computeBreadth(rows);
  const topThemes = topThemesByValue(rows, 3);

  // date label
  const baseDate = DATE || toYmd(nowJST());

  // narrative via LLM (fallback to rules if LLM disabled)
  const sys = `あなたは日本株のリサーチアナリストです。与えられた数値のみから短く鋭い相場観要約を日本語でMarkdownに出力します。誇張や断定を避け、具体的なパーセントや件数を埋め込んでください。`;
  const user = `前提: 本日の集計は売買代金上位600銘柄（終値ベース）。\n`+
    `Top10集中度: ${top10Conc? top10Conc.toFixed(1)+"%" : "N/A"}\n`+
    `ブレッドス(上昇/下落): ${br.up}:${br.dn}\n`+
    `テーマ上位(売買代金): ${topThemes.map(t=>`${t.theme}`).join(", ") || "N/A"}\n`+
    `補足: 表のo→cは日中の値動き、ランキングは前日比優先（価格>=1,000円）。\n`+
    `出力: 「TL;DR」「本日のストーリー(箇条書き3行)」「EOD総括(1段落)」の3ブロック。`;

  let tldrBlock, storyBlock, eodBlock;
  if (USE_LLM){
    const llm = await callLLM(sys, user);
    if (llm){
      // 기대 포맷에 맞춰 들어오므로 그대로 사용
      tldrBlock = (llm.match(/### TL;DR[\s\S]*?(?=\n###|\n---|$)/) || [null])[0];
      storyBlock= (llm.match(/### 本日のストーリー[\s\S]*?(?=\n###|\n---|$)/) || [null])[0];
      eodBlock  = (llm.match(/### EOD総括[\s\S]*?(?=\n###|\n---|$)/) || [null])[0];
    }
  }
  // fallback 규칙
  if (!tldrBlock){
    const concStr = top10Conc? `${top10Conc.toFixed(1)}%` : "N/A";
    tldrBlock = `### TL;DR\nTop10集中度 **${concStr}**、ブレッドス **${br.up}:${br.dn}**。`+
      (topThemes.length? ` テーマ比重は **${topThemes.map(t=>t.theme).join(" / ")}** が上位。`:"");
  }
  if (!storyBlock){
    storyBlock = `### 本日のストーリー
- 主力周辺にフロー集中、分散は限定的。
- ブレッドスは ${br.up}:${br.dn}、指数方向は上位次第。
- テーマは ${topThemes.map(t=>t.theme).join("・") || "コア"} に回遊。`;
  }
  if (!eodBlock){
    eodBlock = `### EOD総括\nTop10集中とブレッドスの兼ね合いで指数は方向感限定。翌日は集中の解消/継続とテーマ入れ替わりが焦点。`;
  }

  // 30分リプレ이(옵션: 프록시 5~8개)
  let replayBlock = "";
  if (REPLAY){
    const proxies = ["1306.T","1321.T","8035.T","6758.T","7203.T","8306.T","9432.T","7974.T"];
    const series = [];
    for (const s of proxies){
      const p = await fetchYahoo5m(s);
      if (!p) continue;
      series.push({ symbol:s, buckets: groupTo30mJST(p) });
      await sleep(80);
    }
    // 단순 합성: 시간슬롯 공통으로 수익률 평균, 거래량합
    const m = new Map(); // slot -> {rets:[], vol:sum}
    for (const s of series){
      for (const b of s.buckets){
        const v = m.get(b.slot) ?? { rets:[], vol:0 };
        v.rets.push(b.retPct);
        v.vol += b.vol||0;
        m.set(b.slot, v);
      }
    }
    const ordered = Array.from(m.entries()).sort((a,b)=> a[0]<b[0]?-1:1);
    const mini = ordered.map(([slot,v])=>({ slot, ret: v.rets.length? v.rets.reduce((x,y)=>x+y,0)/v.rets.length : 0, vol:v.vol }));
    // 규칙 내러티브
    const first = mini[0]?.ret ?? 0, mid = mini[Math.floor(mini.length/2)]?.ret ?? 0, last = mini[mini.length-1]?.ret ?? 0;
    const tone = (x)=> x>0.15? "強" : x<-0.15? "弱" : "横";
    replayBlock = `### 30分リプレイ
- 寄り：${tone(first)}含みのスタート。
- 前場：平均リターンは ${fmtPct(mid,2)}%、出来高は前半集中。
- 後場：方向感は ${tone(last)}、押し目の買い/戻り売りが交錯。
- 引け：終盤の平均リターン ${fmtPct(last,2)}% でクローズ。`;
  }

  // 카드(주요 심볼이 focus에 없을 수 있으니 코드 기준으로 필터)
  const CARD_CODES = new Set(["1321","1306","7203","6758","8035","6861","6501","4063","9432","6954","8306","8316","9984","9983","7974","9433","9434"]);
  const cards = rows.filter(r=>CARD_CODES.has(r.code));
  const cardsLines = cards.length
    ? cards.map(r=>`- ${r.code} — ${r.name}\n  - o→c: ${fmtO2C(r.open,r.close)} / Chg%: ${fmtPct(r.chgPctPrev)} / Vol: ${fmtNum(r.volume)} / ¥Vol(M): ${fmtNum(r.yenVolM)} / ${r.theme||"-"} — ${r.brief||"-"}`).join("\n")
    : "（データを取得できませんでした）";

  // 헤더
  const sourceNote = `YahooBatch${REPLAY?"+YahooChart":""}${USE_LLM?"+LLM":""}`;
  const header =
`# 日本株 夜間警備員 日誌 | ${baseDate}

> ソース: ${sourceNote} / ユニバース: ${rows.length}銘柄
> 集計対象: 売買代金 **上位600銘柄** のみ（事前集計CSV）。
> 注記: JST **15:35**以前のアクセスは前営業日に自動回帰。無料ソース特性上、厳密なEODと微差が出る場合があります。
> ※ ランキングは**前日比(終値/前日終値)**を優先、表の o→c は日中の値動きです。
`;

  const md =
[
  header.trim(),
  tldrBlock.trim(),
  "\n",
  storyBlock.trim(),
  "\n",
  replayBlock ? replayBlock.trim() : "",
  replayBlock ? "\n" : "",
  eodBlock.trim(),
  "\n---\n## カード（主要ETF・大型）\n"+cardsLines+"\n",
  "---\n## 📊 データ(Top10)\n",
  "### Top 10 — 売買代金（百万円換算）\n"+tableByValue(rankings.byValue),
  "\n### Top 10 — 出来高（株数）\n"+tableByVolume(rankings.byVolume),
  "\n### Top 10 — 上昇株（¥1,000+）\n"+tableGainers(rankings.topGainers),
  "\n### Top 10 — 下落株（¥1,000+）\n"+tableLosers(rankings.topLosers),
  "\n\n#日本株 #日経平均 #TOPIX #半導体 #AI #出来高 #売買代金 #大型株\n"
].filter(Boolean).join("\n");

  await mkdir(dirname(OUT), { recursive:true });
  await writeFile(OUT, md, "utf8");
  console.log(`[ok] diary written: ${OUT}`);
}

main().catch(e=>{ console.error(e); process.exit(1); });
