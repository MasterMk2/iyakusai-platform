#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""oa_server.py(Pi で Webhook を直接受ける常駐)の自己テスト。

    python3 oa_server_selftest.py        # 全ケース
    python3 oa_server_selftest.py -v     # サーバのログも見る

LINE にも Cloudflare にも繋がない。やること:

  1. 一時ディレクトリに保管庫と設定を作り、**oa_server.py をサブプロセスで起動**する
     (systemd から起動される形に近づけるため。import して直接叩くのでは
      「起動できること」自体が検査から漏れる)
  2. LINE の API(表示名・メディア実体)は**モックのHTTPサーバ**に差し替える
  3. 署名つきの POST /webhook を撃ち、/export・/media を検査する
  4. 最後に **`../oa_pull.py` を実際に走らせて** `公式LINE.jsonl` まで通す
     (= Cloudflare Worker を置き換えても取り込み側が無変更で動くことの証明)

共有ドライブ上の本物の raw には触らない。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

JST = timezone(timedelta(hours=9))

HERE = Path(__file__).resolve().parent
OA_SERVER = HERE / "oa_server.py"
OA_PULL = HERE.parent / "oa_pull.py"

CHANNEL_SECRET = "selftest-channel-secret-0123456789"
PULL_TOKEN = "selftest-pull-token-abcdefghijklmnop"
ACCESS_TOKEN = "selftest-access-token"

U_KNOWN = "U" + "2" * 32
U_OTHER = "U" + "7" * 32

PNG = bytes.fromhex("89504e470d0a1a0a0000000d49484452")
PDF = b"%PDF-1.4\n% selftest\n"

VERBOSE = "-v" in sys.argv
FAILURES: list[str] = []


def check(name: str, cond: bool, detail: str = ""):
    print(("  PASS  " if cond else "  FAIL  ") + name + (f"  — {detail}" if detail and not cond else ""))
    if not cond:
        FAILURES.append(name)


# --------------------------------------------------------------------- LINE API モック

class LineApiMock(BaseHTTPRequestHandler):
    """/v2/bot/profile/<userId> と /v2/bot/message/<id>/content を返す。

    `delay` を入れてあるのは「**200 を返してから** enrich する」ことを測るため。
    ここが同期だと POST /webhook の応答がこの秒数だけ遅れる。
    """
    delay = 0.0
    hits: dict = {}

    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.headers.get("Authorization") != f"Bearer {ACCESS_TOKEN}":
            self.send_response(401); self.end_headers(); return
        time.sleep(type(self).delay)
        path = self.path
        type(self).hits[path] = type(self).hits.get(path, 0) + 1

        if path.startswith("/v2/bot/profile/"):
            uid = path[len("/v2/bot/profile/"):]
            if uid == U_KNOWN:
                body = json.dumps({"displayName": "軽音サークル"}, ensure_ascii=False).encode("utf-8")
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(body)))
                self.end_headers(); self.wfile.write(body); return
            self.send_response(404); self.send_header("content-length", "0"); self.end_headers(); return

        if path.startswith("/v2/bot/message/") and path.endswith("/content"):
            mid = path[len("/v2/bot/message/"):-len("/content")]
            blob = {"M0003": (PNG, "image/png"), "M0004": (PDF, "application/pdf")}.get(mid)
            if not blob:
                self.send_response(404); self.send_header("content-length", "0"); self.end_headers(); return
            data, ctype = blob
            self.send_response(200)
            self.send_header("content-type", ctype)
            self.send_header("content-length", str(len(data)))
            self.end_headers(); self.wfile.write(data); return

        self.send_response(404); self.send_header("content-length", "0"); self.end_headers()


# --------------------------------------------------------------------- ヘルパ

def sign(body: bytes) -> str:
    return base64.b64encode(
        hmac.new(CHANNEL_SECRET.encode("utf-8"), body, hashlib.sha256).digest()).decode()


