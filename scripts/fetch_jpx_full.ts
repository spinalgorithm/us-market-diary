// scripts/fetch_jpx_full.ts
// 목적: Twelve Data /stocks에서 일본 종목을 페이지네이션으로 수집해
//       public/jpx_universe.csv 로 저장
// 실행: npx -y ts-node@10.9.2 --esm scripts/fetch_jpx_full.ts --limit=5000
//  - GitHub Actions에서는 TWELVEDATA_API_KEY 시크릿을 주입

import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

// ===== 타입 =====
type TDStock = {
  symbol: string;     // "7203", "8035.T", "7203:JP" 등
  name: string;       // 종목명
  currency?: string;  // "JPY"
  exchange?: string;  // "TSE" 등
  country?: string;   // "Japan"
  type?: string;      // "Common Stock", "ETF", "REIT" 등
};

type TDStocksResponse =
  | { data: TDStock[]; status?: string }
  | { status: "error"; message?: string }
  | any;

// ===== 설정 =====
const API_KEY = process.env.TWELVEDATA_API_KEY ?? "";
if (!API_KEY) {
  console.warn("[warn] TWELVEDATA_API_KEY is empty. Public quota may be tiny.");
}

const LIMIT = Number(process.argv.find(a => a.startsWith("--limit="))?.split("=")[1] ?? "5000");
const INCLUDE_TYPES = new Set(["Common Stock", "ETF", "REIT"]); // 필요시 "Fund" 추가
const COUNTRY = "Japan";
const MAX_PAGES = 500;       // 안전 상한
const PAGE_PAUSE_MS = 250;   // 페이지 사이 딜레이(레이트 제한 회피)

// ===== 유틸 =====
const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

function csvEncode(v: string): string {
  if (v == null) return "";
  if (/[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

// 다양한 심볼을 표준 코드/야후심볼로 정규화
function normalizeSymbol(sym: string): { code?: string; yahooSymbol?: string } {
  // 1) 선행 4~5자리 숫자 우선
  let m = sym.match(/^(\d{4,5})/);
  let code = m?.[1];

  // 2) 못 찾으면 전체에서 4~5자리 숫자 검색
  if (!code) {
    m = sym.match(/(\d{4,5})/);
    code = m?.[1];
  }
  if (!code) return {};

  // 야후 심볼로 통일
  const yahoo = /\.T$/i.test(sym) ? sym.toUpperCase() : `${code}.T`;
  return { code, yahooSymbol: yahoo };
}

// ===== API =====
async function fetchPage(page: number): Promise<TDStock[]> {
  const url = new URL("https://api.twelvedata.com/stocks");
  url.searchParams.set("country", COUNTRY);
  url.searchParams.set("page", String(page));
  url.searchParams.set("apikey", API_KEY);
  // 누락 있으면 exchange 제한을 빼두는 게 안전
  // url.searchParams.set("exchange", "TSE");

  const r = await fetch(url.toString(), { cache: "no-store" });
  if (!r.ok) {
    console.warn(`[warn] /stocks page=${page} http=${r.status}`);
    return [];
  }
  const j = (await r.json()) as TDStocksResponse;
  if (!j || (j.status === "error")) {
    console.warn(`[warn] /stocks page=${page} api-error: ${(j as any)?.message ?? ""}`);
    return [];
  }
  const arr = (j as any).data as TDStock[] | undefined;
  return Array.isArray(arr) ? arr : [];
}

// ===== CSV 포맷 =====
type CSVRow = {
  code: string;
  name: string;
  theme: string;       // 기본 "-"
  brief: string;       // 기본 "-"
  yahooSymbol: string;
};

function toCSV(rows: CSVRow[]): string {
  const header = ["code", "name", "theme", "brief", "yahooSymbol"];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        csvEncode(r.code),
        csvEncode(r.name ?? ""),
        csvEncode(r.theme ?? "-"),
        csvEncode(r.brief ?? "-"),
        csvEncode(r.yahooSymbol),
      ].join(",")
    );
  }
  return lines.join("\n") + "\n";
}

// ===== 메인 =====
async function main() {
  console.log(`[info] Start fetch JP stocks from Twelve Data /stocks, LIMIT=${LIMIT}`);
  let all: TDStock[] = [];

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
    if (x.country?.toLowerCase() !== "japan") return false;
    if (x.currency && x.currency.toUpperCase() !== "JPY") return false;
    if (x.type && !INCLUDE_TYPES.has(x.type)) return false;
    return true;
  });

  console.log(`[info] after country/currency/type filter: ${filtered.length}`);

  // 2) 코드/야후심볼 정규화 + 4~5자리 코드만 채택
  type Picked = TDStock & { _code: string; _yahoo: string };
  const picked: Picked[] = [];
  for (const x of filtered) {
    const { code, yahooSymbol } = normalizeSymbol(x.symbol);
    if (!code || !/^\d{4,5}$/.test(code)) continue;
    const ys = yahooSymbol ?? `${code}.T`;
    picked.push({ ...x, _code: code, _yahoo: ys });
  }
  console.log(`[info] after normalize: ${picked.length}`);

  // 3) 중복 제거: 같은 code 중 우선순위
  //    .T 포함, type 우선순위(Common Stock > ETF > REIT > 기타), exchange=TSE 선호
  const typeRank = (t?: string) =>
    t === "Common Stock" ? 3 : t === "ETF" ? 2 : t === "REIT" ? 1 : 0;

  const bestByCode = new Map<string, Picked>();
  for (const x of picked) {
    const prev = bestByCode.get(x._code);
    if (!prev) {
      bestByCode.set(x._code, x);
      continue;
    }
    const score = (a: Picked) =>
      (a._yahoo.endsWith(".T") ? 10 : 0) +
      (typeRank(a.type) * 2) +
      ((a.exchange?.toUpperCase() === "TSE") ? 1 : 0);
    if (score(x) > score(prev)) {
      bestByCode.set(x._code, x);
    }
  }

  let uniq = Array.from(bestByCode.values());
  // 4) LIMIT 적용
  if (uniq.length > LIMIT) uniq = uniq.slice(0, LIMIT);

  // 5) 정렬(코드 숫자 오름차순)
  uniq.sort((a, b) => Number(a._code) - Number(b._code));

  // 6) CSV 행 매핑
  const rows: CSVRow[] = uniq.map(x => ({
    code: x._code,
    name: x.name ?? x._code,
    theme: "-",
    brief: "-",
    yahooSymbol: x._yahoo,
  }));

  // 7) 쓰기
  const OUTPUT = "public/jpx_universe.csv";
  await mkdir(dirname(OUTPUT), { recursive: true });
  const csv = toCSV(rows);
  await writeFile(OUTPUT, csv, "utf8");

  console.log(`[info] wrote CSV: ${OUTPUT}, rows=${rows.length}`);
  if (rows.length > 0) {
    console.log("[info] head:");
    console.log(csv.split("\n").slice(0, 5).join("\n"));
    console.log("[info] tail:");
    console.log(csv.split("\n").slice(-5).join("\n"));
  }
}

main().catch(err => {
  console.error("[error] fetch failed:", err);
  process.exitCode = 1;
});
