# -*- coding: utf-8 -*-
r"""Discord 添付ファイルの回収(実体ダウンロード)
================================================
`raw/*.jsonl` は添付の**ファイル名しか**保存していない(collect_discord_v2.simplify)。
中身が無いため「Discord に貼られた見積書」を Bot も人も読めなかった。
本スクリプトは各メッセージを **API で再取得**して**新しい署名付きURL**を得てから
実体を `_目録/discord/attachments/` に保存する。

★ 重要(2026-07-24 実証): Discord CDN の URL は `?ex=…`(期限)付きで raw に残っていても
   失効するが、**API でメッセージを取り直せば毎回新しい URL が返る**ため、
   過去の添付も回収できる(2.5ヶ月前の PDF で実証済み)。
   ただし**メッセージ自体が削除されると回収不能**なので、早いほど取りこぼしが少ない。

出力:
    ../attachments/<チャンネル名>/<YYYY-MM-DD>_<msgid>_<連番>_<元ファイル名>
    ../attachments/_index.tsv   … 回収台帳(下記の列)

_index.tsv の列:
    saved_rel / channel / msg_id / ts / author / filename / size / sha256 / content_type / status

status:
    ok        … 保存成功
    dup       … 同一内容(sha256一致)が既にあるため実体は保存せず台帳のみ
    gone      … メッセージ削除済み等で回収不能
    error:…   … 失敗

使い方:
    python fetch_attachments.py --dry            # 対象件数だけ表示
    python fetch_attachments.py                  # 全件(resumable。保存済みはスキップ)
    python fetch_attachments.py --limit 10       # 動作確認
    python fetch_attachments.py --max-mb 50      # 1ファイル上限(既定 100MB)

注意:
    - **索引化(fulltext/Bot ミラー)はしない。** 保存のみ。索引化は機微判定を挟んで別途。
    - 元ファイル(共有ドライブの委員会データ)には一切触れない。出力は `_目録/` 配下のみ。
"""
import argparse
import csv
import hashlib
import json
import os
import re
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from collect_discord_v2 import load_token, api_get, sanitize  # noqa: E402

RAW_DIR = Path(__file__).resolve().parent.parent / "raw"
ATT_DIR = Path(__file__).resolve().parent.parent / "attachments"
INDEX = ATT_DIR / "_index.tsv"
COLS = ["saved_rel", "channel", "msg_id", "ts", "author", "filename",
        "size", "sha256", "content_type", "status"]


def longpath(p: Path) -> str:
    s = os.path.abspath(str(p))
    return "\\\\?\\" + s if os.name == "nt" and not s.startswith("\\\\?\\") else s


def load_index() -> dict:
    """msg_id+filename+連番 -> row。resumable の判定に使う。"""
    if not INDEX.exists():
        return {}
    out = {}
    with open(INDEX, encoding="utf-8", newline="") as f:
        for r in csv.DictReader(f, delimiter="\t"):
            out[(r["msg_id"], r["filename"], r.get("saved_rel", ""))] = r
    return out


def save_index(rows: list):
    ATT_DIR.mkdir(parents=True, exist_ok=True)
    tmp = INDEX.with_suffix(".tmp")
    with open(longpath(tmp), "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=COLS, delimiter="\t",
                           extrasaction="ignore", lineterminator="\n")
        w.writeheader()
        w.writerows(rows)
    os.replace(longpath(tmp), longpath(INDEX))


def targets() -> list:
    """raw/*.jsonl から添付付きメッセージを列挙。(channel_label, channel_id, msg) のリスト。"""
    out = []
    for p in sorted(RAW_DIR.glob("*.jsonl")):
        if p.name.startswith("_"):
            continue
        stem = p.stem
        cid = stem.rsplit("__", 1)[-1]
        if not cid.isdigit():
            continue
        label = stem.rsplit("__", 1)[0]
        with open(p, encoding="utf-8") as f:
            for line in f:
                try:
                    o = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if o.get("attachments"):
                    out.append((label, cid, o))
    # 同一メッセージが重複行で入っていることがある(再取得運用)ので畳む
    seen, uniq = set(), []
    for label, cid, o in out:
        if o["id"] in seen:
            continue
        seen.add(o["id"])
        uniq.append((label, cid, o))
    uniq.sort(key=lambda t: t[2].get("ts", ""))
    return uniq


