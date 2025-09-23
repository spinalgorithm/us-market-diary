#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import os, sys, json, csv, argparse, statistics as stats
from pathlib import Path
from datetime import datetime
from zoneinfo import ZoneInfo

import pandas as pd
from openai import OpenAI

def load_bundle(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)

def load_names_csv(path: str) -> dict:
    m = {}
    p = Path(path)
    if not p.exists():
        return m
    with p.open("r", encoding="utf-8") as f:
        r = csv.DictReader(f)
        # 허용 컬럼: ticker/code , name/name_ja/jp_name
        for row in r:
            code = (row.get("ticker") or row.get("code") or "").strip()
            name = (row.get("name") or row.get("name_ja") or row.get("jp_name") or "").strip()
            if code:
                m[code] = name or code
    return m

def nm(code: str, names: dict) -> str:
    n = names.get(code)
    if n and n != code:
        return f"{n}（{code}）"
    return code

def pct(x):
    return f"{x*100:.2f}%" if x is not None else ""

def yen(n):
    # 10^8 단위 억엔 환산 표기
    try:
        v = float(n) / 1e8
        return f"{v:,.1f}億円"
    except Exception:
        return ""

def summarize_distribution(pcts):
    arr = [x for x in pcts if x is not None]
    if not arr:
        return {}
    arr.sort()
    mean = stats.fmean(arr)
    med = stats.median(arr)
    def count_between(lo, hi):
        return sum(1 for x in arr if (lo <= x < hi))
    res = {
        "n": len(arr),
        "up": sum(1 for x in arr if x > 0),
        "down": sum(1 for x in arr if x < 0),
        "flat": sum(1 for x in arr if x == 0),
        "mean": mean,
        "median": med,
        "band_m2_p2": count_between(-0.02, 0.02),
        "p95": arr[int(0.95*(len(arr)-1))],
        "p05": arr[int(0.05*(len(arr)-1))],
        "gt_025": sum(1 for x in arr if x >= 0.025),
        "lt_m025": sum(1 for x in arr if x <= -0.025),
        "gt_05":  sum(1 for x in arr if x >= 0.05),
        "lt_m05": sum(1 for x in arr if x <= -0.05),
    }
    return res

def table(lines, header):
    cols = ["銘柄","Close","Vol","代金","%Chg"]
    out = [header, "Ticker\tClose\tVol\t$Vol\t%Chg"]
    for L in lines:
        out.append(f"{L['disp']}\t{L['close']:,.2f}\t{L['volume']:,.0f}\t{L['dv']}\t{pct(L['pct'])}")
    return "\n".join(out)

def enrich(items, names):
    res = []
    for r in items:
        res.append({
            "code": r["ticker"],
            "disp": nm(r["ticker"], names),
            "close": float(r.get("close", 0.0)),
            "volume": float(r.get("volume", 0.0)),
            "dv": yen(r.get("dollar_volume", 0.0)),
            "pct": r.get("pct_change", None),
        })
    return res

def build_context(bundle, names):
    L = bundle["lists"]
    ctx = {}
    ctx["date"] = bundle["date"]
    # 집중도
    dv = L["universe_top600_by_dollar"]
    top50 = dv[:50]; top10 = dv[:10]
    sum_all = sum(float(x.get("dollar_volume",0)) for x in dv) or 1.0
    share10 = sum(float(x["dollar_volume"]) for x in top10) / sum_all
    share50 = sum(float(x["dollar_volume"]) for x in top50) / sum_all
    ctx["shares"] = {"top10": share10, "top50": share50}

    # 분포
    pcts = [x.get("pct_change") for x in dv]
    dist = summarize_distribution(pcts)
    ctx["dist"] = dist

    # 표 데이터
    ctx["top_dv"]  = enrich(L["top10_dollar_value"], names)
    ctx["top_vol"] = enrich(L["top10_volume"], names)
    ctx["gainers"] = enrich(L["top10_gainers_ge10"], names)
    ctx["losers"]  = enrich(L["top10_losers_ge10"], names)
    return ctx

