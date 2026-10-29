# -*- coding: utf-8 -*-
"""基盤システム(統合アプリ app.iyakusai.com)を /ask のデータソースにする。

基盤システムの今の状態を、Bot が答えの根拠に使えるようにする。
/ask のエージェントは無害化ミラーを Read/Grep するだけなので、基盤システムの「いまの状態」を
**ミラーの `kiban/` に Markdown の写しとして置く**。エージェントに新しいツールやネットワークは
渡さない(検索空間の境界=ミラーの中、という構造は変えない)。

- タスク: 正本は Bot ホストのタスク DB(/todo とアプリのタスク画面が共有)。Bot が開いている
  TaskStore から読むだけ(書かない)。アプリは経由しない。
- 物品・受信箱の対応状況: 統合アプリの Bot 専用の読み取り口 `POST /v1/bot/datasource`
  (svc-auth/v1・client "iyakusai-bot-datasource"・この口専用の鍵)から取る。
  取り決めはリポジトリ直下の `docs/contracts/bot-datasource.md`。
- 公開範囲: /ask の答えは Discord で全委員が見える前提で、
  物品はメモ欄まで、受信箱は対応状況(状態・担当・ラベル・メモ・タスクの紐づけ)まで載せる。
  ID(Discord ID・アカウント ID)は載せず、実名・表示名に解決する。引けなければ「未登録」と書き、
  **生の ID を出さない**。
- 書き出しは同期のたびに全部作り直す(tmp→os.replace)。取得に失敗したソースは**前回の写しを残し**、
  `kiban/_status.md` に失敗と最終成功時刻を書く(エージェントはそれを見て「最新でない可能性」を添える)。
- 出口で mirror と同じ無害化(電話・住所・個人メール・学籍番号・認証行)を掛ける。

このモジュールは discord に依存しない(試験のため)。常駐は kiban_cog.py。
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import shutil
import ssl
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Iterable

from .mirror import _JST, _scrub_plain, _to_jst, _transform_doc_text
from .task_domain import DEPARTMENTS, REQUIREMENT_FIELDS, REQUIREMENT_LABELS, STATUS_LABELS, STATUS_ORDER, department_filter, today_jst

log = logging.getLogger("iyakusai.kiban")

KIBAN_DIR = "kiban"
TASKS_FILE = "tasks.md"
RENTAL_FILE = "rental.md"
MAILBOX_FILE = "mailbox.md"
STATUS_FILE = "_status.md"

CLIENT = "iyakusai-bot-datasource"
API_PATH = "/v1/bot/datasource"
APP_SOURCES = ("rental", "mailbox")
MAX_RESPONSE_BYTES = 16 * 1024 * 1024
MIN_KEY_BYTES = 32

UNKNOWN_PERSON = "(名前未登録の委員)"


class KibanConfigError(ValueError):
    """[kiban] の設定が安全条件を満たさない。起動を止める(鍵の中身・パスは含めない)。"""


class KibanFetchError(RuntimeError):
    """アプリから写しを取れなかった。message は _status.md に出してよい短い理由だけ。"""


# ---------------------------------------------------------------------------
# 設定

@dataclass(frozen=True)
class KibanSettings:
    enabled: bool = False
    tasks: bool = True                       # Bot ホストのタスク DB を写すか
    app_url: str = ""                        # 例 https://app.iyakusai.com 。空なら物品・受信箱は取りに行かない
    key_file: Path | None = None             # この口専用の鍵(所有者だけが読める権限)
    ca_file: Path | None = None              # 私設 CA を使うときだけ
    sources: tuple[str, ...] = APP_SOURCES
    interval_sec: int = 300
    timeout_sec: int = 20

    _KEYS = {"enabled", "tasks", "app_url", "key_file", "ca_file", "sources", "interval_sec", "timeout_sec"}

    @classmethod
    def from_mapping(cls, raw, *, shared_roots: Iterable[Path | None] = ()) -> "KibanSettings":
        if raw is None:
            return cls()
        if not isinstance(raw, dict):
            raise KibanConfigError("kiban: [kiban] の形式が正しくありません")
        enabled = raw.get("enabled", False)
        if type(enabled) is not bool:
            raise KibanConfigError("kiban: enabled は true / false で指定してください")
        if not enabled:
            return cls()
        unknown = set(raw) - cls._KEYS
        if unknown:
            raise KibanConfigError(f"kiban: 未知の設定項目があります: {', '.join(sorted(unknown))}")
        tasks = raw.get("tasks", True)
        if type(tasks) is not bool:
            raise KibanConfigError("kiban: tasks は true / false で指定してください")
        app_url = raw.get("app_url", "")
        if not isinstance(app_url, str):
            raise KibanConfigError("kiban: app_url は文字列で指定してください")
        app_url = app_url.strip().rstrip("/")
        key_file = ca_file = None
        sources: tuple[str, ...] = ()
        if app_url:
            if not _url_ok(app_url):
                raise KibanConfigError("kiban: app_url は https のオリジン(パスなし)で指定してください")
            key_raw = raw.get("key_file")
            if not isinstance(key_raw, str) or not key_raw.strip():
                raise KibanConfigError("kiban: app_url を使うときは key_file が必要です")
            key_file = Path(key_raw).expanduser()
            if not key_file.is_absolute():
                raise KibanConfigError("kiban: key_file は絶対パスで指定してください")
            if any(_inside(key_file, r) for r in shared_roots if r is not None):
                raise KibanConfigError("kiban: key_file は共有ドライブ・ミラーの外に置いてください")
            ca_raw = raw.get("ca_file")
            if ca_raw is not None:
                if not isinstance(ca_raw, str) or not ca_raw.strip():
                    raise KibanConfigError("kiban: ca_file は文字列で指定してください")
                ca_file = Path(ca_raw).expanduser()
            src = raw.get("sources", list(APP_SOURCES))
            if (not isinstance(src, list) or not src or len(set(src)) != len(src)
                    or any(s not in APP_SOURCES for s in src)):
                raise KibanConfigError("kiban: sources は rental / mailbox の配列で指定してください")
            sources = tuple(s for s in APP_SOURCES if s in src)
        interval = raw.get("interval_sec", 300)
        timeout = raw.get("timeout_sec", 20)
        if type(interval) is not int or interval < 60:
            raise KibanConfigError("kiban: interval_sec は 60 以上の整数で指定してください")
        if type(timeout) is not int or not 1 <= timeout <= 120:
            raise KibanConfigError("kiban: timeout_sec は 1〜120 の整数で指定してください")
        if not tasks and not app_url:
            raise KibanConfigError("kiban: tasks も app_url も無効です(写すものがありません)")
        return cls(enabled=True, tasks=tasks, app_url=app_url, key_file=key_file, ca_file=ca_file,
                   sources=sources, interval_sec=interval, timeout_sec=timeout)


def _inside(path: Path, root: Path) -> bool:
    a, b = os.path.abspath(path), os.path.abspath(root)
    try:
        return os.path.commonpath([a, b]) == b
    except ValueError:          # Windows で別ドライブ
        return False


def _url_ok(url: str) -> bool:
    m = re.fullmatch(r"(https?)://([A-Za-z0-9.-]+|\[[0-9a-fA-F:]+\])(:\d{1,5})?", url)
    if not m:
        return False
    # 平文は手元の試験(ループバック)だけ。署名で改ざんは防げても、応答(委員会の情報)が素で流れる。
    return m.group(1) == "https" or m.group(2) in ("127.0.0.1", "localhost", "[::1]")


def parse_key_material(text: str) -> bytes | None:
    """アプリの parseKeyMaterial と同じ規則: 16進 か base64/base64url、32 バイト以上、全バイト同値は不可。"""
    value = text.strip()
    try:
        if re.fullmatch(r"[0-9a-fA-F]+", value) and len(value) % 2 == 0:
            key = bytes.fromhex(value)
        elif re.fullmatch(r"[A-Za-z0-9+/_-]+={0,2}", value):
            b64 = value.replace("-", "+").replace("_", "/")
            key = base64.b64decode(b64 + "=" * (-len(b64) % 4))
        else:
            return None
    except (ValueError, binascii.Error):
        return None
    if len(key) < MIN_KEY_BYTES or len(set(key)) == 1:
        return None
    return key


def load_key(path: Path) -> bytes:
    """鍵ファイルを読む。権限が広い・読めない・形式違反は起動を止める(中身はどこにも出さない)。"""
    try:
        st = path.stat()
        if os.name != "nt" and (st.st_mode & 0o077):
            raise KibanConfigError("kiban: key_file は所有者だけが読める権限(600 など)にしてください")
        text = path.read_text(encoding="ascii")
    except KibanConfigError:
        raise
    except (OSError, UnicodeDecodeError):
        raise KibanConfigError("kiban: key_file を読み込めません") from None
    key = parse_key_material(text)
    if key is None:
        raise KibanConfigError("kiban: key_file の鍵は 32 バイト以上の乱数(16進 または base64)にしてください")
    return key


# ---------------------------------------------------------------------------
# 署名と取得(svc-auth/v1。app/src/server/tasks/signing.ts と同じ正規文字列)

def canonical_string(client: str, method: str, path: str, timestamp: str, nonce: str, actor: str, body: bytes) -> str:
    return "\n".join(["svc-auth/v1", client, method.upper(), path, timestamp, nonce, actor,
                      hashlib.sha256(body).hexdigest()])


def signed_headers(key: bytes, body: bytes, *, path: str = API_PATH, now_ms: int | None = None,
                   nonce: str | None = None) -> dict[str, str]:
    timestamp = str(int(time.time() * 1000) if now_ms is None else now_ms)
    nonce = nonce or secrets.token_urlsafe(18)          # 24 文字(アプリは 24〜128 文字の base64url を要求)
    sig = hmac.new(key, canonical_string(CLIENT, "POST", path, timestamp, nonce, "", body).encode("utf-8"),
                   hashlib.sha256).hexdigest()
    return {"X-Svc-Client": CLIENT, "X-Svc-Timestamp": timestamp, "X-Svc-Nonce": nonce, "X-Svc-Signature": sig}


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """転送には従わない(署名付きの要求を別の宛先へ持っていかせない)。"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D401
        raise urllib.error.HTTPError(req.full_url, code, "redirect refused", headers, fp)


