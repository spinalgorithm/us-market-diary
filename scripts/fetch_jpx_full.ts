// scripts/fetch_jpx_full.ts
/**
 * JPX 유니버스 CSV 생성기
 * - 소스: Twelve Data "stocks" 심볼 리스트 (플랜/커버리지에 따라 결과가 달라질 수 있음)
 * - 출력: public/jpx_universe.csv  (code,name,theme,brief,yahooSymbol)
 *
 * 사용:
 *   TWELVEDATA_API_KEY=xxxxx npx ts-node scripts/fetch_jpx_full.ts
 * 옵션:
 *   --out=public/jpx_universe.csv
 *   --include=stock,etf,reit (콤마구분, 기본: stock,etf,reit)
 *   --limit=5000 (최대 라인 수 상한)
 *
 * 비고:
 * - Twelve Data가 제공하는 "stocks" 리스트를 사용.
 * - 타입 명칭은 Twelve Data의 응답(type) 필드에 의존(예: "Common Stock", "ETF", "REIT"...).
 * - 야후 심볼은 기본적으로 `${code}.T`로 생성(숫자 4자리 코드를 code로 간주).
 * - code가 4자리 숫자가 아닌 항목은 스킵(필요시 로직 수정 가능).
 */

import fs from "fs/promises";
import path from "path";

// Node 18+ fetch 내장
type TDStockItem = {
  symbol?: string;           // ex) "8035" (보통 숫자코드), 가끔 영문/혼합 가능
  name?: string;             // 기업/종목명(로마자/영문)
  currency?: string;         // "JPY" 등
  exchange?: string;         // "Tokyo" 혹은 "JPX" 등
  mic_code?: string;         // "XJPX" 등
  type?: string;             // "Common Stock" | "ETF" | "REIT" | ...
};

type TDStocksResponse =
  | { data?: TDStockItem[]; next_page?: string } // 일부 문서 포맷
  | { data?: TDStockItem[]; next_page_token?: string }
  | { stocks?: TDStockItem[] }
  | TDStockItem[]; // 혹시 배열만 올 수도

type UniverseRow = {
  code: string;
  name: string;
  theme: string;
  brief: string;
  yahooSymbol: string;
};

// -------- CLI 옵션 --------
const args = Object.fromEntries(
  process.argv.slice(2).map((kv) => {
    const [k, v] = kv.split("=");
    return [k.replace(/^--/, ""), v ?? "true"];
  })
);

const OUT = args.out ?? "public/jpx_universe.csv";
const LIMIT = Math.max(100, Math.min(100000, Number(args.limit ?? "5000")));
const INCLUDE = String(args.include ?? "stock,etf,reit")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// Twelve Data API 설정
const API_KEY = process.env.TWELVEDATA_API_KEY || "";
if (!API_KEY) {
  console.error("❌ TWELVEDATA_API_KEY가 필요합니다 (.env에 설정).");
  process.exit(1);
}

// Twelve Data가 사용하는 거래소 키워드(플랜/문서 버전에 따라 다를 수 있어 여러 값을 시도)
const EXCH_KEYS = ["XJPX", "JPX", "Tokyo", "TSE"];

// -------- 유틸 --------
function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}
function isFourDigitCode(s?: string) {
  return !!s && /^\d{4}$/.test(s);
}
function tdTypeToInclude(type?: string): "stock" | "etf" | "reit" | "other" {
  const t = (type ?? "").toLowerCase();
  if (t.includes("etf")) return "etf";
  if (t.includes("reit")) return "reit";
  // ADR/Preferred 등은 제외, Common Stock만 주식으로 포함
  if (t.includes("common")) return "stock";
  return "other";
}
function tdTypeToTheme(type?: string): string {
  const g = tdTypeToInclude(type);
  if (g === "stock") return "株式";
  if (g === "etf") return "ETF";
  if (g === "reit") return "REIT";
  return "-";
}

// Twelve Data 응답을 가장 관대한 형태로 파싱
function pickItems(resp: TDStocksResponse): TDStockItem[] {
  if (Array.isArray(resp)) return resp;
  if (resp?.data && Array.isArray(resp.data)) return resp.data;
  if ((resp as any)?.stocks && Array.isArray((resp as any).stocks)) return (resp as any).stocks;
  return [];
}

