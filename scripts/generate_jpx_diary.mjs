// Node 20+, ESM
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/* ========== 유틸 ========== */
const sleep = (ms)=>new Promise(r=>setTimeout(r, ms));
const toJST = (d=new Date())=>{
  const utc = d.getTime() + d.getTimezoneOffset()*60000;
  return new Date(utc + 9*60*60000);
};
const ymd = (d)=>[
  d.getFullYear(),
  String(d.getMonth()+1).padStart(2,"0"),
  String(d.getDate()).padStart(2,"0")
].join("-");

function parseCsvLine(line){
  const out=[]; let cur="", inQ=false;
  for (let i=0;i<line.length;i++){
    const ch=line[i];
    if (inQ){
      if (ch==='"'){ if(line[i+1]==='"'){ cur+='"'; i++; } else inQ=false; }
      else cur+=ch;
    }else{
      if (ch==='"') inQ=true;
      else if (ch===","){ out.push(cur); cur=""; }
      else cur+=ch;
    }
  }
  out.push(cur);
  return out.map(s=>s.trim());
}
function csvEncode(v=""){
  return /[",\n]/.test(v) ? `"${String(v).replace(/"/g,'""')}"` : String(v);
}
function toTable(rows, header){
  const head = `| ${header.map((h,i)=> i<header.length-1 ? `${h} | `:h ).join("")}\n|${header.map(()=>":---:").join("|")}|`;
  const body = rows.map(r=>`| ${r.join(" | ")} |`).join("\n");
  return `${head}\n${body}`;
}
function nfmt(v){ return (v==null||!isFinite(+v)) ? "-" : Number(v).toLocaleString("ja-JP"); }
function pfmt(v, d=2){ return (v==null||!isFinite(+v)) ? "-" : Number(v).toFixed(d); }
const o2c = (o,c)=> (o==null||c==null) ? "-→-" : `${nfmt(o)}→${nfmt(c)}`;

/* ========== 야후 배치 쿼트 ========== */
function chunk(arr, size){ const out=[]; for(let i=0;i<arr.length;i+=size) out.push(arr.slice(i,i+size)); return out; }
async function j(url){ try{ const r=await fetch(url,{cache:"no-store"}); if(!r.ok) return null; return await r.json(); }catch{ return null; } }
async function fetchYahooBatch(symbols){
  const map = new Map();
  const batches = chunk(symbols, 60);
  for (const b of batches){
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(b.join(","))}`;
    const data = await j(url);
    const arr = data?.quoteResponse?.result ?? [];
    for (const r of arr){
      const sym = String(r?.symbol ?? "");
      if (!sym) continue;
      const open = Number(r?.regularMarketOpen ?? r?.open ?? NaN);
      const close = Number(r?.regularMarketPrice ?? r?.regularMarketPreviousClose ?? r?.postMarketPrice ?? NaN);
      const prev  = Number(r?.regularMarketPreviousClose ?? NaN);
      const volume= Number(r?.regularMarketVolume ?? r?.volume ?? NaN);
      const name  = r?.shortName ?? r?.longName ?? sym;
      const currency = r?.currency ?? "JPY";
      map.set(sym.toUpperCase(), { open:isFinite(open)?open:null, close:isFinite(close)?close:null, previousClose:isFinite(prev)?prev:null, volume:isFinite(volume)?volume:null, currency, name });
    }
    await sleep(120);
  }
  return map;
}

/* ========== LLM(선택) ========== */
async function llmSummary(input){
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null; // 키 없으면 스킵
  const { OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey });

  const sys = `あなたは日本株の場況レポーター。与えられた数値のみで要約を作る。誇張しない。絵文字や過度な形容は避ける。`;
  const usr = `
[入力]
- 日付: ${input.date}
- ユニバース: ${input.universeCount}
- Top10売買代金集中度: ${(input.concentration*100).toFixed(1)}%
- ブレッドス(上昇/下落): ${input.breadth.up} / ${input.breadth.down}
- セクター上位(売買代金): ${input.topThemes.map(t=>`${t.theme}(${(t.share*100).toFixed(1)}%)`).join(", ")}
- 代表銘柄(カード): ${input.cards.join(", ")}

[出力フォーマット(そのまま貼る)]
### TL;DR
一文で全体観。必要なら数字を1〜2個。

### 本日のストーリー
- 箇条書き3〜4行。フロー/セクター/主力と周辺の対比を端的に。

### 30分リプレイ（推定）
- 寄り：〜
- 前場：〜
- 後場：〜
- 引け：〜

### EOD総括
1〜2文の総括。翌日への含みを1点。

### 明日のチェック
- 3〜5個、短く。`;

  const completion = await client.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.4,
    messages: [
      { role:"system", content: sys },
      { role:"user",   content: usr }
    ]
  });
  return completion.choices[0]?.message?.content ?? null;
}

