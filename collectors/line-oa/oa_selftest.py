#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""oa_pull.py の自己テスト。**Worker をデプロイしなくても**通し動作を確かめられるようにする。

    python3 oa_selftest.py          # 全ケース
    python3 oa_selftest.py -v       # oa_pull.py の出力も見る
    python3 oa_selftest.py --serve  # モック Worker だけ立てて待つ(systemd 経由の確認用)

やること: モックの Worker(/export・/media を worker.js と同じ形で返す HTTP サーバ)を立て、
一時ディレクトリに `line/tools/` `line/raw/` の形だけ作って oa_pull.py を**サブプロセスで**回す。
共有ドライブ上の本物の `raw/公式LINE.jsonl` には一切触らない。

これが確かめるのは「Pi/Windows でスクリプトが期待どおり動くか」まで。
**本物の Worker とつながるか**は別に確かめる。
"""

from __future__ import annotations

import http.server
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import urllib.parse
from datetime import datetime, timedelta, timezone
from pathlib import Path

JST = timezone(timedelta(hours=9))
TOOLS_DIR = Path(__file__).resolve().parent
OA_PULL = TOOLS_DIR / "oa_pull.py"
CONTACTS_SRC = TOOLS_DIR.parent / "raw" / "_oa_contacts.json"

TOKEN = "selftest-pull-token-0123456789abcdef"
BASE_MS = int(datetime(2026, 9, 1, 12, 0, tzinfo=JST).timestamp() * 1000)
DAY = "20260901"

PNG = bytes.fromhex("89504e470d0a1a0a0000000d49484452")  # PNG シグネチャだけの疑似データ
PDF = b"%PDF-1.4\n% selftest\n"

MEDIA = {
    "M0003": (PNG, "image/png", None),
    "M0004": (PDF, "application/pdf", "見積書_テント.pdf"),
}

U_UNKNOWN = "U" + "1" * 32   # _oa_contacts.json に無い送信者
U_KNOWN = "U" + "2" * 32     # 登録済みの送信者


def _key(i: int) -> str:
    """worker.js と同じ形: ev:<JSTの日付>:<ms 15桁>:<連番 2桁>:<乱数>"""
    return f"ev:{DAY}:{str(BASE_MS + i * 60000).zfill(15)}:{i:02d}:sfts{i:04d}"


def _base(i: int, **over) -> dict:
    rec = {
        "_key": _key(i),
        "received_at": "2026-09-01T03:00:00.000Z",
        "event_type": "message",
        "timestamp": BASE_MS + i * 60000,
        "mode": "active",
        "source_type": "user",
        "user_id": U_UNKNOWN,
        "group_id": None,
        "display_name": None,
        "message_type": "text",
        "message_id": f"M{i:04d}",
        "text": "",
        "file_name": None,
        "file_size": None,
        "media_key": None,
        "media_error": None,
        "media_pending": False,
        "extra": None,
    }
    rec.update(over)
    return rec


EVENTS = [
    _base(1, text="テントの数量を確認しました。3張でお願いします。"),
    _base(2, user_id=U_KNOWN, display_name="軽音サークル", text="出店場所の希望はA区画です。"),
    _base(3, message_type="image", text=None, media_key="md:M0003"),
    _base(4, message_type="file", text=None, file_name="見積書_テント.pdf", file_size=1234, media_key="md:M0004"),
    _base(5, event_type="follow", message_type=None, message_id=None, text=None),
    _base(6, message_type="sticker", text=None, extra={"package_id": "1", "sticker_id": "2"}),
    _base(7, message_type="image", text=None, media_pending=True),  # Worker の後処理が途中で終わった形
    {"_key": _key(8), "error": "TypeError: bad event", "raw": {"type": "???"}, "received_at": "2026-09-01T03:08:00.000Z"},
    _base(9, message_type="location", text="架空大学 南キャンパス", extra={"address": "架空市南町1-2-3"}),
    _base(10, event_type="postback", message_type=None, text="action=accept"),
]

EXTRA_EVENTS = [
    _base(11, text="追加で1件目"),
    _base(12, event_type="unfollow", message_type=None, message_id=None, text=None),
]


class MockWorker(http.server.BaseHTTPRequestHandler):
    events: list = EVENTS

    def log_message(self, *a):  # アクセスログを黙らせる
        pass

    def _auth_ok(self) -> bool:
        return self.headers.get("Authorization") == f"Bearer {TOKEN}"

    def do_GET(self):
        if not self._auth_ok():
            self.send_response(401)
            self.end_headers()
            self.wfile.write(b"unauthorized")
            return

        url = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(url.query)

        if url.path == "/export":
            after = (qs.get("after") or [""])[0]
            limit = max(1, min(int((qs.get("limit") or ["40"])[0]), 45))
            picked = [e for e in type(self).events if e["_key"] > after][:limit]
            body = "".join(json.dumps(e, ensure_ascii=False) + "\n" for e in picked).encode("utf-8")
            self.send_response(200)
            self.send_header("content-type", "application/x-ndjson; charset=utf-8")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if url.path.startswith("/media/"):
            mid = urllib.parse.unquote(url.path[len("/media/"):])
            if mid not in MEDIA:
                self.send_response(404)
                self.end_headers()
                return
            data, ctype, fname = MEDIA[mid]
            self.send_response(200)
            self.send_header("content-type", ctype)
            self.send_header("content-length", str(len(data)))
            if fname:
                self.send_header("x-file-name", urllib.parse.quote(fname))
            self.end_headers()
            self.wfile.write(data)
            return

        self.send_response(404)
        self.end_headers()


class Fixture:
    """一時ディレクトリに line/tools・line/raw の形を作る(共有ドライブは触らない)。"""

    def __init__(self, tmp: Path):
        self.root = tmp
        self.tools = tmp / "line" / "tools"
        self.raw = tmp / "line" / "raw"
        self.tools.mkdir(parents=True)
        self.raw.mkdir(parents=True)
        shutil.copy2(OA_PULL, self.tools / "oa_pull.py")
        contacts = {
            "_note": ["selftest"],
            "contacts": {U_KNOWN: {"nick": "軽音", "display": "軽音サークル", "campus": "南"}},
        }
        (self.raw / "_oa_contacts.json").write_text(
            json.dumps(contacts, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        self.config = tmp / "line_oa.json"

    def set_config(self, base_url: str, token: str = TOKEN):
        self.config.write_text(
            json.dumps({"base_url": base_url, "pull_token": token}), encoding="utf-8"
        )

    @property
    def out(self) -> Path:
        return self.raw / "公式LINE.jsonl"

    @property
    def state(self) -> Path:
        return self.raw / "_oa_state.json"

    def records(self) -> list[dict]:
        if not self.out.exists():
            return []
        return [json.loads(l) for l in self.out.read_text(encoding="utf-8").splitlines() if l.strip()]

    def run(self, *args: str) -> subprocess.CompletedProcess:
        env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1")
        return subprocess.run(
            [sys.executable, str(self.tools / "oa_pull.py"), "--config", str(self.config), *args],
            capture_output=True, text=True, encoding="utf-8", env=env,
        )


FAILURES: list[str] = []
VERBOSE = "-v" in sys.argv


def check(name: str, cond: bool, detail: str = ""):
    print(("  PASS  " if cond else "  FAIL  ") + name + (f"  — {detail}" if detail and not cond else ""))
    if not cond:
        FAILURES.append(name)


def serve_only() -> int:
    """モック Worker だけを立てて待つ。systemd 経由や別マシンからの疎通確認に使う。"""
    port = int(sys.argv[sys.argv.index("--port") + 1]) if "--port" in sys.argv else 0
    MockWorker.events = list(EVENTS) + list(EXTRA_EVENTS)
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", port), MockWorker)
    print(f"base_url   : http://127.0.0.1:{srv.server_address[1]}")
    print(f"pull_token : {TOKEN}")
    print(f"イベント   : {len(MockWorker.events)} 件(すべて架空)")
    print("⚠ ここから取れるのは**偽のデータ**。本番の raw/公式LINE.jsonl に混ぜないこと(--dry-run で使う)。")
    sys.stdout.flush()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


def main() -> int:
    if "--serve" in sys.argv:
        return serve_only()
    if not OA_PULL.exists():
        sys.exit(f"[ERROR] {OA_PULL} が見つかりません")

    MockWorker.events = list(EVENTS)
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), MockWorker)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base_url = f"http://127.0.0.1:{srv.server_address[1]}"
    print(f"モック Worker: {base_url}\n")

    with tempfile.TemporaryDirectory() as td:
        fx = Fixture(Path(td))
        fx.set_config(base_url)

        # ① dry-run は何も書かない
        r = fx.run("--dry-run", "--limit", "4")
        if VERBOSE:
            print(r.stdout, r.stderr)
        check("① dry-run が成功する", r.returncode == 0, r.stderr.strip())
        check("① dry-run で新規10件を数える", "新規 10 件" in r.stdout, r.stdout.strip())
        check("① dry-run は JSONL を作らない", not fx.out.exists())
        check("① dry-run は state を作らない", not fx.state.exists())

        # ② 本実行(limit=4 で3ページに跨る)
        r = fx.run("--limit", "4")
        if VERBOSE:
            print(r.stdout, r.stderr)
        recs = fx.records()
        check("② 本実行が成功する", r.returncode == 0, r.stderr.strip())
        check("② 10件が JSONL に入る", len(recs) == 10, f"{len(recs)}件")
        check("② ページングで取りこぼさない", [x["_key"] for x in recs] == [e["_key"] for e in EVENTS])
        check("② state に続きの位置が入る",
              fx.state.exists() and json.loads(fx.state.read_text(encoding="utf-8")).get("last_key") == EVENTS[-1]["_key"])
        check("② 通し番号が 0001 から", recs[0]["id"] == "公式LINE#0001" and recs[9]["id"] == "公式LINE#0010")

        by_key = {x["_key"]: x for x in recs}
        r1, r2 = by_key[_key(1)], by_key[_key(2)]
        check("③ 登録済み送信者に nick が入る", r2["nick"] == "軽音" and r2["author"] == "軽音サークル")
        check("③ 未登録送信者は nick が空", r1["nick"] is None)
        check("③ 未登録送信者を WARN で出す", "呼び名が未登録の送信者" in r.stdout and U_UNKNOWN in r.stdout)

        # ④ メディアの実体
        media_dir = fx.raw / "_oa_media"
        saved = sorted(p.name for p in media_dir.iterdir()) if media_dir.is_dir() else []
        check("④ メディア2件を保存する", len(saved) == 2, str(saved))
        check("④ ファイル名を x-file-name から復元する",
              any("見積書_テント.pdf" in n for n in saved), str(saved))
        check("④ 拡張子を content-type から決める(.jpe にしない)",
              any(n.endswith(".png") for n in saved), str(saved))
        check("④ JSONL から相対パスで辿れる",
              (fx.raw / by_key[_key(3)]["media"]).exists() and "\\" not in by_key[_key(3)]["media"])
        check("④ 実体の取得が未完了なら理由を残す",
              by_key[_key(7)]["media"] is None and "未完了" in (by_key[_key(7)]["media_error"] or ""))

        # ⑤ 種別の整形
        check("⑤ follow は system 扱い",
              by_key[_key(5)]["kind"] == "system" and by_key[_key(5)]["content"] == "友だち追加")
        check("⑤ file は本文にファイル名",
              by_key[_key(4)]["kind"] == "file" and by_key[_key(4)]["content"] == "見積書_テント.pdf")
        check("⑤ sticker は [スタンプ]", by_key[_key(6)]["content"] == "[スタンプ]")
        check("⑤ location は本文を残す", by_key[_key(9)]["content"] == "架空大学 南キャンパス")
        check("⑤ postback は data を残す", by_key[_key(10)]["content"] == "action=accept")
        check("⑤ 壊れたイベントは unparsed にする",
              by_key[_key(8)]["kind"] == "unparsed" and "加工に失敗" in by_key[_key(8)]["content"])
        check("⑤ JST で日付が入る", recs[0]["ts"].endswith("+09:00") and recs[0]["date"] == "2026-09-01")

        # ⑥ 再実行しても増えない(重複防止)
        r = fx.run()
        check("⑥ 2回目は新規なし", r.returncode == 0 and "新しい受信はありません" in r.stdout, r.stdout.strip())
        check("⑥ 行数が増えない", len(fx.records()) == 10, f"{len(fx.records())}件")

        # ⑦ state を消しても、_key の突合で二重にならない
        fx.state.unlink()
        r = fx.run()
        check("⑦ state 喪失後も二重取り込みしない", len(fx.records()) == 10, f"{len(fx.records())}件")

        # ⑧ 差分だけ増える
        MockWorker.events = list(EVENTS) + list(EXTRA_EVENTS)
        r = fx.run()
        recs = fx.records()
        check("⑧ 追加の2件だけ増える", len(recs) == 12, f"{len(recs)}件")
        check("⑧ 通し番号が続く", recs[11]["id"] == "公式LINE#0012")
        check("⑧ unfollow を残す", recs[11]["content"] == "ブロック(友だち解除)")

        # ⑨ 出力先が無いとき(=rclone マウントが落ちた形)は止まる
        (fx.raw / "_oa_contacts.json").unlink()
        r = fx.run()
        check("⑨ センチネルが無ければ中断する", r.returncode != 0, f"rc={r.returncode}")
        check("⑨ 中断の理由を出す", "出力先が見当たりません" in (r.stdout + r.stderr), (r.stdout + r.stderr).strip())

        # ⑩ 認証が合わなければ止まる
        fx2 = Fixture(Path(td) / "second")
        fx2.set_config(base_url, token="wrong-token")
        r = fx2.run()
        check("⑩ PULL_TOKEN 不一致で 401 を報せる",
              r.returncode != 0 and "401" in (r.stdout + r.stderr), (r.stdout + r.stderr).strip())

        # ⑪ 接続情報が無いときの案内
        fx3 = Fixture(Path(td) / "third")
        r = fx3.run()
        check("⑪ 接続情報が無ければ場所を案内する",
              r.returncode != 0 and "接続情報がありません" in (r.stdout + r.stderr))

    srv.shutdown()
    print()
    if FAILURES:
        print(f"NG  {len(FAILURES)} 件が落ちました:")
        for n in FAILURES:
            print(f"    - {n}")
        return 1
    print("OK  すべて通りました。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
