#!/usr/bin/env python3
# summarize_with_openai_jp.py
# JPX用 LLMサマリ生成。US版は触らない。
#
# Env:
#   OPENAI_API_KEY            : 必須
#   OPENAI_MODEL              : 既定 gpt-5
#   OPENAI_MAX_OUTPUT_TOKENS  : 既定 8000
#   HEADER_PREFIX             : 既定 "取引代金上位600日本株 デイリー要約"
#   MIN_PRICE_JPY             : 既定 1000  （上昇/下落の判定に併記）

import os, sys, json, argparse, statistics as stats
from pathlib import Path
from typing import Any, Dict, List

# ---------- I/O ----------
def read_bundle(p: Path) -> Dict[str, Any]:
    try:
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        print(f"ERROR: failed to read bundle: {e}", file=sys.stderr)
        sys.exit(2)

def write_text(p: Path, s: str):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(s, encoding="utf-8")

# ---------- format helpers ----------
def fmt_pct(x):
    if x is None: return ""
    try: return f"{float(x)*100:.2f}%"
    except Exception: return ""

def fmt_int(x):
    try: return f"{int(round(float(x))):,}"
    except Exception: return ""

def fmt_money_m(x):
    try: return f"{float(x)/1_000_000:.1f}M"
    except Exception: return ""

def label_ja(r):
    nm = (r.get("name") or "").strip()
    tk = (r.get("ticker") or "").strip()
    return f"{nm}（{tk}）" if nm else tk

def md_table(title_txt: str, rows: List[Dict[str, Any]]) -> str:
    if not rows: return ""
    hdr = ["銘柄","Close","Vol","$Vol","%Chg"]
    out = [title_txt, "\t".join(hdr)]
    for r in rows:
        out.append("\t".join([
            label_ja(r),
            f"{r.get('close','')}",
            fmt_int(r.get("volume")),
            fmt_money_m(r.get("dollar_volume")),
            fmt_pct(r.get("pct_change")),
        ]))
    return "\n".join(out)

def safe_list(x):
    return x if isinstance(x, list) else []

# ---------- universe stats ----------
def universe_stats(univ: List[Dict[str, Any]]) -> Dict[str, Any]:
    pc = [float(v) for v in (r.get("pct_change") for r in univ) if v is not None]
    n = len(pc)
    if n == 0:
        return {"count":0,"up":0,"down":0,"flat":0,"mean":0,"median":0,
                "within_2pct":0,"pos_2_5pct":0,"neg_2_5pct":0,"gt_5pct":0,"lt_5pct":0,
                "p95":None,"p05":None}
    up = sum(1 for x in pc if x>0)
    dn = sum(1 for x in pc if x<0)
    fl = n - up - dn
    mean = sum(pc)/n
    med = stats.median(pc)
    within_2 = sum(1 for x in pc if -0.02<=x<=0.02)
    pos_2_5 = sum(1 for x in pc if 0.02<x<=0.05)
    neg_2_5 = sum(1 for x in pc if -0.05<=x<-0.02)
    gt_5 = sum(1 for x in pc if x>0.05)
    lt_5 = sum(1 for x in pc if x<-0.05)
    srt = sorted(pc)
    def perc(p):
        k=(n-1)*p; f=int(k); c=min(f+1,n-1); d=k-f
        return srt[f]*(1-d)+srt[c]*d
    return {
        "count": n, "up": up, "down": dn, "flat": fl,
        "mean": mean, "median": med,
        "within_2pct": within_2, "pos_2_5pct": pos_2_5, "neg_2_5pct": neg_2_5,
        "gt_5pct": gt_5, "lt_5pct": lt_5,
        "p95": perc(0.95), "p05": perc(0.05)
    }

def concentration(top10: List[Dict[str, Any]], top50: List[Dict[str, Any]], base: List[Dict[str, Any]]) -> Dict[str, Any]:
    s_base = sum(float(r.get("dollar_volume") or 0) for r in base) or 1.0
    s10 = sum(float(r.get("dollar_volume") or 0) for r in top10)
    s50 = sum(float(r.get("dollar_volume") or 0) for r in top50)
    return {"top10_share": s10/s_base, "top50_share": s50/s_base}

def volume_share(vtop10: List[Dict[str, Any]], base: List[Dict[str, Any]]) -> Dict[str, Any]:
    v_base = sum(float(r.get("volume") or 0) for r in base) or 1.0
    v10 = sum(float(r.get("volume") or 0) for r in vtop10)
    return {"vol_top10_share": v10/v_base}

