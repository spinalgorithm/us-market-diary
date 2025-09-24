#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
data/jpx_names.csv 를 생성/갱신하고 'theme' 컬럼을 채운다.
우선순위: MANUAL_OVERRIDES > 키워드 규칙 > 'その他'
입력 소스:
- 있으면 data/jpx_names.csv 를 읽어 이름 보존
- 없으면 scripts/bootstrap_jpx_universe.py 실행해 초기 파일 생성
출력: data/jpx_names.csv  (컬럼: ticker,name,theme)
"""
import os, re, sys, csv, subprocess
from pathlib import Path
import pandas as pd

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
DATA = ROOT / "data"
DATA.mkdir(parents=True, exist_ok=True)
NAMES = DATA / "jpx_names.csv"
BOOT = ROOT / "scripts" / "bootstrap_jpx_universe.py"

# 자주 쓰는 종목 수동 지정(정확도↑)
MANUAL_OVERRIDES = {
    # ticker : (name_ja or None 유지, theme)
    "6920": (None, "半導体製造装置"),
    "8035": (None, "半導体製造装置"),
    "6146": (None, "半導体製造装置"),
    "6857": (None, "半導体検査"),
    "9984": (None, "投資・通信"),
    "8306": (None, "銀行"),
    "5803": (None, "電線・素材"),
    "7974": (None, "ゲーム・コンテンツ"),
    "6501": (None, "総合電機"),
    "7011": (None, "重工"),
    "9432": (None, "通信"),
    "9434": (None, "通信"),
    "9501": (None, "電力"),
    "6740": (None, "電子部品"),
    "9171": (None, "海運"),
    "9082": (None, "陸運・交通"),
    "3905": (None, "ソフトウェア・AI"),
    "9719": (None, "SI・ITサービス"),
    "6417": (None, "機械・装置"),
}

# 이름 키워드 → 테마 규칙(정규식, 큰 범주)
RULES = [
    (r"銀行|ﾌｨﾅﾝｼｬﾙ|証券|信託",          "金融"),
    (r"半導体|ウエハ|露光|検査|EUV|チップ",  "半導体・製造装置"),
    (r"電機|総合電機|電子|エレクトロ",      "電機・エレクトロニクス"),
    (r"自動車|四輪|二輪|タイヤ",            "自動車・部品"),
    (r"通信|ﾃﾚｺﾑ|モバイル|携帯",           "通信"),
    (r"商事|物産|丸紅|伊藤忠|住友商事|豊田通商", "総合商社"),
    (r"鉄|鋼|非鉄|銅|ｱﾙﾐ",                 "素材・金属"),
    (r"化学|樹脂|塗料|繊維|薬品",           "化学"),
    (r"食品|飲料|ﾋﾞｰﾙ|酒|菓子|ﾍﾞﾋﾞｰ",      "食品・飲料"),
    (r"小売|百貨|ｺﾝﾋﾞﾆ|ﾘﾃｲﾙ|ｱﾊﾟﾚﾙ|衣料|ﾌｧｰｽﾄﾘﾃｲﾘﾝｸﾞ|ﾕﾆｸﾛ", "小売・アパレル"),
    (r"ｹﾞｰﾑ|ｴﾝﾀ|任天堂|ｿﾆｰ|ﾊﾞﾝﾀﾞｲ",        "ゲーム・コンテンツ"),
    (r"重工|造船|機械|産業機器|ﾛﾎﾞｯﾄ",      "機械・重工"),
    (r"海運|船|物流|港湾|倉庫",             "海運・物流"),
    (r"建設|清水|鹿島|大成|西松|前田",      "建設"),
    (r"不動産|地所|ﾘｰﾄ|ﾚｼﾞﾃﾞﾝｽ",           "不動産"),
    (r"電力|ｶﾞｽ|水道|公益",                 "公益・電力ガス"),
    (r"医薬|製薬|ﾒﾃﾞｨｶﾙ|ﾍﾙｽｹｱ|ﾊﾞｲｵ",      "ヘルスケア"),
    (r"SI|情報ｻｰﾋﾞｽ|ｼｽﾃﾑ|IT",              "SI・ITサービス"),
]

def ensure_names_exists():
    """data/jpx_names.csv 없으면 bootstrap 실행"""
    if NAMES.exists():
        return
    if not BOOT.exists():
        print("ERROR: bootstrap_jpx_universe.py 가 없습니다.", file=sys.stderr)
        sys.exit(2)
    print(">> bootstrap_jpx_universe.py 실행 중...")
    r = subprocess.run([sys.executable, str(BOOT)], cwd=str(ROOT))
    if r.returncode != 0:
        print("ERROR: JPX 이름 초기화 실패", file=sys.stderr)
        sys.exit(r.returncode)

def load_names():
    df = pd.read_csv(NAMES)
    # 컬럼 표준화
    cols = {c.lower(): c for c in df.columns}
    code_col = cols.get("ticker") or cols.get("code")
    name_col = cols.get("name") or cols.get("name_ja") or cols.get("jp_name")
    if code_col is None:
        raise RuntimeError("jpx_names.csv: 'ticker' 또는 'code' 컬럼 필요")
    if name_col is None:
        # 이름 없으면 빈값으로
        df["__name"] = ""
        name_col = "__name"
    out = df[[code_col, name_col]].copy()
    out.columns = ["ticker", "name"]
    # 4자리만
    out = out[out["ticker"].astype(str).str.fullmatch(r"\d{4}")]
    out["ticker"] = out["ticker"].astype(str)
    out["name"] = out["name"].astype(str)
    return out.drop_duplicates(subset=["ticker"])

def apply_theme(name: str, ticker: str) -> str:
    # 수동 오버라이드 우선
    if ticker in MANUAL_OVERRIDES and MANUAL_OVERRIDES[ticker][1]:
        return MANUAL_OVERRIDES[ticker][1]
    # 키워드 규칙
    s = name
    for pat, theme in RULES:
        if re.search(pat, s, flags=re.I):
            return theme
    return "その他"

def apply_manual_name(name: str, ticker: str) -> str:
    m = MANUAL_OVERRIDES.get(ticker)
    if not m: return name
    override_name, _ = m
    return override_name if override_name else name

def main():
    ensure_names_exists()
    df = load_names()
    df["name"]  = [apply_manual_name(n, t) for t, n in zip(df["ticker"], df["name"])]
    df["theme"] = [apply_theme(n, t)       for t, n in zip(df["ticker"], df["name"])]

    # 필요한 컬럼만 정렬
    df = df[["ticker","name","theme"]].sort_values("ticker")
    NAMES.write_text(df.to_csv(index=False), encoding="utf-8")
    print(f"OK: wrote {NAMES}  ({len(df)} rows)")

if __name__ == "__main__":
    main()