// (가능 시) 페이지 토큰
function nextToken(resp: TDStocksResponse): string | undefined {
  const r: any = resp;
  return r?.next_page_token ?? r?.next_page ?? undefined;
}

// -------- Twelve Data 호출 --------
async function fetchTDStocks(exchangeKey: string, pageToken?: string) {
  const url = new URL("https://api.twelvedata.com/stocks");
  url.searchParams.set("exchange", exchangeKey);
  url.searchParams.set("apikey", API_KEY);
  // 일부 플랜/환경에서 page_token 지원, 없으면 무시됨
  if (pageToken) url.searchParams.set("page", pageToken);

  const r = await fetch(url.toString(), { cache: "no-store" });
  if (!r.ok) {
    throw new Error(`Twelve Data /stocks 실패: HTTP ${r.status}`);
  }
  const j = (await r.json()) as TDStocksResponse;
  return j;
}

// 여러 exchange 키워드를 순차 시도 + 페이지네이션
async function fetchAllTDStocks(): Promise<TDStockItem[]> {
  const seen = new Set<string>(); // symbol 중복 제거
  const out: TDStockItem[] = [];

  for (const ex of EXCH_KEYS) {
    try {
      let token: string | undefined = undefined;
      let round = 0;
      do {
        const resp = await fetchTDStocks(ex, token);
        const items = pickItems(resp);
        let added = 0;
        for (const it of items) {
          const sym = it.symbol ?? "";
          if (!sym) continue;
          if (seen.has(sym)) continue;
          seen.add(sym);
          out.push(it);
          added++;
          if (out.length >= LIMIT) break;
        }
        if (out.length >= LIMIT) break;
        token = nextToken(resp);
        round++;

        // 속도/레이트리밋 보호
        await sleep(120);
        // 안전장치: 무한루프 방지
        if (round > 200) break;
      } while (token);

      if (out.length >= LIMIT) break;
      // 잠깐 쉼
      await sleep(200);
    } catch (e: any) {
      // 한 키 실패해도 다음 키로 진행
      console.warn(`⚠️ exchange='${ex}' 시도 중 오류: ${e?.message ?? e}`);
      await sleep(200);
      continue;
    }
  }
  return out;
}

// -------- 메인 --------
async function main() {
  console.log(`▶ JPX 유니버스 생성 시작 (limit=${LIMIT}, include=${INCLUDE.join(",")})`);

  const items = await fetchAllTDStocks();
  console.log(`• Twelve Data 반환 ${items.length}건 (중복제거 후)`);

  const rows: UniverseRow[] = [];
  const taken = new Set<string>(); // code 중복 방지

  for (const it of items) {
    const symbol = String(it.symbol ?? "");
    if (!isFourDigitCode(symbol)) continue; // 4자리 숫자코드만 포함(필요시 완화 가능)

    const group = tdTypeToInclude(it.type);
    if (!INCLUDE.includes(group)) continue;

    const code = symbol;
    if (taken.has(code)) continue;
    taken.add(code);

    rows.push({
      code,
      name: it.name ?? code,
      theme: tdTypeToTheme(it.type),
      brief: "-", // 원하면 나중에 수동/별도 스크립트로 채우기
      yahooSymbol: `${code}.T`,
    });

    if (rows.length >= LIMIT) break;
  }

  // 소팅: 숫자 코드 오름차순
  rows.sort((a, b) => Number(a.code) - Number(b.code));

  // CSV 작성
  const header = "code,name,theme,brief,yahooSymbol\n";
  const csv = header + rows.map(r =>
    [
      r.code,
      csvEscape(r.name),
      csvEscape(r.theme),
      csvEscape(r.brief),
      r.yahooSymbol,
    ].join(",")
  ).join("\n") + "\n";

  const outPath = path.resolve(process.cwd(), OUT);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, csv, "utf8");

  console.log(`✅ 생성 완료: ${outPath}  (${rows.length} 종목)`);
  console.log("   이제 커밋/배포하면 /jpx_universe.csv가 API에서 자동 사용됩니다.");
}

function csvEscape(s: string) {
  // 단순 이스케이프: 쉼표/따옴표/개행 포함 시 감싸기
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

main().catch((e) => {
  console.error("❌ 실패:", e);
  process.exit(1);
});