def post_webhook(base: str, payload: dict, signature: str | None = None, raw: bytes | None = None):
    body = raw if raw is not None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(f"{base}/webhook", data=body, method="POST",
                                 headers={"Content-Type": "application/json"})
    if signature is None:
        signature = sign(body)
    if signature:
        req.add_header("x-line-signature", signature)
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return res.status, res.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def get(base: str, path: str, token: str | None = PULL_TOKEN):
    req = urllib.request.Request(base + path)
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return res.status, res.read(), dict(res.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read(), dict(e.headers)


def export(base: str, after: str = "", limit: int = 100) -> list[dict]:
    code, body, _ = get(base, f"/export?after={urllib.parse.quote(after)}&limit={limit}")
    if code != 200:
        return []
    return [json.loads(l) for l in body.decode("utf-8").splitlines() if l.strip()]


def wait_until(fn, timeout=15.0, interval=0.2) -> bool:
    """条件が満たされるまで待つ。**例外は握る。**

    起動待ちにも使うので、まだ listen していない間の URLError(Connection refused)で
    落ちてはいけない。Windows では初回接続がたまたま通って露見しなかったが、
    Pi(スクリプトが rclone マウント上=初回読み込みが遅い)では毎回ここで落ちていた。
    """
    end = time.time() + timeout
    while time.time() < end:
        try:
            if fn():
                return True
        except Exception:
            pass
        time.sleep(interval)
    return False


def msg_event(ms: int, mtype: str, **over) -> dict:
    m = {"id": over.pop("mid", f"M{ms % 10000:04d}"), "type": mtype}
    m.update(over.pop("message", {}))
    ev = {"type": "message", "mode": "active", "timestamp": ms,
          "source": {"type": "user", "userId": over.pop("user", U_KNOWN)},
          "message": m}
    ev.update(over)
    return ev


# --------------------------------------------------------------------- 本体

def main() -> int:
    for p in (OA_SERVER, OA_PULL):
        if not p.exists():
            sys.exit(f"[ERROR] {p} が見つかりません")

    api = ThreadingHTTPServer(("127.0.0.1", 0), LineApiMock)
    threading.Thread(target=api.serve_forever, daemon=True).start()
    api_base = f"http://127.0.0.1:{api.server_address[1]}"

    tmp = Path(tempfile.mkdtemp(prefix="oa_server_selftest_"))
    store = tmp / "store"
    cfg_path = tmp / "server.json"
    cfg_path.write_text(json.dumps({
        "channel_secret": CHANNEL_SECRET,
        "channel_access_token": ACCESS_TOKEN,
        "pull_token": PULL_TOKEN,
        "listen_host": "127.0.0.1",
        "listen_port": 0,                 # 後で実ポートに差し替える
        "store": str(store),
        "api_base": api_base,
        "api_data_base": api_base,
        "retention_days": 0,
    }, ensure_ascii=False), encoding="utf-8")

    # ポート 0 だと外から URL が分からないので、空きポートを自分で取って固定する
    import socket
    s = socket.socket(); s.bind(("127.0.0.1", 0)); port = s.getsockname()[1]; s.close()
    cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    cfg["listen_port"] = port
    cfg_path.write_text(json.dumps(cfg, ensure_ascii=False), encoding="utf-8")
    base = f"http://127.0.0.1:{port}"

    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1")
    proc = subprocess.Popen([sys.executable, str(OA_SERVER), "--config", str(cfg_path)],
                            stdout=None if VERBOSE else subprocess.DEVNULL,
                            stderr=None if VERBOSE else subprocess.DEVNULL, env=env)
    try:
        print(f"oa_server: {base} / LINE API モック: {api_base}\n")
        up = wait_until(lambda: get(base, "/healthz", token=None)[0] == 200, timeout=20)
        check("① サブプロセスとして起動して /healthz が 200", up)
        if not up:
            raise SystemExit(1)
        check("① /healthz は認証なしで通る(監視用)", get(base, "/healthz", token=None)[0] == 200)

        # ② 署名検証
        body = json.dumps({"events": []}).encode("utf-8")
        code, _ = post_webhook(base, {}, signature="ZGVhZGJlZWY=", raw=body)
        check("② 署名が違えば 403", code == 403, f"code={code}")
        code, _ = post_webhook(base, {}, signature="", raw=body)
        check("② 署名が無ければ 403", code == 403, f"code={code}")
        code, _ = post_webhook(base, {"events": []})
        check("② 検証リクエスト(events 空)は 200", code == 200, f"code={code}")
        check("② 403 のイベントは保管されない", export(base) == [])

        # ③ 受信 → 保管 → /export
        t0 = 1788000000000        # 2026-09-01 相当の固定 ms(テストを日付に依存させない)
        events = [
            msg_event(t0 + 1000, "text", message={"text": "テントを3張お願いします"}),
            msg_event(t0 + 2000, "text", user=U_OTHER, message={"text": "出店の申込について"}),
            msg_event(t0 + 3000, "image", mid="M0003"),
            msg_event(t0 + 4000, "file", mid="M0004", message={"fileName": "見積書.pdf", "fileSize": 1234}),
            {"type": "follow", "mode": "active", "timestamp": t0 + 5000,
             "source": {"type": "user", "userId": U_KNOWN}},
            msg_event(t0 + 6000, "sticker", message={"packageId": "1", "stickerId": "2"}),
            msg_event(t0 + 7000, "location", message={"title": "南キャンパス", "address": "架空市南町1-2-3"}),
            {"type": "postback", "mode": "active", "timestamp": t0 + 8000,
             "source": {"type": "user", "userId": U_KNOWN}, "postback": {"data": "action=accept"}},
        ]
        LineApiMock.delay = 1.5           # enrich が同期なら応答がこの分だけ遅れる
        started = time.time()
        code, _ = post_webhook(base, {"events": events})
        elapsed = time.time() - started
        check("③ 正しい署名なら 200", code == 200, f"code={code}")
        check("★③ enrich(外部通信)を待たずに応答する", elapsed < 1.0, f"{elapsed:.2f}s かかった")

        recs = export(base)
        check("③ 受信した8件が /export に出る", len(recs) == 8, f"{len(recs)}件")
        check("③ すべて _key を持つ", all(r.get("_key") for r in recs))
        keys = [r["_key"] for r in recs]
        check("★③ _key が時系列=辞書順に並ぶ", keys == sorted(keys))
        check("③ キーの形が worker.js と同じ(ev:日付:ms:連番:乱数)",
              all(k.startswith("ev:") and len(k.split(":")) == 5 for k in keys))

        by_text = {r.get("text"): r for r in recs if r.get("text")}
        check("③ text の本文が入る", "テントを3張お願いします" in by_text)
        follow = [r for r in recs if r["event_type"] == "follow"]
        check("③ follow は message_type なしで残る",
              len(follow) == 1 and follow[0]["message_type"] is None)
        loc = by_text.get("南キャンパス")
        check("③ location は title と住所を分けて持つ",
              loc and loc["extra"]["address"] == "架空市南町1-2-3")
        stick = [r for r in recs if r["message_type"] == "sticker"]
        check("③ sticker は package/sticker id を残す",
              len(stick) == 1 and stick[0]["extra"]["sticker_id"] == "2")
        pb = [r for r in recs if r["event_type"] == "postback"]
        check("③ postback は data を text に入れる",
              len(pb) == 1 and pb[0]["text"] == "action=accept")

        # ④ enrich(表示名・メディア)が後から入る
        LineApiMock.delay = 0.0
        ok = wait_until(lambda: all(
            r.get("display_name") == "軽音サークル"
            for r in export(base) if r.get("user_id") == U_KNOWN))
        check("★④ 表示名が後から入る(200 を返した後の後処理)", ok)
        others = [r for r in export(base) if r.get("user_id") == U_OTHER]
        check("④ プロフィールが取れない送信者(404)でも受信は残る",
              len(others) == 1 and others[0]["display_name"] is None)
        ok = wait_until(lambda: all(
            r.get("media_key") and not r.get("media_pending")
            for r in export(base) if r.get("message_type") in ("image", "file")))
        check("★④ メディアの実体を取りに行き media_key が付く", ok)

        img = [r for r in export(base) if r["message_type"] == "image"][0]
        code, data, hdr = get(base, f"/media/{img['message_id']}")
        check("④ /media が実体を返す", code == 200 and data == PNG, f"code={code}")
        check("④ content-type が保たれる", hdr.get("Content-Type") == "image/png")
        fil = [r for r in export(base) if r["message_type"] == "file"][0]
        code, data, hdr = get(base, f"/media/{fil['message_id']}")
        check("④ ファイルの実体と x-file-name が返る",
              code == 200 and data == PDF
              and urllib.parse.unquote(hdr.get("x-file-name", "")) == "見積書.pdf")
        check("④ 無いメディアは 404", get(base, "/media/NOPE")[0] == 404)
        check("④ 表示名はキャッシュされ、同じ人を何度も引かない",
              LineApiMock.hits.get(f"/v2/bot/profile/{U_KNOWN}", 0) <= 2,
              str(LineApiMock.hits))

        # ⑤ 認証
        check("⑤ /export はトークン無しで 401", get(base, "/export", token=None)[0] == 401)
        check("⑤ /export は違うトークンで 401", get(base, "/export", token="wrong")[0] == 401)
        check("⑤ /media も同様に 401", get(base, "/media/M0003", token="wrong")[0] == 401)
        check("⑤ 知らないパスは 404", get(base, "/nope")[0] == 404)

        # ⑥ 差分とページング
        first3 = export(base, limit=3)
        check("⑥ limit が効く", len(first3) == 3, f"{len(first3)}件")
        rest = export(base, after=first3[-1]["_key"])
        check("⑥ after から続きが取れる", len(rest) == 5, f"{len(rest)}件")
        check("⑥ after 以前は返さない",
              all(r["_key"] > first3[-1]["_key"] for r in rest))
        check("⑥ 最後まで読んだら空", export(base, after=recs[-1]["_key"]) == [])

        # ⑦ 壊れた入力
        code, _ = post_webhook(base, {}, raw=b"{ this is not json")
        check("⑦ 署名が通れば本文が壊れていても 200(再送で詰まらせない)", code == 200, f"code={code}")
        check("⑦ 解釈できない本文からは何も保管しない", len(export(base)) == 8, f"{len(export(base))}件")

        code, _ = post_webhook(base, {"events": [{"type": "message", "message": "bad-shape"}]})
        check("⑦ message が object でない形でも 200", code == 200, f"code={code}")
        shaped = [r for r in export(base) if r["event_type"] == "message" and r["message_id"] is None]
        check("⑦ 想定外の形でも例外にせず受信として残す(message_type は空)",
              len(shaped) == 1 and shaped[0]["message_type"] is None, f"{len(shaped)}件")

        code, _ = post_webhook(base, {"events": ["not-an-object"]})
        check("⑦ イベントが object ですらなくても 200", code == 200, f"code={code}")
        broken = [r for r in export(base) if r.get("error")]
        check("★⑦ 壊れたイベントも『受信した事実』として残る(raw ごと)",
              len(broken) == 1 and broken[0].get("raw") == "not-an-object", f"{len(broken)}件")

        # ⑧ oa_pull.py との通し(取り込み側は無変更で動くか)
        pull_root = tmp / "drive"
        (pull_root / "line" / "tools").mkdir(parents=True)
        (pull_root / "line" / "raw").mkdir(parents=True)
        shutil.copy2(OA_PULL, pull_root / "line" / "tools" / "oa_pull.py")
        (pull_root / "line" / "raw" / "_oa_contacts.json").write_text(json.dumps({
            "_note": ["selftest"],
            "contacts": {U_KNOWN: {"nick": "軽音", "display": "軽音サークル", "campus": "南"}},
        }, ensure_ascii=False), encoding="utf-8")
        pull_cfg = tmp / "pull.json"
        pull_cfg.write_text(json.dumps({"base_url": base, "pull_token": PULL_TOKEN}), encoding="utf-8")

        def run_pull(*args):
            return subprocess.run(
                [sys.executable, str(pull_root / "line" / "tools" / "oa_pull.py"),
                 "--config", str(pull_cfg), *args],
                capture_output=True, text=True, encoding="utf-8", env=env)

        r = run_pull("--dry-run")
        check("⑧ oa_pull.py が dry-run で件数を数える",
              r.returncode == 0 and "新規 10 件" in r.stdout, (r.stdout + r.stderr).strip())
        r = run_pull()
        out = pull_root / "line" / "raw" / "公式LINE.jsonl"
        rows = [json.loads(l) for l in out.read_text(encoding="utf-8").splitlines() if l.strip()] \
            if out.exists() else []
        check("★⑧ Worker を置き換えても取り込み側は無変更で通る",
              r.returncode == 0 and len(rows) == 10, f"rc={r.returncode} {len(rows)}件")
        check("⑧ 呼び名(_oa_contacts.json)が当たる",
              any(x.get("nick") == "軽音" for x in rows))
        check("⑧ メディアの実体がドライブ側に落ちる",
              sum(1 for x in rows if x.get("media")) == 2
              and (pull_root / "line" / "raw" / "_oa_media").is_dir())
        check("⑧ 2回目は新規なし",
              "新しい受信はありません" in run_pull().stdout)

        # ⑨ 受信が増えたら差分だけ増える。
        # ★ わざと **カーソルより古い timestamp**(t0 = 数日前)のイベントを送る。
        #   worker.js のようにイベント側の時刻をキーにしていると、ここで永久に
        #   取りこぼす(再送・送信側の時計ずれで実際に起きうる)。受信順キーなら拾える。
        post_webhook(base, {"events": [msg_event(t0 + 9000, "text",
                                                 message={"text": "追加の問い合わせです"})]})
        r = run_pull()
        rows2 = [json.loads(l) for l in out.read_text(encoding="utf-8").splitlines() if l.strip()]
        check("★⑨ timestamp がカーソルより古い受信でも取りこぼさない",
              len(rows2) == 11, f"{len(rows2)}件")
        check("⑨ 通し番号が続く", rows2[-1]["id"] == "公式LINE#0011")
        check("⑨ 本文の日付は LINE の timestamp を保つ(受信順キーとは別)",
              rows2[-1]["content"] == "追加の問い合わせです"
              and rows2[-1]["date"] == datetime.fromtimestamp((t0 + 9000) / 1000, JST).strftime("%Y-%m-%d"),
              rows2[-1].get("date", ""))

    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        api.shutdown()
        shutil.rmtree(tmp, ignore_errors=True)

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
