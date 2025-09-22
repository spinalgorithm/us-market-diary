#!/usr/bin/env python3
import os, sys, json, time, argparse
from pathlib import Path

try:
    from openai import OpenAI
except Exception:
    print("ERROR: pip install openai", file=sys.stderr); sys.exit(2)

MAX_ITEMS = 600

SYSTEM = (
    "You are a quantitative market writer.\n"
    "Write concise, factual Japanese. No emojis. No hype.\n"
    "Output Markdown only. Keep it under 12 KB."
)

USER_TMPL = """以下は米国株の集計サマリー（取引代金上位600ユニバース）とトップリストです。
これを基に、note.com向けに**短く要点だけ**の日本語マーケットダイジェストを書いてください。

要件:
- 見出し: 「取引代金上位600米国株 デイリー要約 | {date}」
- 市況ダイジェスト: 4〜6行。ブレッド（上昇/下落/変わらず）、平均/中央値、±5%銘柄比率などを活用。
- テーマ/セクター感: 4〜8項目。根拠としてティッカー2〜5個を丸括弧で添付。
- 需給・フロー: 売買代金Top10と出来高Top10から読み取れるポイントを5項目以内。
- リスク: 3〜5項目。過熱/急落/イベント。
- その下に**表を4つ**（売買代金Top10・出来高Top10・値上がりTop10(終値≥$10)・値下がりTop10(終値≥$10)）。見出しのみ日本語、表はMarkdown形式。数値は過度に細かくしない。

集計サマリー(JSON):
{summary_json}

トップリスト(JSON):
{lists_json}
"""

def pct(x): return f"{x*100:.2f}%" if x is not None else ""

def md_table(title, rows, limit=10):
    hdr = "| Ticker | Close | Vol | $Vol | %Chg |\n|---|---:|---:|---:|---:|\n"
    lines = [f"### {title}\n", hdr]
    for r in rows[:limit]:
        dv = f"{(r.get('dollar_volume') or 0)/1e6:.1f}M" if r.get("dollar_volume") is not None else ""
        pc = pct(r.get("pct_change"))
        lines.append(f"| {r.get('ticker','')} | {r.get('close','')} | {r.get('volume','')} | {dv} | {pc} |\n")
    lines.append("\n")
    return "".join(lines)

def safe_stats(pcts):
    arr = [x for x in pcts if isinstance(x, (int,float))]
    n = len(arr)
    if n == 0: return {"n":0}
    arr.sort()
    mean = sum(arr)/n
    med = arr[n//2] if n%2==1 else (arr[n//2-1]+arr[n//2])/2
    def q(qv):
        i = max(0, min(n-1, int(qv*(n-1))))
        return arr[i]
    return {
        "n": n,
        "mean": mean,
        "median": med,
        "p95": q(0.95),
        "p05": q(0.05),
        "gt_5": sum(1 for x in arr if x >= 0.05),
        "lt_-5": sum(1 for x in arr if x <= -0.05),
        "gt_2": sum(1 for x in arr if x >= 0.02),
        "lt_-2": sum(1 for x in arr if x <= -0.02),
    }

def build_summary(b):
    lists = b.get("lists",{})
    uni = lists.get("universe_top600_by_dollar",[])[:MAX_ITEMS]
    adv = sum(1 for r in uni if (r.get("pct_change") or 0) > 0)
    dec = sum(1 for r in uni if (r.get("pct_change") or 0) < 0)
    flat = len(uni) - adv - dec
    pstats = safe_stats([r.get("pct_change") for r in uni])
    # 上位カバレッジ強化として、売買代金上位40の簡易リストを添付
    top40 = [{"ticker": r.get("ticker"), "close": r.get("close"), "pct_change": r.get("pct_change")}
             for r in lists.get("universe_top600_by_dollar",[])[:40]]
    return {
        "date": b.get("date",""),
        "breadth": {"adv": adv, "dec": dec, "flat": flat, "total": len(uni)},
        "pct_stats": pstats,
        "top10_dollar_value": lists.get("top10_dollar_value",[])[:10],
        "top10_volume": lists.get("top10_volume",[])[:10],
        "top10_gainers_ge10": lists.get("top10_gainers_ge10",[])[:10],
        "top10_losers_ge10": lists.get("top10_losers_ge10",[])[:10],
        "top40_by_dollar": top40
    }

def call_llm(cli, model, system, user):
    for k in range(3):
        try:
            resp = cli.responses.create(
                model=model,
                max_output_tokens=2800,
                input=[
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
            )
            return resp.output_text
        except Exception:
            if k == 2:
                raise
            time.sleep(2 * (k + 1))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bundle", required=True)
    ap.add_argument("--out", default="note_post_llm.md")
    args = ap.parse_args()

    if not os.getenv("OPENAI_API_KEY"):
        print("ERROR: set OPENAI_API_KEY", file=sys.stderr); sys.exit(2)
    model = os.getenv("OPENAI_MODEL","gpt-5")  # ← GPT-5 사용

    b = json.load(open(args.bundle,"r",encoding="utf-8"))
    summary = build_summary(b)
    lists = b.get("lists",{})

    cli = OpenAI()
    user = USER_TMPL.format(
        date=summary["date"],
        summary_json=json.dumps({k:v for k,v in summary.items() if k not in ["top10_dollar_value","top10_volume","top10_gainers_ge10","top10_losers_ge10"]}, ensure_ascii=False),
        lists_json=json.dumps({
            "top10_dollar_value": summary["top10_dollar_value"],
            "top10_volume": summary["top10_volume"],
            "top10_gainers_ge10": summary["top10_gainers_ge10"],
            "top10_losers_ge10": summary["top10_losers_ge10"],
        }, ensure_ascii=False)
    )
    body = call_llm(cli, model, SYSTEM, user)

    md = f"# 取引代金上位600米国株 デイリー要約 | {summary['date']}\n\n{body}\n\n"
    md += md_table("売買代金 Top10", summary["top10_dollar_value"])
    md += md_table("出来高 Top10",   summary["top10_volume"])
    md += md_table("値上がり Top10 (終値≥$10)", summary["top10_gainers_ge10"])
    md += md_table("値下がり Top10 (終値≥$10)", summary["top10_losers_ge10"])

    Path(args.out).write_text(md, encoding="utf-8")
    print(f"Wrote {args.out} ({len(md)} bytes)")

if __name__ == "__main__":
    main()