def fetch_app(settings: KibanSettings, key: bytes) -> dict:
    """アプリの読み取り口から写しを取る。失敗は KibanFetchError(短い理由だけ)。"""
    body = json.dumps({"sources": list(settings.sources)}, separators=(",", ":")).encode("utf-8")
    headers = {**signed_headers(key, body), "Content-Type": "application/json", "Accept": "application/json"}
    req = urllib.request.Request(settings.app_url + API_PATH, data=body, method="POST", headers=headers)
    handlers: list = [_NoRedirect()]
    if settings.app_url.startswith("https://"):
        ctx = ssl.create_default_context(cafile=str(settings.ca_file) if settings.ca_file else None)
        handlers.append(urllib.request.HTTPSHandler(context=ctx))
    opener = urllib.request.build_opener(*handlers)
    try:
        with opener.open(req, timeout=settings.timeout_sec) as resp:
            if resp.status != 200:
                raise KibanFetchError(f"応答 {resp.status}")
            raw = resp.read(MAX_RESPONSE_BYTES + 1)
    except KibanFetchError:
        raise
    except urllib.error.HTTPError as e:
        raise KibanFetchError("署名が拒否された(鍵・時刻のずれを確認)" if e.code == 401
                              else "読み取り口が無い(アプリ側が未設定)" if e.code == 404
                              else f"応答 {e.code}") from None
    except (urllib.error.URLError, OSError, ssl.SSLError) as e:
        raise KibanFetchError(f"接続できない({type(e).__name__})") from None
    if len(raw) > MAX_RESPONSE_BYTES:
        raise KibanFetchError("応答が大きすぎる")
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise KibanFetchError("応答が JSON ではない") from None
    return check_snapshot(data)


