// scripts/fetch_jpx_full.ts
import fs from "node:fs/promises";
import path from "node:path";

const BASE = process.env.BASE_URL ?? "https://YOUR-VERCEL-APP.vercel.app"; // 배포 도메인
const PAGE = 150;

async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`Fetch failed: ${r.status}`);
  return r.json() as Promise<T>;
}

type Row = {
  code: string; ticker: string; name: string; theme: string; brief: string;
  open: number|null; close: number|null; previousClose: number|null;
  chgPctPrev: number|null; chgPctIntraday: number|null; volume: number|null;
  yenVolM: number|null; currency: string;
};
type Resp = {
  ok: boolean; date: string; universeCount: number;
  quotes: Row[];
  rankings: {
    byValue: Row[];
    byVolume: Row[];
    topGainers: Row[];
    topLosers: Row[];
  }
};

async function main() {
  // 먼저 전체 길이를 알기 위해 count=1로 한 번
  const probe: Resp = await fetchJson(`${BASE}/api/jpx-eod?count=1`);
  const total = probe.universeCount;
  console.log(`Universe total: ${total}`);

  let all: Row[] = [];
  for (let start = 0; start < total; start += PAGE) {
    const url = `${BASE}/api/jpx-eod?start=${start}&count=${PAGE}`;
    console.log("fetch:", url);
    const page: Resp = await fetchJson(url);
    all = all.concat(page.quotes);
    // 쿨다운 (무료 소스 보호)
    await new Promise(r => setTimeout(r, 800));
  }

  // 여기서 all(전량)로 랭킹 계산해서 MD 생성
  const md = buildMarkdown(all);
  const outDir = path.join(process.cwd(), "out");
  await fs.mkdir(outDir, { recursive: true });
  const ymd = new Date().toISOString().slice(0,10);
  const outFile = path.join(outDir, `jpx_${ymd}.md`);
  await fs.writeFile(outFile, md, "utf8");
  console.log("Wrote:", outFile);
}

function buildMarkdown(rows: Row[]): string {
  const price = (r: Row) => (r.close ?? r.previousClose ?? r.open ?? 0);
  const byValue = rows.filter(r => r.yenVolM!=null)
    .sort((a,b)=> (b.yenVolM!-a.yenVolM!)).slice(0,10);
  const byVolume = rows.filter(r => r.volume!=null)
    .sort((a,b)=> (b.volume!-a.volume!)).slice(0,10);
  const elig = rows.filter(r => price(r)>=1000 && r.chgPctPrev!=null);
  const topGainers = elig.filter(r => (r.chgPctPrev as number)>0)
    .sort((a,b)=> (b.chgPctPrev!-a.chgPctPrev!)).slice(0,10);
  const topLosers = elig.filter(r => (r.chgPctPrev as number)<0)
    .sort((a,b)=> (a.chgPctPrev!-b.chgPctPrev!)).slice(0,10);

  const table = (arr: Row[], withY=false) =>
`| Rank | Ticker | o→c | Chg% | Vol ${withY? '| ¥Vol(M) ':''}| Theme | Brief |
|---:|---|---:|---:|---:|${withY?'---:|':''}---|---|
${arr.map((r,i)=>{
  const o = r.open??'-', c = r.close??'-', ch = r.chgPctPrev!=null? r.chgPctPrev.toFixed(2):'-';
  const vol = r.volume!=null? r.volume.toLocaleString():'-';
  const y = r.yenVolM!=null? r.yenVolM.toFixed(0):'-';
  return `| ${i+1} | ${r.code} | ${o}→${c} | ${ch} | ${vol} ${withY?`| ${y} `:''}| ${r.theme} | ${r.brief} |`;
}).join('\n')}`;

  return `# 日本株 夜間警備員 日誌 | ${new Date().toISOString().slice(0,10)}
> ソース: Aggregated (/api jpx-eod pages) / ユニバース: ${rows.length}銘柄

## 📊 データ(Top10)
### Top 10 — 売買代金（百万円換算）
${table(byValue, true)}

### Top 10 — 出来高（株数）
${table(byVolume)}

### Top 10 — 上昇株（¥1,000+）
${table(topGainers)}

### Top 10 — 下落株（¥1,000+）
${table(topLosers)}
`;
}

main().catch(e => { console.error(e); process.exit(1); });
