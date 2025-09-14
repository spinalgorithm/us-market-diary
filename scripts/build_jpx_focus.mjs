// scripts/build_jpx_focus.mjs
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/* ========= CSV 유틸 ========= */
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
function toCSV(rows, header) {
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(header.map(k => csvEncode(String(r[k] ?? ""))).join(","));
  }
  return lines.join("\n") + "\n";
}

/* ========= 입력 CSV 로드 ========= */
async function loadUniverseCsv(path) {
  const text = await readFile(path, "utf8");
  const lines = text.replace(/\r\n?/g,"\n").trim().split("\n");
  if (lines.length <= 1) return [];
  const head = parseCsvLine(lines[0]);
  const L = head.map(s => s.toLowerCase());
  const idx = k => L.indexOf(k.toLowerCase());

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
      theme: (cols[iTheme] && cols[iTheme] !== "-") ? cols[iTheme] : "-",
      brief: (cols[iBrief] && cols[iBrief] !== "-") ? cols[iBrief] : "-",
      yahooSymbol: (cols[iYsym] && cols[iYsym] !== "-" ? cols[iYsym] : `${code}.T`).toUpperCase(),
    });
  }
  return out;
}

/* ========= 야후 v7 일괄 시세 ========= */
function chunk(arr, size){ const out=[]; for(let i=0;i<arr.length;i+=size) out.push(arr.slice(i,i+size)); return out; }
async function safeJson(url){
  try{ const r = await fetch(url, {cache:"no-store"}); if(!r.ok) return null; return await r.json(); }catch{ return null; }
}
async function fetchYahooBatch(symbols){
  const map = new Map(); // sym -> { price, prev, vol, name, currency }
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
      map.set(sym.toUpperCase(), { price, prev, vol, name, currency });
    }
    await new Promise(res=>setTimeout(res,120));
  }
  return map;
}

/* ========= 규칙 기반 테마/브리프 추정 ========= */
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
  if (hit(["construction","obayashi","shimizu","kajima","taisei","sekisui house","daiwa house"])) return ["建設","ゼネコン/住宅"];
  return ["-","-"];
}

/* ========= LLM 보강(옵션) ========= */
async function llmClassifyMany(rows, limit, apiKey) {
  if (!apiKey || !rows.length) return [];

  // 동적 import (런타임에만 필요)
  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey });

  // 간단 동시성 제한
  async function mapLimit(items, max, mapper) {
    const res = Array(items.length);
    let idx = 0;
    const workers = Array.from({length: Math.min(max, items.length)}, async () => {
      while (idx < items.length) {
        const i = idx++;
        res[i] = await mapper(items[i], i);
      }
    });
    await Promise.all(workers);
    return res;
  }

  const target = rows.slice(0, limit);
  const results = await mapLimit(target, 3, async (r) => {
    try {
      const prompt =
`銘柄名から「テーマ」と「ブリーフ」を簡潔な日本語で推定してください。
- 出力は必ずJSON {"theme":"...", "brief":"..."} のみ
- テーマは1~3語程度（例: "半導体製造装置","通信","建設" など）
- ブリーフはごく短い説明（例: "原油/ガス","銀行/メガバンク","装置/検査" など）
- 不明なら {"theme":"-","brief":"-"}
銘柄: ${r.name} (code: ${r.code})`;

      const resp = await client.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "あなたは日本株の銘柄を業種・テーマに素早く分類するアナリストです。" },
          { role: "user", content: prompt }
        ]
      });
      const txt = resp.choices?.[0]?.message?.content ?? "{}";
      const j = JSON.parse(txt);
      const theme = (j.theme && j.theme !== "-") ? String(j.theme) : "-";
      const brief = (j.brief && j.brief !== "-") ? String(j.brief) : "-";
      return { code: r.code, theme, brief };
    } catch {
      return { code: r.code, theme: "-", brief: "-" };
    }
  });

  return results;
}

/* ========= 메인 ========= */
async function main(){
  const TOP = Number(process.argv.find(a=>a.startsWith("--top="))?.split("=")[1] ?? "600");
  const LLM_MAX = Number(process.env.LLM_MAX ?? "150"); // LLM 보강 상한
  const apiKey = process.env.OPENAI_API_KEY || "";

  const src = "public/jpx_universe.csv";
  const dst = "public/jpx_focus.csv";

  console.log(`[info] load base: ${src}`);
  const base = await loadUniverseCsv(src);
  if (!base.length) { console.log(`[error] universe empty`); process.exit(1); }

  // 시세 취득 & 점수
  const symbols = base.map(x => x.yahooSymbol);
  console.log(`[info] fetch yahoo quotes (n=${symbols.length})`);
  const qmap = await fetchYahooBatch(symbols);

  const scored = base.map(x => {
    const q = qmap.get(x.yahooSymbol) || {};
    const price = Number(q.price||0) || Number(q.prev||0) || 0;
    const vol = Number(q.vol||0) || 0;
    const yenVolM = (price * vol) / 1e6;
    return { ...x, _yenVolM: yenVolM, _q: q };
  }).sort((a,b)=> (b._yenVolM - a._yenVolM));

  const top = scored.slice(0, TOP).map(({code,name,theme,brief,yahooSymbol}) => ({ code,name,theme,brief,yahooSymbol }));

  // (1) 규칙 보강
  for (const r of top) {
    if (!r.theme || r.theme === "-" || !r.brief || r.brief === "-") {
      const [t,b] = inferThemeBrief(r.name);
      if (!r.theme || r.theme === "-") r.theme = t;
      if (!r.brief || r.brief === "-") r.brief = b;
    }
  }

  // (2) LLM 보강 (선택)
  const missing = top.filter(r => (r.theme === "-" || r.brief === "-"));
  console.log(`[info] missing after rules: ${missing.length}`);
  if (apiKey && missing.length) {
    const picked = await llmClassifyMany(missing, LLM_MAX, apiKey);
    const byCode = new Map(picked.map(x => [x.code, x]));
    for (const r of top) {
      const upd = byCode.get(r.code);
      if (upd) {
        if (r.theme === "-" && upd.theme && upd.theme !== "-") r.theme = upd.theme;
        if (r.brief === "-" && upd.brief && upd.brief !== "-") r.brief = upd.brief;
      }
    }
  } else {
    if (!apiKey) console.log(`[info] OPENAI_API_KEY not set -> skip LLM enrich`);
  }

  // 저장
  await mkdir(dirname(dst), { recursive: true });
  const header = ["code","name","theme","brief","yahooSymbol"];
  await writeFile(dst, toCSV(top, header), "utf8");
  console.log(`[ok] focus written: ${dst} (rows=${top.length})`);
}

main().catch(e=>{ console.error(e); process.exit(1); });
