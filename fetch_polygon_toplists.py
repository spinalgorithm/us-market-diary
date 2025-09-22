#!/usr/bin/env python3
import os, sys, json, argparse, datetime as dt, csv, urllib.request
from pathlib import Path

URL = "https://api.polygon.io/v2/aggs/grouped/locale/us/market/stocks/{date}?adjusted=true&include_otc=false&apiKey={key}"

def prev_us_weekday(d: dt.date) -> dt.date:
    while d.weekday() >= 5: d -= dt.timedelta(days=1)
    return d

def fetch(date_str: str, key: str):
    with urllib.request.urlopen(URL.format(date=date_str, key=key), timeout=60) as r:
        data = json.loads(r.read().decode("utf-8"))
    if data.get("status") != "OK":
        raise RuntimeError(f"Polygon non-OK: {data}")
    return data.get("results") or []

def f(x):
    try: return float(x)
    except: return None

def ensure_out(date_str:str)->Path:
    p = Path("out")/date_str
    p.mkdir(parents=True, exist_ok=True)
    return p

def write_csv(p:Path, rows, cols):
    with p.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=cols); w.writeheader()
        for r in rows: w.writerow({k:r.get(k) for k in cols})

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", default=None)
    args = ap.parse_args()

    key = os.getenv("POLYGON_API_KEY")
    if not key:
        print("ERROR: set POLYGON_API_KEY", file=sys.stderr); sys.exit(2)

    target = dt.datetime.strptime(args.date, "%Y-%m-%d").date() if args.date \
             else prev_us_weekday(dt.date.today() - dt.timedelta(days=1))
    dstr = target.strftime("%Y-%m-%d")
    outdir = ensure_out(dstr)

    raw = fetch(dstr, key)
    rows=[]
    for r in raw:
        T=r.get("T"); v=f(r.get("v")); vw=f(r.get("vw")); c=f(r.get("c")); o=f(r.get("o"))
        if not T or v is None or c is None or o is None: continue
        dv = v*(vw if (vw and vw>0) else c)
        pct = (c-o)/o if o>0 else None
        rows.append({"ticker":T,"open":o,"close":c,"vwap":vw,"volume":v,"dollar_volume":dv,"pct_change":pct,"date":dstr})
    if not rows: raise RuntimeError("No rows from Polygon")

    rows_by_dv = sorted([r for r in rows if r["dollar_volume"] is not None], key=lambda x:x["dollar_volume"], reverse=True)
    top600 = rows_by_dv[:600]
    top10_dv = top600[:10]
    top10_vol = sorted(rows, key=lambda x:x["volume"] if x["volume"] is not None else -1, reverse=True)[:10]
    pool_ge10 = [r for r in rows if r["close"] is not None and r["close"]>=10 and r["pct_change"] is not None]
    top10_g = sorted(pool_ge10, key=lambda x:x["pct_change"], reverse=True)[:10]
    top10_l = sorted(pool_ge10, key=lambda x:x["pct_change"])[:10]

    cols = ["ticker","open","close","vwap","volume","dollar_volume","pct_change","date"]
    write_csv(outdir/"universe_top600_by_dollar.csv", top600, cols)
    write_csv(outdir/"top10_dollar_value.csv", top10_dv, cols)
    write_csv(outdir/"top10_volume.csv", top10_vol, cols)
    write_csv(outdir/"top10_gainers_ge10.csv", top10_g, cols)
    write_csv(outdir/"top10_losers_ge10.csv", top10_l, cols)

    bundle={"date":dstr,"counts":{"total_rows":len(rows),"universe_top600_by_dollar":len(top600)},
            "lists":{"universe_top600_by_dollar":top600,"top10_dollar_value":top10_dv,
                     "top10_volume":top10_vol,"top10_gainers_ge10":top10_g,"top10_losers_ge10":top10_l}}
    (outdir/"bundle.json").write_text(json.dumps(bundle,ensure_ascii=False,indent=2), encoding="utf-8")
    print(f"Wrote {outdir.resolve()}")

if __name__=="__main__": main()
