# -*- coding: utf-8 -*-
r"""
Discord digest 鮮度チェック(staleness detector)
===================================================
raw は IyakusaiBot の収集ループで自動最新化されるが、**digest 再生成は手動**
(全自動 digest は劣化リスクで見送り)。放置すると raw と digest が静かに乖離し
「最新が反映されていない」状態になる。これを**数字で可視化**する軽量ツール。

やること:
- `raw/*.jsonl` を走査し、**基準時刻(=前回 digest 再生成時点)以降の新規メッセージ**を
  チャンネル/スレッド別に数える。しきい値を超えたら「再生成すべき」と示す。
- **再生成はしない**(劣化リスクを避け、判断は人へ)。

基準時刻の持ち方:
- `digest/_last_regen.json`({"ts": "<最終再生成時点の raw 最新 ts>", "date": "..."})を基準にする。
- **digest を再生成し終えたら `--mark` で更新する**(= 現在の raw 最新 ts を刻む)。
  マーカーが無い場合は `--since YYYY-MM-DD` を指定するか、既定で 7 日前を仮の基準にする。

データの場所:
- Bot が動かすときは環境変数 IYAKUSAI_KNOWLEDGE_DIR(資料の目録のフォルダ)を渡す。
  手で動かすときは `--knowledge-dir <目録>`。どちらも無ければ、このファイルの 2 つ上を目録とみなす
  (目録の中の discord/tools/ に置いた旧配置と同じ)。

使い方:
    python digest_staleness.py --knowledge-dir <目録>              # 前回 mark 以降の新規件数(既定しきい値=30)
    python digest_staleness.py --knowledge-dir <目録> --since 2026-07-11
    python digest_staleness.py --knowledge-dir <目録> --mark       # 再生成完了後: 現在の raw 最新 ts を基準として刻む
    python digest_staleness.py --knowledge-dir <目録> --json       # 機械可読(Bot が使う)
"""
import argparse
import datetime
import glob
import io
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
# テスト用・低価値チャンネルは鮮度判定から除外(業務 digest の対象でない)
SKIP_PREFIX = ("bottest",)
DEFAULT_THRESHOLD = 30


def knowledge_dir(explicit: str | None) -> str:
    if explicit:
        return os.path.abspath(explicit)
    env = os.environ.get("IYAKUSAI_KNOWLEDGE_DIR")
    if env:
        return os.path.abspath(env)
    return os.path.dirname(os.path.dirname(HERE))


class Paths:
    def __init__(self, root: str):
        self.discord = os.path.join(root, "discord")
        self.raw = os.path.join(self.discord, "raw")
        self.digest = os.path.join(self.discord, "digest")
        self.marker = os.path.join(self.digest, "_last_regen.json")


def max_raw_ts(p: Paths):
    """本文チャンネル raw の最新 ts(ISO 文字列)を返す(除外プレフィックスは無視)。"""
    latest = ""
    for fp in glob.glob(os.path.join(p.raw, "*.jsonl")):
        if os.path.basename(fp).rsplit("__", 1)[0].startswith(SKIP_PREFIX):
            continue
        with open(fp, encoding="utf-8") as f:
            for ln in f:
                ln = ln.strip()
                if not ln:
                    continue
                try:
                    ts = json.loads(ln).get("ts", "")
                except Exception:
                    continue
                if ts > latest:
                    latest = ts
    return latest


def load_since(p: Paths, explicit):
    if explicit:
        return explicit + "T00:00:00"
    if os.path.exists(p.marker):
        try:
            with open(p.marker, encoding="utf-8") as f:
                return json.load(f).get("ts", "")
        except Exception:
            pass
    # フォールバック: 7 日前
    d = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=7)
    return d.strftime("%Y-%m-%dT%H:%M:%S")


def count_new(p: Paths, since):
    """since 以降の新規メッセージを (チャンネル名 -> (新規, 人間発言)) で返す。"""
    res = {}
    latest = ""
    for fp in glob.glob(os.path.join(p.raw, "*.jsonl")):
        name = os.path.basename(fp).rsplit("__", 1)[0]
        if name.startswith(SKIP_PREFIX):
            continue
        new = nonbot = 0
        with open(fp, encoding="utf-8") as f:
            for ln in f:
                ln = ln.strip()
                if not ln:
                    continue
                try:
                    m = json.loads(ln)
                except Exception:
                    continue
                ts = m.get("ts", "")
                if ts > latest:
                    latest = ts
                if ts and ts > since:
                    new += 1
                    if not m.get("bot"):
                        nonbot += 1
        if new:
            res[name] = res.get(name, (0, 0))
            res[name] = (res[name][0] + new, res[name][1] + nonbot)
    return res, latest


def do_mark(p: Paths):
    ts = max_raw_ts(p)
    data = {"ts": ts, "date": datetime.date.today().isoformat()}
    with open(p.marker, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"基準を更新: {p.marker}\n  最終再生成時点の raw 最新 ts = {ts}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--knowledge-dir", default="", help="資料の目録のフォルダ(未指定は IYAKUSAI_KNOWLEDGE_DIR)")
    ap.add_argument("--since", default="", help="基準日 YYYY-MM-DD(未指定はマーカー→7 日前)")
    ap.add_argument("--threshold", type=int, default=DEFAULT_THRESHOLD)
    ap.add_argument("--mark", action="store_true", help="再生成完了後に基準を刻む")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    p = Paths(knowledge_dir(args.knowledge_dir))
    if not os.path.isdir(p.raw):
        print(json.dumps({"error": "raw_dir_missing"}) if args.json else f"raw フォルダが見当たりません: {p.raw}")
        return 2

    if args.mark:
        do_mark(p)
        return 0

    since = load_since(p, args.since)
    res, latest = count_new(p, since)
    total = sum(v[0] for v in res.values())
    total_h = sum(v[1] for v in res.values())
    stale = total >= args.threshold

    if args.json:
        print(json.dumps({
            "since": since, "raw_latest": latest, "total_new": total,
            "human_new": total_h, "threshold": args.threshold, "stale": stale,
            "by_channel": {k: v[0] for k, v in res.items()},
        }, ensure_ascii=False))
        return 0

    print(f"基準(前回 digest 再生成時点): {since}")
    print(f"raw 最新: {latest or '(なし)'}")
    print(f"未反映の新規: {total} 件(うち人間発言 {total_h} 件) / しきい値 {args.threshold}")
    if res:
        print("チャンネル/スレッド別(新規件 / うち人間):")
        for name, (n, h) in sorted(res.items(), key=lambda x: -x[1][0]):
            print(f"  {name:34} {n:>4} / {h:>4}")
    print()
    if stale:
        print("⇒ ⚠ 乖離あり。digest を再生成し、完了後 `--mark` で基準更新を推奨。")
    else:
        print(f"⇒ 乖離は小さい({total}<{args.threshold})。当面は /ask の raw 検索で補完可。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