def check_snapshot(data) -> dict:
    """形だけを確かめる(中身の個々の値は整形側で str() に倒して読む)。"""
    if not isinstance(data, dict) or data.get("version") != 1 or not isinstance(data.get("generatedAt"), str):
        raise KibanFetchError("応答の形式が契約と違う(version)")
    rental = data.get("rental")
    if rental is not None and not (isinstance(rental, dict) and isinstance(rental.get("summary"), dict)
                                   and isinstance(rental.get("items"), list)):
        raise KibanFetchError("応答の形式が契約と違う(rental)")
    mailbox = data.get("mailbox")
    if mailbox is not None and not (isinstance(mailbox, dict) and isinstance(mailbox.get("mailboxes"), list)
                                    and isinstance(mailbox.get("messages"), list)):
        raise KibanFetchError("応答の形式が契約と違う(mailbox)")
    return data


# ---------------------------------------------------------------------------
# 整形の部品

def _one_line(value) -> str:
    """表・見出しに入れる1行の文字列。改行・表の区切りを潰す。"""
    return re.sub(r"\s+", " ", str(value or "")).replace("|", "｜").strip()


def _block(value) -> str:
    """複数行の自由記述を箇条書きの下に入れる(継続行を字下げ)。"""
    lines = [ln.rstrip() for ln in str(value or "").strip().splitlines()]
    return "\n    ".join(ln for ln in lines if ln.strip())


