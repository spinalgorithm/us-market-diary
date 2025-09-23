#!/usr/bin/env python3
import os, sys, csv, json, time, argparse
from pathlib import Path
import pandas as pd
import yfinance as yf
from datetime import date

BATCH = 100
MIN_PRICE_JPY = float(os.getenv("MIN_PRICE_JPY", "1000"))

def load_universe_codes():
    p = Path("data/jpx_tickers.txt")
    if p.exists():
        codes = [x.strip() for x in p.read_text(encoding="utf-8").splitlines() if x.strip()]
    else:
        # 최소 시드. bootstrap 스텝이 성공하면 다음 실행부턴 data/ 에 풀 유니버스가 생김.
        codes = ["7203","6758","9984","9432","9983","8306","8035","6861","4063","4502",
                 "6954","7974","8591","8766","6367","7267","7269","7751","7735","7201"]
    return [c + ".T" for c in codes]

def load_name_map():
    m = {}
    p = Path("data/jpx_names.csv")
    if p.exists():
        with p.open(encoding="utf-8") as f:
            for r in csv.DictReader(f):
                c = str(r.get("ticker","")).strip()
                n = str(r.get("name","")).strip()
                if c: m[c] = n
    return m

def batched(seq, n):
    for i in range(0, len(seq), n):
        yield seq[i:i+n]

def fetch_batch(tickers):
    df = yf.download(
        tickers=tickers,
        period="3d", interval="1d",
        group_by="ticker", auto_adjust=False, progress=False, threads=True,
    )
    out = []
    d_this = None
    if isinstance(df.columns, pd.MultiIndex):
        for t in tickers:
            if t not in df.columns.get_level_values(0):
                continue
            cdf = df[t].dropna()
            if len(cdf) < 2:  # 전일 대비 필요
                continue
            last = cdf.iloc[-1]; prev = cdf.iloc[-2]
            o = float(last.get("Open", float("nan")))
            c = float(last.get("Close", float("nan")))
            v = float(last.get("Volume", float("nan")))
            p = None
            if pd.notna(c) and pd.notna(prev.get("Close")) and prev["Close"] != 0:
                p = (c - float(prev["Close"])) / float(prev["Close"])
            if pd.isna(c) or pd.isna(v):
                continue
            dv = v * c
            out.append({"ticker": t.replace(".T",""), "open": o, "close": c,
                        "volume": v, "dollar_volume": dv, "pct_change": p})
            d_this = cdf.index[-1].date()
    else:
        cdf = df.dropna()
        if len(cdf) >= 2:
            last = cdf.iloc[-1]; prev = cdf.iloc[-2]
            t = tickers[0]
            o = float(last.get("Open", float("nan")))
            c = float(last.get("Close", float("nan")))
            v = float(last.get("Volume", float("nan")))
            p = None
            if pd.notna(c) and pd.notna(prev.get("Close")) and prev["Close"] != 0:
                p = (c - float(prev["Close"])) / float(prev["Close"])
            if not (pd.isna(c) or pd.isna(v)):
                dv = v * c
                out.append({"ticker": t.replace(".T",""), "open": o, "close": c,
                            "volume": v, "dollar_volume": dv, "pct_change": p})
                d_this = cdf.index[-1].date()
    return out, d_this

def ensure_out(date_str: str) -> Path:
    p = Path("out_jpx") / date_str
    p.mkdir(parents=True, exist_ok=True)
    return p

def write_csv(p: Path, rows, cols):
    with p.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=cols); w.writeheader()
        for r in rows: w.writerow({k: r.get(k) for k in cols})

THEME_KEYWORDS = {
    "半導体": ["半導体","エレクトロン","レーザーテック","アドバンテスト","テスタ","露光","EUV","シリコン","ウエハ","SCREEN"],
    "電機/電子部品": ["電機","モーター","センサー","コンデンサ","コネクタ","電子部品","受動部品"],
    "自動車": ["自動車","トヨタ","ホンダ","日産","スズキ","部品","デンソー"],
    "銀行": ["銀行","フィナンシャル"],
    "商社": ["商事","物産","商社"],
    "通信": ["通信","NTT","KDDI","ソフトバンク"],
    "ゲーム/コンテンツ": ["任天堂","ソニー","ゲーム","コンテンツ"],
    "重工/機械": ["重工","機械","造船","防衛"],
    "電線": ["電線","フジクラ","古河","住友電工"],
    "電力/エネルギー": ["電力","石油","ガス","原発","再生可能"],
    "医薬/ヘルスケア": ["薬","医薬","製薬","バイオ"],
    "海運/陸運": ["海運","陸運","JR","鉄道","運輸"],
    "小売": ["小売","アパレル","ユニクロ","SPA"],
}

