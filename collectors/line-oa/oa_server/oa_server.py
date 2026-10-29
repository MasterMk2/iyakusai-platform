#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""公式LINE の Webhook を **Raspberry Pi で直接受ける**常駐サービス。

Cloudflare Worker 版(`../oa_webhook/worker.js`)の置き換え。提供する口は同じなので、
取り込み側(`../oa_pull.py`)は `base_url` を差し替えるだけで動く。

    GET  /healthz                     … 生存確認(認証なし・何も明かさない)
    POST /webhook                     … LINE からの受信(署名検証 → 保管 → 即 200)
    GET  /export?after=&limit=        … 差分を ndjson で返す(要 PULL_TOKEN)
    GET  /media/<messageId>           … 画像・ファイルの実体(要 PULL_TOKEN)

Worker 版に対する違い(Pi 完結にしたことで良くなった点):

  - **保管に期限が無い。** KV の 90日 TTL が消えたので、pull が数週間止まっても失われない。
  - **rclone マウントが落ちていても受信は失われない。** 受信の記録(ローカル)と
    ドライブへの整形(oa_pull.py)が分離されているため。

⚠ 引き換えに **Pi が落ちている間の受信は失われる**(LINE の Webhook 再送は保証されない)。
   これは運用上の判断(失われた分は公式の手順で過去ログを見る)。
   ただしその担保 = 公式アカウントの履歴保存には**期間の上限がある**(無料プランで約6か月)。

設定は `~/.iyakusai/line_oa_server.json`(**共有ドライブに置かない**):

    {
      "channel_secret":       "...",      # 署名検証。必須
      "channel_access_token": "...",      # 表示名・メディア取得。無くても受信はできる
      "pull_token":           "...",      # /export・/media の認証。必須
      "listen_host":          "127.0.0.1",
      "listen_port":          8788,
      "store":                "/opt/iyakusai-line-oa",
      "retention_days":       0           # 0 = 無期限
    }

配置の例は ../systemd/ と collectors/README.md
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
import queue
import secrets
import shutil
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

JST = timezone(timedelta(hours=9))
DEFAULT_CONFIG_PATH = Path.home() / ".iyakusai" / "line_oa_server.json"
DEFAULT_STORE = "/opt/iyakusai-line-oa"

EV_PREFIX = "ev:"
MEDIA_TYPES = {"image", "video", "audio", "file"}
PROFILE_TTL_SEC = 7 * 24 * 3600      # 表示名のキャッシュ。団体名は滅多に変わらない


def log(msg: str) -> None:
    """journal 向け。**本文・住所・トークンは絶対に書かない**(受信の事実だけ)。"""
    print(f"{datetime.now(JST):%Y-%m-%d %H:%M:%S} {msg}", flush=True)


def jst_day(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, JST).strftime("%Y%m%d")


def make_key(ms: int, i: int) -> str:
    """worker.js と同じ形: ev:<JSTの日付>:<ms 15桁>:<連番 2桁>:<乱数>。

    **辞書順が時系列順になること**が /export の `after` 比較の前提。
    ゼロ埋めを崩すと、桁が変わった瞬間に差分が飛ぶ。

    🔑 **ここに入れるのは「受信した時刻」であって、LINE のイベント timestamp ではない**
    (worker.js は `ev.timestamp` を使っていた)。`after` は単調増加のカーソルなので、
    イベント側の時刻を使うと **再送や送信側の時計ずれで過去の timestamp が来たとき、
    カーソルを追い越せず永久に取りこぼす**。受信順にすれば構造的に起きない。
    レコードの `timestamp`(=LINE の値)はそのまま持つので、JSONL の日付は正しいままになる。
    """
    return f"{EV_PREFIX}{jst_day(ms)}:{str(ms).zfill(15)}:{i:02d}:{secrets.token_hex(4)}"


# --------------------------------------------------------------------------- 保管

