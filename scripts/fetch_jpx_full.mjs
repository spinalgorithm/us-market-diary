// scripts/fetch_jpx_full.mjs
// 목적: Twelve Data /stocks 를 페이지네이션으로 긁어서
//       JP(일본) 종목만 골라 public/jpx_universe.csv 생성/덮어쓰기.
//
// 실행: node scripts/fetch_jpx_full.mjs --limit=5000
// 필요: 리포지토리 시크릿에 TWELVEDATA_API_KEY

import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import process from "node:process";

// ===== 설정 =====
const API_KEY = process.env.TWELVEDATA_API_KEY ?? "";
if (!API_KEY) {
  console.warn("[warn] TWELVEDATA_API_KEY is empty. Public quota may be tiny.");
}
const LIMIT = Number(process.argv.find(a => a.startsWith("--limit="))?.split("=")[1] ?? "5000");
const OUT = "public/jpx_universe.csv";

const COUNTRY = "Japan";                 // 일본만
const INCLUDE_TYPES = new Set(["Common Stock", "ETF", "REIT"]); // 필요시 "Fund" 추가
const MAX_PAGES = 500;                   // 안전 상한
const PAGE_PAUSE_MS = 250;               // 페이지 간 딜레이

// ===== 유틸 =====
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

function csvEncode(v) {
  if (v == null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function normalizeSymbol(sym) {
  // 1) 선행 4~5자리
  let m = sym.match(/^(\d{4,5})/);
  let code = m?.[1];
  if (!code) {
    // 2) 전체에서 4~5자리
    m = sym.match(/(\d{4,5})/);
    code = m?.[1];
  }
  if (!code) return {};
  const yahooSymbol = /\.T$/i.test(sym) ? sym.toUpperCase() : `${code}.T`;
  return { code, yahooSymbol };
}

function typeScore(t) {
  if (t === "Common Stock") return 3;
  if (t === "ETF") return 2;
  if (t === "REIT") return 1;
  return 0;
}

function exchangeScore(ex) {
  const s = (ex || "").toUpperCase();
  if (s === "TSE" || s.includes("TOKYO")) return 2;
  return 0;
}

function pickBetter(a, b) {
  // 가중치: .T 여부 > 거래소 > 타입
  const at = /\.T$/.test(a._yahoo) ? 100 : 0;
  const bt = /\.T$/.test(b._yahoo) ? 100 : 0;
  if (at !== bt) return at > bt ? a : b;

  const ae = exchangeScore(a.exchange);
  const be = exchangeScore(b.exchange);
  if (ae !== be) return ae > be ? a : b;

  const aty = typeScore(a.type);
  const bty = typeScore(b.type);
  if (aty !== bty) return aty > bty ? a : b;

  // 이름 길이 짧은 쪽(가끔 중복/변형명 처리)
  return (a.name || "").length <= (b.name || "").length ? a : b;
}

function toCSV(rows) {
  const header = "code,name,theme,brief,yahooSymbol";
  const lines = [header];
  for (const r of rows) {
    lines.push([
      csvEncode(r.code),
      csvEncode(r.name ?? ""),
      csvEncode(r.theme ?? "-"),
      csvEncode(r.brief ?? "-"),
      csvEncode(r.yahooSymbol)
    ].join(","));
  }
  return lines.join("\n") + "\n";
}

// ===== API =====
async function fetchPage(page) {
  const url = new URL("https://api.twelvedata.com/stocks");
  url.searchParams.set("country", COUNTRY);
  url.searchParams.set("page", String(page));
  if (API_KEY) url.searchParams.set("apikey", API_KEY);
  const r = await fetch(url.toString(), { cache: "no-store" });
  if (!r.ok) {
    console.warn(`[warn] /stocks page=${page} http=${r.status}`);
    return [];
  }
  const j = await r.json();
  if (!j || j.status === "error") {
    console.warn(`[warn] /stocks page=${page} api-error: ${(j && j.message) || ""}`);
    return [];
  }
  return Array.isArray(j.data) ? j.data : [];
}

// ===== 메인 =====
async function main() {
  console.log(`[info] Start fetch JP stocks. LIMIT=${LIMIT}`);
  let all = [];
  for (let p = 1; p <= MAX_PAGES; p++) {
    const arr = await fetchPage(p);
    console.log(`[info] page ${p}: ${arr.length} items`);
    if (arr.length === 0) break;
    all = all.concat(arr);
    await sleep(PAGE_PAUSE_MS);
    if (all.length > LIMIT * 3) break; // 비정상 방지
  }
  console.log(`[info] raw fetched: ${all.length}`);

  // 1) 필터
  const filtered = all.filter(x => {
    if ((x.country || "").toLowerCase() !== "japan") return false;
    if (x.currency && String(x.currency).toUpperCase() !== "JPY") return false;
    if (x.type && !INCLUDE_TYPES.has(x.type)) return false;
    return true;
  });
  console.log(`[info] after country/currency/type filter: ${filtered.length}`);

  // 2) 코드/야후 심볼 정규화
  const picked = [];
  for (const x of filtered) {
    const { code, yahooSymbol } = normalizeSymbol(x.symbol);
    if (!code || !/^\d{4,5}$/.test(code)) continue;
    picked.push({ ...x, _code: code, _yahoo: yahooSymbol ?? `${code}.T` });
  }
  console.log(`[info] after normalize: ${picked.length}`);

  // 3) 코드별 최고 후보 선택
  const bestByCode = new Map();
  for (const x of picked) {
    const prev = bestByCode.get(x._code);
    bestByCode.set(x._code, prev ? pickBetter(prev, x) : x);
  }

  let rows = Array.from(bestByCode.values())
    .map(x => ({
      code: x._code,
      name: x.name || x._code,
      theme: "-",
      brief: "-",
      yahooSymbol: x._yahoo
    }));

  // 4) 정렬 + LIMIT
  rows.sort((a, b) => Number(a.code) - Number(b.code));
  if (rows.length > LIMIT) rows = rows.slice(0, LIMIT);

  console.log(`[info] final rows: ${rows.length}`);

  const csv = toCSV(rows);

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, csv, "utf-8");
  console.log(`[done] wrote ${OUT}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
