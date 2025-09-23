#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
JPX Top-Lists fetcher
- 입력: data/jpx_tickers.txt  (4자리 코드, 줄바꿈 구분)
- 산출: out_jpx/{YYYY-MM-DD}/ 以下에 CSV 4종 + bundle.json
- 메트릭: dollar_volume = Volume * Close  (JPY 기준)
- 필터: 상승/하락 Top10은 종가가 MIN_PRICE_JPY 이상인 종목만 포함
- 날짜: JST 16:00 이후 실행 시 헤더 날짜를 '당일(JST)'로 강제 표기
"""

import os, sys, csv, json, time, argparse
from pathlib import Path
from typing import List, Tuple, Optional

import pandas as pd
import yfinance as yf
from datetime import datetime
from zoneinfo import ZoneInfo

# --------------------
# 설정
# --------------------
BATCH = int(os.getenv("JPX_BATCH", "100"))
MIN_PRICE_JPY = float(os.getenv("MIN_PRICE_JPY", "1000"))  # 상승/하락 Top10 최저가 필터(¥)

# --------------------
# 유틸
# --------------------
def load_universe_codes() -> List[str]:
    """
    data/jpx_tickers.txt 존재 시 사용.
    없으면 최소 시드 사용. (운영 시 bootstrap 스크립트로 반드시 생성)
    반환: ["7203.T", "6758.T", ...]
    """
    p = Path("data/jpx_tickers.txt")
    if p.exists():
        codes = [x.strip() for x in p.read_text(encoding="utf-8").splitlines() if x.strip()]
    else:
        # 최소 시드(작동 보장용)
        codes = [
            "7203","6758","9984","9432","9983","8306","8035","6861","4063","4502",
            "6954","7974","8591","8766","6367","7267","7269","7751","7735","7201"
        ]
    return [c + ".T" for c in codes]

def batched(seq: List[str], n: int):
    for i in range(0, len(seq), n):
        yield seq[i:i+n]

def fetch_batch(tickers: List[str]) -> Tuple[List[dict], Optional[pd.Timestamp]]:
    """
    yfinance에서 3영업일 daily로 내려받아 전일 대비 % 계산.
    반환: (rows, max_timestamp)
    """
    df = yf.download(
        tickers=tickers,
        period="3d",
        interval="1d",
        group_by="ticker",
        auto_adjust=False,
        progress=False,
        threads=True,
    )

    rows: List[dict] = []
    max_ts: Optional[pd.Timestamp] = None

    # 멀티/단일 형태 모두 처리
    if isinstance(df.columns, pd.MultiIndex):
        for t in tickers:
            if t not in df.columns.get_level_values(0):
                continue
            cdf = df[t].dropna()
            if cdf.empty or len(cdf) < 2:
                continue

            last = cdf.iloc[-1]
            prev = cdf.iloc[-2]

            o = float(last.get("Open", float("nan")))
            c = float(last.get("Close", float("nan")))
            v = float(last.get("Volume", float("nan")))
            pct = None
            if pd.notna(c) and pd.notna(prev.get("Close")) and prev["Close"] != 0:
                pct = (c - float(prev["Close"])) / float(prev["Close"])

            if pd.isna(c) or pd.isna(v):
                continue

            dv = v * c  # JPY
            rows.append({
                "ticker": t.replace(".T", ""),   # "7203"
                "open": o, "close": c, "volume": v,
                "dollar_volume": dv, "pct_change": pct
            })

            ts = cdf.index[-1]
            if isinstance(ts, pd.Timestamp):
                if (max_ts is None) or (ts > max_ts):
                    max_ts = ts
    else:
        cdf = df.dropna()
        if not cdf.empty and len(cdf) >= 2:
            last = cdf.iloc[-1]
            prev = cdf.iloc[-2]
            t = tickers[0]

            o = float(last.get("Open", float("nan")))
            c = float(last.get("Close", float("nan")))
            v = float(last.get("Volume", float("nan")))
            pct = None
            if pd.notna(c) and pd.notna(prev.get("Close")) and prev["Close"] != 0:
                pct = (c - float(prev["Close"])) / float(prev["Close"])

            if pd.isna(c) or pd.isna(v):
                return rows, None

            dv = v * c
            rows.append({
                "ticker": t.replace(".T", ""),
                "open": o, "close": c, "volume": v,
                "dollar_volume": dv, "pct_change": pct
            })
            max_ts = cdf.index[-1]

    return rows, max_ts

def ensure_out(date_str: str) -> Path:
    p = Path("out_jpx") / date_str
    p.mkdir(parents=True, exist_ok=True)
    return p

def write_csv(path: Path, rows: List[dict], cols: List[str]):
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        for r in rows:
            w.writerow({k: r.get(k) for k in cols})

# --------------------
# 메인 로직
# --------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sleep", type=float, default=float(os.getenv("JPX_SLEEP", "0.6")),
                    help="batch 간 대기(sec)")
    args = ap.parse_args()

    tickers = load_universe_codes()
    all_rows: List[dict] = []
    seen_dates: List[pd.Timestamp] = []

    for chunk in batched(tickers, BATCH):
        try:
            r, ts = fetch_batch(chunk)
            all_rows.extend(r)
            if ts is not None:
                seen_dates.append(ts)
        except Exception:
            # 간헐적 429 등 완화
            time.sleep(2)
            continue
        time.sleep(max(args.sleep, 0.0))

    if not all_rows or not seen_dates:
        print("ERROR: no data", file=sys.stderr)
        sys.exit(2)

    # 원천에서 관측된 마지막 거래일(UTC 기반 타임스탬프) → date
    max_date = max(seen_dates).date()

    # --- JST 헤더 날짜 보정 패치 ---
    now_jst = datetime.now(ZoneInfo("Asia/Tokyo"))
    tokyo_today = now_jst.date()
    # 장 마감 이후(16:00 JST) 실행이면 지연 여부와 무관하게 헤더를 '오늘'로 표기
    if now_jst.hour >= 16 and tokyo_today >= max_date:
        date_str = tokyo_today.strftime("%Y-%m-%d")
    else:
        date_str = max_date.strftime("%Y-%m-%d")

    outdir = ensure_out(date_str)

    # 랭킹 계산
    rows_has_dv = [r for r in all_rows if r.get("dollar_volume") is not None]
    rows_by_dv = sorted(rows_has_dv, key=lambda x: x["dollar_volume"], reverse=True)

    top600 = rows_by_dv[:600]
    top10_dv = top600[:10]

    top10_vol = sorted(
        [r for r in all_rows if r.get("volume") is not None],
        key=lambda x: x["volume"],
        reverse=True
    )[:10]

    pool_ge = [
        r for r in all_rows
        if r.get("close") is not None and r["close"] >= MIN_PRICE_JPY
        and r.get("pct_change") is not None
    ]
    top10_gainers = sorted(pool_ge, key=lambda x: x["pct_change"], reverse=True)[:10]
    top10_losers  = sorted(pool_ge, key=lambda x: x["pct_change"])[:10]

    # CSV 출력
    cols = ["ticker", "open", "close", "volume", "dollar_volume", "pct_change"]
    write_csv(outdir / "universe_top600_by_dollar.csv", top600, cols)
    write_csv(outdir / "top10_dollar_value.csv", top10_dv, cols)
    write_csv(outdir / "top10_volume.csv",        top10_vol, cols)
    write_csv(outdir / "top10_gainers_ge_minprice.csv", top10_gainers, cols)
    write_csv(outdir / "top10_losers_ge_minprice.csv",  top10_losers,  cols)

    bundle = {
        "date": date_str,
        "market": "JP",
        "currency": "JPY",
        "params": {
            "min_price_jpy": MIN_PRICE_JPY,
            "batch": BATCH,
        },
        "counts": {
            "universe_total": len(all_rows),
            "universe_top600_by_dollar": len(top600),
        },
        "lists": {
            "universe_top600_by_dollar": top600,
            "top10_dollar_value": top10_dv,
            "top10_volume": top10_vol,
            # US와 키 호환을 위해 이름 유지
            "top10_gainers_ge10": top10_gainers,
            "top10_losers_ge10":  top10_losers,
        },
        "source_note": "Prices/Volumes via yfinance JP (.T). dollar_volume means JPY not USD.",
    }

    (outdir / "bundle.json").write_text(
        json.dumps(bundle, ensure_ascii=False, indent=2),
        encoding="utf-8"
    )

    print(f"Wrote {outdir.resolve()}")

# --------------------
if __name__ == "__main__":
    main()
