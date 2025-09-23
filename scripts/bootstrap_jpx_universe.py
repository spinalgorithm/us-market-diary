#!/usr/bin/env python3
# scripts/bootstrap_jpx_universe.py
# JPX銘柄ユニバースを作成（優先度: repo > JPX公式 > StockAnalysis > シード）
import re, io, sys, csv, time
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
    ("2914","日本たばこ産業"),("4503","アステラス製薬"),("7741","HOYA"),
    ("4661","オリエンタルランド"),("3382","セブン&アイ・ホールディングス"),
    ("9020","東日本旅客鉄道"),("9022","東海旅客鉄道"),("6869","シスメックス"),
    ("5108","ブリヂストン"),("6501","日立製作所"),("6502","東芝"),("3402","東レ")
]

def _write(rows: list[tuple[str,str]]) -> None:
    # 重複除去・4桁コードのみ
    seen, cleaned = set(), []
    for c,n in rows:
        c = str(c).strip()
        n = str(n).strip()
        if not re.fullmatch(r"\d{4}", c): continue
        if c in seen: continue
        seen.add(c); cleaned.append((c, n))
    if not cleaned:
        raise RuntimeError("no rows to write")
    # 保存
    TICKERS_TXT.write_text("\n".join([c for c,_ in cleaned]), encoding="utf-8")
    with NAMES_CSV.open("w", encoding="utf-8", newline="") as f:
        w = csv.writer(f); w.writerow(["ticker","name"])
        for c,n in cleaned: w.writerow([c,n])
    print(f"OK: {len(cleaned)} tickers -> {TICKERS_TXT} / {NAMES_CSV}")

def from_repo() -> bool:
    # public/jpx/jpx_universe.csv（任意）を最優先で読む
    for p in [Path("public/jpx/jpx_universe.csv"), Path("public/jpx_universe.csv")]:
        if not p.exists(): continue
        try:
            df = pd.read_csv(p)
            cols = {c.lower(): c for c in df.columns}
            c_code = cols.get("ticker") or cols.get("code")
            c_name = cols.get("name") or cols.get("name_ja") or cols.get("jp_name")
            if not c_code: continue
            if not c_name:
                df["__name"] = ""; c_name = "__name"
            rows = [(str(x), str(y)) for x,y in zip(df[c_code], df[c_name])]
            _write(rows); print(f"via repo: {p}")
            return True
        except Exception:
            continue
    return False

def _jpx_xls_url() -> str | None:
    try:
        html = requests.get(JPX_PAGE, headers=UA, timeout=30).text
        m = re.search(r'href="([^"]+/att/[^"]+\.(?:xlsx|xls))"', html)
        return ("https://www.jpx.co.jp" + m.group(1)) if m else None
    except Exception:
        return None

def from_jpx() -> bool:
    url = _jpx_xls_url()
    if not url: return False
    try:
        bin = requests.get(url, headers=UA, timeout=60).content
        xf = pd.ExcelFile(io.BytesIO(bin))
        df = None
        for sh in xf.sheet_names:
            t = xf.parse(sh)
            cols = "".join(map(str, t.columns))
            if re.search(r"コード", cols) and re.search(r"銘柄名", cols):
                df = t; break
        if df is None: return False
        col_code = next(c for c in df.columns if re.search(r"コード", str(c)))
        col_name = next(c for c in df.columns if re.search(r"銘柄名", str(c)))
        # ETF/REIT/ETN/インフラ除外（列があれば）
        mk_col = next((c for c in df.columns if re.search(r"市場|区分", str(c))), None)
        if mk_col is not None:
            df = df[~df[mk_col].astype(str).str.contains("ETF|ETN|REIT|インフラ", regex=True, na=False)]
        df = df[[col_code, col_name]].dropna()
        rows = [(str(int(c)), str(n)) for c,n in df.values if re.fullmatch(r"\d{4}", str(c))]
        _write(rows); print(f"via JPX: {url}")
        return True
    except Exception:
        return False

def from_stockanalysis() -> bool:
    try:
        all_rows = []
        for page in range(1, 80):
            url = STOCKANALYSIS + (f"?p={page}" if page > 1 else "")
            r = requests.get(url, headers=UA, timeout=30)
            if r.status_code != 200: break
            rows = re.findall(r'/stocks/(\d{4})\.T/.*?</a>\s*</td>\s*<td[^>]*>([^<]+)</td>', r.text, flags=re.S)
            if not rows: break
            all_rows += [(c.strip(), n.strip()) for c,n in rows]
            time.sleep(0.25)
        if not all_rows: return False
        # 重複除去
        seen, uniq = set(), []
        for c,n in all_rows:
            if c in seen: continue
            seen.add(c); uniq.append((c,n))
        _write(uniq); print(f"via StockAnalysis ({len(uniq)})")
        return True
    except Exception:
        return False

def from_seed() -> bool:
    _write(SEED); print("via SEED"); return True

def main():
    for fn in (from_repo, from_jpx, from_stockanalysis, from_seed):
        if fn():
            return
    print("ERROR: JPX universe build failed", file=sys.stderr)
    sys.exit(1)

if __name__ == "__main__":
    main()
