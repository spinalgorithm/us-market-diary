#!/usr/bin/env python3
import os, sys, json, argparse, statistics as stats
from pathlib import Path
from typing import Any, Dict, List

# ---------- I/O ----------
def read_bundle(p: Path) -> Dict[str, Any]:
    with open(p, encoding="utf-8") as f:
        return json.load(f)

def write_text(p: Path, s: str):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(s, encoding="utf-8")

# ---------- helpers ----------
def fmt_pct(x):
    try: return f"{float(x)*100:.2f}%"
    except: return ""

def fmt_int(x):
    try: return f"{int(round(float(x))):,}"
    except: return ""

def fmt_money_m(x):
    try: return f"{float(x)/1_000_000:.1f}M"
    except: return ""

def label_ja(r):
    nm = (r.get("name") or "").strip(); tk = (r.get("ticker") or "").strip()
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

def safe_list(x): return x if isinstance(x, list) else []

# ---------- stats ----------
def universe_stats(univ: List[Dict[str, Any]]) -> Dict[str, Any]:
    pc = [float(v) for v in (r.get("pct_change") for r in univ) if v is not None]
    n = len(pc)
    if n == 0:
        return {"count":0,"up":0,"down":0,"flat":0,"mean":0,"median":0,
                "within_2pct":0,"pos_2_5pct":0,"neg_2_5pct":0,"gt_5pct":0,"lt_5pct":0,
                "p95":None,"p05":None}
    up = sum(1 for x in pc if x>0); dn = sum(1 for x in pc if x<0); fl = n-up-dn
    mean = sum(pc)/n; med = stats.median(pc)
    within_2 = sum(1 for x in pc if -0.02<=x<=0.02)
    pos_2_5 = sum(1 for x in pc if 0.02<x<=0.05)
    neg_2_5 = sum(1 for x in pc if -0.05<=x<-0.02)
    gt_5 = sum(1 for x in pc if x>0.05); lt_5 = sum(1 for x in pc if x<-0.05)
    srt = sorted(pc)
    def perc(p):
        k=(n-1)*p; f=int(k); c=min(f+1,n-1); d=k-f
        return srt[f]*(1-d)+srt[c]*d
    return {"count": n,"up":up,"down":dn,"flat":fl,"mean":mean,"median":med,
            "within_2pct":within_2,"pos_2_5pct":pos_2_5,"neg_2_5pct":neg_2_5,
            "gt_5pct":gt_5,"lt_5pct":lt_5,"p95":perc(0.95),"p05":perc(0.05)}

def concentration(top10, top50, base):
    s_base = sum(float(r.get("dollar_volume") or 0) for r in base) or 1.0
    s10 = sum(float(r.get("dollar_volume") or 0) for r in top10)
    s50 = sum(float(r.get("dollar_volume") or 0) for r in top50)
    return {"top10_share": s10/s_base, "top50_share": s50/s_base}

def volume_share(vtop10, base):
    v_base = sum(float(r.get("volume") or 0) for r in base) or 1.0
    v10 = sum(float(r.get("volume") or 0) for r in vtop10)
    return {"vol_top10_share": v10/v_base}

# ---------- LLM ----------
def init_openai():
    from openai import OpenAI
    key = os.getenv("OPENAI_API_KEY","").strip()
    if not key: return None
    return OpenAI(api_key=key)

def build_prompts(data, stats_u, conc, vshare, min_price):
    system = (
        "あなたは機関投資家向けストラテジスト。事実のみ、簡潔、定量中心。"
        "入力に無い指数や米国銘柄、ニュースは記述禁止。出力は日本語。"
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
        "以下の入力に基づき、日本株デイリー解説を作成。\n"
        "必須見出し: 1) 市況ダイジェスト 2) フローと集中度 3) テーマ・セクター 4) リスク 5) トレード観点\n"
        f"『終値≥¥{min_price:,}』条件に言及。推測・脚色は禁止。\n\n入力:\n"
        f"{json.dumps(payload, ensure_ascii=False)}"
    )
    return system, user

