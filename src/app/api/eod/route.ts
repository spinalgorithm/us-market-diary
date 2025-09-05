import { NextRequest, NextResponse } from 'next/server';
  import { DateTime } from 'luxon';

  export const runtime = 'nodejs';
  export const dynamic = 'force-dynamic';

  // Lazy import to avoid bundling if key is missing
  let openaiClient: any = null;
  async function getOpenAI() {
    if (!process.env.OPENAI_API_KEY) return null;
    if (!openaiClient) {
      const { OpenAI } = await import('openai');
      openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
    }
    return openaiClient;
  }

  const POLYGON_KEY = process.env.POLYGON_API_KEY || '';

  function previousUsTradingDate(nowUtc: DateTime): string {
    // Compute previous/actual trading date based on New York time.
    let nowET = nowUtc.setZone('America/New_York');
    // If current ET time is before 16:10, use previous calendar day (skip weekends)
    let d = nowET;
    const beforeClose = (nowET.hour < 16) || (nowET.hour === 16 && nowET.minute < 10);
    if (beforeClose) d = d.minus({ days: 1 });
    // Move back to last weekday if weekend
    while (d.weekday > 5) d = d.minus({ days: 1 });
    return d.toFormat('yyyy-LL-dd');
  }

  async function fetchGroupedDaily(dateStr: string) {
    const url = `https://api.polygon.io/v2/aggs/grouped/locale/us/market/stocks/${dateStr}?adjusted=true&apiKey=${POLYGON_KEY}`;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`Polygon grouped daily failed: ${res.status} ${t}`);
    }
    const json = await res.json();
    return json as any; // { results: Array<{ T, o, c, v, ... }> }
  }

  type Row = { T: string; o: number; c: number; v: number; };

  function computeLists(rows: Row[]) {
    const enriched = rows.map((r) => ({
      ticker: r.T,
      open: r.o,
      close: r.c,
      volume: r.v,
      changePct: r.o ? ((r.c - r.o) / r.o) * 100 : 0
    }))
    .filter(r => typeof r.open === 'number' && typeof r.close === 'number' && typeof r.volume === 'number' && isFinite(r.changePct));

    // Remove obvious non-common stocks (optional): warrants/units/ETFs could be filtered here by ticker suffix if desired.

    const mostActive = [...enriched].sort((a, b) => b.volume - a.volume).slice(0, 30);
    const gainers = [...enriched].sort((a, b) => b.changePct - a.changePct).slice(0, 30);
    const losers = [...enriched].sort((a, b) => a.changePct - b.changePct).slice(0, 30);

    return {
      mostActiveTop10: mostActive.slice(0, 10),
      gainersTop10: gainers.slice(0, 10),
      losersTop10: losers.slice(0, 10),
      mostActiveTop30: mostActive,
      gainersTop30: gainers,
      losersTop30: losers,
    };
  }

  function fmt(n: number | undefined, digits: number = 2) {
    return typeof n === 'number' && isFinite(n) ? n.toFixed(digits) : '-';
  }
  function fmtInt(n: number | undefined) {
    return typeof n === 'number' && isFinite(n) ? n.toLocaleString() : '-';
  }

  function tableMarkdown(rows: any[], title: string) {
    const header = `### ${title}\n| Rank | Ticker | Price(o→c) | Chg% | Volume |\n|---:|---|---|---:|---:|`;
    const body = rows.map((r, i) => `| ${i + 1} | ${r.ticker} | ${fmt(r.open)}→${fmt(r.close)} | ${fmt(r.changePct)} | ${fmtInt(r.volume)} |`).join('\n');
    return `${header}\n${body}`;
  }

  function quickBrief(lists: ReturnType<typeof computeLists>) {
    const up = lists.gainersTop10[0];
    const dn = lists.losersTop10[0];
    const act = lists.mostActiveTop10[0];
    if (!up || !dn || !act) return '데이터 표본이 충분하지 않습니다.';
    return `상승 선두는 ${up.ticker} (${fmt(up.changePct,1)}%), 하락 선두는 ${dn.ticker} (${fmt(dn.changePct,1)}%). 거래대금은 ${act.ticker}에 집중되었습니다.`;
    }

  async function writeWithLLM(dateEt: string, lists: ReturnType<typeof computeLists>) {
    const client = await getOpenAI();
    const kst = DateTime.now().setZone('Asia/Seoul').toFormat('yyyy-LL-dd HH:mm');

    const hint = quickBrief(lists);
    const system = `너는 신뢰도 높은 마켓 라이터다. 캐릭터는 '미국 야간경비원'. 신뢰감 + 가벼운 유머(10%). 데이터 근거. 과장/투자권유 금지.`;
    const user = `미국 야간경비원 일지 작성.
- 기준일(ET): ${dateEt}
- 발행(KST): ${kst}
- 요약 힌트: ${hint}
- 구성: 오프닝(2~3문단) → 오늘 결론(글머리표 3개) → 시장 한눈(EOD, 지수/섹터 간단) → 30분 리플레이 하이라이트 4~5줄 → 테마 스토리(왜 움직였나, 대표 티커 3~5, 과장 금지) → 종가 총평/내일 체크리스트.
- 한국어로 작성.`;

    if (!client) {
      // Fallback without LLM (still outputs a minimal body)
      return `## 🎙️ 오프닝 — 미국 야간경비원 보고드립니다
오늘도 새벽 순찰 완료. ${hint}

## 📌 오늘 결론(요약)
- 대형주 중심 수급
- 섹터 로테이션 감지
- 내일은 매크로 지표/실적 체크
`;
    }

    const completion = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      temperature: 0.7,
    });

    return completion.choices?.[0]?.message?.content || '';
  }

  function buildFullMarkdown(dateEt: string, lists: ReturnType<typeof computeLists>, body: string) {
    const prefix = process.env.SITE_TITLE_PREFIX || '미국 야간경비원 일지';
    const top10 = [
      tableMarkdown(lists.mostActiveTop10, 'Top 10 — 거래많은주 (Most Active)'),
      tableMarkdown(lists.gainersTop10, 'Top 10 — 급등주 (Gainers)'),
      tableMarkdown(lists.losersTop10, 'Top 10 — 하락주 (Losers)'),
    ].join('\n\n');

    const appendix = [
      tableMarkdown(lists.mostActiveTop30, 'Most Active Top 30 (EOD)'),
      tableMarkdown(lists.gainersTop30, 'Gainers Top 30 (EOD)'),
      tableMarkdown(lists.losersTop30, 'Losers Top 30 (EOD)'),
    ].join('\n\n');

    return `# ${prefix} | ${dateEt}

${body}

---

## 📊 데이터(Top10)
${top10}

---

## 📚 데이터 부록(Top30)
${appendix}

---

#미국주식 #미국야간경비원 #장마감 #나스닥 #S&P500 #증시브리핑 #테마 #상승주 #하락주 #MostActive`;
  }

  export async function GET(req: NextRequest) {
    try {
      if (!POLYGON_KEY) {
        return NextResponse.json({ ok: false, error: 'Missing POLYGON_API_KEY' }, { status: 500 });
      }
      const now = DateTime.utc();
      const dateEt = previousUsTradingDate(now);
      const data = await fetchGroupedDaily(dateEt);
      const rows = (data?.results ?? []) as Row[];
      if (!rows.length) {
        throw new Error('No EOD data returned from Polygon');
      }
      const lists = computeLists(rows);
      const body = await writeWithLLM(dateEt, lists);
      const markdown = buildFullMarkdown(dateEt, lists, body);
      return NextResponse.json({ ok: true, dateEt, markdown });
    } catch (err: any) {
      return NextResponse.json({ ok: false, error: err?.message || String(err) }, { status: 500 });
    }
  }