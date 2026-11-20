# -*- coding: utf-8 -*-
"""統合アプリの Bot の依頼(質問・文書・画像)の履歴を、共有ドライブへ書き出す(2026-11-21)。

[assistant] post_to_discord = false で #bottest に出さなくなった分の、ドライブ側の記録。今までは
#bottest の投稿を Discord の収集が `_目録/discord/raw/bottest__*.jsonl` に拾っていた。

- 元はジョブ表(SQLite・ローカル)。読むだけで、ジョブ表には書かない。
- 対象は ask / doc / image の完了と失敗だけ。taskdraft(本人だけが読む)・remind・screening・取り消しは入れない。
- 置き場(history_dir)の中に、月ごとの `YYYY-MM.jsonl`(1 行 = 1 依頼)と `YYYY-MM.md`(人が読む形)、
  生成物の写し `files/<ジョブ>/<名前>`、説明の `README.md` を作る。月の 2 つは、その月に新しく
  終わった依頼があるときだけ、ジョブ表から作り直す(一時ファイル → 置き換え)。手で直さない前提。
- どこまで書いたか(カーソル)はジョブ表の隣のローカルのファイルに持つ(ドライブには置かない)。
- 置き場の親(例: `_目録`)が無いときは書かない。ドライブのマウントが外れているときに、マウント先の
  ローカルのディスクへ書いてしまわないため。
- 依頼者は表示名だけを書く(#bottest の見出しに出ていた範囲)。Discord の ID は書かない。

手で流すとき(過去分をまとめて書き出す・試す):
    python -m iyakusai_bot.history_export --store <jobs.sqlite3> --files <files_dir> --out <_目録/Bot履歴> [--full]
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sqlite3
import sys
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import write_guard

JST = timezone(timedelta(hours=9))
FORMAT_VERSION = 1   # 書き出しの形を変えたら上げる(カーソルを捨てて全部を作り直す)
KINDS = ("ask", "doc", "image")
STATES = ("done", "failed")
KIND_LABELS = {"ask": "質問", "doc": "文書", "image": "画像"}
DOC_TYPE_LABELS = {"request": "依頼文", "notice": "お知らせ", "report": "報告書", "minutes": "議事録たたき台",
                   "mail": "メール文面", "free": "自由"}
# 書き出す入力の項目(連携口の検査 assistant_logic と同じ集合)。ほかの項目が増えても書かない
INPUT_FIELDS = {
    "ask": ("question", "format", "model", "effort", "tone"),
    "doc": ("docType", "content", "format", "useSources", "model"),
    "image": ("prompt", "aspect"),
}
README_NAME = "README.md"
README_TEXT = """# Bot の依頼の履歴(統合アプリ発)

統合アプリの「Bot」タブから出た依頼(質問・文書・画像)と、その結果の記録です。
2026-11-21 から、これらは Discord の #bottest に投稿しない設定にできるようになりました。その代わりの記録です
(それまでの分は `_目録/discord/raw/bottest__*.jsonl` にあります)。

- `YYYY-MM.md`: 人が読む形。依頼を受けた順。
- `YYYY-MM.jsonl`: 1 行 = 1 依頼。機械で読む形。
- `files/<ジョブ番号>/`: Bot が作ったファイル(文書・画像)の写し。

