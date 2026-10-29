#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""公式LINE(LINE公式アカウント)の受信ログを Cloudflare Worker から回収して JSONL にする。

    python3 oa_pull.py             # 差分だけ取り込む(通常はこれ)
    python3 oa_pull.py --dry-run   # 取り込まずに件数だけ見る
    (Windows では py oa_pull.py)

やっていること:
  1. Worker の /export?after=<前回の続き> を叩いて、新しい受信イベントを取る
  2. 既存の LINE アーカイブと同じ形(1行1メッセージ)に整えて `raw/公式LINE.jsonl` に**追記**する
  3. 画像・ファイルの実体は `raw/_oa_media/` に落とす(LINE 側からは早期に消えるため)
  4. 未知の送信者(=どの団体か分からない userId)を警告として出す

定期実行の正は Raspberry Pi(systemd --user timer `iyakusai-line-oa.timer`)。
**Windows と Pi の両方で回さないこと**(`_oa_state.json` と JSONL が競合する)。

注意:
  - **取れるのは団体→委員会の受信側だけ。** 委員が管理画面から返した内容は LINE の仕様上ここに来ない。
  - 接続情報(Worker の URL と PULL_TOKEN)は**共有ドライブに置かない**。`~/.iyakusai/line_oa.json` に置く:
        {"base_url": "https://<worker名>.<サブドメイン>.workers.dev", "pull_token": "..."}
    別の場所を使うときは `--config <path>` か環境変数 `IYAKUSAI_LINE_OA_CONFIG`。
  - 配置の例は systemd/ と collectors/README.md
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

JST = timezone(timedelta(hours=9))

TOOLS_DIR = Path(__file__).resolve().parent
RAW_DIR = TOOLS_DIR.parent / "raw"
OUT_PATH = RAW_DIR / "公式LINE.jsonl"
STATE_PATH = RAW_DIR / "_oa_state.json"
CONTACTS_PATH = RAW_DIR / "_oa_contacts.json"
MEDIA_DIR = RAW_DIR / "_oa_media"
DEFAULT_CONFIG_PATH = Path.home() / ".iyakusai" / "line_oa.json"

GROUP_NAME = "公式LINE"

# event_type / message_type → 既存 LINE アーカイブと揃えた種別
SYSTEM_EVENTS = {"follow", "unfollow", "join", "leave", "memberJoined", "memberLeft", "unsend"}
EVENT_LABEL = {
    "follow": "友だち追加",
    "unfollow": "ブロック(友だち解除)",
    "join": "グループに参加",
    "leave": "グループから退出",
    "memberJoined": "メンバーが参加",
    "memberLeft": "メンバーが退出",
    "unsend": "送信取り消し",
}
MESSAGE_LABEL = {
    "image": "[画像]",
    "video": "[動画]",
    "audio": "[音声]",
    "sticker": "[スタンプ]",
}
EXT_BY_CONTENT_TYPE = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "video/mp4": ".mp4",
    "audio/m4a": ".m4a",
    "audio/mp4": ".m4a",
    "application/pdf": ".pdf",
}


def resolve_config_path(arg: str | None) -> Path:
    """--config > 環境変数 IYAKUSAI_LINE_OA_CONFIG > ~/.iyakusai/line_oa.json の順に決める。

    Windows(主ワークステーション)と Linux(Raspberry Pi)で同じコードを使うため、
    置き場所を決め打ちにしない。テストでモック Worker に向けるときもここで差す。
    """
    if arg:
        return Path(arg).expanduser()
    env = os.environ.get("IYAKUSAI_LINE_OA_CONFIG")
    if env:
        return Path(env).expanduser()
    return DEFAULT_CONFIG_PATH


def load_config(path: Path) -> dict:
    if not path.exists():
        sys.exit(
            f"[ERROR] 接続情報がありません: {path}\n"
            '        {"base_url": "https://....workers.dev", "pull_token": "..."} を作ってください。\n'
            "        (共有ドライブには置かないこと)"
        )
    cfg = json.loads(path.read_text(encoding="utf-8"))
    if not cfg.get("base_url") or not cfg.get("pull_token"):
        sys.exit(f"[ERROR] {path} に base_url / pull_token が要ります")
    cfg["base_url"] = cfg["base_url"].rstrip("/")
    return cfg


