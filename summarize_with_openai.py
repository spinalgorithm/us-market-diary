#!/usr/bin/env python3
import os, sys, json, time, argparse
from pathlib import Path

try:
    from openai import OpenAI
except Exception:
    print("ERROR: pip install openai", file=sys.stderr); sys.exit(2)

MAX_ITEMS=600
SYSTEM="""You are a quantitative market writer.
Write terse, factual Korean. No hype. No emojis. Output Markdown < 12 KB."""
SECTION="""다음은 거래대금 상위 유니버스 일부다.
각 항목: ticker, close, volume, dollar_volume, pct_change.
시장 요약 3~5줄, 섹터/테마 4~7 불릿(근거 티커 표기), 수급/리스크 포인트를 간결히."""

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
        except Exception as e:
            if k==2: raise
            time.sleep(2*(k+1))

def main():
    ap=argparse.ArgumentParser(); ap.add_argument("--bundle",required=True); ap.add_argument("--out",default="note_post_llm.md")
    args=ap.parse_args()

    key=os.getenv("OPENAI_API_KEY"); model=os.getenv("OPENAI_MODEL","gpt-4.1-mini")
    if not key: print("ERROR: set OPENAI_API_KEY", file=sys.stderr); sys.exit(2)

    b=json.load(open(args.bundle,"r",encoding="utf-8"))
    u=b.get("lists",{}).get("universe_top600_by_dollar",[])[:MAX_ITEMS]
    if not u: print("ERROR: empty universe", file=sys.stderr); sys.exit(2)

    cli=OpenAI()
    parts=[]
    for ch in chunk(u,220):
        payload=[{"ticker":r.get("ticker"),"close":r.get("close"),
                  "volume":r.get("volume"),"dollar_volume":r.get("dollar_volume"),
                  "pct_change":r.get("pct_change")} for r in ch]
        parts.append(call_llm(cli, model, SECTION+"\n\n"+json.dumps(payload,ensure_ascii=False)))
    body="\n\n".join(parts)

    md = f"# 미국 주식 데일리 요약 | {b.get('date','')}\n\n{body}\n\n"
    md += "### 표는 웹에서 렌더됨(Top10 4종)\n"
    Path(args.out).write_text(md, encoding="utf-8")
    print(f"Wrote {args.out}")

if __name__=="__main__": main()