def _jst(iso) -> str:
    return (_to_jst(str(iso)) if iso else None) or "不明"


def _scrub(text: str) -> str:
    """ミラーの出口と同じ無害化(電話・住所行・個人メール・認証行 → 学籍番号・口座)。"""
    return _scrub_plain(_transform_doc_text(text, mask_fin=False))


def _person(names: dict[str, str], uid) -> str:
    if uid is None:
        return "未定"
    return names.get(str(uid)) or UNKNOWN_PERSON


def _dept_label(tags: Iterable[str]) -> str:
    labels = [DEPARTMENTS[t][0] for t in tags if t in DEPARTMENTS]
    return "・".join(labels) if labels else "(部局なし)"


def _header(title: str, now: datetime, lines: list[str]) -> list[str]:
    return [f"# {title}", f"- 生成: {now.astimezone(_JST).strftime('%Y-%m-%d %H:%M')} JST(この時点の写し)", *lines, ""]


# ---------------------------------------------------------------------------
# タスク

def render_tasks(views: list, names: dict[str, str], now: datetime, interval_min: int) -> str:
    """TaskView の一覧 → kiban/tasks.md。"""
    today = today_jst() if now is None else now.astimezone(_JST).strftime("%Y-%m-%d")
    open_views = [v for v in views if v.task.status != "done"]
    done_views = [v for v in views if v.task.status == "done"]
    by_status = {s: sum(1 for v in open_views if v.task.status == s) for s in ("in_progress", "blocked", "todo")}
    overdue = [v for v in open_views if v.overdue]
    due_today = [v for v in open_views if v.task.deadline == today]
    out = _header("基盤システムの写し: 委員会タスク(/todo・アプリのタスク画面と同じ台帳)", now, [
        f"- 正本: Bot ホストのタスク DB。アプリ(app.iyakusai.com)のタスク画面と Discord の /todo は同じ台帳を見ている。約{interval_min}分ごとに作り直す",
        f"- 件数: 全 {len(views)} 件 / 未完了 {len(open_views)} 件(進行中 {by_status['in_progress']}・保留 {by_status['blocked']}・未着手 {by_status['todo']})/ 完了 {len(done_views)} 件",
        f"- 生成時点で期限超過 {len(overdue)} 件 / 今日({today})が期限 {len(due_today)} 件",
        "- 番号 `#12` はアプリと /todo の通し番号。部局はタグで、1件に複数付くことがある(部の件数にはその部の課の分も含む)",
        "- 状態: 未着手 / 進行中 / 保留(止まっている) / 完了",
    ])

    out += ["## 部局ごとの未完了件数", "| 部局 | 未完了 | うち期限超過 |", "|---|---|---|"]
    for key, (label, _parent) in DEPARTMENTS.items():
        keys = set(department_filter(key))
        hit = [v for v in open_views if keys & set(v.task.tags)]
        out.append(f"| {label} | {len(hit)} | {sum(1 for v in hit if v.overdue)} |")
    out.append("")

    def sort_key(v):
        return (v.task.deadline is None, v.task.deadline or "", STATUS_ORDER.get(v.task.status, 9), v.task.number)

    out.append("## 未完了(期限の早い順。期限なしは最後)")
    if not open_views:
        out.append("- (未完了のタスクはない)")
    for v in sorted(open_views, key=sort_key):
        t = v.task
        due = t.deadline or "なし"
        if v.overdue:
            due += "(生成時点で期限超過)"
        elif t.deadline == today:
            due += "(今日が期限)"
        out.append(f"### #{t.number} {_one_line(t.title)}")
        out.append(f"- 状態: {STATUS_LABELS.get(t.status, t.status)} / 期限: {due} / 部局: {_dept_label(t.tags)}"
                   f" / 担当: {_person(names, t.assignee_id)}")
        if t.description.strip():
            out.append(f"- 説明: {_block(t.description)}")
        for f in REQUIREMENT_FIELDS:
            if t.requirements.get(f, "").strip():
                out.append(f"- {REQUIREMENT_LABELS[f]}: {_block(t.requirements[f])}")
        out.append(f"- 作成: {_jst(t.created_at)} JST({_person(names, t.created_by)})"
                   f" / 最終更新: {_jst(t.updated_at)} JST({_person(names, t.updated_by)})")
        out.append("")

    out.append("## 完了(最終更新の新しい順)")
    if not done_views:
        out.append("- (完了したタスクはない)")
    for v in sorted(done_views, key=lambda v: (v.task.updated_at, v.task.number), reverse=True):
        t = v.task
        out.append(f"- #{t.number} {_one_line(t.title)} / 部局: {_dept_label(t.tags)} / 担当: {_person(names, t.assignee_id)}"
                   f" / 完了(最終更新): {_jst(t.updated_at)} JST({_person(names, t.updated_by)})")
    return "\n".join(out) + "\n"


