#!/usr/bin/env python3
# summarize_with_openai_jp.py
# 用途: 日本株用の要約を単独で生成（米国版には影響しない）
# 使い方: python summarize_with_openai_jp.py --bundle out_jpx/XXXX-XX-XX/bundle.json --out note_post_llm_jpx.md
# 必須: OPENAI_API_KEY
# 任意: OPENAI_MODEL=gpt-5 / OPENAI_MAX_OUTPUT_TOKENS=7000 / MIN_PRICE_JPY=1000

import os, sys, json, argparse, statistics as stats
from pathlib import Path
from typing import Any, Dict, List

# ---------- OpenAI ----------
def init_openai():
    try:
        from openai import OpenAI
    except Exception:
        print("ERROR: pip install openai が必要", file=sys.stderr); sys.exit(2)
    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    if not api_key:
        print("ERROR: OPENAI_API_KEY 未設定", file=sys.stderr); sys.exit(2)
    return OpenAI(api_key=api_key)

# ---------- IO ----------
def read_bundle(p: Path) -> Dict[str, Any]:
    if not p.exists():
        print(f"ERROR: bundle not found: {p}", file=sys.stderr); sys.exit(2)
    with p.open("r", encoding="utf-8") as f:
        return json.load(f)

def write_text(p: Path, s: str):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(s, encoding="utf-8")

# ---------- formatting ----------
def fmt_pct(x):
    if x is None: return ""
    try: return f"{float(x)*100:.2f}%"
    except: return ""

def fmt_int(x):
    try:
        v = int(round(float(x))); return f"{v:,}"
    except: return ""

def fmt_money_m(x):
    try: return f"{float(x)/1_000_000:.1f}M"
    except: return ""

def jp_label(row):
    nm = (row.get("name") or "").strip()
    tk = (row.get("ticker") or "").strip()
    return f"{nm} ({tk})" if nm else tk

def md_table(title_txt: str, rows: List[Dict[str, Any]]) -> str:
    hdr = ["銘柄","Close","Vol","$Vol","%Chg"]
    lines = ["", title_txt, "\t".join(hdr)]
    for r in rows:
        lines.append("\t".join([
            jp_label(r),
            f"{r.get('close','')}",
            fmt_int(r.get("volume")),
            fmt_money_m(r.get("dollar_volume")),
            fmt_pct(r.get("pct_change")),
        ]))
    return "\n".join(lines)

# ---------- stats ----------
def safe_list(v):
    return v if isinstance(v, list) else []

def universe_stats(univ: List[Dict[str, Any]]) -> Dict[str, Any]:
    pc = [r.get("pct_change") for r in univ if r.get("pct_change") is not None]
    pc = [float(x) for x in pc]
    n = len(pc)
    up = sum(1 for x in pc if x > 0)
    dn = sum(1 for x in pc if x < 0)
    eq = sum(1 for x in pc if x == 0)
    mean = sum(pc)/n if n else 0.0
    med  = stats.median(pc) if n else 0.0
    within_2 = sum(1 for x in pc if -0.02 <= x <= 0.02)
    pos_2_5  = sum(1 for x in pc if 0.02 < x <= 0.05)
    neg_2_5  = sum(1 for x in pc if -0.05 <= x < -0.02)
    gt_5     = sum(1 for x in pc if x > 0.05)
    lt_5     = sum(1 for x in pc if x < -0.05)
    p95 = p05 = None
    if n:
        srt = sorted(pc)
        def perc(p):
            k = (n-1)*p; f=int(k); c=min(f+1,n-1); d=k-f
            return srt[f]*(1-d)+srt[c]*d
        p95, p05 = perc(0.95), perc(0.05)
    return {
        "count": n, "up": up, "down": dn, "flat": eq,
        "mean": mean, "median": med,
        "within_2pct": within_2, "pos_2_5pct": pos_2_5, "neg_2_5pct": neg_2_5,
        "gt_5pct": gt_5, "lt_5pct": lt_5, "p95": p95, "p05": p05
    }