def detect_themes(name_ja: str) -> list:
    if not name_ja: return []
    tags = []
    for k, kws in THEME_KEYWORDS.items():
        for kw in kws:
            if kw in name_ja:
                tags.append(k); break
    return tags

def main():
    ap = argparse.ArgumentParser()
    args = ap.parse_args()

    tickers = load_universe_codes()
    name_map = load_name_map()

    rows = []
    max_date: date | None = None

    for chunk in batched(tickers, BATCH):
        try:
            r, d = fetch_batch(chunk)
            for x in r:
                code = x["ticker"]
                x["name"] = name_map.get(code, "")  # 일본어 이름 주입
                x["themes"] = detect_themes(x["name"])
            rows.extend(r)
            if d and (max_date is None or d > max_date):
                max_date = d
        except Exception:
            time.sleep(2)
            continue
        time.sleep(0.8)

    if not rows or not max_date:
        print("ERROR: no data", file=sys.stderr); sys.exit(2)

    date_str = max_date.strftime("%Y-%m-%d")
    outdir = ensure_out(date_str)

    rows_dv = sorted([r for r in rows if r.get("dollar_volume")], key=lambda x: x["dollar_volume"], reverse=True)
    top600 = rows_dv[:600]
    top10_dv = top600[:10]
    top10_vol = sorted(rows, key=lambda x: x.get("volume",0), reverse=True)[:10]
    pool_ge = [r for r in rows if r.get("close") and r["close"] >= MIN_PRICE_JPY and r.get("pct_change") is not None]
    top10_g = sorted(pool_ge, key=lambda x: x["pct_change"], reverse=True)[:10]
    top10_l = sorted(pool_ge, key=lambda x: x["pct_change"])[:10]

    # 테마 집계
    total_dv = sum(float(r.get("dollar_volume") or 0) for r in top600) or 1.0
    theme_stats = []
    for th in THEME_KEYWORDS.keys():
        members = [r for r in top600 if th in r.get("themes",[])]
        share = sum(float(r.get("dollar_volume") or 0) for r in members)/total_dv
        leaders = sorted(members, key=lambda x: x["dollar_volume"], reverse=True)[:5]
        theme_stats.append({
            "theme": th,
            "count": len(members),
            "share": share,
            "leaders": [{"ticker": m["ticker"], "name": m.get("name",""), "pct_change": m.get("pct_change")} for m in leaders]
        })
    theme_stats = [t for t in theme_stats if t["count"]>0]
    theme_stats.sort(key=lambda x: x["share"], reverse=True)

    cols = ["ticker","name","open","close","volume","dollar_volume","pct_change"]
    write_csv(outdir/"universe_top600_by_dollar.csv", top600, cols)
    write_csv(outdir/"top10_dollar_value.csv", top10_dv, cols)
    write_csv(outdir/"top10_volume.csv", top10_vol, cols)
    write_csv(outdir/"top10_gainers_ge_minprice.csv", top10_g, cols)
    write_csv(outdir/"top10_losers_ge_minprice.csv", top10_l, cols)

    bundle = {
        "date": date_str,
        "market": "JP",
        "currency": "JPY",
        "counts": {"total_rows": len(rows), "universe_top600_by_dollar": len(top600)},
        "lists": {
            "universe_top600_by_dollar": top600,
            "top10_dollar_value": top10_dv,
            "top10_volume": top10_vol,
            "top10_gainers_ge10": top10_g,
            "top10_losers_ge10": top10_l
        },
        "themes": theme_stats
    }
    (outdir/"bundle.json").write_text(json.dumps(bundle, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Wrote {outdir.resolve()}")

if __name__ == "__main__":
    main()