# ---------------------------------------------------------------------------
# 物品

PHASE_LABELS = {
    "loaned": "貸出中",
    "review": "要確認(返却時に問題あり)",
    "planned": "貸出予定",
    "returned": "返却済",
    "unassigned": "未割当",
}
CONDITION_LABELS = {"normal": "損傷なし", "damage": "損傷あり", "maintenance": "要整備"}


def render_rental(rental: dict, generated_at: str, now: datetime, interval_min: int) -> str:
    summary = rental.get("summary") or {}
    items = [i for i in rental.get("items") or [] if isinstance(i, dict)]
    phases = {p: sum(1 for i in items if i.get("phase") == p) for p in PHASE_LABELS}
    out = _header("基盤システムの写し: 物品貸出の台帳", now, [
        f"- 正本: アプリ(app.iyakusai.com)の物品台帳。アプリ側の時刻 {_jst(generated_at)} JST に取得。約{interval_min}分ごとに作り直す",
        f"- 全 {len(items)} 個体 / " + " / ".join(f"{PHASE_LABELS[p]} {n}" for p, n in phases.items()),
        "- 個体コード `IY-…` はラベル・カードに書かれたコード。「団体」は貸出先(出展団体など)",
        "- 貸出時・返却時の「メモ」は担当の委員が端末で書いた自由記述",
    ])

    out += ["## 団体ごとの貸出中", "| 団体 | 貸出中の個体数 | 最初の貸出(JST) |", "|---|---|---|"]
    groups = [g for g in summary.get("loanedByGroup") or [] if isinstance(g, dict)]
    if not groups:
        out.append("| (貸出中なし) | 0 | - |")
    for g in groups:
        out.append(f"| {_one_line(g.get('borrower'))} | {g.get('loaned', 0)} | {_jst(g.get('since'))} |")
    out.append("")

    out += ["## 品目ごとの集計", "| 品目 | 個体数 | " + " | ".join(PHASE_LABELS.values()) + " |",
            "|---|---|" + "---|" * len(PHASE_LABELS)]
    by_name: dict[str, list[dict]] = {}
    for i in items:
        by_name.setdefault(_one_line(i.get("name")) or "(品目名なし)", []).append(i)
    for name in sorted(by_name):
        its = by_name[name]
        out.append(f"| {name} | {len(its)} | "
                   + " | ".join(str(sum(1 for i in its if i.get("phase") == p)) for p in PHASE_LABELS) + " |")
    out.append("")

    out.append("## 個体一覧(品目ごと)")
    for name in sorted(by_name):
        its = sorted(by_name[name], key=lambda i: str(i.get("code")))
        out.append(f"### {name}({len(its)} 個体)")
        for i in its:
            out.append(_rental_line(i))
        out.append("")
    return "\n".join(out) + "\n"