def concentration(top10: List[Dict[str, Any]], top50: List[Dict[str, Any]], base: List[Dict[str, Any]]):
    s_base = sum(float(r.get("dollar_volume") or 0.0) for r in base) or 1.0
    s10 = sum(float(r.get("dollar_volume") or 0.0) for r in top10)
    s50 = sum(float(r.get("dollar_volume") or 0.0) for r in top50)
    return {"top10_share": s10/s_base, "top50_share": s50/s_base}

def volume_share(vtop10: List[Dict[str, Any]], base: List[Dict[str, Any]]):
    v_base = sum(float(r.get("volume") or 0.0) for r in base) or 1.0
    v10 = sum(float(r.get("volume") or 0.0) for r in vtop10)
    return {"vol_top10_share": v10/v_base}

# ---------- LLM ----------
def build_prompts(data: Dict[str,Any], stats_u: Dict[str,Any], conc: Dict[str,Any],
                  vshare: Dict[str,Any], min_price: int) -> tuple[str,str]:
    system = (
        "あなたは機関投資家向けのマーケットストラテジストです。"
        "事実のみ、簡潔、定量中心。提供データの範囲を超えた指数やニュースは持ち出さない。"
        "箇条書き中心、見出しは短く。米国メガキャップ・米ETFの記述は禁止。"
    )
    lists = data.get("lists", {})
    payload = {
        "date": data.get("date"),
        "market": data.get("market"),
        "counts": data.get("counts"),
        "stats": stats_u,
        "concentration": conc,
        "volume_share": vshare,
        "top10_dollar_value": lists.get("top10_dollar_value", []),
        "top10_volume": lists.get("top10_volume", []),
        "top10_gainers_ge_minprice": lists.get("top10_gainers_ge10", []),
        "top10_losers_ge_minprice": lists.get("top10_losers_ge10", []),
    }
    user = (
        "以下の入力に基づき、日次の市場解説を作成してください。\n"
        "- セクション: 市況ダイジェスト / フローと集中度 / テーマ・セクター / リスク\n"
        "- 数値は入力データのみ使用。推測禁止。\n"
        f"- 上昇/下落の注記は『終値≥¥{min_price:,}』と明記。\n"
        "- 文体は簡潔。余計な形容を避ける。\n\n"
        f"入力データ:\n{json.dumps(payload, ensure_ascii=False)}"
    )
    return system, user

def call_llm(cli, model: str, system: str, user: str, max_tokens: int) -> str:
    r = cli.responses.create(
        model=model,
        input=[{"role":"system","content":system},{"role":"user","content":user}],
        max_output_tokens=max_tokens
    )
    return (r.output_text or "").strip()

# ---------- main ----------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bundle", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    data = read_bundle(Path(args.bundle))
    date = data.get("date", "")

    # Stats and shares
    univ = safe_list(data.get("lists", {}).get("universe_top600_by_dollar"))
    stats_u = universe_stats(univ)
    top10_dv = safe_list(data.get("lists", {}).get("top10_dollar_value"))
    top50_dv = univ[:50]
    conc = concentration(top10_dv, top50_dv, univ)
    vshare = volume_share(safe_list(data.get("lists", {}).get("top10_volume")), univ)

    # LLM
    cli = init_openai()
    model = os.getenv("OPENAI_MODEL", "gpt-5")
    max_tokens = int(os.getenv("OPENAI_MAX_OUTPUT_TOKENS", "5000"))
    min_price = int(os.getenv("MIN_PRICE_JPY", "1000"))

    system, user = build_prompts(data, stats_u, conc, vshare, min_price)
    body = call_llm(cli, model, system, user, max_tokens)

    # Compose markdown
    title = f"取引代金上位600日本株 デイリー要約 | {date}"
    lists = data.get("lists", {})
    md = [title, body]
    md.append(md_table("売買代金 Top10", safe_list(lists.get("top10_dollar_value")),))
    md.append(md_table("出来高 Top10",   safe_list(lists.get("top10_volume")),))
    md.append(md_table(f"値上がり Top10 (終値≥¥{min_price:,})", safe_list(lists.get("top10_gainers_ge10")),))
    md.append(md_table(f"値下がり Top10 (終値≥¥{min_price:,})", safe_list(lists.get("top10_losers_ge10")),))
    out_text = "\n\n".join(md).strip() + "\n"
    write_text(Path(args.out), out_text)

if __name__ == "__main__":
    main()
