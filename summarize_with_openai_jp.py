#!/usr/bin/env python3
import os, sys, json, argparse, statistics as stats
from pathlib import Path
from typing import Any, Dict, List

def init_openai():
    from openai import OpenAI
    key = os.getenv("OPENAI_API_KEY", "").strip()
    if not key: print("ERROR: OPENAI_API_KEY", file=sys.stderr); sys.exit(2)
    return OpenAI(api_key=key)

def read_bundle(p: Path) -> Dict[str, Any]:
    return json.load(open(p, encoding="utf-8"))

def write_text(p: Path, s: str):
    p.parent.mkdir(parents=True, exist_ok=True); p.write_text(s, encoding="utf-8")

def fmt_pct(x):  return "" if x is None else f"{float(x)*100:.2f}%"
def fmt_int(x):  return f"{int(round(float(x))):,}"
def fmt_money_m(x): return f"{float(x)/1_000_000:.1f}M"

def jp_label(r): 
    nm = (r.get("name") or "").strip(); tk = (r.get("ticker") or "").strip()
    return f"{nm} ({tk})" if nm else tk

def md_table(title_txt: str, rows: List[Dict[str, Any]]) -> str:
    hdr = ["銘柄","Close","Vol","$Vol","%Chg"]
    lines = ["", title_txt, "\t".join(hdr)]
    for r in rows:
        lines.append("\t".join([
            jp_label(r), f"{r.get('close','')}", fmt_int(r.get("volume")),
            fmt_money_m(r.get("dollar_volume")), fmt_pct(r.get("pct_change")),
        ]))
    return "\n".join(lines)

def safe_list(v): return v if isinstance(v, list) else []

def universe_stats(univ: List[Dict[str, Any]]) -> Dict[str, Any]:
    pc = [float(x) for x in [r.get("pct_change") for r in univ] if x is not None]
    n=len(pc); 
    mean=sum(pc)/n if n else 0.0; med=stats.median(pc) if n else 0.0
    within_2=sum(1 for x in pc if -0.02<=x<=0.02)
    pos_2_5=sum(1 for x in pc if 0.02<x<=0.05); neg_2_5=sum(1 for x in pc if -0.05<=x<-0.02)
    gt_5=sum(1 for x in pc if x>0.05); lt_5=sum(1 for x in pc if x<-0.05)
    up=sum(1 for x in pc if x>0); dn=sum(1 for x in pc if x<0); eq=n-up-dn
    if n:
        s=sorted(pc)
        def perc(p):
            k=(n-1)*p; f=int(k); c=min(f+1,n-1); d=k-f
            return s[f]*(1-d)+s[c]*d
        p95, p05 = perc(0.95), perc(0.05)
    else:
        p95=p05=None
    return {"count":n,"up":up,"down":dn,"flat":eq,"mean":mean,"median":med,
            "within_2pct":within_2,"pos_2_5pct":pos_2_5,"neg_2_5pct":neg_2_5,
            "gt_5pct":gt_5,"lt_5pct":lt_5,"p95":p95,"p05":p05}

def concentration(top10, top50, base):
    s_base=sum(float(r.get("dollar_volume") or 0) for r in base) or 1.0
    s10=sum(float(r.get("dollar_volume") or 0) for r in top10)
    s50=sum(float(r.get("dollar_volume") or 0) for r in top50)
    return {"top10_share": s10/s_base, "top50_share": s50/s_base}

def volume_share(vtop10, base):
    v_base=sum(float(r.get("volume") or 0) for r in base) or 1.0
    v10=sum(float(r.get("volume") or 0) for r in vtop10)
    return {"vol_top10_share": v10/v_base}

def build_prompts(data, stats_u, conc, vshare, min_price):
    system = (
      "あなたは機関投資家向けのストラテジスト。事実のみ、簡潔、定量中心。"
      "入力データに無い米国銘柄・指数・ニュースは書かない。"
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
      "以下の入力で日本株のデイリー解説を作成。\n"
      "- 見出し: 市況ダイジェスト / フローと集中度 / テーマ・セクター / セクター別ドライバー / 個別イベント / リスク / トレード観点\n"
      "- 各見出しは3〜6項目。必ず具体数値を入れる。推測禁止。\n"
      f"- 上昇/下落は『終値≥¥{min_price:,}』の条件に沿って記述。\n\n"
      f"入力データ:\n{json.dumps(payload, ensure_ascii=False)}"
    )
    return system, user

def call_llm(cli, model, system, user, max_tokens):
    r = cli.responses.create(
        model=model,
        input=[{"role":"system","content":system},{"role":"user","content":user}],
        max_output_tokens=max_tokens
    )
    return (r.output_text or "").strip()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bundle", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    data = read_bundle(Path(args.bundle))
    date = data.get("date","")
    univ = safe_list(data.get("lists",{}).get("universe_top600_by_dollar"))
    stats_u = universe_stats(univ)
    conc = concentration(safe_list(data["lists"].get("top10_dollar_value")), univ[:50], univ)
    vshare = volume_share(safe_list(data["lists"].get("top10_volume")), univ)
    min_price = int(os.getenv("MIN_PRICE_JPY","1000"))

    cli = init_openai()
    model = os.getenv("OPENAI_MODEL","gpt-5")
    max_tokens = int(os.getenv("OPENAI_MAX_OUTPUT_TOKENS","8000"))

    system, user = build_prompts(data, stats_u, conc, vshare, min_price)
    body = call_llm(cli, model, system, user, max_tokens)

    title = f"{os.getenv('HEADER_PREFIX','取引代金上位600日本株')} | {date}"
    lists = data["lists"]
    md = [title, body]
    md.append(md_table("売買代金 Top10", safe_list(lists.get("top10_dollar_value"))))
    md.append(md_table("出来高 Top10",   safe_list(lists.get("top10_volume"))))
    md.append(md_table(f"値上がり Top10 (終値≥¥{min_price:,})", safe_list(lists.get("top10_gainers_ge10"))))
    md.append(md_table(f"値下がり Top10 (終値≥¥{min_price:,})", safe_list(lists.get("top10_losers_ge10"))))
    write_text(Path(args.out), ("\n\n".join(md).strip()+"\n"))

if __name__ == "__main__":
    main()