def _rental_line(i: dict) -> str:
    phase = str(i.get("phase") or "")
    group = i.get("group") if isinstance(i.get("group"), dict) else None
    gname = _one_line(group.get("name")) if group else ""
    head = f"- {_one_line(i.get('code'))}: {PHASE_LABELS.get(phase, phase or '不明')}"
    if gname:
        head += {"loaned": f" → {gname}", "planned": f" → {gname}"}.get(phase, f"(最後の貸出先: {gname})")
    parts = []
    if i.get("lent_at"):
        lent = f"貸出 {_jst(i.get('lent_at'))} JST・{CONDITION_LABELS.get(str(i.get('lent_condition')), '状態不明')}"
        if i.get("lent_photo_skip"):
            lent += "・写真省略"
        if str(i.get("lent_note") or "").strip():
            lent += f"・メモ: {_one_line(i.get('lent_note'))}"
        parts.append(lent)
    if i.get("returned_at"):
        back = f"返却 {_jst(i.get('returned_at'))} JST・{CONDITION_LABELS.get(str(i.get('return_condition')), str(i.get('return_condition') or '状態不明'))}"
        if str(i.get("return_note") or "").strip():
            back += f"・メモ: {_one_line(i.get('return_note'))}"
        parts.append(back)
    return head + (f"({' / '.join(parts)})" if parts else "")


# ---------------------------------------------------------------------------
# 受信箱

MAIL_STATUS_LABELS = {"unhandled": "未対応", "in_progress": "対応中", "on_hold": "保留", "done": "完了"}


