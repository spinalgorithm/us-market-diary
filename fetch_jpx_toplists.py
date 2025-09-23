#!/usr/bin/env python3
# JPX Toplists builder (super full version)
# - Pulls JP tickers via data/jpx_tickers.txt (fallback seed)
# - Uses yfinance daily OHLCV, computes JPY "dollar_volume" = Close * Volume
# - Injects Japanese company names from data/jpx_names.csv
# - Writes CSVs and a bundle.json under out_jpx/YYYY-MM-DD/
# Env:
#   MIN_PRICE_JPY: filter for gainers/losers (default 1000)
# CLI:
#   python fetch_jpx_toplists.py [--out-root out_jpx] [--batch 100]

import os, sys, csv, json, time, argparse
from pathlib import Path
from typing import List, Dict, Tuple, Any

import pandas as pd
import yfinance as yf

# ---------------- Config ----------------
DEFAULT_OUT_ROOT = "out_jpx"
DEFAULT_BATCH = 100
REQ_PERIOD = "3d"     # need prev close
REQ_INTERVAL = "1d"
SLEEP_BETWEEN = 0.8   # seconds between batches
RETRY = 2             # yfinance occasional retry
MIN_PRICE_JPY = float(os.getenv("MIN_PRICE_JPY", "1000"))

SEED_TICKERS = [      # fallback if data/jpx_tickers.txt is missing
    "7203","6758","9984","9432","9983","8306","8035","6861","4063","4502",
    "6954","7974","8591","8766","6367","7267","7269","7751","7735","7201",
]

# -------------- IO helpers --------------
def ensure_dir(p: Path) -> Path:
    p.mkdir(parents=True, exist_ok=True)
    return p

def write_csv(p: Path, rows: List[Dict[str, Any]], cols: List[str]) -> None:
    with p.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        for r in rows:
            w.writerow({k: r.get(k) for k in cols})

# -------------- Name map ----------------
def load_name_map() -> Dict[str, str]:
    """
    data/jpx_names.csv format:
      ticker,name
      6920,レーザーテック
      8035,東京エレクトロン
      ...
    """
    m: Dict[str, str] = {}
    p = Path("data/jpx_names.csv")
    if not p.exists():
        return m
    with p.open(encoding="utf-8") as f:
        for row in csv.DictReader(f):
            code = str(row.get("ticker") or "").strip()
            name = str(row.get("name") or "").strip()
            if code and name:
                m[code] = name
    return m

def apply_names(rows: List[Dict[str, Any]], name_map: Dict[str, str]) -> None:
    for r in rows:
        code = str(r.get("ticker") or "")
        r["name"] = name_map.get(code, "")

# -------------- Universe ----------------
def load_universe_codes() -> List[str]:
    p = Path("data/jpx_tickers.txt")
    if p.exists():
        codes = [x.strip() for x in p.read_text(encoding="utf-8").splitlines() if x.strip()]
        codes = [c for c in codes if c.isdigit() and len(c) == 4]
        if not codes:
            codes = SEED_TICKERS
    else:
        codes = SEED_TICKERS
    # Yahoo Finance JP suffix
    return [c + ".T" for c in codes]

def batched(seq: List[str], n: int):
    for i in range(0, len(seq), n):
        yield seq[i:i+n]

# -------------- Fetch -------------------
def fetch_batch(tickers: List[str]) -> Tuple[List[Dict[str, Any]], Any]:
    """
    Returns:
      rows: list of dicts
      last_date: pandas Timestamp.date() or None
    """
    out: List[Dict[str, Any]] = []

    for attempt in range(RETRY + 1):
        try:
            df = yf.download(
                tickers=tickers,
                period=REQ_PERIOD, interval=REQ_INTERVAL,
                group_by="ticker", auto_adjust=False,
                progress=False, threads=True,
            )
            break
        except Exception:
            if attempt >= RETRY:
                raise
            time.sleep(1.2)

    if df is None or df.empty:
        return out, None

    # MultiIndex when multiple tickers, single-index when one
    if isinstance(df.columns, pd.MultiIndex):
        last_date = df.index[-1].date() if not df.empty else None
        base_names = set(df.columns.get_level_values(0))
        for t in tickers:
            if t not in base_names:
                continue
            cdf = df[t].dropna()
            if cdf.empty or len(cdf) < 2:
                continue
            last, prev = cdf.iloc[-1], cdf.iloc[-2]
            try:
                o = float(last.get("Open"))
                c = float(last.get("Close"))
                v = float(last.get("Volume"))
                pc = (c - float(prev.get("Close"))) / float(prev.get("Close")) if float(prev.get("Close")) else None
            except Exception:
                continue
            if pd.isna(c) or pd.isna(v):
                continue
            out.append({
                "ticker": t.replace(".T", ""),
                "open": o, "close": c, "volume": v,
                "dollar_volume": v * c,  # JPY
                "pct_change": pc,
            })
    else:
        last_date = df.index[-1].date() if not df.empty else None
        cdf = df.dropna()
        if not cdf.empty and len(cdf) >= 2:
            last, prev = cdf.iloc[-1], cdf.iloc[-2]
            try:
                o = float(last.get("Open"))
                c = float(last.get("Close"))
                v = float(last.get("Volume"))
                pc = (c - float(prev.get("Close"))) / float(prev.get("Close")) if float(prev.get("Close")) else None
            except Exception:
                pc = None
            if not pd.isna(c) and not pd.isna(v):
                out.append({
                    "ticker": tickers[0].replace(".T", ""),
                    "open": o, "close": c, "volume": v,
                    "dollar_volume": v * c, "pct_change": pc,
                })
    return out, last_date

