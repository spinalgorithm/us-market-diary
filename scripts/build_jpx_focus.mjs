// scripts/build_jpx_focus.mjs
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/* ─ CSV 파서(따옴표/쉼표 안전) ─ */
function parseCsvLine(line) {
  const out = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { inQ = false; }
      } else cur += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ",") { out.push(cur); cur = ""; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out.map(s => s.trim());
}
function csvEncode(v = "") {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g,'""')}"` : v;
}
function toCSV(rows) {
  const header = ["code","name","theme","brief","yahooSymbol"];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push([r.code,r.name,r.theme,r.brief,r.yahooSymbol].map(csvEncode).join(","));
  }
  return lines.join("\n")+"\n";
}

/* ─ 유니버스 로드 ─ */
async function loadUniverseCsv(path) {
  const text = await readFile(path, "utf8");
  const lines = text.replace(/\r\n?/g,"\n").trim().split("\n");
  if (lines.length <= 1) return [];
  const head = parseCsvLine(lines[0]).map(s => s.toLowerCase());
  const idx = k => head.indexOf(k.toLowerCase());
  const iCode  = idx("code");
  const iName  = idx("name");
  const iTheme = idx("theme");
  const iBrief = idx("brief");
  const iYsym  = idx("yahoosymbol");

  const out = [];
  for (let i=1;i<lines.length;i++){
    const cols = parseCsvLine(lines[i]);
    const code = cols[iCode];
    if (!/^\d{4,5}$/.test(code||"")) continue;
    out.push({
      code,
      name: cols[iName] || code,
      theme: cols[iTheme] || "-",
      brief: cols[iBrief] || "-",
      yahooSymbol: (cols[iYsym] && cols[iYsym] !== "-" ? cols[iYsym] : `${code}.T`).toUpperCase(),
    });
  }
  return out;
}

/* ─ 간단 테마/브리프 추정 ─ */
function inferThemeBrief(name) {
  const n = (name||"").toLowerCase();
  const hit = (arr)=>arr.some(w=>n.includes(w));
  if (hit(["motor","toyota","nissan","honda","subaru","suzuki"])) return ["自動車","完成車/関連"];
  if (hit(["bank","financial","mizuho","ufj","sumitomo"])) return ["金融","銀行/メガバンク"];
  if (hit(["electronics","electric","sony","panasonic","sharp","hitachi","fujitsu"])) return ["電機","エレクトロニクス"];
  if (hit(["semiconductor","device","lasertech","advantest","tokyo electron","screen"])) return ["半導体関連","装置/検査"];
  if (hit(["chemical","chem"])) return ["化学","素材/化学"];
  if (hit(["pharma","pharmaceutical","yakuhin"])) return ["医薬","製薬"];
  if (hit(["railway","jr","rail"])) return ["鉄道","運輸"];
  if (hit(["telecom","softbank","kddi","ntt"])) return ["通信","キャリア"];
  if (hit(["energy","oil","inpex"])) return ["エネルギー","原油/ガス"];
  if (hit(["retail","unicharm","seven","aeon","fast retailing","uniqlo"])) return ["小売","消費"];
  return ["-", "-"];
}

/* ─ 야후 배치 쿼트 ─ */
function chunk(arr, size){ const out=[]; for(let i=0;i<arr.length;i+=size) out.push(arr.slice(i,i+size)); return out; }
async function safeJson(url){
  try{ const r = await fetch(url, {cache:"no-store"}); if(!r.ok) return null; return await r.json(); }catch{ return null; }
}
async function fetchYahooBatch(symbols){
  const map = new Map(); // sym -> {price, prev, vol, name, currency}
  const batches = chunk(symbols, 60);
  for (const b of batches) {
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(b.join(","))}`;
    const j = await safeJson(url);
    const arr = j?.quoteResponse?.result ?? [];
    for (const r of arr) {
      const sym = String(r?.symbol ?? "");
      if (!sym) continue;
      const price = Number(r?.regularMarketPrice ?? r?.regularMarketPreviousClose ?? 0);
      const prev  = Number(r?.regularMarketPreviousClose ?? 0);
      const vol   = Number(r?.regularMarketVolume ?? r?.volume ?? 0);
      const name  = r?.shortName ?? r?.longName ?? sym;
      const currency = r?.currency ?? "JPY";
 const sector = r?.sector || "";
const industry = r?.industry || "";

map.set(sym.toUpperCase(), { price, prev, vol, name, currency, sector, industry });
    }
    await new Promise(res=>setTimeout(res,120));
  }
  return map;
}

/* ─ 메인 ─ */
async function main(){
  const TOP = Number(process.argv.find(a=>a.startsWith("--top="))?.split("=")[1] ?? "600");
  const src = "public/jpx_universe.csv";
  const dst = "public/jpx_focus.csv";

  const all = await loadUniverseCsv(src);
  if (!all.length) {
    console.log(`[error] universe empty: ${src}`);
    process.exit(1);
  }
  const symbols = all.map(x=>x.yahooSymbol);
  const qmap = await fetchYahooBatch(symbols);

  const scored = all.map(x=>{
    const q = qmap.get(x.yahooSymbol) || {};
    const price = Number(q.price||0) || Number(q.prev||0) || 0;
    const vol = Number(q.vol||0) || 0;
    const yenVolM = (price * vol) / 1e6;
    return { ...x, _yenVolM: yenVolM };
  }).sort((a,b)=> (b._yenVolM - a._yenVolM));

 const pick = scored.slice(0, TOP).map(x=>{
  const q = qmap.get(x.yahooSymbol) || {};
  let theme = x.theme, brief = x.brief, name = x.name;
  if (!theme || theme === "-") theme = q.industry || q.sector || theme;
  if (!brief || brief === "-") brief = (q.sector && q.industry) ? `${q.sector}/${q.industry}` : (q.sector || q.industry || brief);
  if (!name || name === "-" ) name = q.name || name;
  // inferThemeBrief는 최후 보완용
  if ((!theme || theme === "-") || (!brief || brief === "-")) {
    const [t,b] = inferThemeBrief(name);
    if (!theme || theme === "-") theme = t;
    if (!brief || brief === "-") brief = b;
  }
  return { code:x.code, name, theme, brief, yahooSymbol:x.yahooSymbol };
});

  await mkdir(dirname(dst), { recursive: true });
  await writeFile(dst, toCSV(pick), "utf8");
  console.log(`[ok] focus written: ${dst} (rows=${pick.length})`);
}




main().catch(e=>{ console.error(e); process.exit(1); });