class Store:
    """ローカルの保管庫。1イベント=1ファイル(後から表示名・メディアで**上書きできる**形)。

    events/<JSTの日付>/<key>.json … 受信イベント
    media/<messageId>             … 実体 + <messageId>.meta.json
    profiles.json                 … userId → 表示名 のキャッシュ

    ⚠ 置き場所をホームの外(`/opt`)にしているのは、ホーム配下をファイル共有で公開している機械でも
      本文へ届く経路を増やさないため。公式LINE には外部の人の住所・氏名が流れてくることがある。
    """

    def __init__(self, root: Path):
        self.root = root
        self.events = root / "events"
        self.media = root / "media"
        self.profiles_path = root / "profiles.json"
        self._lock = threading.Lock()
        for d in (self.events, self.media):
            d.mkdir(parents=True, exist_ok=True)

    # --- イベント ---------------------------------------------------------

    # キーは `ev:...:...` とコロン区切りだが、**Windows ではファイル名に `:` を使えない**
    # (代替データストリーム扱いになり、書き込みが黙って失敗する)。保管庫を主WSで
    # 覗くこともあるので、ファイル名では `-` に置き換える。キーの各フィールドは
    # 固定長・数字と hex だけなので、置換しても**辞書順は変わらず**可逆。
    @staticmethod
    def _stem(key: str) -> str:
        return key.replace(":", "-")

    @staticmethod
    def _key_of(stem: str) -> str:
        return stem.replace("-", ":")

    def _path(self, key: str) -> Path:
        parts = key.split(":")
        day = parts[1] if len(parts) > 2 else "unknown"
        return self.events / day / f"{self._stem(key)}.json"

    def put_event(self, key: str, record: dict) -> None:
        p = self._path(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_name(p.name + ".tmp")
        tmp.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, p)          # 途中で切れた JSON を /export に見せない

    def get_event(self, key: str) -> dict | None:
        try:
            return json.loads(self._path(key).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None

    def iter_keys(self, after: str, limit: int) -> list[str]:
        """`after` より後ろのキーを、時系列(=辞書順)で最大 limit 件。

        日付ディレクトリを先に絞るので、貯まっても全件を舐めない
        (worker.js の `dy:` 索引と同じ役割をディレクトリ構造が担う)。
        """
        after_day = after.split(":")[1] if after.startswith(EV_PREFIX) and after.count(":") > 1 else ""
        after_stem = self._stem(after)
        out: list[str] = []
        try:
            days = sorted(d.name for d in self.events.iterdir() if d.is_dir())
        except OSError:
            return out
        for day in days:
            if after_day and day < after_day:
                continue
            try:
                stems = sorted(f.stem for f in (self.events / day).glob("*.json"))
            except OSError:
                continue
            for stem in stems:
                if stem > after_stem:
                    out.append(self._key_of(stem))
                    if len(out) >= limit:
                        return out
        return out

    # --- メディア ---------------------------------------------------------

    def put_media(self, message_id: str, data: bytes, content_type: str, file_name: str | None) -> None:
        safe = urllib.parse.quote(message_id, safe="")
        (self.media / safe).write_bytes(data)
        (self.media / f"{safe}.meta.json").write_text(
            json.dumps({"content_type": content_type, "file_name": file_name}, ensure_ascii=False),
            encoding="utf-8")

    def get_media(self, message_id: str):
        safe = urllib.parse.quote(message_id, safe="")
        p = self.media / safe
        if not p.is_file():
            return None
        try:
            meta = json.loads((self.media / f"{safe}.meta.json").read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            meta = {}
        return p.read_bytes(), meta.get("content_type") or "application/octet-stream", meta.get("file_name")

    # --- 表示名キャッシュ -------------------------------------------------

    def get_profile(self, user_id: str) -> str | None:
        with self._lock:
            try:
                data = json.loads(self.profiles_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                return None
        hit = data.get(user_id)
        if not hit or time.time() - hit.get("at", 0) > PROFILE_TTL_SEC:
            return None
        return hit.get("name")

    def put_profile(self, user_id: str, name: str) -> None:
        with self._lock:
            try:
                data = json.loads(self.profiles_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                data = {}
            data[user_id] = {"name": name, "at": time.time()}
            tmp = self.profiles_path.with_name(self.profiles_path.name + ".tmp")
            tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            os.replace(tmp, self.profiles_path)

    # --- 掃除 -------------------------------------------------------------

    def purge(self, retention_days: int) -> int:
        """retention_days より古い日付ディレクトリを消す(0 なら何もしない)。"""
        if retention_days <= 0:
            return 0
        limit = (datetime.now(JST) - timedelta(days=retention_days)).strftime("%Y%m%d")
        removed = 0
        try:
            days = [d for d in self.events.iterdir() if d.is_dir() and d.name < limit]
        except OSError:
            return 0
        for d in days:
            shutil.rmtree(d, ignore_errors=True)
            removed += 1
        return removed


# --------------------------------------------------------------------------- 受信の整形

def base_record(ev: dict) -> dict:
    """**外部通信なしで組み立てられる部分だけ**の記録(worker.js の baseRecord と同じ形)。

    表示名やメディアより先にこれを確定させるのが肝心。先に取りに行くと、
    後処理が落ちたときイベントごと消える。
    """
    src = ev.get("source") or {}
    rec = {
        "received_at": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "event_type": ev.get("type") or "unknown",
        "timestamp": ev.get("timestamp") or None,
        "mode": ev.get("mode") or None,
        "source_type": src.get("type"),
        "user_id": src.get("userId"),
        "group_id": src.get("groupId") or src.get("roomId"),
        "display_name": None,
        "message_type": None,
        "message_id": None,
        "text": None,
        "file_name": None,
        "file_size": None,
        "media_key": None,
        "media_error": None,
        "media_pending": False,
        "extra": None,
    }

    if ev.get("type") == "message" and isinstance(ev.get("message"), dict):
        m = ev["message"]
        rec["message_type"] = m.get("type")
        rec["message_id"] = m.get("id")
        if m.get("type") == "text":
            rec["text"] = m.get("text") or ""
            if m.get("quotedMessageId"):
                rec["extra"] = {"quoted_message_id": m["quotedMessageId"]}
        elif m.get("type") == "sticker":
            rec["extra"] = {"package_id": m.get("packageId"), "sticker_id": m.get("stickerId"),
                            "keywords": m.get("keywords")}
        elif m.get("type") == "location":
            rec["text"] = m.get("title") or m.get("address") or ""
            rec["extra"] = {"address": m.get("address"), "latitude": m.get("latitude"),
                            "longitude": m.get("longitude")}
        elif m.get("type") == "file":
            rec["file_name"] = m.get("fileName")
            rec["file_size"] = m.get("fileSize")

        if m.get("type") in MEDIA_TYPES and m.get("id"):
            cp = m.get("contentProvider") or {}
            if cp.get("type") == "external":
                rec["media_error"] = "external provider(実体は LINE 側に無い)"
                rec["extra"] = {"original_content_url": cp.get("originalContentUrl")}
            else:
                rec["media_pending"] = True
    elif ev.get("type") == "postback" and isinstance(ev.get("postback"), dict):
        rec["text"] = ev["postback"].get("data") or ""
    elif ev.get("type") == "unsend" and isinstance(ev.get("unsend"), dict):
        rec["message_id"] = ev["unsend"].get("messageId")

    return rec


# --------------------------------------------------------------------------- LINE API

def _api_get(url: str, token: str, timeout: int = 20):
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    return urllib.request.urlopen(req, timeout=timeout)


def fetch_display_name(user_id: str, cfg: dict) -> str | None:
    url = f"{cfg['api_base']}/v2/bot/profile/{urllib.parse.quote(user_id)}"
    try:
        with _api_get(url, cfg["channel_access_token"]) as res:
            return (json.loads(res.read().decode("utf-8")) or {}).get("displayName")
    except (urllib.error.URLError, json.JSONDecodeError, OSError):
        return None                      # 友だち未追加だと 404。名前が無いだけで受信は成立する


def fetch_media(message_id: str, cfg: dict):
    url = f"{cfg['api_data_base']}/v2/bot/message/{urllib.parse.quote(message_id)}/content"
    try:
        with _api_get(url, cfg["channel_access_token"], timeout=120) as res:
            return res.read(), res.headers.get("content-type", "application/octet-stream")
    except urllib.error.HTTPError as e:
        return None, f"HTTP {e.code}"
    except (urllib.error.URLError, OSError) as e:
        return None, str(e)


def enrich(store: Store, cfg: dict, key: str) -> None:
    """表示名とメディアの実体(=外部通信)。**200 を返した後**にワーカーが呼ぶ。"""
    rec = store.get_event(key)
    if not rec or rec.get("error"):
        return
    changed = False

    if rec.get("user_id") and cfg.get("channel_access_token") and not rec.get("display_name"):
        name = store.get_profile(rec["user_id"]) or fetch_display_name(rec["user_id"], cfg)
        if name:
            store.put_profile(rec["user_id"], name)
            rec["display_name"] = name
            changed = True

    if rec.get("media_pending") and rec.get("message_id"):
        if not cfg.get("channel_access_token"):
            rec["media_error"] = "CHANNEL_ACCESS_TOKEN 未設定のため実体を取得していない"
        else:
            data, info = fetch_media(rec["message_id"], cfg)
            if data is None:
                rec["media_error"] = f"実体を取得できなかった({info})"
            else:
                store.put_media(rec["message_id"], data, info, rec.get("file_name"))
                rec["media_key"] = f"md:{rec['message_id']}"
        rec["media_pending"] = False
        changed = True

    if changed:
        store.put_event(key, rec)


# --------------------------------------------------------------------------- HTTP

def verify_signature(secret: str, body: bytes, signature: str | None) -> bool:
    """**生のバイト列**に対する HMAC-SHA256 → base64。パースし直したものを使わないこと。"""
    mac = base64.b64encode(hmac.new(secret.encode("utf-8"), body, hashlib.sha256).digest()).decode()
    return hmac.compare_digest(mac, signature or "")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "iyakusai-line-oa"
    sys_version = ""                     # 実装とバージョンを外に晒さない

    cfg: dict = {}
    store: Store | None = None
    work_q: queue.Queue | None = None

    def log_message(self, fmt, *args):   # 既定のアクセスログはパスを丸ごと出すので使わない
        pass

    # --- 応答ヘルパ -------------------------------------------------------

    def _send(self, code: int, body: bytes = b"", ctype: str = "text/plain; charset=utf-8",
              extra: dict | None = None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _authed(self) -> bool:
        return hmac.compare_digest(self.headers.get("Authorization") or "",
                                   f"Bearer {self.cfg['pull_token']}")

    # --- POST /webhook ----------------------------------------------------

    def do_POST(self):
        if urllib.parse.urlparse(self.path).path != "/webhook":
            return self._send(404, b"not found")

        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return self._send(400, b"bad length")
        if length > 5 * 1024 * 1024:
            return self._send(413, b"too large")
        body = self.rfile.read(length) if length else b""

        if not verify_signature(self.cfg["channel_secret"], body, self.headers.get("x-line-signature")):
            log("webhook 403 署名不一致")
            return self._send(403, b"bad signature")

        try:
            events = (json.loads(body.decode("utf-8")) or {}).get("events") or []
        except (json.JSONDecodeError, UnicodeDecodeError):
            # 署名は通っているので LINE 由来。**200 を返す**(再送で詰まらせない)
            log("webhook 200 本文を解釈できず(署名は正当)")
            return self._send(200, b"ok")

        # ① 受信した事実を先に確定させる(外部通信をしない範囲)
        keys: list[str] = []
        try:
            received_ms = int(time.time() * 1000)
            for i, ev in enumerate(events):
                # イベントが object ですらない形も想定する。ここで落ちると
                # 「署名は正当なのに受信を1件も残せない」= いちばん取り返しがつかない。
                key = make_key(received_ms, i)      # ← 受信順(make_key の説明を参照)
                try:
                    if not isinstance(ev, dict):
                        raise TypeError("event is not an object")
                    rec = base_record(ev)
                except Exception as e:                              # 壊れた形でも受信は残す
                    rec = {"error": str(e), "raw": ev,
                           "received_at": datetime.now(timezone.utc).isoformat()}
                self.store.put_event(key, rec)
                keys.append(key)
        except OSError as e:
            # 保管できないなら **200 を返してはいけない**。500 なら LINE が再送してくれる
            # 可能性が残る(ディスク満杯・権限喪失など)。握りつぶすと確実に消える。
            log(f"webhook 500 保管に失敗 ({type(e).__name__})")
            return self._send(500, b"store failure")

        # ② 先に 200 を返す。LINE は応答を待っており、外部通信を挟むと再送・欠落を招く
        self._send(200, b"ok")
        if events:
            log(f"webhook 200 受信 {len(events)} 件")
        else:
            # **イベントが無い POST も必ず1行残す。** LINE Developers の「検証」ボタンは
            # `events: []` を送ってくるので、ここを黙らせると
            # 「押したのに journal に何も出ない = 届いていないのか判断できない」になる
            # (2026-09-02 に実際にそうなった)。疎通確認の唯一の手がかり。
            log("webhook 200 events 0 件(検証リクエストなど)")

        # ③ 表示名・メディアはワーカーで後追い(ここで落ちても①は残る)
        for key in keys:
            self.work_q.put(key)

    # --- GET --------------------------------------------------------------

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)

        if url.path == "/healthz":
            return self._send(200, b"ok")

        if url.path == "/export":
            if not self._authed():
                return self._send(401, b"unauthorized")
            qs = urllib.parse.parse_qs(url.query)
            after = (qs.get("after") or [""])[0]
            try:
                limit = int((qs.get("limit") or ["40"])[0])
            except ValueError:
                limit = 40
            limit = max(1, min(limit, 1000))
            lines = []
            for key in self.store.iter_keys(after, limit):
                rec = self.store.get_event(key)
                if rec is None:
                    continue
                rec["_key"] = key
                lines.append(json.dumps(rec, ensure_ascii=False))
            body = ("\n".join(lines) + "\n").encode("utf-8") if lines else b""
            return self._send(200, body, "application/x-ndjson; charset=utf-8")

        if url.path.startswith("/media/"):
            if not self._authed():
                return self._send(401, b"unauthorized")
            got = self.store.get_media(urllib.parse.unquote(url.path[len("/media/"):]))
            if got is None:
                return self._send(404, b"not found")
            data, ctype, fname = got
            extra = {"x-file-name": urllib.parse.quote(fname)} if fname else None
            return self._send(200, data, ctype, extra)

        return self._send(404, b"not found")


# --------------------------------------------------------------------------- 起動

def load_config(path: Path) -> dict:
    if not path.exists():
        sys.exit(
            f"[ERROR] 設定がありません: {path}\n"
            "        channel_secret / pull_token は必須です。\n"
            "        共有ドライブには置かないこと。"
        )
    cfg = json.loads(path.read_text(encoding="utf-8"))
    for k in ("channel_secret", "pull_token"):
        if not cfg.get(k):
            sys.exit(f"[ERROR] {path} に {k} がありません")
    cfg.setdefault("listen_host", "127.0.0.1")
    cfg.setdefault("listen_port", 8788)
    cfg.setdefault("store", DEFAULT_STORE)
    cfg.setdefault("api_base", "https://api.line.me")
    cfg.setdefault("api_data_base", "https://api-data.line.me")
    cfg.setdefault("channel_access_token", "")
    cfg.setdefault("retention_days", 0)
    return cfg


def serve(cfg: dict) -> int:
    store = Store(Path(cfg["store"]))
    work_q: queue.Queue = queue.Queue()

    def worker():
        while True:
            key = work_q.get()
            if key is None:
                return
            try:
                enrich(store, cfg, key)
            except Exception as e:                     # 後処理の失敗で受信を落とさない
                log(f"enrich 失敗 ({type(e).__name__})")
            finally:
                work_q.task_done()

    threading.Thread(target=worker, daemon=True, name="enrich").start()

    removed = store.purge(int(cfg["retention_days"]))
    if removed:
        log(f"保持期間を超えた {removed} 日分を削除しました")

    Handler.cfg, Handler.store, Handler.work_q = cfg, store, work_q
    httpd = ThreadingHTTPServer((cfg["listen_host"], int(cfg["listen_port"])), Handler)
    log(f"listening on {cfg['listen_host']}:{cfg['listen_port']} / store={cfg['store']}")
    if cfg["listen_host"] not in ("127.0.0.1", "localhost", "::1"):
        log("⚠ ループバック以外で待ち受けています。/export と /media は PULL_TOKEN で守られていますが、"
            "外部へ出すのは /webhook だけにすること")
    if not cfg["channel_access_token"]:
        log("⚠ channel_access_token が未設定です。送信者の表示名と添付の実体は取得しません")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="公式LINE の Webhook を Pi で受ける常駐サービス")
    ap.add_argument("--config", help="設定の場所(既定 ~/.iyakusai/line_oa_server.json)")
    ap.add_argument("--check", action="store_true", help="設定を読んで表示するだけ(起動しない)")
    args = ap.parse_args()

    path = Path(args.config).expanduser() if args.config else Path(
        os.environ.get("IYAKUSAI_LINE_OA_SERVER_CONFIG") or DEFAULT_CONFIG_PATH)
    cfg = load_config(path)

    if args.check:
        # 秘密は出さない。「入っているか」だけ
        print(f"config           : {path}")
        print(f"listen           : {cfg['listen_host']}:{cfg['listen_port']}")
        print(f"store            : {cfg['store']}")
        print(f"channel_secret   : {'あり' if cfg['channel_secret'] else 'なし'}")
        print(f"access_token     : {'あり' if cfg['channel_access_token'] else 'なし(表示名・実体を取らない)'}")
        print(f"pull_token       : {'あり' if cfg['pull_token'] else 'なし'}")
        print(f"retention_days   : {cfg['retention_days']}(0=無期限)")
        return 0

    return serve(cfg)


if __name__ == "__main__":
    sys.exit(main())
