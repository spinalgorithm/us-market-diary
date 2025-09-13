// scripts/fetch_jpx_full.ts
// 목적: Twelve Data /stocks에서 일본 종목을 페이지네이션으로 전부 수집해
//       public/jpx_universe.csv 로 저장.
// 실행: npm run fetch:jpx  (GitHub Actions에서 TWELVEDATA_API_KEY로 실행됨)

import { writeFile } from "node:fs/promises";

type TDStock = {
  symbol: string;      // 예: "7203", "8035.T", "7203:JP" 등
  name: string;        // 종목명
  currency?: string;   // "JPY" 등
  exchange?: string;   // "TSE" 등
  country?: string;    // "Japan"
  type?: string;       // "Common Stock", "ETF", "REIT" 등
};

type TDStocksResponse =
  | { data: TDStock[]; status?: string }
  | { status: "error"; message?: string }
  | any;

const API_KEY = process.env.TWELVEDATA_API_KEY ?? "";
if (!API_KEY) {
  console.warn("[warn] TWELVEDATA_API_KEY is empty. You can still try, but quota may be tiny.");
}

// ---- 설정값(필요시 조정) ----
const LIMIT = Number(process.argv.find(a => a.startsWith("--limit="))?.split("=")[1] ?? "5000");
const INCLUDE_TYPES = new Set(["Common Stock", "ETF", "REIT"]); // 필요시 "Fund" 등 추가
const COUNTRY = "Japan";     // 일본만
// exchange 필터를 너무 좁히면 누락될 수 있어 country만으로 먼저 긁고, 후처리로 정제합니다.
const MAX_PAGES = 500;       // 안전 상한
const PAGE_PAUSE_MS = 250;   // 페이지 사이 살짝 딜레이(레이트 제한 방지)

// ---- 유틸 ----
const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

// 12Data /stocks 페이지 단위 요청
async function fetchPage(page: number): Promise<TDStock[]> {
  const url = new URL("https://api.twelvedata.com/stocks");
  url.searchParams.set("country", COUNTRY);
  url.searchParams.set("page", String(page));
  url.searchParams.set("apikey", API_KEY);
  // 필요시 exchange를 추가로 좁혀보고 싶다면:
  // url.searchParams.set("exchange", "TSE"); // 누락 생기면 주석 처리하세요.

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
  if (!Array.isArray(arr)) return [];
  return arr;
}

// 심볼에서 JP 코드/야후심볼 추출
function normalizeSymbol(s: string) {
  // 다양한 패턴 대응: "8035", "8035.T", "8035:JP", "8035.TOKYO" 등 가능성
  // 1) 숫자만 추출(선행 숫자 덩어리)
  const m = s.match(/^(\d{3,5})/);
  const code = m ? m[1] : s.replace(/[:.].*$/, "");

  // 2) 야후 심볼로 통일
  //    이미 *.T 이면 그대로, 아니면 "<code>.T"
  const yahoo =
    /\.T$/i.test(s) ? s.toUpperCase() :
    `${code}.T`;

  return { code, yahooSymbol: yahoo };
}

// CSV 행 포맷
type CSVRow = {
  code: string;
  name: string;
  theme: string;       // 비워두면 "-" (추후 수동 보강 가능)
  brief: string;       // 비워두면 "-"
  yahooSymbol: string;
};

function toCSV(rows: CSVRow[]): string {
  const header = ["code", "name", "theme", "brief", "yahooSymbol"];
  const lines = [header.join(",")];
  for (const r of rows) {
    // 아주 단순 CSV (필드에 쉼표가 거의 없다고 가정; 필요시 더 견고한 CSV 인코딩 적용)
    lines.push(
      [r.code, r.name ?? "", r.theme ?? "-", r.brief ?? "-", r.yahooSymbol].map(v =>
        /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
      ).join(",")
    );
  }
  return lines.join("\n") + "\n";
}

async function main() {
  console.log(`[info] Start fetch JP stocks from Twelve Data /stocks, LIMIT=${LIMIT}`);
  let all: TDStock[] = [];
  for (let p = 1; p <= MAX_PAGES; p++) {
    const arr = await fetchPage(p);
    console.log(`[info] page ${p}: ${arr.length} items`);
    if (arr.length === 0) break;
    all = all.concat(arr);
    await sleep(PAGE_PAUSE_MS);
    if (all.length > LIMIT * 3) {
      // 비정상 폭주 방지
      break;
    }
  }
  console.log(`[info] raw fetched: ${all.length}`);

  // 1) 국가/통화 정제
  const jpy = all.filter(x =>
    (x.country?.toLowerCase() === "japan") &&
    (!x.currency || x.currency.toUpperCase() === "JPY")
  );

  // 2) 타입 필터
  const typed = jpy.filter(x => !x.type || INCLUDE_TYPES.has(x.type));

  console.log(`[info] after filter country=Japan,currency=JPY,type in ${[...INCLUDE_TYPES].join("/")}: ${typed.length}`);

  // 3) 코드/야후심볼 정규화 + dedupe (code 기준)
  const map = new Map<string, CSVRow>();
  for (const s of typed) {
    const { code, yahooSymbol } = normalizeSymbol(s.symbol);
    if (!/^\d{3,5}$/.test(code)) continue; // 일본 코드는 보통 숫자 4자리 (ETF/REIT 등 3~5자리도 존재)
    if (!map.has(code)) {
      map.set(code, {
        code,
        name: s.name ?? code,
        theme: "-",         // 필요시 나중에 수동 보강
        brief: "-",
        yahooSymbol,
      });
    }
  }

  // 4) 정렬 및 LIMIT 적용
  const rows = [...map.values()].sort((a, b) => Number(a.code) - Number(b.code)).slice(0, LIMIT);

  console.log(`[info] final rows: ${rows.length}`);

  // 5) CSV 저장
  const csv = toCSV(rows);
  await writeFile("public/jpx_universe.csv", csv, "utf8");
  console.log(`[done] wrote public/jpx_universe.csv (${rows.length} rows)`);
}

main().catch((e) => {
  console.error("[fatal] fetch_jpx_full failed:", e);
  process.exit(1);
});
