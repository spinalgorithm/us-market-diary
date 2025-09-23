#!/usr/bin/env python3
import os, re, io, sys, csv, time
from pathlib import Path
import requests
import pandas as pd

JPX_PAGE_JA = "https://www.jpx.co.jp/markets/statistics-equities/misc/01.html"
STOCKANALYSIS_TSE = "https://stockanalysis.com/list/tokyo-stock-exchange/"

OUT_DIR = Path("data"); OUT_DIR.mkdir(parents=True, exist_ok=True)
TICKERS_TXT = OUT_DIR / "jpx_tickers.txt"
NAMES_CSV   = OUT_DIR / "jpx_names.csv"

def fetch_jpx_xls_url():
    html = requests.get(JPX_PAGE_JA, timeout=30).text
    # 페이지 내의 .xls 直リンク를 탐지 (매월 파일명/パス가 바뀜)
    m = re.search(r'href="([^"]+?/att/[^"]+?\.xls)"', html)
    return f"https://www.jpx.co.jp{m.group(1)}" if m else None

def build_from_jpx():
    url = fetch_jpx_xls_url()
    if not url: 
        return False
    xls = requests.get(url, timeout=60).content
    # 시트 자동 탐색
    x = pd.ExcelFile(io.BytesIO(xls))
    df = None
    for name in x.sheet_names:
        tmp = x.parse(name)
        # 4자리 코드와 일본어 컬럼이 있는 시트 탐색
        cols = "".join(map(str, tmp.columns))
        if re.search(r'コード|銘柄名', cols):
            df = tmp
            break
    if df is None:
        return False

    # 컬럼명 정규화
    c_code = next(c for c in df.columns if re.search(r'コード', str(c)))
    c_name = next(c for c in df.columns if re.search(r'銘柄名', str(c)))
    # ETF/REIT 등 제외
    mkt_col = next((c for c in df.columns if re.search(r'市場|区分', str(c))), None)
    if mkt_col is not None:
        df = df[~df[mkt_col].astype(str).str.contains("ETF|ETN|REIT|インフラ|ベンチャー", regex=True, na=False)]

    df = df[[c_code, c_name]].dropna()
    df = df[df[c_code].astype(str).str.match(r'^\d{4}$')]
    df = df.drop_duplicates(subset=[c_code])

    codes = df[c_code].astype(int).astype(str).tolist()
    with open(TICKERS_TXT, "w", encoding="utf-8") as f:
        f.write("\n".join(codes))

    df_out = pd.DataFrame({"code": df[c_code].astype(int).astype(str),
                           "name_ja": df[c_name].astype(str)})
    df_out.to_csv(NAMES_CSV, index=False, quoting=csv.QUOTE_MINIMAL, encoding="utf-8")
    return True

def build_from_stockanalysis():
    # 서버측 렌더 테이블을 페이지네이션 돌며 수집
    all_rows = []
    page = 1
    while True:
        url = STOCKANALYSIS_TSE + (f"?p={page}" if page > 1 else "")
        r = requests.get(url, timeout=30)
        if r.status_code != 200: break
        # 표 행 파싱
        rows = re.findall(r'>\s*(\d{4})\s*</a>\s*</td>\s*<td[^>]*>([^<]+)</td>', r.text)
        if not rows: break
        all_rows.extend(rows)
        page += 1
        if page > 50: break  # 안전장치
        time.sleep(0.3)

    if not all_rows: 
        return False

    # 영어 이름만 제공됨 → 일본어명 빈칸
    codes = sorted({c for c,_ in all_rows})
    with open(TICKERS_TXT, "w", encoding="utf-8") as f:
        f.write("\n".join(codes))

    with open(NAMES_CSV, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f); w.writerow(["code","name_ja","name_en"])
        for c,n in all_rows:
            w.writerow([c, "", n.strip()])
    return True

def main():
    ok = build_from_jpx()
    if not ok:
        ok = build_from_stockanalysis()
    if not ok:
        print("ERROR: JPX/backup 소스에서 종목 리스트를 가져오지 못함.", file=sys.stderr)
        sys.exit(1)
    print(f"wrote {TICKERS_TXT} and {NAMES_CSV}")

if __name__ == "__main__":
    main()