# -------------- Build lists -------------
def build_lists(rows: List[Dict[str, Any]]) -> Dict[str, List[Dict[str, Any]]]:
    rows_dv = sorted(
        (r for r in rows if r.get("dollar_volume") is not None),
        key=lambda x: float(x["dollar_volume"]), reverse=True
    )
    top600 = rows_dv[:600]
    top10_dv = top600[:10]
    top10_vol = sorted(rows, key=lambda x: float(x.get("volume", 0)), reverse=True)[:10]

    pool_ge = [
        r for r in rows
        if r.get("close") is not None and float(r["close"]) >= MIN_PRICE_JPY and r.get("pct_change") is not None
    ]
    top10_g = sorted(pool_ge, key=lambda x: float(x["pct_change"]), reverse=True)[:10]
    top10_l = sorted(pool_ge, key=lambda x: float(x["pct_change"]))[:10]

    return {
        "universe_top600_by_dollar": top600,
        "top10_dollar_value": top10_dv,
        "top10_volume": top10_vol,
        "top10_gainers_ge10": top10_g,  # key 名称はUS側に合わせて互換維持
        "top10_losers_ge10": top10_l,
    }

# -------------- Main --------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out-root", default=DEFAULT_OUT_ROOT)
    ap.add_argument("--batch", type=int, default=DEFAULT_BATCH)
    args = ap.parse_args()

    name_map = load_name_map()
    tickers = load_universe_codes()

    rows: List[Dict[str, Any]] = []
    last_date = None

    for chunk in batched(tickers, args.batch):
        try:
            r, d = fetch_batch(chunk)
            rows.extend(r)
            if d:
                last_date = d
        except Exception:
            # tolerate occasional Yahoo blocks
            time.sleep(2.0)
            continue
        time.sleep(SLEEP_BETWEEN)

    if not rows or not last_date:
        print("ERROR: no JPX data fetched", file=sys.stderr)
        sys.exit(2)

    # inject names
    apply_names(rows, name_map)

    # lists
    lists = build_lists(rows)

    # out paths
    date_str = last_date.strftime("%Y-%m-%d")
    outdir = ensure_dir(Path(args.out_root) / date_str)

    # write csvs
    cols = ["ticker", "name", "open", "close", "volume", "dollar_volume", "pct_change"]
    write_csv(outdir / "universe_top600_by_dollar.csv", lists["universe_top600_by_dollar"], cols)
    write_csv(outdir / "top10_dollar_value.csv",          lists["top10_dollar_value"], cols)
    write_csv(outdir / "top10_volume.csv",                lists["top10_volume"], cols)
    write_csv(outdir / "top10_gainers_ge10.csv",          lists["top10_gainers_ge10"], cols)
    write_csv(outdir / "top10_losers_ge10.csv",           lists["top10_losers_ge10"], cols)

    # bundle
    bundle = {
        "date": date_str,
        "market": "JP",
        "currency": "JPY",
        "counts": {
            "total_rows": len(rows),
            "universe_top600_by_dollar": len(lists["universe_top600_by_dollar"]),
        },
        "lists": lists,
    }
    (outdir / "bundle.json").write_text(json.dumps(bundle, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"Wrote {outdir.resolve()}")
    print(f"BUNDLE={str(outdir / 'bundle.json')}")

if __name__ == "__main__":
    main()
