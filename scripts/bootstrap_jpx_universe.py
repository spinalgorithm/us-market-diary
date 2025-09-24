#!/usr/bin/env python3
# JPX universe builder with yfinance validation
import os, re, io, sys, csv, time
from pathlib import Path
import requests
import pandas as pd

# yfinance 검증용
import warnings, logging
warnings.filterwarnings("ignore")
logging.getLogger("yfinance").setLevel(logging.ERROR)
import yfinance as yf

OUT = Path("data"); OUT.mkdir(parents=True, exist_ok=True)
TICKERS_TXT = OUT / "jpx_tickers.txt"
NAMES_CSV   = OUT / "jpx_names.csv"

UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/123 Safari/537.36"}
JPX_PAGE = "https://www.jpx.co.jp/markets/statistics-equities/misc/01.html"
STOCKANALYSIS = "https://stockanalysis.com/list/tokyo-stock-exchange/"

# 최소 시드
SEED = [
    ("7203","トヨタ自動車"),("6758","ソニーグループ"),("9984","ソフトバンクグループ"),
    ("9983","ファーストリテイリング"),("8035","東京エレクトロン"),("6861","キーエンス"),
    ("9432","日本電信電話"),("8306","三菱UFJフィナンシャル・グループ"),("4063","信越化学工業"),
    ("4502","武田薬品工業"),("6954","ファナック"),("7974","任天堂"),
    ("7267","本田技研工業"),("7201","日産自動車"),("7269","スズキ"),
    ("7751","キヤノン"),("7735","SCREENホールディングス"),("6367","ダイキン工業"),
    ("8591","オリックス"),("8766","東京海上ホールディングス"),
    ("8316","三井住友フィナンシャルグループ"),("8411","みずほフィナンシャルグループ"),
    ("6902","デンソー"),("8031","三井物産"),("8058","三菱商事"),
    ("2914","日本たばこ産業"),("4503","アステラス製薬"),("7741","HOYA"),
    ("4661","オリエンタルランド"),("3382","セブン&アイ・ホールディングス"),
    ("9020","東日本旅客鉄道"),("9022","東海旅客鉄道"),("6869","シスメックス"),
    ("5108","ブリヂストン"),("6501","日立製作所"),("3402","東レ")
]

def write_outputs(rows):
    # rows: [(code, name_ja)]
    codes = [c for c,_ in rows]
    TICKERS_TXT.write_text("\n".join(codes), encoding="utf-8")
    with NAMES_CSV.open("w", encoding="utf-8", newline="") as f:
        w = csv.writer(f); w.writerow(["ticker","name"])
        for c,n in rows: w.writerow([c,n])

def from_jpx():
    try:
        html = requests.get(JPX_PAGE, headers=UA, timeout=30).text
        m = re.search(r'href="([^"]+/att/[^"]+\.(?:xlsx|xls))"', html)
        if not m: return None
        url = "https://www.jpx.co.jp" + m.group(1)
        bin = requests.get(url, headers=UA, timeout=60).content
        xf = pd.ExcelFile(io.BytesIO(bin))
        df = None
        for sh in xf.sheet_names:
            t = xf.parse(sh)
            cols = "".join(map(str, t.columns))
            if re.search(r'コード', cols) and re.search(r'銘柄名', cols):
                df = t; break
        if df is None: return None
        col_code = next(c for c in df.columns if re.search(r'コード', str(c)))
        col_name = next(c for c in df.columns if re.search(r'銘柄名', str(c)))

        # ETF/ETN/REIT/インフラ 除外 + 廃止行 제거 시도
        maybe_mkt = next((c for c in df.columns if re.search(r'市場|区分', str(c))), None)
        if maybe_mkt is not None:
            df = df[~df[maybe_mkt].astype(str).str.contains("ETF|ETN|REIT|インフラ|上場廃止|廃止", regex=True, na=False)]

        df = df[[col_code, col_name]].dropna()
        df = df[df[col_code].astype(str).str.match(r'^\d{4}$')]
        rows = [(str(int(c)), str(n).strip()) for c,n in df.values]
        return rows if rows else None
    except Exception:
        return None

def from_stockanalysis():
    try:
        all_rows = []
        for page in range(1, 80):
            url = STOCKANALYSIS + (f"?p={page}" if page > 1 else "")
            r = requests.get(url, headers=UA, timeout=30)
            if r.status_code != 200: break
            rows = re.findall(r'/stocks/(\d{4})\.T/.*?</a>\s*</td>\s*<td[^>]*>([^<]+)</td>',
                              r.text, flags=re.S)
            if not rows: break
            all_rows.extend((c.strip(), n.strip()) for c,n in rows)
            time.sleep(0.2)
        if not all_rows: return None
        seen, rows = set(), []
        for c,n in all_rows:
            if c not in seen:
                seen.add(c); rows.append((c,n))
        return rows if rows else None
    except Exception:
        return None

def from_repo():
    p = Path("public/jpx/jpx_universe.csv")
    if not p.exists(): return None
    try:
        df = pd.read_csv(p)
        cols = {c.lower(): c for c in df.columns}
        c_code = cols.get("ticker") or cols.get("code")
        c_name = cols.get("name") or cols.get("name_ja") or cols.get("jp_name")
        if not c_code: return None
        if c_name is None:
            df["__name"] = ""
            c_name = "__name"
        df = df[df[c_code].astype(str).str.match(r"^\d{4}$")]
        rows = [(str(int(c)), str(n)) for c, n in zip(df[c_code], df[c_name])]
        return rows if rows else None
    except Exception:
        return None

def fallback_seed():
    return SEED

def batched(seq, n):
    for i in range(0, len(seq), n):
        yield seq[i:i+n]

def validate_with_yf(rows):
    """ yfinance로 최근 3영업일 데이터 존재하는 코드만 통과 """
    code2name = dict(rows)
    codes = list(code2name.keys())
    good = set()

    for chunk in batched(codes, 200):
        syms = [c + ".T" for c in chunk]
        try:
            df = yf.download(
                tickers=syms,
                period="3d", interval="1d",
                group_by="ticker", auto_adjust=False,
                progress=False, threads=True
            )
        except Exception:
            continue

        if isinstance(df.columns, pd.MultiIndex):
            have = set(df.columns.get_level_values(0))
            for c in chunk:
                if c+".T" not in have:  # 완전 실패
                    continue
                try:
                    cdf = df[c+".T"].dropna()
                except KeyError:
                    continue
                if not cdf.empty:
                    good.add(c)
        else:
            # 단일 티커 케이스
            if not df.empty:
                only = chunk[0]
                good.add(only)

        time.sleep(0.3)

    clean = [(c, code2name.get(c, "")) for c in sorted(good)]
    return clean

def main():
    # 1) 소스 시도
    for src in (from_jpx, from_stockanalysis, from_repo):
        rows = src()
        if rows:
            print(f"source: {src.__name__} -> raw {len(rows)} codes")
            break
    else:
        rows = fallback_seed()
        print(f"source: seed -> {len(rows)} codes")

    # 2) yfinance 검증
    rows_clean = validate_with_yf(rows)
    print(f"validated: {len(rows_clean)} codes with recent data")

    if not rows_clean:
        print("ERROR: No valid JPX tickers after validation", file=sys.stderr)
        sys.exit(2)

    # 3) 저장
    write_outputs(rows_clean)
    print(f"OK -> {TICKERS_TXT} / {NAMES_CSV}")

if __name__ == "__main__":
    main()