def download(url: str, max_bytes: int) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "iyakusai-archive-bot (private, 1.0)"})
    for _ in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read(max_bytes + 1)
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            time.sleep(1.5)
    raise RuntimeError("download failed")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--max-mb", type=int, default=100)
    ap.add_argument("--dry", action="store_true")
    args = ap.parse_args()
    max_bytes = args.max_mb * 1024 * 1024

    tgts = targets()
    n_att = sum(len(o.get("attachments") or []) for _, _, o in tgts)
    print(f"添付付きメッセージ {len(tgts)} 件 / 添付 {n_att} 個", flush=True)
    if args.dry:
        for label, cid, o in tgts[:20]:
            print(f"  {o['ts'][:10]} #{label} {o.get('author')}: {o['attachments']}")
        return
    if args.limit:
        tgts = tgts[:args.limit]

    token = load_token()
    ATT_DIR.mkdir(parents=True, exist_ok=True)
    index = load_index()
    rows = list(index.values())
    by_hash = {r["sha256"]: r["saved_rel"] for r in rows if r.get("sha256") and r.get("saved_rel")}

    done = dup = gone = err = skip = 0
    t0 = time.time()
    for n, (label, cid, o) in enumerate(tgts, 1):
        msg_id = o["id"]
        # 既に全添付が台帳にあるならAPIすら叩かない(resumable・レート節約)
        want = len(o.get("attachments") or [])
        have = sum(1 for k, row in index.items()
                   if k[0] == msg_id and row.get("status") in ("ok", "dup"))
        if have >= want and want > 0:
            skip += want
            continue
        # 失敗/goneは再確認する。成功行は保持し、再試行結果で失敗行を置き換える。
        rows = [row for row in rows if row["msg_id"] != msg_id
                or row.get("status") in ("ok", "dup")]
        failure_status = "error:forbidden"
        try:
            msg = api_get(f"/channels/{cid}/messages/{msg_id}", token)
        except urllib.error.HTTPError as e:
            if e.code == 401:
                save_index(rows)
                print("Discord認証失敗。未回収分は次回に持ち越します。", flush=True)
                raise SystemExit(1)
            msg = None
            failure_status = "gone" if e.code == 404 else f"error:http_{e.code}"
        except Exception as e:
            msg = None
            failure_status = f"error:{type(e).__name__}"
        if not msg:
            for fn in (o.get("attachments") or []):
                rows.append({"saved_rel": "", "channel": label, "msg_id": msg_id,
                             "ts": o.get("ts", ""), "author": o.get("author", ""),
                             "filename": fn, "size": "", "sha256": "",
                             "content_type": "", "status": failure_status})
                if failure_status == "gone":
                    gone += 1
                else:
                    err += 1
            continue

        chan_dir = ATT_DIR / sanitize(label)
        for i, a in enumerate(msg.get("attachments", [])):
            fn = a.get("filename") or f"attachment_{i}"
            safe = re.sub(r'[\\/:*?"<>|]+', "_", fn).strip() or f"attachment_{i}"
            day = (o.get("ts") or "")[:10]
            saved = chan_dir / f"{day}_{msg_id}_{i}_{safe}"
            rel = str(saved.relative_to(ATT_DIR)).replace("\\", "/")
            if index.get((msg_id, fn, rel), {}).get("status") in ("ok", "dup"):
                skip += 1
                continue
            try:
                data = download(a.get("url", ""), max_bytes)
                if len(data) > max_bytes:
                    rows.append({"saved_rel": "", "channel": label, "msg_id": msg_id,
                                 "ts": o.get("ts", ""), "author": o.get("author", ""),
                                 "filename": fn, "size": str(a.get("size", "")),
                                 "sha256": "", "content_type": a.get("content_type", ""),
                                 "status": f"error:too_large(>{args.max_mb}MB)"})
                    err += 1
                    continue
                h = hashlib.sha256(data).hexdigest()
                if h in by_hash:
                    rows.append({"saved_rel": by_hash[h], "channel": label, "msg_id": msg_id,
                                 "ts": o.get("ts", ""), "author": o.get("author", ""),
                                 "filename": fn, "size": str(len(data)), "sha256": h,
                                 "content_type": a.get("content_type", ""), "status": "dup"})
                    dup += 1
                    continue
                chan_dir.mkdir(parents=True, exist_ok=True)
                with open(longpath(saved), "wb") as f:
                    f.write(data)
                by_hash[h] = rel
                rows.append({"saved_rel": rel, "channel": label, "msg_id": msg_id,
                             "ts": o.get("ts", ""), "author": o.get("author", ""),
                             "filename": fn, "size": str(len(data)), "sha256": h,
                             "content_type": a.get("content_type", ""), "status": "ok"})
                done += 1
            except Exception as e:
                rows.append({"saved_rel": "", "channel": label, "msg_id": msg_id,
                             "ts": o.get("ts", ""), "author": o.get("author", ""),
                             "filename": fn, "size": "", "sha256": "",
                             "content_type": a.get("content_type", ""),
                             "status": f"error:{str(e)[:40]}"})
                err += 1
        if n % 20 == 0 or n == len(tgts):
            save_index(rows)
            print(f"[{n}/{len(tgts)}] ok={done} dup={dup} gone={gone} err={err} "
                  f"skip={skip} {time.time()-t0:.0f}s", flush=True)

    save_index(rows)
    print(f"\n完了: 新規保存 {done} / 重複 {dup} / 回収不能 {gone} / 失敗 {err} / 既存skip {skip}")
    print(f"台帳: {INDEX}")
    if err:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