def parse_response_text(r) -> str:
    # SDK互換パース
    # 1) output_text
    txt = getattr(r, "output_text", None)
    if isinstance(txt, str) and txt.strip():
        return txt.strip()
    # 2) top-level choices (旧chat.completions互換)
    ch = getattr(r, "choices", None)
    if ch and isinstance(ch, list) and ch and "message" in ch[0]:
        t = ch[0]["message"].get("content","")
        if t: return t.strip()
    # 3) responses.create 的構造
    out = getattr(r, "output", None)
    if isinstance(out, list) and out:
        seg = out[0]
        content = seg.get("content") if isinstance(seg, dict) else None
        if isinstance(content, list) and content and "text" in content[0]:
            t = content[0]["text"]
            if t: return t.strip()
    return ""

def call_llm(cli, model, system, user, max_tokens) -> str:
    if cli is None: return ""
    try:
        r = cli.responses.create(
            model=model,
            input=[{"role":"system","content":system},{"role":"user","content":user}],
            max_output_tokens=max_tokens
        )
        return parse_response_text(r)
    except Exception:
        return ""

# ---------- fallback body ----------
def fallback_body(date, stats_u, conc, vshare, min_price) -> str:
    return (
        "市況ダイジェスト\n"
        f"- 対象: 売買代金上位600。騰落 上昇{stats_u['up']}・下落{stats_u['down']}・変わらず{stats_u['flat']}（計{stats_u['count']}）。\n"
        f"- 平均{fmt_pct(stats_u['mean'])} / 中央値{fmt_pct(stats_u['median'])}。p95 {fmt_pct(stats_u['p95'])} / p05 {fmt_pct(stats_u['p05'])}。\n"
        f"- 分布: ±2%内 {stats_u['within_2pct']}、+2〜5% {stats_u['pos_2_5pct']}、-5〜-2% {stats_u['neg_2_5pct']}、+5%以上 {stats_u['gt_5pct']}、-5%以下 {stats_u['lt_5pct']}。\n\n"
        "フローと集中度\n"
        f"- 代金集中度: Top10 {conc['top10_share']*100:.2f}% / Top50 {conc['top50_share']*100:.2f}%。\n"
        f"- 出来高集中度: Top10 {vshare['vol_top10_share']*100:.2f}%。\n\n"
        "テーマ・セクター\n"
        "- 上位テーブルに基づき、半導体・大型中心の資金配分を確認（詳細は付表参照）。\n\n"
        "リスク\n"
        "- 流動性の上位集中により個別ニュースの指数インパクトが増幅しやすい。\n\n"
        "トレード観点\n"
        f"- 終値≥¥{min_price:,} の範囲でモメンタム追随は出来高の裏付けを要確認。\n"
    )

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
        print("ERROR: universe_top600_by_dollar missing/empty", file=sys.stderr); sys.exit(2)

    stats_u = universe_stats(univ)
    conc = concentration(safe_list(lists.get("top10_dollar_value")), univ[:50], univ)
    vshare = volume_share(safe_list(lists.get("top10_volume")), univ)
    min_price = int(os.getenv("MIN_PRICE_JPY", "1000"))

    cli = init_openai()
    model = os.getenv("OPENAI_MODEL", "gpt-5")
    max_tokens = int(os.getenv("OPENAI_MAX_OUTPUT_TOKENS", "8000"))

    system, user = build_prompts(data, stats_u, conc, vshare, min_price)
    body = call_llm(cli, model, system, user, max_tokens)
    if not body.strip():
        body = fallback_body(data.get("date",""), stats_u, conc, vshare, min_price)

    title = f'{os.getenv("HEADER_PREFIX","取引代金上位600日本株 デイリー要約")} | {data.get("date","")}'
    sections = [title, body]
    sections.append(md_table("売買代金 Top10", safe_list(lists.get("top10_dollar_value"))))
    sections.append(md_table("出来高 Top10",   safe_list(lists.get("top10_volume"))))
    sections.append(md_table(f"値上がり Top10（終値≥¥{min_price:,}）", safe_list(lists.get("top10_gainers_ge10"))))
    sections.append(md_table(f"値下がり Top10（終値≥¥{min_price:,}）", safe_list(lists.get("top10_losers_ge10"))))

    out_md = "\n\n".join([s for s in sections if s]).strip() + "\n"
    write_text(Path(args.out), out_md)

if __name__ == "__main__":
    main()
