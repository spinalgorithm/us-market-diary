#!/usr/bin/env python3
# summarize_with_openai.py
# 日本語要約をGPT-5で生成。LLM無応答時はフォールバック本文を自動挿入。

import os
import sys
import json
import time
import argparse
from pathlib import Path

# OpenAI Python SDK (Responses API)
try:
    from openai import OpenAI
except Exception:
    print("ERROR: pip install openai", file=sys.stderr)
    sys.exit(2)

MAX_ITEMS = 600  # universe size cap

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
- 出力はMarkdownのみ。冒頭に見出しを重複して書かない（本文では小見出しから開始）。

集計サマリー(JSON):
{summary_json}

トップリスト(JSON):
{lists_json}
"""

def pct(x):
    return f"{x*100:.2f}%" if isinstance(x, (int, float)) else ""

def md_table(title, rows, limit=10):
    hdr = "| Ticker | Close | Vol | $Vol | %Chg |\n|---|---:|---:|---:|---:|\n"
    lines = [f"### {title}\n", hdr]
    for r in (rows or [])[:limit]:
        dv = f"{(r.get('dollar_volume') or 0)/1e6:.1f}M" if r.get("dollar_volume") is not None else ""
        pc = pct(r.get("pct_change"))
        lines.append(
            f"| {r.get('ticker','')} | {r.get('close','')} | {r.get('volume','')} | {dv} | {pc} |\n"
        )
    lines.append("\n")
    return "".join(lines)

def safe_stats(pcts):
    arr = [x for x in pcts if isinstance(x, (int, float))]
    n = len(arr)
    if n == 0:
        return {"n": 0}
    arr.sort()
    mean = sum(arr) / n
    median = arr[n // 2] if n % 2 == 1 else (arr[n // 2 - 1] + arr[n // 2]) / 2

    def q(qv: float):
        i = max(0, min(n - 1, int(qv * (n - 1))))
        return arr[i]

    return {
        "n": n,
        "mean": mean,
        "median": median,
        "p95": q(0.95),
        "p05": q(0.05),
        "gt_5": sum(1 for x in arr if x >= 0.05),
        "lt_-5": sum(1 for x in arr if x <= -0.05),
        "gt_2": sum(1 for x in arr if x >= 0.02),
        "lt_-2": sum(1 for x in arr if x <= -0.02),
    }

def build_summary(bundle: dict) -> dict:
    lists = bundle.get("lists", {})
    uni = lists.get("universe_top600_by_dollar", [])[:MAX_ITEMS]
    adv = sum(1 for r in uni if (r.get("pct_change") or 0) > 0)
    dec = sum(1 for r in uni if (r.get("pct_change") or 0) < 0)
    flat = len(uni) - adv - dec
    pstats = safe_stats([r.get("pct_change") for r in uni])

    top40 = [
        {"ticker": r.get("ticker"), "close": r.get("close"), "pct_change": r.get("pct_change")}
        for r in uni[:40]
    ]

    return {
        "date": bundle.get("date", ""),
        "breadth": {"adv": adv, "dec": dec, "flat": flat, "total": len(uni)},
        "pct_stats": pstats,
        "top10_dollar_value": lists.get("top10_dollar_value", [])[:10],
        "top10_volume": lists.get("top10_volume", [])[:10],
        "top10_gainers_ge10": lists.get("top10_gainers_ge10", [])[:10],
        "top10_losers_ge10": lists.get("top10_losers_ge10", [])[:10],
        "top40_by_dollar": top40,
    }

def call_llm(cli: OpenAI, model: str, system: str, user: str) -> str:
    for k in range(3):
        try:
            resp = cli.responses.create(
                model=model,
                max_output_tokens=int(os.getenv("OPENAI_MAX_OUTPUT_TOKENS", "2800")),
                input=[
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
            )
            return resp.output_text or ""
        except Exception:
            if k == 2:
                raise
            time.sleep(2 * (k + 1))
    return ""

def fallback_md(summary: dict) -> str:
    b = summary["breadth"]
    s = summary["pct_stats"]
    adv, dec, flat, total = b["adv"], b["dec"], b["flat"], b["total"]
    mean = s.get("mean")
    median = s.get("median")
    gt5, lt5 = s.get("gt_5", 0), s.get("lt_-5", 0)

    lines = []
    lines.append("## 市況ダイジェスト")
    lines.append(f"- 銘柄騰落: 上昇 {adv} / 下落 {dec} / 変わらず {flat}（計 {total}）")
    if mean is not None and median is not None:
        lines.append(f"- 平均騰落率 {mean*100:.2f}% / 中央値 {median*100:.2f}%")
    lines.append(f"- ±5% 以上の変動銘柄: 上昇 {gt5} / 下落 {lt5}")
    lines.append("")
    lines.append("## テーマ/セクター感（簡易）")
    tick = ", ".join(r.get("ticker", "") for r in summary["top10_dollar_value"][:10])
    lines.append(f"- 売買代金上位からの主役: {tick}")
    lines.append("")
    lines.append("## 需給・フロー（要点）")
    lines.append("- 売買代金上位は大型テック中心。指数連動のフロー優勢。")
    lines.append("- 出来高上位は低位株と大型の混在。短期回転の痕跡。")
    lines.append("")
    lines.append("## リスク")
    lines.append("- 低位・高ボラ銘柄の逆回転。")
    lines.append("- 半導体・エネルギーは外部イベントの見出しに敏感。")
    lines.append("")
    return "\n".join(lines)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bundle", required=True)
    ap.add_argument("--out", default="note_post_llm.md")
    ap.add_argument("--model", default=os.getenv("OPENAI_MODEL", "gpt-5"))
    args = ap.parse_args()

    if not os.getenv("OPENAI_API_KEY"):
        print("ERROR: set OPENAI_API_KEY", file=sys.stderr)
        sys.exit(2)

    # Read bundle
    try:
        bundle = json.load(open(args.bundle, "r", encoding="utf-8"))
    except Exception as e:
        print(f"ERROR: cannot read bundle: {e}", file=sys.stderr)
        sys.exit(2)

    summary = build_summary(bundle)
    lists = bundle.get("lists", {})

    # Build LLM prompt (compact JSON to control token size)
    user = USER_TMPL.format(
        date=summary["date"],
        summary_json=json.dumps(
            {
                "date": summary["date"],
                "breadth": summary["breadth"],
                "pct_stats": summary["pct_stats"],
                "top40_by_dollar": summary["top40_by_dollar"],
            },
            ensure_ascii=False,
        ),
        lists_json=json.dumps(
            {
                "top10_dollar_value": summary["top10_dollar_value"],
                "top10_volume": summary["top10_volume"],
                "top10_gainers_ge10": summary["top10_gainers_ge10"],
                "top10_losers_ge10": summary["top10_losers_ge10"],
            },
            ensure_ascii=False,
        ),
    )

    # Call LLM
    cli = OpenAI()
    try:
        body = call_llm(cli, args.model, SYSTEM, user)
    except Exception as e:
        print(f"WARN: LLM call failed, using fallback. Detail: {e}", file=sys.stderr)
        body = ""

    if not body or not body.strip():
        body = fallback_md(summary)

    # Assemble final Markdown
    md_parts = []
    md_parts.append(f"# 取引代金上位600米国株 デイリー要約 | {summary['date']}\n")
    md_parts.append(body.strip() + "\n")
    md_parts.append(md_table("売買代金 Top10", summary["top10_dollar_value"]))
    md_parts.append(md_table("出来高 Top10", summary["top10_volume"]))
    md_parts.append(md_table("値上がり Top10 (終値≥$10)", summary["top10_gainers_ge10"]))
    md_parts.append(md_table("値下がり Top10 (終値≥$10)", summary["top10_losers_ge10"]))

    out = "\n".join(md_parts)
    Path(args.out).write_text(out, encoding="utf-8")
    print(f"Wrote {args.out} ({len(out)} bytes)")

if __name__ == "__main__":
    main()