Bot(iyakusai_bot.history_export)がジョブ表から 10 分ごとに作り直します。**手で直さないでください**
(次の書き出しで上書きされます)。タスクの下書き(依頼した本人だけが読むもの)・リマインド・タスク候補は入れていません。
"""


class ExportError(RuntimeError):
    """書き出せなかった(置き場の親が無い・ジョブ表が読めない など)。次の回にやり直す。"""


@dataclass
class _Row:
    seq: int
    id: str
    kind: str
    actor_name: str
    input: dict
    state: str
    result: dict | None
    error_code: str | None
    error_message: str | None
    created_at: str
    finished_at: str | None
    updated_at: str


def state_path_for(store_path: Path) -> Path:
    """カーソルの置き場。ジョブ表と同じローカルのフォルダ(共有ドライブには置かない)。"""
    store_path = Path(store_path)
    return store_path.with_name(store_path.name + ".history-export.json")


def _load_state(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, ValueError):
        return {}   # 壊れていたら最初から作り直す(書き出しは作り直しで同じ結果になる)
    if not isinstance(data, dict) or data.get("version") != FORMAT_VERSION:
        return {}
    return data


def _save_state(path: Path, cursor: str, ids: list[str]) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps({"version": FORMAT_VERSION, "cursor": cursor, "ids": sorted(ids)},
                              ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


def _read_rows(store_path: Path) -> tuple[list[_Row], dict[str, list[dict]]]:
    if not Path(store_path).is_file():
        raise ExportError("ジョブ表が見つかりません")
    uri = Path(store_path).resolve().as_uri() + "?mode=ro"
    try:
        con = sqlite3.connect(uri, uri=True, timeout=5)
    except sqlite3.Error as error:
        raise ExportError(f"ジョブ表を開けません: {type(error).__name__}") from None
    try:
        marks = ",".join("?" for _ in KINDS)
        states = ",".join("?" for _ in STATES)
        found = con.execute(
            "SELECT seq, id, kind, actor_name, input_json, state, result_json, error_code, error_message, "
            f"created_at, finished_at, updated_at FROM jobs WHERE kind IN ({marks}) AND state IN ({states}) "
            "ORDER BY seq", (*KINDS, *STATES)).fetchall()
        files: dict[str, list[dict]] = {}
        for job_id, name, mime, size, sha, relpath in con.execute(
                "SELECT job_id, name, mime, size, sha256, relpath FROM job_files ORDER BY id"):
            files.setdefault(job_id, []).append(
                {"name": name, "mime": mime, "size": size, "sha256": sha, "relpath": relpath})
    except sqlite3.Error as error:
        raise ExportError(f"ジョブ表を読めません: {type(error).__name__}") from None
    finally:
        con.close()
    rows = []
    for seq, job_id, kind, actor, input_json, state, result_json, code, message, created, finished, updated in found:
        rows.append(_Row(seq, job_id, kind, actor or "", _json(input_json) or {}, state, _json(result_json),
                         code, message, created or "", finished, updated or created or ""))
    return rows, files


def _json(text):
    if not text:
        return None
    try:
        value = json.loads(text)
    except ValueError:
        return None
    return value


def _month(row: _Row) -> str:
    return row.created_at[:7] if len(row.created_at) >= 7 else "不明"


def _record(row: _Row, files: list[dict]) -> dict:
    fields = INPUT_FIELDS.get(row.kind, ())
    record = {
        "id": row.id,
        "kind": row.kind,
        "state": row.state,
        "actor": row.actor_name,
        "createdAt": row.created_at,
        "finishedAt": row.finished_at,
        "input": {key: row.input.get(key) for key in fields if key in row.input},
        "text": (row.result or {}).get("text", "") if row.state == "done" else "",
        "files": [{"name": f["name"], "mime": f["mime"], "size": f["size"], "sha256": f["sha256"],
                   "path": f"files/{row.id}/{f['name']}"} for f in files] if row.state == "done" else [],
        "error": ({"code": row.error_code, "message": row.error_message} if row.state == "failed" else None),
    }
    return record


def _when(iso: str | None) -> str:
    if not iso:
        return ""
    try:
        return datetime.fromisoformat(iso).astimezone(JST).strftime("%Y-%m-%d %H:%M")
    except ValueError:
        return iso


def _quote(text: str) -> str:
    """本文を引用にする(回答の見出し・区切り線が、この文書の見出しと混ざらないように)。"""
    lines = str(text or "").replace("\r\n", "\n").split("\n")
    return "\n".join(f"> {line}" if line else ">" for line in lines)


def _request_text(record: dict) -> str:
    data = record["input"]
    if record["kind"] == "ask":
        return str(data.get("question") or "")
    if record["kind"] == "image":
        return str(data.get("prompt") or "")
    return str(data.get("content") or "")


def _markdown(month: str, records: list[dict]) -> str:
    out = [f"# Bot の依頼の履歴 {month}(統合アプリ発)", "",
           "ジョブ表から機械で書き出したもの。手で直さない(次の書き出しで作り直す)。説明は README.md。", ""]
    for rec in records:
        label = KIND_LABELS.get(rec["kind"], rec["kind"])
        if rec["kind"] == "doc":
            doc_type = DOC_TYPE_LABELS.get(str(rec["input"].get("docType")), "")
            label = f"{label}({doc_type})" if doc_type else label
        out.append(f"## {_when(rec['createdAt'])} {label} — {rec['actor'] or '不明'}")
        out.append("")
        if rec["state"] == "done":
            out.append(f"- 状態: 完了({_when(rec['finishedAt'])})")
        else:
            error = rec["error"] or {}
            out.append(f"- 状態: 失敗({error.get('code') or '不明'})")
        for f in rec["files"]:
            out.append(f"- ファイル: [{f['name']}](<{f['path']}>)")
        out.append(f"- ジョブ: `{rec['id']}`")
        out.append("")
        out.append("**依頼**")
        out.append("")
        out.append(_quote(_request_text(rec)))
        out.append("")
        if rec["state"] == "done" and rec["text"]:
            out.append("**結果**")
            out.append("")
            out.append(_quote(rec["text"]))
            out.append("")
        elif rec["state"] == "failed" and (rec["error"] or {}).get("message"):
            out.append("**失敗の理由**")
            out.append("")
            out.append(_quote(rec["error"]["message"]))
            out.append("")
        out.append("---")
        out.append("")
    return "\n".join(out)


def _write_atomic(path: Path, text: str) -> bool:
    """中身が同じなら書かない(ドライブの更新を増やさない)。書いたら True。"""
    data = text.encode("utf-8")
    try:
        if path.read_bytes() == data:
            return False
    except FileNotFoundError:
        pass
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)
    return True


def _copy_files(files_dir: Path, out_dir: Path, job_id: str, files: list[dict]) -> int:
    copied = 0
    dest_root = out_dir / "files"
    for f in files:
        try:
            src = write_guard.contained(files_dir, files_dir / f["relpath"])
            dest = write_guard.contained(dest_root, dest_root / job_id / f["name"])
        except write_guard.WriteDenied:
            continue   # 置き場の外を指す名前は写さない
        if not src.is_file():
            continue   # 生成物が消えている(記録の行だけ残す)
        if dest.is_file() and dest.stat().st_size == f["size"]:
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_name(f".{dest.name}.tmp")
        shutil.copyfile(src, tmp)
        os.replace(tmp, dest)
        copied += 1
    return copied


def export(store_path: Path, files_dir: Path, out_dir: Path, state_path: Path, *, full: bool = False) -> dict:
    """1 回分の書き出し。新しく終わった依頼がある月だけを作り直す。戻り値は件数の要約。"""
    store_path, files_dir, out_dir, state_path = Path(store_path), Path(files_dir), Path(out_dir), Path(state_path)
    if not out_dir.parent.is_dir():
        raise ExportError("書き出し先の親フォルダがありません(ドライブのマウントを確かめてください)")
    rows, files = _read_rows(store_path)
    state = {} if full else _load_state(state_path)
    cursor, seen = str(state.get("cursor") or ""), set(state.get("ids") or [])
    changed = [r for r in rows if r.updated_at > cursor or (r.updated_at == cursor and r.id not in seen)]
    stats = {"months": [], "jobs": 0, "files_copied": 0}
    if not changed:
        return stats
    try:
        out_dir.mkdir(exist_ok=True)
        readme = out_dir / README_NAME
        if not readme.exists():
            _write_atomic(readme, README_TEXT)
        months = sorted({_month(r) for r in changed})
        for month in months:
            in_month = [r for r in rows if _month(r) == month]
            records = []
            for row in in_month:
                job_files = files.get(row.id, []) if row.state == "done" else []
                stats["files_copied"] += _copy_files(files_dir, out_dir, row.id, job_files)
                records.append(_record(row, job_files))
            lines = "".join(json.dumps(rec, ensure_ascii=False) + "\n" for rec in records)
            _write_atomic(out_dir / f"{month}.jsonl", lines)
            _write_atomic(out_dir / f"{month}.md", _markdown(month, records))
            stats["months"].append(month)
            stats["jobs"] += len(records)
    except OSError as error:
        raise ExportError(f"ドライブに書けません: {type(error).__name__}") from None
    newest = max(r.updated_at for r in rows)
    _save_state(state_path, newest, [r.id for r in rows if r.updated_at == newest])
    return stats


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="統合アプリの Bot の依頼の履歴を共有ドライブへ書き出す")
    parser.add_argument("--store", required=True, type=Path, help="ジョブ表(jobs.sqlite3)")
    parser.add_argument("--files", required=True, type=Path, help="生成物の置き場(assistant.files_dir)")
    parser.add_argument("--out", required=True, type=Path, help="書き出し先(例: _目録/Bot履歴)")
    parser.add_argument("--state", type=Path, help="カーソルのファイル(省略時はジョブ表の隣)")
    parser.add_argument("--full", action="store_true", help="カーソルを使わず全部の月を作り直す")
    args = parser.parse_args(argv)
    try:
        stats = export(args.store, args.files, args.out, args.state or state_path_for(args.store), full=args.full)
    except ExportError as error:
        print(f"書き出せませんでした: {error}", file=sys.stderr)
        return 1
    print(json.dumps(stats, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
