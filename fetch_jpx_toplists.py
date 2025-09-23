#!/usr/bin/env python3
import os, sys, csv, json, time, argparse, datetime as dt
from pathlib import Path

import pandas as pd
import yfinance as yf

BATCH = 100
MIN_PRICE_JPY = float(os.getenv("MIN_PRICE_JPY", "1000"))  # 상승/하락 Top10 최저가 필터

def load_universe():
    p = Path("data/jpx_tickers.txt")
    if p.exists():
        codes = [x.strip() for x in p.read_text(encoding="utf-8").splitlines() if x.strip()]
    else:
        # 최소 시드(작동 보장용). 실제 운용은 data/jpx_tickers.txt 채워라.
        codes = ["7203","6758","9984","9432","9983","8306","8035","6861","4063","4502","6954","7974","8591","8766","6367","7267","7269","7751","7735","7201"]
    return [c + ".T" for c in codes]

def batched(seq, n):
    for i in range(0, len(seq), n):
        yield seq[i:i+n]

def fetch_batch(tickers):
    # 2영업일 히스토리로 전일 대비 % 계산
    df = yf.download(
        tickers=tickers,
        period="3d", interval="1d",
        group_by="ticker", auto_adjust=False, progress=False, threads=True
    )
    out = []
    # yfinance는 단일/복수에 따라 형태가 달라서 분기 처리
    if isinstance(df.columns, pd.MultiIndex):
        for t in tickers:
            if t not in df.columns.get_level_values(0):  # 일부 실패 가능
                continue
            cdf = df[t].dropna()
            if cdf.empty or len(cdf) < 2:  # 최소 2일 필요
                continue
            last = cdf.iloc[-1]
            prev = cdf.iloc[-2]
            o = float(last.get("Open", float("nan")))
            c = float(last.get("Close", float("nan")))
            v = float(last.get("Volume", float("nan")))
            p = None
            if prev.get("Close") and prev["Close"] != 0 and pd.notna(prev["Close"]) and pd.notna(c):
                p = (c - prev["Close"]) / prev["Close"]
            if pd.isna(c) or pd.isna(v):
                continue
            dv = v * c  # JPY 기준 거래대금
            out.append({"ticker": t.replace(".T",""), "open": o, "close": c, "volume": v,
                        "dollar_volume": dv, "pct_change": p})
    else:
        # 단일 티커 케이스
        cdf = df.dropna()
        if not cdf.empty and len(cdf) >= 2:
            last = cdf.iloc[-1]; prev = cdf.iloc[-2]
            t = tickers[0]
            o = float(last.get("Open", float("nan")))
            c = float(last.get("Close", float("nan")))
            v = float(last.get("Volume", float("nan")))
            p = None
            if prev.get("Close") and prev["Close"] != 0 and pd.notna(prev["Close"]) and pd.notna(c):
                p = (c - prev["Close"]) / prev["Close"]
            if pd.isna(c) or pd.isna(v):
                return out
            dv = v * c
            out.append({"ticker": t.replace(".T",""), "open": o, "close": c, "volume": v,
                        "dollar_volume": dv, "pct_change": p})
    return out, df.index[-1].date() if not df.empty else None

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

    tickers = load_universe()
    rows = []
    last_date = None

    for chunk in batched(tickers, BATCH):
        try:
            r, d = fetch_batch(chunk)
            rows.extend(r)
            if d: last_date = d
        except Exception as e:
            # 야후 제한 완화
            time.sleep(2)
            continue
        time.sleep(0.8)  # 레이트 한도 보호

    if not rows or not last_date:
        print("ERROR: no data", file=sys.stderr); sys.exit(2)

    date_str = last_date.strftime("%Y-%m-%d")
    outdir = ensure_out(date_str)

    # 랭킹 계산
    rows_dv = sorted([r for r in rows if r.get("dollar_volume")], key=lambda x: x["dollar_volume"], reverse=True)
    top600 = rows_dv[:600]
    top10_dv = top600[:10]
    top10_vol = sorted([r for r in rows if r.get("volume")], key=lambda x: x["volume"], reverse=True)[:10]
    pool_ge = [r for r in rows if r.get("close") and r["close"] >= MIN_PRICE_JPY and r.get("pct_change") is not None]
    top10_g = sorted(pool_ge, key=lambda x: x["pct_change"], reverse=True)[:10]
    top10_l = sorted(pool_ge, key=lambda x: x["pct_change"])[:10]

    cols = ["ticker","open","close","volume","dollar_volume","pct_change"]
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
            "top10_gainers_ge10": top10_g,   # 이름은 US와 호환 위해 유지
            "top10_losers_ge10": top10_l
        }
    }
    (outdir/"bundle.json").write_text(json.dumps(bundle, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Wrote {outdir.resolve()}")

if __name__ == "__main__":
    main()