SYSTEM = """あなたは日本株マーケットの客観的な日次レポート執筆アシスタントです。
感情表現や誇張は避け、データ駆動で簡潔にまとめます。"""

USER_TPL = """以下の集計値を用いて、見出しなしの本文パラグラフを日本語で300〜450語で作成してください。
- トーン: 事実ベース、短文主体、過度な形容詞なし
- 含める章: 市況ダイジェスト / フローと集中度 / テーマ・セクター概況 / リスク
- 個別銘柄は「銘柄名（コード）」表記
- 表は本文に入れない（下部に別表あり）

入力:
日付: {date}
騰落: 上昇{up}・下落{down}・変わらず{flat}
平均: {mean_pct:.2f}% / 中央値: {med_pct:.2f}%
分布: ±2%内={band_77}、+2.5%以上={gt25}、-2.5%以下={lt25}、+5%以上={gt5}、-5%以下={lt5}
パーセンタイル: p95={p95:.2f}%, p05={p05:.2f}%
集中度: 代金Top10={share10:.2f}%、Top50={share50:.2f}%
代金上位寄与（例示）: {dv_examples}
出来高上位の性質（例示）: {vol_examples}
上昇率上位（終値≥¥1,000の一部）: {g_ex}
下落率上位（終値≥¥1,000の一部）: {l_ex}
"""

def call_llm(model: str, ctx: dict) -> str:
    dv_ex = "、".join([f"{x['disp']} {pct(x['pct'])}" for x in ctx["top_dv"][:5]])
    vol_ex = "、".join([f"{x['disp']} {pct(x['pct'])}" for x in ctx["top_vol"][:5]])
    g_ex = "、".join([f"{x['disp']} {pct(x['pct'])}" for x in ctx["gainers"][:5]])
    l_ex = "、".join([f"{x['disp']} {pct(x['pct'])}" for x in ctx["losers"][:5]])

    dist = ctx["dist"]; shares = ctx["shares"]
    user = USER_TPL.format(
        date=ctx["date"],
        up=dist["up"], down=dist["down"], flat=dist["flat"],
        mean_pct=dist["mean"]*100, med_pct=dist["median"]*100,
        band_77=dist["band_m2_p2"], gt25=dist["gt_025"], lt25=dist["lt_m025"],
        gt5=dist["gt_05"], lt5=dist["lt_m05"],
        p95=dist["p95"]*100, p05=dist["p05"]*100,
        share10=shares["top10"]*100, share50=shares["top50"]*100,
        dv_examples=dv_ex, vol_examples=vol_ex, g_ex=g_ex, l_ex=l_ex
    )

    cli = OpenAI()
    # Responses API 사용. temperature 미지정.
    r = cli.responses.create(
        model=model,
        input=[
            {"role":"system","content":SYSTEM},
            {"role":"user","content":user}
        ],
        max_output_tokens=1200,
    )
    return r.output_text

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bundle", required=True)
    ap.add_argument("--names", default="data/jpx_names.csv")
    ap.add_argument("--out", default="note_post_llm_jp.md")
    ap.add_argument("--model", default=os.getenv("OPENAI_MODEL","gpt-5"))
    args = ap.parse_args()

    bundle = load_bundle(args.bundle)
    names  = load_names_csv(args.names)

    ctx = build_context(bundle, names)
    body = call_llm(args.model, ctx)

    # 제목
    title = f"取引代金上位600日本株 デイリー要約 | {bundle['date']}"

    # 표 섹션들
    md = [title, "", body.strip(), ""]
    md.append(table(ctx["top_dv"],  "売買代金 Top10"))
    md.append("")
    md.append(table(ctx["top_vol"], "出来高 Top10"))
    md.append("")
    md.append(table(ctx["gainers"], "値上がり Top10（終値≥¥1,000）"))
    md.append("")
    md.append(table(ctx["losers"],  "値下がり Top10（終値≥¥1,000）"))
    md.append("")

    Path(args.out).write_text("\n".join(md), encoding="utf-8")
    print(f"Wrote {args.out}")

if __name__ == "__main__":
    main()