def render_mailbox(mailbox: dict, generated_at: str, now: datetime, interval_min: int,
                   task_titles: dict[int, str] | None) -> str:
    boxes = [b for b in mailbox.get("mailboxes") or [] if isinstance(b, dict)]
    box_names = {str(b.get("id")): _one_line(b.get("name")) for b in boxes}
    msgs = [m for m in mailbox.get("messages") or [] if isinstance(m, dict)]
    counts = {s: sum(1 for m in msgs if m.get("status") == s) for s in MAIL_STATUS_LABELS}
    out = _header("基盤システムの写し: 委員会受信箱の対応状況", now, [
        f"- 正本: アプリ(app.iyakusai.com)の受信箱。アプリ側の時刻 {_jst(generated_at)} JST に取得。約{interval_min}分ごとに作り直す",
        f"- 掲載 {len(msgs)} 通 / " + " / ".join(f"{MAIL_STATUS_LABELS[s]} {n}" for s, n in counts.items()),
        "- ここにあるのは**対応状況だけ**(状態・担当・ラベル・メモ・紐づくタスク)。メール本文は `mail/raw/mail_YYYY-MM.txt` にあるので、件名と日時で突き合わせる",
        "- 受信箱の対応状況の機能は 2026-10 に始まったばかりで、古いメールの多くは「未対応」のまま(=実際に放置されたとは限らない)",
    ])

    out += ["## 受信箱ごと", "| 受信箱 | スレッド数 | 未対応(通) |", "|---|---|---|"]
    for b in boxes:
        out.append(f"| {box_names.get(str(b.get('id')))} | {b.get('threads', 0)} | {b.get('unhandled', 0)} |")
    out.append("")

    def touched(m: dict) -> bool:
        return (m.get("status") not in (None, "unhandled") or bool(m.get("assignee")) or bool(m.get("labels"))
                or bool(m.get("notes")) or bool(m.get("taskIds")))

    def where(m: dict) -> str:
        names = [box_names.get(str(x)) or "(一覧外の受信箱)" for x in m.get("mailboxIds") or []]
        return "・".join(names) or "(受信箱不明)"

    out.append("## 対応が付いているメール(状態・担当・ラベル・メモ・タスクのいずれかがあるもの。新しい順)")
    worked = [m for m in msgs if touched(m)]
    if not worked:
        out.append("- (まだない)")
    for m in worked:
        out.append(f"### {_jst(m.get('receivedAt'))} JST「{_one_line(m.get('subject')) or '(件名なし)'}」")
        line = (f"- 受信箱: {where(m)} / 差出人: {_one_line(m.get('fromName')) or '(名前なし)'}"
                f" / 状態: {MAIL_STATUS_LABELS.get(str(m.get('status')), str(m.get('status')))}"
                f" / 担当: {_one_line(m.get('assignee')) or '未定'}")
        labels = [_one_line(x) for x in m.get("labels") or []]
        if labels:
            line += f" / ラベル: {', '.join(labels)}"
        if m.get("attachments"):
            line += f" / 添付 {m.get('attachments')} 件"
        out.append(line)
        tasks = [_task_ref(t, task_titles) for t in m.get("taskIds") or []]
        if tasks:
            out.append(f"- 紐づくタスク: {'、'.join(tasks)}")
        notes = [n for n in m.get("notes") or [] if isinstance(n, dict)]
        if notes:
            out.append("- メモ:")
            for n in notes:
                out.append(f"  - {_jst(n.get('at'))} JST {_one_line(n.get('author')) or '(不明)'}: {_block(n.get('body'))}")
        out.append("")

    out.append("## 未対応のメール(担当・メモなし。新しい順・全件)")
    rest = [m for m in msgs if not touched(m)]
    if not rest:
        out.append("- (なし)")
    for m in rest:
        out.append(f"- {_jst(m.get('receivedAt'))} JST / {where(m)} / {_one_line(m.get('fromName')) or '(名前なし)'}"
                   f" /「{_one_line(m.get('subject')) or '(件名なし)'}」")
    return "\n".join(out) + "\n"


def _task_ref(task_id, titles: dict[int, str] | None) -> str:
    m = re.fullmatch(r"task-([1-9][0-9]{0,9})", str(task_id))
    if not m:
        return "(形式の分からないタスク)"
    n = int(m.group(1))
    if titles and n in titles:
        return f"#{n} {titles[n]}"
    return f"#{n}"


# ---------------------------------------------------------------------------
# 同期

@dataclass
class SourceState:
    label: str
    file: str
    status: str = "未実行"
    note: str = ""


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(_scrub(text), encoding="utf-8")
    os.replace(tmp, path)


def _last_success(path: Path) -> str:
    try:
        return datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).astimezone(_JST).strftime("%Y-%m-%d %H:%M") + " JST"
    except OSError:
        return "-"