/* ========== 메인 ========== */
async function main(){
  // 1) 입력 CSV(사전 정의)
  const universeCsvPath = "public/jpx_universe.csv";   // 전체(3,800)
  const focusCsvPath    = "public/jpx_focus.csv";      // build_jpx_focus.mjs가 생성하는 top600
  const today = toJST(); const y = ymd(today);

  // focus 로드
  const focusCsv = await readFile(focusCsvPath, "utf8");
  const lines = focusCsv.replace(/\r\n?/g,"\n").trim().split("\n");
  const head  = parseCsvLine(lines[0]).map(s=>s.toLowerCase());
  const idx = (k)=> head.indexOf(k.toLowerCase());
  const iCode=idx("code"), iName=idx("name"), iTheme=idx("theme"), iBrief=idx("brief"), iY=idx("yahoosymbol");
  const focus = [];
  for(let i=1;i<lines.length;i++){
    const c = parseCsvLine(lines[i]); if (!c[iCode]) continue;
    focus.push({
      code: c[iCode], name: c[iName]||c[iCode], theme: c[iTheme]||"-", brief: c[iBrief]||"-",
      yahoo: (c[iY] && c[iY]!=="-" ? c[iY] : `${c[iCode]}.T`).toUpperCase()
    });
  }
  const symbols = focus.map(x=>x.yahoo);

  // 2) 시세(야후 배치) — 오프라인에서 한 번 호출
  const qmap = await fetchYahooBatch(symbols);

  // 3) 행 구성 + 메트릭
  const rows = focus.map(x=>{
    const q = qmap.get(x.yahoo) || {};
    const open = q?.open ?? null, close = q?.close ?? null, prev = q?.previousClose ?? null;
    const chgPrev = (close!=null && prev!=null && prev>0) ? ((close/prev - 1)*100) : null;
    const chgIntra= (close!=null && open!=null && open>0) ? ((close/open - 1)*100) : null;
    const vol = q?.volume ?? null;
    const yenVolM = (close!=null && vol!=null) ? (close*vol/1e6) : null;
    return {
      code:x.code, ticker:x.yahoo, name:x.name, theme:x.theme, brief:x.brief,
      open, close, previousClose:prev, chgPctPrev: chgPrev, chgPctIntraday: chgIntra,
      volume: vol, yenVolM, currency: q?.currency ?? "JPY"
    };
  });

  // 4) 랭킹/지표(전량 600 기준)
  const all = rows.filter(r=>r.close!=null || r.previousClose!=null);
  const sumYen = all.reduce((a,b)=> a + (b.yenVolM??0), 0);
  const byValue = [...all].filter(r=>r.yenVolM!=null).sort((a,b)=> b.yenVolM - a.yenVolM).slice(0,10);
  const byVolume= [...all].filter(r=>r.volume!=null).sort((a,b)=> b.volume - a.volume).slice(0,10);
  const price = (r)=> r.close ?? r.previousClose ?? r.open ?? 0;
  const elig  = all.filter(r=> price(r) >= 1000 && r.chgPctPrev!=null);
  const topG  = [...elig].filter(r=> r.chgPctPrev>0).sort((a,b)=> b.chgPctPrev - a.chgPctPrev).slice(0,10);
  const topL  = [...elig].filter(r=> r.chgPctPrev<0).sort((a,b)=> a.chgPctPrev - b.chgPctPrev).slice(0,10);

  // 지표: 집중도, 브레드스, 테마 비중
  const top10Sum = byValue.reduce((a,b)=> a + (b.yenVolM??0), 0);
  const concentration = sumYen>0 ? (top10Sum/sumYen) : 0;
  const up = all.filter(r=> (r.chgPctPrev??0) > 0).length;
  const dn = all.filter(r=> (r.chgPctPrev??0) < 0).length;
  const themeAgg = new Map(); // theme -> sum yenVolM
  for (const r of all){
    const key = (r.theme && r.theme!=="-") ? r.theme : "その他";
    themeAgg.set(key, (themeAgg.get(key)||0) + (r.yenVolM??0));
  }
  const themeRank = [...themeAgg.entries()]
    .map(([theme, val])=>({ theme, val, share: sumYen>0 ? (val/sumYen) : 0 }))
    .sort((a,b)=> b.val - a.val)
    .slice(0,5);

  // 5) 카드(대표) — 보여줄 대상만 추림
  const CARD = new Set(["1321.T","1306.T","7203.T","6758.T","8035.T","6861.T","6501.T","4063.T","9432.T","8306.T","7974.T"]);
  const cards = all.filter(r=> CARD.has(r.ticker)).map(r=>
    `${r.code} — ${r.name}`
  );

  // 6) LLM 요약(선택) + Fallback 규칙문
  const llmInput = {
    date: y, universeCount: all.length, concentration, breadth:{up,down},
    topThemes: themeRank, cards
  };
  let narrative = await llmSummary(llmInput);
  if (!narrative){
    // (키 없거나 실패 시) 규칙 기반 Fallback
    narrative = [
      "### TL;DR",
      `Top10集中度 ${(concentration*100).toFixed(1)}%、ブレッドス ${up}:${dn}。主力周辺にフロー集中。`,
      "",
      "### 本日のストーリー",
      "- 売買代金は主力・大型に寄る構図、周辺は選別的。",
      `- セクター上位: ${themeRank.slice(0,3).map(t=>t.theme).join(" / ")}。`,
      "- 値がさの押し目は相対的に吸収、広がりは限定。",
      "",
      "### 30分リプレイ（推定）",
      "- 寄り：指数連動で様子見。",
      "- 前場：主力に資金回帰、二番手は選別。",
      "- 後場：方向感の鈍化、戻り待ち売りも散見。",
      "- 引け：主力周辺での攻防を引き継ぎクローズ。",
      "",
      "### EOD総括",
      "主力集中とブレッドスのバランスで指数は大崩れせず。翌日は集中の解消/継続が焦点。",
      "",
      "### 明日のチェック",
      "- Top10集中度の変化",
      "- ブレッドスの改善/悪化",
      "- 上位テーマの入れ替わり"
    ].join("\n");
  }

  // 7) 표 4종 (Top10)
  const tByVal = toTable(byValue.map((r,i)=>[
    i+1, r.code, r.name, o2c(r.open,r.close), pfmt(r.chgPctPrev), nfmt(r.volume), nfmt(r.yenVolM), r.theme, r.brief
  ]), ["Rank","Ticker","Name","o→c","Chg%","Vol","¥Vol(M)","Theme","Brief"]);

  const tByVol = toTable(byVolume.map((r,i)=>[
    i+1, r.code, r.name, o2c(r.open,r.close), pfmt(r.chgPctPrev), nfmt(r.volume), r.theme, r.brief
  ]), ["Rank","Ticker","Name","o→c","Chg%","Vol","Theme","Brief"]);

  const tGainers = toTable(topG.map((r,i)=>[
    i+1, r.code, r.name, o2c(r.open,r.close), pfmt(r.chgPctPrev), nfmt(r.volume), r.theme, r.brief
  ]), ["Rank","Ticker","Name","o→c","Chg%","Vol","Theme","Brief"]);

  const tLosers = toTable(topL.map((r,i)=>[
    i+1, r.code, r.name, o2c(r.open,r.close), pfmt(r.chgPctPrev), nfmt(r.volume), r.theme, r.brief
  ]), ["Rank","Ticker","Name","o→c","Chg%","Vol","Theme","Brief"]);

  // 8) 최종 Markdown 조립
  const mdParts = [];
  mdParts.push(`# 日本株 夜間警備員 日誌 | ${y}\n`);
  mdParts.push(`> ソース: Offline(事前集計) / ユニバース: ${all.length}銘柄`);
  mdParts.push(`\n> 集計対象: 売買代金 **上位600銘柄** のみ（事前集計CSV）。`);
  mdParts.push(`\n> 注記: EODベースの事前生成。投稿時API呼び出しは行っていません。`);
  mdParts.push(`\n`);
  mdParts.push(narrative);
  mdParts.push(`\n---\n## カード（主要ETF・大型）\n${cards.length? cards.map(c=>`- ${c}`).join("\n") : "（データを取得できませんでした）"}\n`);
  mdParts.push(`---\n## 📊 データ(Top10)\n`);
  mdParts.push(`### Top 10 — 売買代金（百万円換算）\n${tByVal}\n`);
  mdParts.push(`\n### Top 10 — 出来高（株数）\n${tByVol}\n`);
  mdParts.push(`\n### Top 10 — 上昇株（¥1,000+）\n${tGainers}\n`);
  mdParts.push(`\n### Top 10 — 下落株（¥1,000+）\n${tLosers}\n`);
  mdParts.push(`\n#日本株 #日経平均 #TOPIX #半導体 #出来高 #売買代金 #大型株\n`);

  const md = mdParts.join("\n");

  // 9) 파일로 저장 (레포에 커밋됨)
  const outMd  = `public/diaries/JPX-${y}.md`;
  const outJson= `public/diaries/JPX-${y}.json`;
  await mkdir(dirname(outMd), { recursive:true });
  await writeFile(outMd, md, "utf8");
  await writeFile(outJson, JSON.stringify({
    date:y, metrics:{ concentration, breadth:{up,down}, sumYen }, themes: themeRank,
    rankings:{ byValue, byVolume, topGainers: topG, topLosers: topL }
  }, null, 2), "utf8");

  console.log(`[ok] diary written: ${outMd}`);
}

main().catch(e=>{ console.error(e); process.exit(1); });