# ---------- OpenAI ----------
def init_openai():
    try:
        from openai import OpenAI
    except Exception:
        print("ERROR: openai package not installed", file=sys.stderr)
        sys.exit(2)
    key = os.getenv("OPENAI_API_KEY", "").strip()
    if not key:
        print("ERROR: OPENAI_API_KEY not set", file=sys.stderr); sys.exit(2)
    return OpenAI(api_key=key)

def build_prompts(data: Dict[str, Any], stats_u: Dict[str, Any], conc: Dict[str, Any], vshare: Dict[str, Any], min_price: int):
    system = (
        "あなたは機関投資家向けストラテジスト。事実のみ、簡潔、定量中心。"
        "入力データに存在しない指数・米国銘柄・ニュースは記述禁止。推測や脚色も禁止。"
        "出力は日本語。"
    )
    payload = {
        "date": data.get("date"),
        "counts": data.get("counts"),
        "stats": stats_u,
        "concentration": conc,
        "volume_share": vshare,
        "top10_dollar_value": data["lists"].get("top10_dollar_value", []),
        "top10_volume": data["lists"].get("top10_volume", []),
        "top10_gainers_ge_minprice": data["lists"].get("top10_gainers_ge10", []),
        "top10_losers_ge_minprice": data["lists"].get("top10_losers_ge10", []),
    }
    user = (
        "以下の入力に基づき、日本株のデイリー解説を作成。\n"
        "見出しは次の順で必須：\n"
        "1) 市況ダイジェスト\n"
        "2) フローと集中度\n"
        "3) テーマ・セクター\n"
        "4) セクター別ドライバー\n"
        "5) 個別イベント（必要な場合のみ）\n"
        "6) リスク\n"
        "7) トレード観点（時間軸別：デイ/数日/数週。リスク要因も併記）\n"
        "各見出しは3〜6項目の箇条書き。必ず具体的な数値（比率・件数・パーセンタイル等）を引用。"
        "『終値≥¥{minp}』の条件に言及し、米国銘柄や海外ETF名の記述は禁止。"
        "テンプレではなく、入力データ（統計・Top10群）の整合に基づく要旨のみを書く。\n\n"
        "入力:\n"
        f"{json.dumps(payload, ensure_ascii=False)}"
    ).replace("{minp}", f"{min_price:,}")
    return system, user

def call_llm(cli, model, system, user, max_tokens):
    r = cli.responses.create(
        model=model,
        input=[
            {"role":"system","content":system},
            {"role":"user","content":user}
        ],
        max_output_tokens=max_tokens
    )
    return (getattr(r, "output_text", None) or "").strip()

# ---------- main ----------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bundle", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    data = read_bundle(Path(args.bundle))
    lists = data.get("lists", {})
    univ = safe_list(lists.get("universe_top600_by_dollar"))
    if not univ:
        print("ERROR: universe_top600_by_dollar missing/empty", file=sys.stderr)
        sys.exit(2)

    stats_u = universe_stats(univ)
    conc = concentration(safe_list(lists.get("top10_dollar_value")), univ[:50], univ)
    vshare = volume_share(safe_list(lists.get("top10_volume")), univ)
    min_price = int(os.getenv("MIN_PRICE_JPY", "1000"))

    cli = init_openai()
    model = os.getenv("OPENAI_MODEL", "gpt-5")
    max_tokens = int(os.getenv("OPENAI_MAX_OUTPUT_TOKENS", "8000"))

    system, user = build_prompts(data, stats_u, conc, vshare, min_price)
    body = call_llm(cli, model, system, user, max_tokens)

    title = f'{os.getenv("HEADER_PREFIX","取引代金上位600日本株 デイリー要約")} | {data.get("date","")}'
    sections = [title, body]

    # テーブル（日本語名＋コードで出力）
    sections.append(md_table("売買代金 Top10", safe_list(lists.get("top10_dollar_value"))))
    sections.append(md_table("出来高 Top10",   safe_list(lists.get("top10_volume"))))
    sections.append(md_table(f"値上がり Top10（終値≥¥{min_price:,}）", safe_list(lists.get("top10_gainers_ge10"))))
    sections.append(md_table(f"値下がり Top10（終値≥¥{min_price:,}）", safe_list(lists.get("top10_losers_ge10"))))

    out_md = "\n\n".join([s for s in sections if s]).strip() + "\n"
    write_text(Path(args.out), out_md)

if __name__ == "__main__":
    main()
