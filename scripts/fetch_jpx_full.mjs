// scripts/fetch_jpx_full.mjs
// 목적: Twelve Data /stocks에서 일본 종목을 페이지네이션으로 수집해
//       public/jpx_universe.csv 로 저장
// 실행: node scripts/fetch_jpx_full.mjs --limit=5000
//  - GitHub Actions에서는 TWELVEDATA_API_KEY 시크릿을 주입

import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

// ===== 설정 =====
const API_KEY = process.env.TWELVEDATA_API_KEY ?? "";
if (!API_KEY) {
  console.warn("[warn] TWELVEDATA_API_KEY is empty. Public quota may be tiny.");
}

const argLimit = process.argv.find(a => a.startsWith("--limit="));
const LIMIT = Number(argLimit ? argLimit.split("=")[1] : "5000");
const INCLUDE_TYPES = new Set(["Common Stock", "ETF", "REIT"]); // 필요시 "Fund" 추가
const COUNTRY = "Japan";
const MAX_PAGES = 500;       // 안전 상한
const PAGE_PAUSE_MS = 250;   // 페이지 사이 딜레이(레이트 제한 회피)

// ===== 유틸 =====
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

function csvEncode(v) {
  if (v == null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// 다양한 심볼을 표준 코드/야후심볼로 정규화
function normalizeSymbol(sym) {
  // 1) 선행 4~5자리 숫자 우선
  let m = sym.match(/^(\d{4,5})/);
  let code = m?.[1];
  // 2) 못 찾으면 전체에서 4~5자리 숫자 검색
  if (!code) {
    m = sym.match(/(\d{4,5})/);
    code = m?.[1];
  }
  if (!code) return {};
  // 야후 심볼로 통일 (.T 있으면 유지)
  const yahoo = /\.T$/i.test(sym) ? sym.toUpperCase() : `${code}.T`;
  return { code, yahooSymbol: yahoo };
}

function toCSV(rows) {
  const header = ["code", "name", "theme", "brief", "yahooSymbol"];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push([
      csvEncode(r.code),
      csvEncode(r.name ?? ""),
      csvEncode(r.theme ?? "-"),
      csvEncode(r.brief ?? "-"),
      csvEncode(r.yahooSymbol),
    ].join(","));
  }
  return lines.join("\n") + "\n";
}

async function fetchPage(page) {
  const url = new URL("https://api.twelvedata.com/stocks");
  url.searchParams.set("country", COUNTRY);
  url.searchParams.set("page", String(page));
  url.searchParams.set("apikey", API_KEY);
  const r = await fetch(url.toString(), { cache: "no-store" });
  if (!r.ok) {
    console.warn(`[warn] /stocks page=${page} http=${r.status}`);
    return [];
  }
  const j = await r.json();
  if (!j || j.status === "error") {
    console.warn(`[warn] /stocks page=${page} api-error: ${j?.message ?? ""}`);
    return [];
  }
  const arr = j.data;
  return Array.isArray(arr) ? arr : [];
}

function typeRank(t) {
  return t === "Common Stock" ? 3 : t === "ETF" ? 2 : t === "REIT" ? 1 : 0;
}
function exRank(ex) {
  if (!ex) return 0;
  const s = String(ex).toUpperCase();
  if (s.includes("TSE") || s.includes("TOKYO")) return 2;
  return 1;
}

async function main() {
  console.log(`[info] Start fetch JP stocks from Twelve Data /stocks, LIMIT=${LIMIT}`);
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

  // 1) 1차 필터: 국가/통화/타입
  const filtered = all.filter(x => {
    if ((x.country ?? "").toLowerCase() !== "japan") return false;
    if (x.currency && String(x.currency).toUpperCase() !== "JPY") return false;
    if (x.type && !INCLUDE_TYPES.has(x.type)) return false;
    return true;
  });
  console.log(`[info] after country/currency/type filter: ${filtered.length}`);

  // 2) 코드/야후심볼 정규화 + 4~5자리 코드만 채택
  const picked = [];
  for (const x of filtered) {
    const norm = normalizeSymbol(x.symbol);
    if (!norm.code || !/^\d{4,5}$/.test(norm.code)) continue;
    picked.push({ ...x, _code: norm.code, _yahoo: norm.yahooSymbol ?? `${norm.code}.T` });
  }
  console.log(`[info] after normalize: ${picked.length}`);

  // 3) 중복 제거: 같은 code 중 우선순위 (.T, type 순, 거래소 순)
  const bestByCode = new Map();
  for (const x of picked) {
    const prev = bestByCode.get(x._code);
    if (!prev) { bestByCode.set(x._code, x); continue; }
    const candScore =
      (x._yahoo.endsWith(".T") ? 10 : 0) + typeRank(x.type) * 3 + exRank(x.exchange);
    const prevScore =
      (prev._yahoo.endsWith(".T") ? 10 : 0) + typeRank(prev.type) * 3 + exRank(prev.exchange);
    if (candScore > prevScore) bestByCode.set(x._code, x);
  }

  let rows = Array.from(bestByCode.values())
    .map(x => ({
      code: x._code,
      name: x.name || x._code,
      theme: "-",
      brief: "-",
      yahooSymbol: x._yahoo,
    }))
    .sort((a, b) => Number(a.code) - Number(b.code));

  // 4) LIMIT 적용
  if (rows.length > LIMIT) rows = rows.slice(0, LIMIT);

  console.log(`[info] final rows: ${rows.length}`);

  // 5) 저장
  const outPath = "public/jpx_universe.csv";
  await mkdir(dirname(outPath), { recursive: true });
  const csv = toCSV(rows);
  await writeFile(outPath, csv, "utf-8");
  console.log(`[info] wrote ${rows.length} rows to ${outPath}`);
}

main().catch(err => {
  console.error("[fatal]", err);
  process.exitCode = 1;
});
