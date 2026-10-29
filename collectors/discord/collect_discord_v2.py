# -*- coding: utf-8 -*-
"""医薬祭実行委員会 Discord ログ収集スクリプト(v2: リアクション保存対応)

collect_discord.py と同一動作。相違点は simplify() が各メッセージの
reactions(絵文字名と数)を保存すること。個人名入りの催促スレッド等で完了報告が
打ち消し線ではなく :kaiketsu: 等のリアクションで行われており、v1 ではこれを
取りこぼしていたため v2 を追加した(鉄則により v1 は上書きせず新規追加)。

使い方:
    python collect_discord_v2.py
    (トークンは共有ドライブ外のファイルから読む。下記 TOKEN_FILE を参照)

出力:
    ../raw/<チャンネル名>__<チャンネルID>.jsonl  … 1行1メッセージ
    ../raw/_state.json                           … チャンネルごとの最終取得メッセージID

注意(過去分の遡及):
    _state.json により取得済みメッセージは再取得されないため、v2 に切り替えても
    既存 raw の過去メッセージにはリアクションが遡及保存されない。過去分にも
    リアクションを反映したい場合は、対象チャンネルの _state.json を巻き戻して
    再取得する(ただし raw に重複行が追記される点に注意。別ファイルへ吐くなど
    運用側で調整すること)。
"""

import json
import os
import re
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

# トークンの置き場所。環境変数 DISCORD_TOKEN_FILE で上書き可。
# 既定は自分のホームの中(本人だけが読める場所)。共有ドライブなど複数人が読める場所には置かない。
_CANDIDATES = [
    os.environ.get("DISCORD_TOKEN_FILE", ""),
    str(Path.home() / ".iyakusai" / "discord-token.env"),
    str(Path.home() / ".discord_bot_token.txt"),
]
TOKEN_FILE = next((p for p in _CANDIDATES if p and Path(p).exists()), _CANDIDATES[1])

API = "https://discord.com/api/v10"
RAW_DIR = Path(__file__).resolve().parent.parent / "raw"
STATE_FILE = RAW_DIR / "_state.json"


def load_token() -> str:
    # 環境変数 DISCORD_TOKEN があれば最優先(IyakusaiBot が自分の読込済みトークンを
    # サブプロセスへ渡す経路。トークンのファイルを読まずに済む)。
    env_tok = os.environ.get("DISCORD_TOKEN")
    if env_tok and env_tok.strip():
        return env_tok.strip()
    p = Path(TOKEN_FILE)
    if not p.exists():
        sys.exit(f"トークンファイルが見つかりません: {p}\n"
                 f"Bot トークンをこのパスに保存するか、環境変数 DISCORD_TOKEN_FILE を設定してください。")
    text = p.read_text(encoding="utf-8-sig").strip()
    # .env 形式(KEY=VALUE)にも素のトークンにも対応
    if "=" in text:
        for line in text.splitlines():
            if "TOKEN" in line.upper() and "=" in line:
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return text


def api_get(path: str, token: str):
    """GET リクエスト。レート制限(429)と一過性の切断は待って再試行する。"""
    import http.client
    url = API + path
    for _ in range(12):
        req = urllib.request.Request(url, headers={
            "Authorization": f"Bot {token}",
            "User-Agent": "iyakusai-archive-bot (private, 1.0)",
        })
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                remaining = r.headers.get("X-RateLimit-Remaining")
                if remaining == "0":
                    reset_after = float(r.headers.get("X-RateLimit-Reset-After", "1"))
                    time.sleep(reset_after + 0.1)
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 429:
                retry = float(json.loads(e.read().decode("utf-8")).get("retry_after", 2))
                time.sleep(retry + 0.5)
                continue
            if e.code == 403:  # 権限のないチャンネルはスキップ
                return None
            raise
        except (http.client.IncompleteRead, urllib.error.URLError, TimeoutError, ConnectionError):
            time.sleep(1.5)
            continue
    raise RuntimeError(f"リトライ上限超過: {path}")


def sanitize(name: str) -> str:
    return re.sub(r'[\\/:*?"<>|\s]+', "_", name).strip("_") or "channel"