def ensure_raw_dir() -> None:
    """出力先(`line/raw/`)が本物であることを確かめる。**mkdir はしない。**

    Raspberry Pi では `line/` は rclone マウントの下にある。マウントが落ちた状態で
    走ると、mkdir する実装では**ローカルディスクに空の raw/ を作り**、
    「新規 N 件 OK」と言いながら共有ドライブには何も残らず、
    しかも次回マウント復帰後に `_oa_state.json` が無い＝先頭から取り直す形になる。
    ツール自身が置いた `_oa_contacts.json` をセンチネルにして、そこで止める。
    """
    if not RAW_DIR.is_dir() or not CONTACTS_PATH.exists():
        sys.exit(
            f"[ERROR] 出力先が見当たりません: {RAW_DIR}\n"
            f"        センチネル {CONTACTS_PATH.name} が無いので、共有ドライブが\n"
            "        マウントされていない(または別のツリーを指している)と判断して中断します。\n"
            "        Pi なら: systemctl --user status iyakusai-mount.service"
        )


def write_json_atomic(path: Path, obj) -> None:
    """同じディレクトリに書いてから os.replace で差し替える(途中で切れた state を残さない)。

    rclone マウント上で os.replace が通ることは RPi移植手順_方式A §3.3 で実測済み。
    """
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def load_json(path: Path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:  # 壊れていても落とさない(次の書き込みで直る)
        print(f"[WARN] {path.name} を読めませんでした({e})。既定値で続行します。")
        return default


def http_get(url: str, token: str, timeout: int = 60):
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    return urllib.request.urlopen(req, timeout=timeout)


def fetch_batch(cfg: dict, after: str, limit: int) -> list[dict]:
    url = f"{cfg['base_url']}/export?after={urllib.parse.quote(after)}&limit={limit}"
    try:
        with http_get(url, cfg["pull_token"]) as res:
            body = res.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        if e.code == 401:
            sys.exit("[ERROR] 401 unauthorized — PULL_TOKEN が Worker 側と一致していません")
        sys.exit(f"[ERROR] /export が {e.code} を返しました: {e.reason}")
    except urllib.error.URLError as e:
        # ここで詰まるいちばん多い原因は「受け口は動いていて受信も保管されているのに、
        # base_url と listen_host が食い違っている」形。症状が『ドライブに何も来ない』
        # なので、受信側の障害と見分けがつきにくい。宛先を明示して切り分けを助ける。
        sys.exit(
            f"[ERROR] 受け口に接続できません: {e.reason}\n"
            f"        宛先: {cfg['base_url']}\n"
            "        ① 受け口が動いているか: systemctl --user status iyakusai-line-oa-server\n"
            "        ② base_url が受け口の listen_host と一致しているか\n"
            "           (~/.iyakusai/line_oa.json と line_oa_server.json)"
        )
    return [json.loads(line) for line in body.splitlines() if line.strip()]


def safe_filename(name: str) -> str:
    name = re.sub(r'[\\/:*?"<>|]', "_", name).strip()
    return name[:120] or "file"


def download_media(cfg: dict, message_id: str, file_name: str | None) -> str | None:
    """メディアの実体を raw/_oa_media/ に保存し、raw/ からの相対パスを返す。"""
    MEDIA_DIR.mkdir(parents=True, exist_ok=True)
    url = f"{cfg['base_url']}/media/{urllib.parse.quote(message_id)}"
    try:
        with http_get(url, cfg["pull_token"], timeout=180) as res:
            data = res.read()
            ctype = res.headers.get("content-type", "")
            header_name = res.headers.get("x-file-name")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None  # Worker 側に実体が無い(保持期間切れ・取得失敗)
        print(f"[WARN] メディア取得に失敗 {message_id}: HTTP {e.code}")
        return None
    except urllib.error.URLError as e:
        print(f"[WARN] メディア取得に失敗 {message_id}: {e.reason}")
        return None

    name = file_name or (urllib.parse.unquote(header_name) if header_name else None)
    if not name:
        base = ctype.split(";")[0].strip().lower()
        # guess_extension は Windows だとレジストリを見て image/jpeg に .jpe を返すことがある。
        # LINE から来る4種だけは自分で決める。
        ext = EXT_BY_CONTENT_TYPE.get(base) or mimetypes.guess_extension(base) or ".bin"
        name = f"{message_id}{ext}"
    path = MEDIA_DIR / f"{message_id}_{safe_filename(name)}"
    if not path.exists():
        path.write_bytes(data)
    return str(path.relative_to(RAW_DIR)).replace("\\", "/")


def to_record(ev: dict, seq: int, contacts: dict, cfg: dict, dry_run: bool) -> dict:
    ts_ms = ev.get("timestamp")
    dt = datetime.fromtimestamp(ts_ms / 1000, JST) if ts_ms else datetime.now(JST)

    user_id = ev.get("user_id")
    contact = contacts.get(user_id or "", {}) if isinstance(contacts, dict) else {}
    author = ev.get("display_name") or contact.get("display") or (f"未解決({user_id[:8]}…)" if user_id else "不明")

    event_type = ev.get("event_type") or "unknown"
    message_type = ev.get("message_type")

    if event_type in SYSTEM_EVENTS:
        kind = "system"
        content = EVENT_LABEL.get(event_type, event_type)
    elif event_type == "postback":
        kind = "postback"
        content = ev.get("text") or ""
    elif event_type == "message":
        kind = message_type or "message"
        if message_type == "text":
            content = ev.get("text") or ""
        elif message_type == "file":
            content = ev.get("file_name") or "[ファイル]"
        elif message_type == "location":
            content = ev.get("text") or "[位置情報]"
        else:
            content = MESSAGE_LABEL.get(message_type or "", f"[{message_type}]")
    else:
        kind = event_type
        content = ev.get("text") or ""

    rec = {
        "id": f"{GROUP_NAME}#{seq:04d}",
        "ts": dt.strftime("%Y-%m-%dT%H:%M+09:00"),
        "date": dt.strftime("%Y-%m-%d"),
        "author": author,
        "nick": contact.get("nick"),
        "campus": contact.get("campus"),
        "kind": kind,
        "content": content,
        "src_line": None,
        # ここから公式LINE固有
        "user_id": user_id,
        "source_type": ev.get("source_type"),
        "message_id": ev.get("message_id"),
        "file_name": ev.get("file_name"),
        "media": None,
        "media_error": ev.get("media_error"),
        "_key": ev.get("_key"),
    }

    if ev.get("media_key") and ev.get("message_id") and not dry_run:
        rec["media"] = download_media(cfg, ev["message_id"], ev.get("file_name"))
        if rec["media"] is None and not rec["media_error"]:
            rec["media_error"] = "Worker から実体を取得できなかった"
    elif ev.get("media_pending"):
        # Worker 側で実体の取得が終わる前に処理が打ち切られた形。受信の事実と messageId は残っている。
        rec["media_error"] = rec["media_error"] or "実体の取得が未完了(Worker の後処理が途中で終わった可能性)"

    if ev.get("extra"):
        rec["extra"] = ev["extra"]
    if ev.get("error"):
        rec["kind"] = "unparsed"
        rec["content"] = f"[加工に失敗した生イベント] {ev.get('error')}"
        rec["extra"] = ev.get("raw")
    return rec


def main() -> int:
    ap = argparse.ArgumentParser(description="公式LINEの受信ログを Worker から回収する")
    ap.add_argument("--limit", type=int, default=40, help="1回のリクエストで取る件数(既定40・上限45)")
    ap.add_argument("--max-batches", type=int, default=50, help="1回の実行で回す最大バッチ数")
    ap.add_argument("--dry-run", action="store_true", help="書き込まずに件数だけ確認する")
    ap.add_argument("--config", help="接続情報の場所(既定 ~/.iyakusai/line_oa.json)")
    args = ap.parse_args()

    cfg = load_config(resolve_config_path(args.config))
    ensure_raw_dir()
    state = load_json(STATE_PATH, {})
    # _oa_contacts.json は {"_note": [...], "contacts": {...}} 形式。素の辞書も一応許す。
    contacts_file = load_json(CONTACTS_PATH, {})
    contacts = contacts_file.get("contacts", contacts_file) if isinstance(contacts_file, dict) else {}
    after = state.get("last_key", "")

    seen_keys = set()
    seq = 0
    if OUT_PATH.exists():
        with OUT_PATH.open(encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    old = json.loads(line)
                except Exception:
                    continue
                seq += 1
                if old.get("_key"):
                    seen_keys.add(old["_key"])

    fetched: list[dict] = []
    for _ in range(args.max_batches):
        batch = fetch_batch(cfg, after, min(args.limit, 45))
        if not batch:
            break
        fetched.extend(batch)
        after = batch[-1]["_key"]
        if len(batch) < min(args.limit, 45):
            break

    new_events = [ev for ev in fetched if ev.get("_key") not in seen_keys]
    if not new_events:
        print("新しい受信はありません。" + (f"(前回位置: {state.get('last_key', '(なし)')})"))
        # 取れた分がすべて既知 = その範囲は JSONL に入っている。続きの位置だけ進めておく
        # (進めないと、毎回同じ範囲を Worker から読み直すことになる)。
        if after and after != state.get("last_key") and not args.dry_run:
            state["last_key"] = after
            state["last_pulled_at"] = datetime.now(JST).strftime("%Y-%m-%dT%H:%M:%S+09:00")
            state["total_records"] = seq
            write_json_atomic(STATE_PATH, state)
        return 0

    records = []
    for ev in new_events:
        seq += 1
        records.append(to_record(ev, seq, contacts, cfg, args.dry_run))

    kinds: dict[str, int] = {}
    unknown_users: dict[str, int] = {}
    for r in records:
        kinds[r["kind"]] = kinds.get(r["kind"], 0) + 1
        if r["user_id"] and not r["nick"]:
            unknown_users[r["user_id"]] = unknown_users.get(r["user_id"], 0) + 1

    if args.dry_run:
        print(f"[dry-run] 新規 {len(records)} 件 / 期間 {records[0]['date']} 〜 {records[-1]['date']}")
        print(f"[dry-run] 種別: {kinds}")
        return 0

    # 本文を確定させてから state を進める。逆順にすると、途中で落ちたときに
    # 「読んだことになっているのに JSONL に無い」受信が出て、二度と取り直せない。
    with OUT_PATH.open("a", encoding="utf-8", newline="\n") as f:
        for r in records:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
        f.flush()
        os.fsync(f.fileno())

    state["last_key"] = after
    state["last_pulled_at"] = datetime.now(JST).strftime("%Y-%m-%dT%H:%M:%S+09:00")
    state["total_records"] = seq
    write_json_atomic(STATE_PATH, state)

    print(f"OK  {OUT_PATH}")
    print(f"    新規 {len(records)} 件 / 期間 {records[0]['date']} 〜 {records[-1]['date']} / 累計 {seq} 件")
    print(f"    種別: {kinds}")
    media_saved = sum(1 for r in records if r.get("media"))
    media_failed = sum(1 for r in records if r.get("media_error"))
    if media_saved or media_failed:
        print(f"    メディア: 保存 {media_saved} 件 / 取得できず {media_failed} 件 → {MEDIA_DIR}")
    if unknown_users:
        print(f"[WARN] 呼び名が未登録の送信者が {len(unknown_users)} 人います。{CONTACTS_PATH.name} の contacts に追記してください:")
        for uid, n in sorted(unknown_users.items(), key=lambda x: -x[1]):
            sample = next((r["author"] for r in records if r["user_id"] == uid), "")
            print(f'       "{uid}": {{"nick": "", "display": "{sample}", "campus": null}}   ({n}件)')
    return 0


if __name__ == "__main__":
    sys.exit(main())
