#!/usr/bin/env python3
# Robust JPX universe bootstrapper
import os, re, io, sys, csv, time
from pathlib import Path
import requests
import pandas as pd

OUT = Path("data"); OUT.mkdir(parents=True, exist_ok=True)
TICKERS_TXT = OUT / "jpx_tickers.txt"
NAMES_CSV   = OUT / "jpx_names.csv"

UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/123 Safari/537.36"}
JPX_PAGE = "https://www.jpx.co.jp/markets/statistics-equities/misc/01.html"
STOCKANALYSIS = "https://stockanalysis.com/list/tokyo-stock-exchange/"

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
    ("2914","日本たばこ産業"),("4503","アステラス製薬"),("6861","キーエンス"),
    ("7741","HOYA"),("4661","オリエンタルランド"),("3382","セブン&アイ・ホールディングス"),
    ("9020","東日本旅客鉄道"),("9022","東海旅客鉄道"),("6869","シスメックス"),
    ("5108","ブリヂストン"),("7205","日野自動車"),("6901","澤藤電機"),
    ("6501","日立製作所"),("6502","東芝"),("3402","東レ")
]

def write_outputs(rows):
    codes = [c for c,_ in rows]
    TICKERS_TXT.write_text("\n".join(codes), encoding="utf-8")
    with NAMES_CSV.open("w", encoding="utf-8", newline="") as f:
        w = csv.writer(f); w.writerow(["ticker","name"])
        for c,n in rows: w.writerow([c,n])

def from_jpx():
    try:
        html = requests.get(JPX_PAGE, headers=UA, timeout=30).text
        m = re.search(r'href="([^"]+/att/[^"]+\.(?:xlsx|xls))"', html)
        if not m: return False
        url = "https://www.jpx.co.jp" + m.group(1)
        bin = requests.get(url, headers=UA, timeout=60).content
        xf = pd.ExcelFile(io.BytesIO(bin))
        df = None
        for sh in xf.sheet_names:
            t = xf.parse(sh)
            cols = "".join(map(str, t.columns))
            if re.search(r'コード', cols) and re.search(r'銘柄名', cols):
                df = t; break
        if df is None: return False
        col_code = next(c for c in df.columns if re.search(r'コード', str(c)))
        col_name = next(c for c in df.columns if re.search(r'銘柄名', str(c)))
        # ETF/REIT/ETN/インフラ 제외
        maybe_mkt = next((c for c in df.columns if re.search(r'市場|区分', str(c))), None)
        if maybe_mkt is not None:
            df = df[~df[maybe_mkt].astype(str).str.contains("ETF|ETN|REIT|インフラ", regex=True, na=False)]
        df = df[[col_code, col_name]].dropna()
        df = df[df[col_code].astype(str).str.match(r'^\d{4}$')]
        rows = [(str(int(c)), str(n).strip()) for c,n in df.values]
        if not rows: return False
        write_outputs(rows)
        return True
    except Exception:
        return False

def from_stockanalysis():
    try:
        all_rows = []
        for page in range(1, 60):
            url = STOCKANALYSIS + (f"?p={page}" if page > 1 else "")
            r = requests.get(url, headers=UA, timeout=30)
            if r.status_code != 200: break
            # <a href="/stocks/7203.T/">7203</a></td><td>Company Name</td>
            rows = re.findall(r'/stocks/(\d{4})\.T/.*?</a>\s*</td>\s*<td[^>]*>([^<]+)</td>',
                              r.text, flags=re.S)
            if not rows: break
            all_rows.extend((c.strip(), n.strip()) for c,n in rows)
            time.sleep(0.25)
        if not all_rows: return False
        # 영어 이름만 제공 → name은 일단 영문
        # 중복 제거
        seen, rows = set(), []
        for c,n in all_rows:
            if c not in seen:
                seen.add(c); rows.append((c,n))
        write_outputs(rows)
        return True
    except Exception:
        return False

def from_repo():
    # public/jpx/jpx_universe.csv → ticker,name 열 기대
    p = Path("public/jpx/jpx_universe.csv")
    if not p.exists(): return False
    try:
        df = pd.read_csv(p)
        if "ticker" not in df.columns or "name" not in df.columns: return False
        rows = [(str(int(t)) if str(t).isdigit() else str(t), str(n)) for t,n in zip(df["ticker"], df["name"])]
        if not rows: return False
        write_outputs(rows); return True
    except Exception:
        return False

def from_seed():
    write_outputs(SEED); return True

def main():
    for fn in (from_jpx, from_stockanalysis, from_repo, from_seed):
        if fn():
            print(f"OK: universe built via {fn.__name__}")
            print(f" -> {TICKERS_TXT} / {NAMES_CSV}")
            return
    print("ERROR: JPX/backup 소스에서 종목 리스트를取得失敗", file=sys.stderr); sys.exit(1)

if __name__ == "__main__":
    main()