def simplify(msg: dict) -> dict:
    """保存する項目を絞る(トークン・システム情報は保存しない)。

    v1 との違い: reactions(絵文字名と数)を保存する。カスタム絵文字は name、
    Unicode 絵文字も name(その文字自体)で入る。完了報告に使われる :kaiketsu:
    等を後段の digest で判定できるようにするため。

    後から判明した2つの穴:
    - **poll(投票)**: Discord の投票は `content` が空で、質問・選択肢・票数はすべて
      `poll` オブジェクトに入る。保存していなかったため、**役員会の日程決定など
      「投票で決めた意思決定」がアーカイブから丸ごと欠落**していた(会議の日程を決める
      投票が、本文なしの空メッセージとしてのみ記録された)。
    - **edited_ts**: 従来は `edited` (bool) だけで**編集時刻を捨てていた**。
      収集は差分取得(取得済みは再取得しない)なので、**収集後に編集されると raw は
      古い本文のまま**になる。時刻を持っておけば後からの再走査で
      「raw の版はいつ時点のものか」を判定できる。
    """
    poll = msg.get("poll")
    return {
        "id": msg["id"],
        "ts": msg["timestamp"],
        "author": msg["author"].get("global_name") or msg["author"].get("username", "?"),
        # author_id は Discord の不変ユーザーID。global_name(表示名)は改名され得るため、
        # 表示名→ニックネーム対応(_authors.json)を改名に強くする(ID で引ける)ために保存する。
        "author_id": msg["author"].get("id"),
        "bot": msg["author"].get("bot", False),
        "content": msg.get("content", ""),
        "attachments": [a.get("filename") for a in msg.get("attachments", [])],
        "reply_to": (msg.get("referenced_message") or {}).get("id"),
        "edited": msg.get("edited_timestamp") is not None,
        # 編集時刻そのもの(未編集なら None)。bool だけだと「いつの版か」が分からない。
        "edited_ts": msg.get("edited_timestamp"),
        "reactions": [
            {"name": (r.get("emoji") or {}).get("name"), "count": r.get("count", 0)}
            for r in msg.get("reactions", [])
        ],
        # 投票。無い場合はキーごと省く(既存 raw との差を最小にするため)。
        **({"poll": {
            "question": ((poll.get("question") or {}).get("text")),
            "answers": [
                {
                    "id": a.get("answer_id"),
                    "text": ((a.get("poll_media") or {}).get("text")),
                }
                for a in (poll.get("answers") or [])
            ],
            "multiselect": poll.get("allow_multiselect"),
            "expiry": poll.get("expiry"),
            # 票数は収集した瞬間の値(締切後に rescan すれば確定値が入る)
            "counts": [
                {"id": c.get("id"), "count": c.get("count")}
                for c in ((poll.get("results") or {}).get("answer_counts") or [])
            ],
            "finalized": ((poll.get("results") or {}).get("is_finalized")),
        }} if poll else {}),
    }


def pull_channel(cid: str, label: str, fname: Path, state: dict, token: str) -> int:
    """1チャンネル(またはスレッド)の新規メッセージを取得して追記する。"""
    after = state.get(cid, "0")
    new_msgs = []
    while True:
        batch = api_get(f"/channels/{cid}/messages?after={after}&limit=100", token)
        if batch is None:
            print(f"  {label}: 権限なし(スキップ)")
            return 0
        if not batch:
            break
        batch.sort(key=lambda m: int(m["id"]))  # 古い順に
        new_msgs.extend(batch)
        after = batch[-1]["id"]
        if len(batch) < 100:
            break
    if new_msgs:
        with open(fname, "a", encoding="utf-8") as f:
            for m in new_msgs:
                f.write(json.dumps(simplify(m), ensure_ascii=False) + "\n")
        state[cid] = new_msgs[-1]["id"]
        print(f"  {label}: +{len(new_msgs)}件")
    return len(new_msgs)


def list_threads(gid: str, text_channels: list, token: str) -> list:
    """アクティブ+アーカイブ済み(公開)スレッドを列挙する。"""
    threads = {}
    active = api_get(f"/guilds/{gid}/threads/active", token) or {}
    for t in active.get("threads", []):
        threads[t["id"]] = t
    for ch in text_channels:
        before = None
        while True:
            q = f"/channels/{ch['id']}/threads/archived/public?limit=100" + (
                f"&before={before}" if before else "")
            page = api_get(q, token)
            if not page:
                break
            ths = page.get("threads", [])
            for t in ths:
                threads[t["id"]] = t
            if not page.get("has_more") or not ths:
                break
            before = ths[-1].get("thread_metadata", {}).get("archive_timestamp")
    return list(threads.values())


def main():
    token = load_token()
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    state = json.loads(STATE_FILE.read_text(encoding="utf-8")) if STATE_FILE.exists() else {}

    guilds = api_get("/users/@me/guilds", token)
    if not guilds:
        sys.exit("Bot が参加しているサーバーがありません。招待を確認してください。")

    total_new = 0
    for g in guilds:
        print(f"サーバー: {g['name']}")
        channels = api_get(f"/guilds/{g['id']}/channels", token) or []
        text_channels = [c for c in channels if c.get("type") in (0, 5)]  # 0=text, 5=announcement
        ch_name = {c["id"]: c["name"] for c in channels}

        for ch in sorted(text_channels, key=lambda c: c.get("position", 0)):
            fname = RAW_DIR / f"{sanitize(ch['name'])}__{ch['id']}.jsonl"
            total_new += pull_channel(ch["id"], f"#{ch['name']}", fname, state, token)

        # スレッド(アクティブ+アーカイブ済み公開)
        print("スレッド収集中...")
        for th in list_threads(g["id"], text_channels, token):
            parent = sanitize(ch_name.get(th.get("parent_id"), "不明"))
            fname = RAW_DIR / f"{parent}__スレッド_{sanitize(th['name'])}__{th['id']}.jsonl"
            total_new += pull_channel(th["id"], f"#{parent} > {th['name']}", fname, state, token)

    STATE_FILE.write_text(json.dumps(state, indent=1), encoding="utf-8")
    print(f"完了: 新規 {total_new} 件")


if __name__ == "__main__":
    main()
