#!/usr/bin/env python3
import os, sys, csv, json, time, argparse
from pathlib import Path
import pandas as pd
import yfinance as yf

BATCH = 100
MIN_PRICE_JPY = float(os.getenv("MIN_PRICE_JPY", "1000"))

def load_universe():
    p = Path("data/jpx_tickers.txt")
    if p.exists():
        codes = [x.strip() for x in p.read_text(encoding="utf-8").splitlines() if x.strip()]
    else:
        # fallback 최소 시드
        codes = ["7203","6758","9984","9432","9983","8306","8035","6861","4063","4502","6954",
                 "7974","8591","8766","6367","7267","7269","7751","7735","7201"]
    return [c + ".T" for c in codes]

def load_name_map():
    """data/jpx_names.csv -> { '8035': '東京エレクトロン', ... }"""
    m = {}
    p = Path("data/jpx_names.csv")
    if p.exists():
        with p.open("r", encoding="utf-8") as f:
            r = csv.DictReader(f)
            for row in r:
                code = (row.get("ticker") or row.get("code") or "").strip()
                name = (row.get("name") or row.get("name_ja") or row.get("jp_name") or "").strip()
                if code:
                    m[code] = name
    return m

def apply_names(rows, name_map):
    for r in rows:
        code = r.get("ticker")
        if code in name_map:
            r["name"] = name_map[code]
    return rows

def batched(seq, n):
    for i in range(0, len(seq), n):
        yield seq[i:i+n]

def fetch_batch(tickers):
    df = yf.download(
        tickers=tickers, period="3d", interval="1d",
        group_by="ticker", auto_adjust=False, progress=False, threads=True
    )
    out = []
    if isinstance(df.columns, pd.MultiIndex):
        for t in tickers:
            if t not in df.columns.get_level_values(0): 
                continue
            cdf = df[t].dropna()
            if len(cdf) < 2:
                continue
            last, prev = cdf.iloc[-1], cdf.iloc[-2]
            o = float(last.get("Open", float("nan"))); c = float(last.get("Close", float("nan")))
            v = float(last.get("Volume", float("nan")))
            if pd.isna(c) or pd.isna(v):
                continue
            p = None
            if prev.get("Close") and prev["Close"] != 0 and pd.notna(prev["Close"]):
                p = (c - prev["Close"]) / prev["Close"]
            dv = v * c  # 円建て
            out.append({"ticker": t.replace(".T",""), "open": o, "close": c, "volume": v,
                        "dollar_volume": dv, "pct_change": p})
        dtidx = df.index
    else:
        cdf = df.dropna()
        dtidx = df.index
        if len(cdf) >= 2:
            last, prev = cdf.iloc[-1], cdf.iloc[-2]
            t = tickers[0]
            o = float(last.get("Open", float("nan"))); c = float(last.get("Close", float("nan")))
            v = float(last.get("Volume", float("nan")))
            if not(pd.isna(c) or pd.isna(v)):
                p = None
                if prev.get("Close") and prev["Close"] != 0 and pd.notna(prev["Close"]):
                    p = (c - prev["Close"]) / prev["Close"]
                dv = v * c
                out.append({"ticker": t.replace(".T",""), "open": o, "close": c, "volume": v,
                            "dollar_volume": dv, "pct_change": p})
    last_date = dtidx[-1].date() if len(dtidx) > 0 else None
    return out, last_date

def ensure_out(date_str: str) -> Path:
    p = Path("out_jpx") / date_str
    p.mkdir(parents=True, exist_ok=True)
    return p

def write_csv(p: Path, rows, cols):
    with p.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=cols); w.writeheader()
        for r in rows: w.writerow({k: r.get(k) for k in cols})

def main():
    ap = argparse.ArgumentParser()
    args = ap.parse_args()

    name_map = load_name_map()
    print(f"[DBG] names loaded: {len(name_map)}")
    tickers = load_universe()
    print(f"[DBG] tickers loaded: {len(tickers)}")

    rows, last_date = [], None
    for chunk in batched(tickers, BATCH):
        try:
            r, d = fetch_batch(chunk)
            rows.extend(r)
            if d: last_date = d
        except Exception as e:
            time.sleep(1.2)
            continue
        time.sleep(0.6)

    if not rows or not last_date:
        print("ERROR: no data", file=sys.stderr); sys.exit(2)

    date_str = last_date.strftime("%Y-%m-%d")
    outdir = ensure_out(date_str)

    rows_dv = sorted([r for r in rows if r.get("dollar_volume")], key=lambda x: x["dollar_volume"], reverse=True)
    top600   = rows_dv[:600]
    top10_dv = top600[:10]
    top10_vol = sorted([r for r in rows if r.get("volume")], key=lambda x: x["volume"], reverse=True)[:10]

    pool = [r for r in rows if r.get("close") and r["close"] >= MIN_PRICE_JPY and r.get("pct_change") is not None]
    gains = [r for r in pool if r["pct_change"] > 0]
    losses = [r for r in pool if r["pct_change"] < 0]
    top10_g = sorted(gains,  key=lambda x: x["pct_change"], reverse=True)[:10]
    top10_l = sorted(losses, key=lambda x: x["pct_change"])[:10]

    # 이름 주입
    apply_names(top600,   name_map)
    apply_names(top10_dv, name_map)
    apply_names(top10_vol,name_map)
    apply_names(top10_g,  name_map)
    apply_names(top10_l,  name_map)

    cols = ["ticker","name","open","close","volume","dollar_volume","pct_change"]
    write_csv(outdir/"universe_top600_by_dollar.csv", top600, cols)
    write_csv(outdir/"top10_dollar_value.csv",       top10_dv, cols)
    write_csv(outdir/"top10_volume.csv",             top10_vol, cols)
    write_csv(outdir/"top10_gainers_ge_minprice.csv",top10_g, cols)
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
        }
    }
    (outdir/"bundle.json").write_text(json.dumps(bundle, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Wrote {outdir.resolve()}")

if __name__ == "__main__":
    main()