class KibanSync:
    """1回分の同期(スレッドで呼ぶ)。Discord に依存しない。

    list_tasks: 引数なしで TaskView の一覧を返す関数(Bot の TaskStore を読むだけ)。None ならタスクは写さない。
    names: Discord user ID(文字列) → 実名 を返す関数(_authors.json を毎回読み直す=改名に追随)。
    """

    def __init__(self, settings: KibanSettings, mirror_dir: Path, *,
                 list_tasks: Callable[[], list] | None,
                 names: Callable[[], dict[str, str]],
                 key: bytes | None = None,
                 fetch: Callable[[KibanSettings, bytes], dict] = fetch_app):
        self.settings = settings
        self.dir = Path(mirror_dir) / KIBAN_DIR
        self.list_tasks = list_tasks
        self.names = names
        self.key = key
        self.fetch = fetch
        self.states = {
            "tasks": SourceState("タスク", TASKS_FILE),
            "rental": SourceState("物品貸出", RENTAL_FILE),
            "mailbox": SourceState("受信箱の対応状況", MAILBOX_FILE),
        }

    def run_once(self, now: datetime | None = None) -> dict[str, str]:
        now = now or datetime.now(timezone.utc)
        interval_min = max(1, self.settings.interval_sec // 60)
        names = {}
        try:
            names = self.names()
        except Exception as e:  # noqa: BLE001  対応表が読めなくても写しは作る(名前は「未登録」になる)
            log.warning("実名の対応表を読めません(名前なしで続行): %s", type(e).__name__)

        task_titles: dict[int, str] | None = None
        st = self.states["tasks"]
        if self.settings.tasks and self.list_tasks is not None:
            try:
                views = self.list_tasks()
                _write(self.dir / TASKS_FILE, render_tasks(views, names, now, interval_min))
                task_titles = {v.task.number: _one_line(v.task.title) + f"({STATUS_LABELS.get(v.task.status, v.task.status)})"
                               for v in views}
                st.status, st.note = "成功", f"{len(views)} 件"
            except Exception as e:  # noqa: BLE001
                st.status, st.note = "失敗", f"タスク DB を読めない({type(e).__name__})。前回の写しのまま"
                log.warning("kiban: タスクの写しに失敗: %s", type(e).__name__)
        else:
            self._drop(st, "未設定(タスク連携が無効)")

        if self.settings.app_url and self.key is not None:
            try:
                data = self.fetch(self.settings, self.key)
            except KibanFetchError as e:
                for k in APP_SOURCES:
                    if k in self.settings.sources:
                        s = self.states[k]
                        s.status, s.note = "失敗", f"{e}。前回の写しのまま"
                log.warning("kiban: アプリから取得できません: %s", e)
            else:
                gen = str(data.get("generatedAt"))
                for k, render in (("rental", lambda d: render_rental(d, gen, now, interval_min)),
                                  ("mailbox", lambda d: render_mailbox(d, gen, now, interval_min, task_titles))):
                    s = self.states[k]
                    if k not in self.settings.sources:
                        self._drop(s, "未設定(sources に無い)")
                    elif data.get(k) is None:
                        self._drop(s, "アプリ側でこの機能が未設定")
                    else:
                        try:
                            _write(self.dir / s.file, render(data[k]))
                            s.status, s.note = "成功", ""
                        except Exception as e:  # noqa: BLE001  形の崩れた1件で全体を止めない
                            s.status, s.note = "失敗", f"整形できない({type(e).__name__})。前回の写しのまま"
                            log.warning("kiban: %s の整形に失敗: %s", k, type(e).__name__)
        else:
            for k in APP_SOURCES:
                self._drop(self.states[k], "未設定(アプリ連携が無効)")

        self._write_status(now)
        return {k: s.status for k, s in self.states.items()}

    def _drop(self, s: SourceState, why: str) -> None:
        """使わなくなったソースの写しを消す(古い写しが「いまの状態」として読まれないように)。"""
        s.status, s.note = "未設定", why
        try:
            (self.dir / s.file).unlink(missing_ok=True)
        except OSError:
            pass

    def _write_status(self, now: datetime) -> None:
        out = ["# 基盤システムの写しの状態",
               f"- 最終確認: {now.astimezone(_JST).strftime('%Y-%m-%d %H:%M')} JST",
               "- 「失敗」の写しは前回のまま残っている。回答に使うときは「最新でない可能性(最終成功 〇〇時点)」と添える",
               "", "| 写し | ファイル | 状態 | 最終成功 | 備考 |", "|---|---|---|---|---|"]
        for s in self.states.values():
            path = self.dir / s.file
            last = _last_success(path) if path.exists() else "-"
            out.append(f"| {s.label} | `kiban/{s.file}` | {s.status} | {last} | {_one_line(s.note)} |")
        _write(self.dir / STATUS_FILE, "\n".join(out) + "\n")


def remove_kiban(mirror_dir: Path) -> bool:
    """連携を無効にしたときに写しを消す(ミラーは再生成前提=削除してよい場所)。消したら True。"""
    target = Path(mirror_dir) / KIBAN_DIR
    try:
        if target.is_dir() and not target.is_symlink():
            shutil.rmtree(target)
            return True
    except OSError as e:
        log.warning("kiban: 古い写しを消せません: %s", type(e).__name__)
    return False

