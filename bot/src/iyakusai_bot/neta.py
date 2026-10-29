# -*- coding: utf-8 -*-
r"""ネタ帳(委員長本人の公開Xポストから厳選した小ネタ)。

ネタ枠の口調(ホスト側の口調プリセットで neta が真のもの)のときだけ、厳選済みの数十行を**そのまま**プロンプトに渡す。
**委員会の事実の根拠には絶対に使わない**(出典[n]に出さない)= ルール文面は
ai_provider.build_neta_block() 側で担保する。

■ なぜ「検索」ではなく「厳選した静的リスト」なのか(2026-07-17・実測で決定)
  当初は全ポストをベクトル索引にして質問ごとに引く案(B)で作りかけたが、398件を
  bge-m3 で索引化して実測したところ**どの閾値でも成立しないこと**が分かった:
    - 閾値0.45 … 委員会質問の8/10で発火するが中身がノイズ(「発電機の見積」→「火力が
      高うございます」/「後夜祭の音響」→「長いナイフの夜」= 単語の偶然一致)。
      真面目な回答にノイズが接ぎ木され、Botの本業を劣化させる。
    - 閾値0.60 … ノイズは消えるが委員会質問での発火は0/10。代わりに雑談・感情系の
      質問でだけ発火し、そこで上位に来るのは**ネタとして使えない私的な内容**だった。
  つまり「ノイズを消す閾値」と「私的な投稿に集中する閾値」が同じ。ポストは中央値47文字と
  短く個人的で、委員会のロジスティクスとは偶然以外で一致しないため。
  → ネタは**人が選んだ静的リスト**で持つ。検索は捨てた(ベクトル索引も作らない)。

■ 置き場所(構造で守る)
  ネタ帳は **~/.iyakusai/neta/lines.txt(ホストローカル。共有ドライブに置かない)**。
  config.toml・mirror_dir と同じ流儀(個人の投稿を委員会の共有ドライブに置かない=
  ドライブを開ける人が素の全ポストを落とせる状態を作らない)。加えて
    - mirror.PLAIN_GLOBS は _目録 配下しか写さない → FSエージェントの Read 範囲外
    - 検索索引の roots にも入っていない → digest意味検索・keyword索引・vsearch から引かれない
  ★このファイルを共有ドライブや検索ルートに移さないこと(移すと上の保証が壊れる)。

■ 素材の性質
  本人の**公開アカウント**の投稿を本人合意で使う(アカウント名はコードに書かない)。
  ネタ帳に載せるのは「委員会で出しても平気な行」だけ(選別は人がやる)。

ネタ帳の作成補助(候補の書き出し。**Botを動かすホスト上で**):
    py -m iyakusai_bot.neta --candidates "<Xエクスポート.csv>"   # → candidates.tsv
    py -m iyakusai_bot.neta --show                               # 現在のネタ帳を確認
"""

from __future__ import annotations

import csv
import io
import logging
from pathlib import Path

log = logging.getLogger("iyakusai.neta")

DEFAULT_NETA_DIR = Path.home() / ".iyakusai" / "neta"   # ドライブ外(config.toml と同じ流儀)
LINES_NAME = "lines.txt"
CANDIDATES_NAME = "candidates.tsv"
MAX_LINES = 60          # プロンプトに載せる上限(トークン頭打ち)


def load_lines(neta_dir: Path | None = None) -> list[str]:
    """ネタ帳を読む。無ければ空(=ネタ無しで通常の口調のまま喋る)。

    1行1ネタ。`#` 始まりはコメント、空行は無視。
    """
    path = (Path(neta_dir) if neta_dir else DEFAULT_NETA_DIR) / LINES_NAME
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        log.info("ネタ帳が未作成(%s)。ネタ無しで続行", path)
        return []
    except OSError as e:
        log.warning("ネタ帳を読めません(ネタ無しで続行): %s", e)
        return []
    out = []
    for line in raw.splitlines():
        s = line.strip()
        if s and not s.startswith("#"):
            out.append(s)
    return out[:MAX_LINES]


# ---------- ネタ帳づくりの補助(手動CLI) ----------

def parse_export(csv_path: Path) -> list[dict]:
    """Xエクスポート csv(id,url,date,text,flag / ヘッダ無し)→ ポスト列。

    @返信は除外(会話の断片=単体で意味を成さず、相手アカウントを連れてくる)。
    """
    text = Path(csv_path).read_text(encoding="utf-8")
    rows = list(csv.reader(io.StringIO(text)))
    out, skipped = [], 0
    for r in rows:
        if len(r) < 4:
            continue
        body = " ".join(r[3].split())          # 改行を畳む(1行1ネタにするため)
        if not body or body.startswith("@"):
            skipped += 1
            continue
        out.append({"id": r[0], "url": r[1], "date": r[2], "text": body})
    log.info("parse: %d件(@返信 %d件を除外)", len(out), skipped)
    return out


def write_candidates(csv_path: Path, neta_dir: Path | None = None) -> int:
    """全ポストを candidates.tsv に書き出す(人が選別してネタ帳にする用の下ごしらえ)。"""
    posts = parse_export(csv_path)
    out_dir = Path(neta_dir) if neta_dir else DEFAULT_NETA_DIR
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / CANDIDATES_NAME
    with open(path, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f, delimiter="\t")
        w.writerow(["採用", "日付", "本文", "url"])
        for p in posts:
            w.writerow(["", p["date"][:10], p["text"], p["url"]])
    return len(posts)


def main() -> None:
    import argparse
    import sys
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    ap = argparse.ArgumentParser(description="ネタ帳の作成補助")
    ap.add_argument("--neta-dir", default=None,
                    help=f"置き場(既定: {DEFAULT_NETA_DIR}。共有ドライブに置かないこと)")
    ap.add_argument("--candidates", metavar="CSV", help="Xエクスポートcsvから候補を書き出す")
    ap.add_argument("--show", action="store_true", help="現在のネタ帳を表示")
    args = ap.parse_args()
    if args.candidates:
        n = write_candidates(Path(args.candidates), args.neta_dir)
        print(f"候補 {n}件 → {(Path(args.neta_dir) if args.neta_dir else DEFAULT_NETA_DIR) / CANDIDATES_NAME}")
        print(f"採用する行を {LINES_NAME}(1行1ネタ)に書けば有効になります")
    if args.show:
        lines = load_lines(args.neta_dir)
        print(f"ネタ帳: {len(lines)}行")
        for s in lines:
            print("  -", s)


if __name__ == "__main__":
    main()
