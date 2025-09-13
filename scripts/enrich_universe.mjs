// scripts/enrich_universe.mjs
// 목적: public/jpx_universe.csv에서 theme/brief가 빈("-") 항목을
//       data/jpx_theme_map.json(사용자 사전)로 채워 넣어 같은 경로로 덮어쓰기.
//
// 실행: node scripts/enrich_universe.mjs
// 비고: 사전 파일이 없으면, 내장된 몇 개 샘플만 사용(그 외는 그대로 둠)

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const IN = "public/jpx_universe.csv";
const OUT = "public/jpx_universe.csv"; // 같은 파일에 덮어쓰기
const MAP_FILE = "data/jpx_theme_map.json";

// --- 간단 CSV 파서/직렬화 (따옴표/쉼표 최소 대응) ---
function parseCSV(text) {
  const rows = [];
  let i = 0, cur = [], field = "", inQuotes = false;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      } else { field += ch; i++; continue; }
    } else {
      if (ch === '"') { inQuotes = true; i++; continue; }
      if (ch === ',') { cur.push(field); field = ""; i++; continue; }
      if (ch === '\n') { cur.push(field); rows.push(cur); cur = []; field = ""; i++; continue; }
      if (ch === '\r') { i++; continue; }
      field += ch; i++; continue;
    }
  }
  // 끝 필드 처리
  cur.push(field);
  if (cur.length > 1 || (cur.length === 1 && cur[0] !== "")) rows.push(cur);
  return rows;
}

function toCSV(rows) {
  const esc = (v) => {
    const s = v ?? "";
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map(r => r.map(esc).join(",")).join("\n") + "\n";
}

// --- 사전 로드(없으면 내장 샘플만) ---
async function loadThemeMap() {
  try {
    const t = await readFile(MAP_FILE, "utf-8");
    const arr = JSON.parse(t);
    if (Array.isArray(arr)) return arr;
  } catch {}
  // 내장 샘플(원하면 여기에 계속 추가해도 됨)
  return [
    { code: "8035", theme: "半導体製造装置", brief: "製造装置大手" },
    { code: "6920", theme: "半導体検査", brief: "EUV検査" },
    { code: "6857", theme: "半導体検査", brief: "テスタ大手" },
    { code: "4063", theme: "素材/化学", brief: "半導体用シリコン" },
    { code: "6594", theme: "電機/モーター", brief: "小型モーター/EV" },
    { code: "6758", theme: "エレクトロニクス", brief: "ゲーム/画像センサー/音楽" },
    { code: "7203", theme: "自動車", brief: "世界最大級の自動車メーカー" },
    { code: "9984", theme: "投資/テック", brief: "投資持株/通信" },
    { code: "9983", theme: "アパレル/SPA", brief: "ユニクロ" },
    { code: "9432", theme: "通信", brief: "国内通信大手" },
    { code: "9433", theme: "通信", brief: "au/通信" },
    { code: "9434", theme: "通信", brief: "携帯通信" },
    { code: "6501", theme: "総合電機", brief: "社会インフラ/IT" },
  ];
}

// --- 메인 ---
async function main() {
  const csv = await readFile(IN, "utf-8");
  const rows = parseCSV(csv);
  if (rows.length === 0) throw new Error("CSV empty");

  const header = rows[0];
  const idx = Object.fromEntries(header.map((h, i) => [h.trim().toLowerCase(), i]));

  const need = ["code","name","theme","brief","yahoosymbol"];
  for (const k of need) {
    if (!(k in idx)) throw new Error(`missing column: ${k}`);
  }

  const themeMap = await loadThemeMap();
  const byCode = new Map(themeMap.map(x => [String(x.code), x]));
  const byYahoo = new Map(themeMap.map(x => [String(x.yahooSymbol || ""), x]).filter(([k]) => !!k));

  // 첫 행(헤더) 제외
  const dataRows = rows.slice(1);

  let changed = 0;
  for (const r of dataRows) {
    const code = (r[idx["code"]] ?? "").trim();
    const yahoo = (r[idx["yahoosymbol"]] ?? "").trim();
    const curTheme = (r[idx["theme"]] ?? "").trim();
    const curBrief = (r[idx["brief"]] ?? "").trim();

    if (curTheme !== "-" && curTheme !== "" && curBrief !== "-" && curBrief !== "") {
      continue; // 이미 채워져 있으면 유지
    }

    const m = byCode.get(code) || byYahoo.get(yahoo);
    if (m) {
      if (curTheme === "-" || curTheme === "") r[idx["theme"]] = m.theme ?? "-";
      if (curBrief === "-" || curBrief === "") r[idx["brief"]] = m.brief ?? "-";
      changed++;
    }
  }

  const out = [header, ...dataRows];
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, toCSV(out), "utf-8");
  console.log(`[enrich] done. rows=${dataRows.length}, updated=${changed}, out=${OUT}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
