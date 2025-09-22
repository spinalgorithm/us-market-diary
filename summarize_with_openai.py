#!/usr/bin/env python3
import os, sys, json, time, argparse
from pathlib import Path

try:
    from openai import OpenAI
except Exception:
    print("ERROR: pip install openai", file=sys.stderr); sys.exit(2)

MAX_ITEMS = 600
CHUNK_SIZE = 220

SYSTEM = (
    "You are a quantitative market writer.\n"
    "Write terse, factual Korean. No hype. No emojis. Output Markdown < 12 KB."
)
SECTION = (
    "다음은 거래대금 상위 유니버스 일부다.\n"
    "각 항목: ticker, close, volume, dollar_volume, pct_change.\n"
    "시장 요약 3~5줄, 섹터/테마 4~7 불릿(근거 티커 표기), 수급/리스크 포인트를 간결히."
)

def chunk(a,n):
    for i in range(0,len(a),n): yield a[i:i+n]

def call_llm(cli, model, user):
    for k in range(3):
        try:
            r = cli.responses.create(
                model=model, temperature=0.2, max_output_tokens=1800,
                input=[{"role":"system","content":SYSTEM},{"role":"user","content":user}]
            )
            return r.output_text
        except Exception:
            if k==2: raise
            time.sleep(2*(k+1))

def md_table(title, rows, limit=10):
    hdr = "| Ticker | Close | Vol | $Vol | %Chg |\n|---|---:|---:|---:|---:|\n"
    lines = [f"### {title}\n", hdr]
    for r in rows[:limit]:
        pct = "" if r.get("pct_change") is None else f"{r['pct_change']*100:.2f}%"
        dv  = "" if r.get("dollar_volume") is None else f"{r['dollar_volume']/1e6:.1f}M"
        lines.append(f"| {r.get('ticker','')} | {r.get('close','')} | {r.get('volume','')} | {dv} | {pct} |\n")
    lines.append("\n")
    return "".join(lines)

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--bundle",required=True)
    ap.add_argument("--out",default="note_post_llm.md")
    ap.add_argument("--single",action="store_true",help="요약 청크 1개만 사용")
    args=ap.parse_args()

    if not os.getenv("OPENAI_API_KEY"):
        print("ERROR: set OPENAI_API_KEY", file=sys.stderr); sys.exit(2)
    model=os.getenv("OPENAI_MODEL","gpt-4.1-mini")

    b=json.load(open(args.bundle,"r",encoding="utf-8"))
    lists=b.get("lists",{})
    uni=lists.get("universe_top600_by_dollar",[])[:MAX_ITEMS]
    if not uni: print("ERROR: empty universe", file=sys.stderr); sys.exit(2)

    cli=OpenAI()
    parts=[]
    chunks = list(chunk(uni, CHUNK_SIZE))
    if args.single: chunks = chunks[:1]
    for ch in chunks:
        payload=[{"ticker":r.get("ticker"),"close":r.get("close"),
                  "volume":r.get("volume"),"dollar_volume":r.get("dollar_volume"),
                  "pct_change":r.get("pct_change")} for r in ch]
        parts.append(call_llm(cli, model, SECTION+"\n\n"+json.dumps(payload,ensure_ascii=False)))

    body="\n\n".join(parts)

    md = f"# 미국 주식 데일리 요약 | {b.get('date','')}\n\n{body}\n\n"
    md += md_table("거래대금 Top10", lists.get("top10_dollar_value",[]))
    md += md_table("거래량 Top10",   lists.get("top10_volume",[]))
    md += md_table("상승 Top10 (≥$10)", lists.get("top10_gainers_ge10",[]))
    md += md_table("하락 Top10 (≥$10)", lists.get("top10_losers_ge10",[]))

    Path(args.out).write_text(md, encoding="utf-8")
    print(f"Wrote {args.out} ({len(md)} bytes)")

if __name__=="__main__": main()
