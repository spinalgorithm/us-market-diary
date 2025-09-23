#!/usr/bin/env python3
import os, sys, json, argparse, statistics as stats
from pathlib import Path
from typing import Any, Dict, List

def read_bundle(p: Path) -> Dict[str, Any]:
    with open(p, encoding="utf-8") as f:
        return json.load(f)

def write_text(p: Path, s: str):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(s, encoding="utf-8")

def safe_list(x): return x if isinstance(x, list) else []

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

def init_openai():
    from openai import OpenAI
    key = os.getenv("OPENAI_API_KEY","").strip()
    if not key: return None
    return OpenAI(api_key=key)

def build_prompts(data, stats_u, conc, vshare, themes, min_price):
    system = (
        "あなたは機関投資家向けの日本株ストラテジスト。事実のみ、短文、定量重視。"
        "入力外の指数・米株・推測は厳禁。出力は日本語。"
    )
    payload = {
        "date": data.get("date"),
        "counts": data.get("counts"),
        "stats": stats_u,
        "concentration": conc,
        "volume_share": vshare,
        "themes": themes[:8],  # 上位テーマのみ
        "leaders_top10": [ {"name": (r.get("name") or ""), "ticker": r.get("ticker"), "pct": r.get("pct_change")} for r in data["lists"].get("top10_dollar_value", []) ],
        "gainers": [ {"name": (r.get("name") or ""), "ticker": r.get("ticker"), "pct": r.get("pct_change")} for r in data["lists"].get("top10_gainers_ge10", []) ],
        "losers":  [ {"name": (r.get("name") or ""), "ticker": r.get("ticker"), "pct": r.get("pct_change")} for r in data["lists"].get("top10_losers_ge10",  []) ],
    }
    user = (
        "以下のJSONだけを根拠にデイリー要約を作成。"
        "必須セクション: 1) 市況ダイジェスト 2) フローと集中度 3) テーマ・セクター 4) リスク 5) トレード観点。"
        f"『終値≥¥{min_price:,}』は明記。箇条書き中心、短文、ポジトーク禁止。\n\n"
        f"{json.dumps(payload, ensure_ascii=False)}"
    )
    return system, user

def parse_response_text(r) -> str:
    txt = getattr(r, "output_text", None)
    if isinstance(txt, str) and txt.strip():
        return txt.strip()
    ch = getattr(r, "choices", None)
    if ch and isinstance(ch, list) and ch and "message" in ch[0]:
        t = ch[0]["message"].get("content","")
        if t: return t.strip()
    out = getattr(r, "output", None)
    if isinstance(out, list) and out:
        content = out[0].get("content")
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

def md_themes(themes: List[Dict[str,Any]]) -> str:
    if not themes: return ""
    lines = ["テーマ概況（Top）"]
    for t in themes[:8]:
        share = f"{float(t.get('share',0))*100:.2f}%"
        leaders = ", ".join([f"{(x.get('name') or x.get('ticker'))}({fmt_pct(x.get('pct'))})" for x in t.get("leaders",[])])
        lines.append(f"- {t['theme']}: 比率 {share}, 主な構成 {leaders}")
    return "\n".join(lines)

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

def concentration(top10, top50, base):
    s_base = sum(float(r.get("dollar_volume") or 0) for r in base) or 1.0
    s10 = sum(float(r.get("dollar_volume") or 0) for r in top10)
    s50 = sum(float(r.get("dollar_volume") or 0) for r in top50)
    return {"top10_share": s10/s_base, "top50_share": s50/s_base}

def volume_share(vtop10, base):
    v_base = sum(float(r.get("volume") or 0) for r in base) or 1.0
    v10 = sum(float(r.get("volume") or 0) for r in vtop10)
    return {"vol_top10_share": v10/v_base}

def fallback_body(stats_u, conc, vshare, themes, min_price) -> str:
    return (
        "市況ダイジェスト\n"
        f"- 騰落 上昇{stats_u['up']}・下落{stats_u['down']}・変わらず{stats_u['flat']}（{stats_u['count']}）。\n"
        f"- 平均{fmt_pct(stats_u['mean'])} / 中央値{fmt_pct(stats_u['median'])}。p95 {fmt_pct(stats_u['p95'])} / p05 {fmt_pct(stats_u['p05'])}。\n\n"
        "フローと集中度\n"
        f"- 代金集中度 Top10 {conc['top10_share']*100:.2f}% / Top50 {conc['top50_share']*100:.2f}%、出来高Top10 {vshare['vol_top10_share']*100:.2f}%。\n\n"
        + md_themes(themes) + "\n\n"
        "トレード観点\n"
        f"- 終値≥¥{min_price:,} の範囲で出来高裏付けのあるモメンタムのみ追随。\n"
    )

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
    themes = data.get("themes", [])
    min_price = int(os.getenv("MIN_PRICE_JPY", "1000"))

    cli = init_openai()
    model = os.getenv("OPENAI_MODEL", "gpt-5")
    max_tokens = int(os.getenv("OPENAI_MAX_OUTPUT_TOKENS", "8000"))

    sys_txt, user_txt = build_prompts(data, stats_u, conc, vshare, themes, min_price)
    body = ""
    if cli: body = call_llm(cli, model, sys_txt, user_txt, max_tokens)
    if not body.strip():
        body = fallback_body(stats_u, conc, vshare, themes, min_price)

    title = f'{os.getenv("HEADER_PREFIX","取引代金上位600日本株 デイリー要約")} | {data.get("date","")}'
    sections = [title, body,
                md_themes(themes),
                md_table("売買代金 Top10", safe_list(lists.get("top10_dollar_value"))),
                md_table("出来高 Top10",   safe_list(lists.get("top10_volume"))),
                md_table(f"値上がり Top10（終値≥¥{min_price:,}）", safe_list(lists.get("top10_gainers_ge10"))),
                md_table(f"値下がり Top10（終値≥¥{min_price:,}）", safe_list(lists.get("top10_losers_ge10")))]
    out_md = "\n\n".join([s for s in sections if s]).strip() + "\n"
    write_text(Path(args.out), out_md)

if __name__ == "__main__":
    main()
