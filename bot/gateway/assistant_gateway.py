"""統合アプリ「Bot」タブの連携口(task-web-api の /api/integration/v1/assistant/*・2026-10-14 追加)。

取り決め docs/contracts/bot-front.md §3-2〜§3-4 の形で応答する。
- 書くのはジョブ表へのジョブの受付・取り消しだけ。実行・リマインドの書き込み・候補の書き換えは Bot が行う。
- 読むのは Bot が書いた写し(reminder_snapshot)・capabilities(meta)・生成物・候補台帳(mode=ro)。
- Discord には直接触れない(委員確認は LiveContext の共有キャッシュ経由)。共有ドライブのパスにも触れない。

bot_task_gateway.py はこのモジュールを import しない。ApiServer に入った AssistantGateway の
Error 属性と、handle() の戻り値(dict か BinaryFile 相当)の形だけを使う。
"""

from __future__ import annotations

import json
import re
import sqlite3
import threading
import time
import urllib.parse
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path


PREFIX = "/api/integration/v1/assistant"
PUBLIC_FILES = "/assistant/files"
JST = timezone(timedelta(hours=9))
KINDS = ("ask", "doc", "image", "remind", "screening")
FILE_KINDS = ("ask", "doc", "image")
TERMINAL_STATES = ("done", "failed", "canceled")
DOC_TYPES = (
    ("request", "依頼文(対外)"), ("notice", "お知らせ(学内・委員向け)"), ("report", "報告書"),
    ("minutes", "議事録たたき台"), ("mail", "メール文面"), ("free", "自由"),
)
DEFAULT_MAX_ACTIVE = 3
DEFAULT_LIMIT = 20
ONLINE_WINDOW_SEC = 30       # Bot の生存記録がこの秒数より古ければ「応答していません」
WAIT_POLL_SEC = 0.25
WAIT_SLOTS = 4               # 待つルートは同時に 4 本まで(超えたら待たずに 202)
LEDGER_TIMEOUT_SEC = 2.0     # Bot が候補台帳に書いている間に、連携口の応答を長く止めない
SNOWFLAKE = r"[1-9][0-9]{16,19}"
JOB_ID = r"j_[a-z0-9]{20}"
UNSAFE_NAME_RE = re.compile(r"[\\/\x00-\x1f\x7f]")


class AssistantError(Exception):
    """連携口の応答エラー。bot_task_gateway はこれを {"error":{code,message}} に変換する。"""

    def __init__(self, status: int, code: str, message: str):
        super().__init__(code)
        self.status, self.code, self.message = status, code, message


@dataclass(frozen=True)
class BinaryFile:
    """生成物の本体。bot_task_gateway が Content-Type と Content-Disposition を付けて返す。"""

    content_type: str
    filename: str
    body: bytes


# 経路の表: (メソッド, 経路の正規表現, 処理名)。経路は PREFIX の後ろだけを見る。
ROUTES = (
    ("GET", r"/meta", "meta"),
    ("GET", r"/summary", "summary"),
    ("POST", r"/jobs", "create_job"),
    ("GET", r"/jobs", "list_jobs"),
    ("GET", rf"/jobs/({JOB_ID})", "get_job"),
    ("POST", rf"/jobs/({JOB_ID})/cancel", "cancel_job"),
    ("GET", r"/similar", "similar"),
    ("GET", rf"/files/({JOB_ID})/([^/]+)", "file"),
    ("GET", r"/members", "members"),
    ("GET", r"/reminders", "list_reminders"),
    ("POST", r"/reminders", "create_reminder"),
    ("POST", r"/reminders/([^/]*)/(done|delete)", "reminder_action"),
    ("GET", r"/candidates", "candidates"),
    ("POST", r"/candidates/([^/]*)/([^/]*)", "candidate_action"),
)


def _invalid(message: str = "入力を確認してください。") -> None:
    raise AssistantError(400, "VALIDATION", message)


def _not_found() -> None:
    raise AssistantError(404, "NOT_FOUND", "見つかりません。")


def _user_int(value) -> int:
    """"discord-<ID>" の ID を整数にする。形式が違えば ValueError(呼び出し側で扱う)。"""
    match = re.fullmatch(r"discord-(" + SNOWFLAKE + ")", value) if isinstance(value, str) else None
    if match is None:
        raise ValueError("user id")
    return int(match[1])


def _parse_iso(value) -> datetime:
    """写し・ジョブの時刻を読む。時刻帯が無ければ JST とみなす(契約 §3-1 は +09:00)。"""
    if not isinstance(value, str):
        raise ValueError("time")
    parsed = datetime.fromisoformat(value)
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=JST)


def _text(value) -> str:
    return "" if value is None else str(value)


class AssistantGateway:
    Error = AssistantError  # bot_task_gateway はこの属性で例外を捕まえる(モジュールを import しない)

    def __init__(self, store, modules, screening_store_path, files_dir, guild_id, *,
                 wait_sec: float = 8.0, waits: threading.BoundedSemaphore | None = None, clock=None):
        ledger, files = Path(screening_store_path), Path(files_dir)
        # 共有ドライブ上の相対パスを読むと、ドライブ停止で連携口が止まるため絶対パスだけ受ける。
        if not ledger.is_absolute() or not files.is_absolute():
            raise ValueError("absolute path required")
        if not re.fullmatch(SNOWFLAKE, str(guild_id)):
            raise ValueError("invalid guild id")
        self.store = store
        self.jobs = modules.store        # assistant_store(例外・JOB_ID_RE)
        self.logic = modules.logic       # assistant_logic(入力検査・権限規則)
        self.remind = modules.remind     # remind_logic(表示用の時刻帯)
        self.screening = modules.screening  # screening_store(列の定義と行の形)
        self.ledger_path = ledger
        self.files_dir = files
        self.files_root = files.resolve()
        self.guild_id = str(guild_id)
        self.wait_sec = float(wait_sec)
        self.waits = waits or threading.BoundedSemaphore(WAIT_SLOTS)
        self.clock = clock or (lambda: datetime.now(JST))

    # ---- 入口 ----

    def handle(self, method: str, path: str, payload: dict, context):
        """(status, body) を返す。body は JSON の dict か BinaryFile。失敗は AssistantError。"""
        parsed = urllib.parse.urlsplit(path)
        if parsed.fragment or not (parsed.path == PREFIX or parsed.path.startswith(PREFIX + "/")):
            _not_found()
        route = parsed.path[len(PREFIX):]
        found = []
        for verb, pattern, name in ROUTES:
            match = re.fullmatch(pattern, route)
            if match is not None:
                found.append((verb, name, match.groups()))
        chosen = [item for item in found if item[0] == method]
        if not chosen:
            _not_found()
        _, name, groups = chosen[0]
        # 委員確認は経路が決まった後・入力検査より前。委員でなければ入力の良し悪しを見せない。
        self._require_member(context, write=method != "GET")
        return getattr(self, "_route_" + name)(context, parsed.query, payload, *groups)

    def _require_member(self, context, *, write: bool) -> str:
        """委員(role あり)だけが使える。承認前・一時停止中の委員は読むだけ(契約 §3)。"""
        role = context.committee_role()
        if role is None:
            raise AssistantError(403, "FORBIDDEN", "委員だけが使えます。")
        if write and role == "viewer":
            raise AssistantError(403, "FORBIDDEN", "承認前か一時停止中のため、依頼や操作はできません。")
        return role

    # ---- 入力の共通検査 ----

    @staticmethod
    def _params(raw: str, allowed: set[str]) -> dict:
        """クエリを検査する。未対応の項目・重複・形式違いは 400(契約 §3-3)。"""
        if not raw:
            return {}
        try:
            pairs = urllib.parse.parse_qsl(raw, keep_blank_values=True, max_num_fields=8)
        except ValueError:
            _invalid()
        params = dict(pairs)
        if len(params) != len(pairs) or set(params) - allowed:
            _invalid()
        return params

    @staticmethod
    def _body(payload, allowed: set[str]) -> dict:
        if not isinstance(payload, dict) or set(payload) - allowed:
            _invalid("未対応の項目が含まれています。")
        return payload

    @contextmanager
    def _input_guard(self):
        """assistant_logic の入力検査の失敗(InputError)を 400 の応答に変える。"""
        try:
            yield
        except self.logic.InputError as error:
            raise AssistantError(400, error.code, error.message) from None

    def _client_op(self, value) -> str:
        with self._input_guard():
            return self.logic.client_operation_id(value)

    @staticmethod
    def _number(value: str | None, default: int, low: int, high: int) -> int:
        """件数などの整数。[0-9] だけを受ける(int() の空白・+・全角数字を通さない)。"""
        if value is None:
            return default
        if not re.fullmatch(r"[0-9]{1,3}", value) or not low <= int(value) <= high:
            _invalid("件数の指定が正しくありません。")
        return int(value)

    @staticmethod
    def _positive_id(value: str, message: str) -> int:
        if not re.fullmatch(r"[0-9]{1,10}", value) or not 1 <= int(value) <= 2**31 - 1:
            _invalid(message)
        return int(value)

    # ---- 設定(capabilities)・時刻 ----

    def _capabilities(self) -> dict:
        raw = self.store.get_meta("capabilities")
        if not raw:
            return {}
        try:
            value = json.loads(raw)
        except ValueError:
            return {}  # 読めない写しは「機能なし」と同じに倒す(出さない側に倒す)
        return value if isinstance(value, dict) else {}

    @staticmethod
    def _features(caps: dict) -> dict:
        raw = caps.get("features")
        raw = raw if isinstance(raw, dict) else {}
        return {kind: raw.get(kind) is True for kind in KINDS}

    def _require_feature(self, caps: dict, kind: str) -> None:
        # Bot が無効と言っている機能の依頼は受け付けない。受け付けると Bot が取らない
        # ジョブが queued のまま残り、利用者の同時受付枠(3 件)を塞いでしまう。
        # 400 にする(MODEL_UNAVAILABLE と同じく「いまの設定では受け付けない」依頼の形)。
        # 503 にすると Pi の接続失敗と見分けがつかず、アプリが「Bot に届かない」と出してしまう。
        if not self._features(caps)[kind]:
            raise AssistantError(400, "FEATURE_UNAVAILABLE", "この機能はいまの設定では使えません。")

    @staticmethod
    def _max_active(caps: dict) -> int:
        value = caps.get("maxActivePerUser")
        return value if type(value) is int and 1 <= value <= 100 else DEFAULT_MAX_ACTIVE

    @staticmethod
    def _named(value) -> dict | None:
        if not isinstance(value, dict):
            return None
        ident, name = value.get("id"), value.get("name")
        if not isinstance(ident, str) or not re.fullmatch(SNOWFLAKE, ident) or not isinstance(name, str):
            return None
        return {"id": ident, "name": name}

    def _reminder_channels(self, caps: dict) -> list | None:
        """通知先の候補。Bot が書いていなければ None(検査できない = Bot の検査に任せる)。"""
        raw = caps.get("reminderChannels")
        if not isinstance(raw, list):
            return None
        return [channel for channel in (self._named(item) for item in raw) if channel is not None]

    def _now(self) -> datetime:
        value = self.clock()
        if value.tzinfo is None:
            value = value.replace(tzinfo=JST)
        return value.astimezone(self.remind.JST)

    def _actor_int(self, context) -> int:
        return _user_int(context.actor_id)

    def _alive(self, seen_text: str | None) -> bool:
        if not seen_text:
            return False
        try:
            seen = _parse_iso(seen_text)
        except ValueError:
            return False
        return abs((self._now() - seen).total_seconds()) <= ONLINE_WINDOW_SEC

    # ---- リマインドの写し(reminder_snapshot)・候補台帳 ----

    def _manages_guild(self, context) -> bool:
        """見ている本人が「サーバー管理」(manage_guild)を持つか。Discord の /remind の役員判定と同じ
        (所有者・管理者・サーバー管理)。2026-10-14: Bot はメンバー一覧の特権インテントを持たないので、
        Bot の写しではなく、委員確認で既に読んだ本人の情報(共有キャッシュ)から計算する。
        読めなければ役員とみなさない(ボタンが出ないだけ。実行時は Bot が改めて判定する)。"""
        try:
            guild = context.load_guild(context.guild_id)
            actor = str(self._actor_int(context))
            member = context.member(context.guild_id, actor)
            if member is None:
                return False
            if actor == guild.get("owner_id"):
                return True
            roles = set(member.get("roles", []))
            permissions = 0
            for role in guild.get("roles", []):
                if role.get("id") == context.guild_id or role.get("id") in roles:
                    permissions |= int(role.get("permissions", 0))
        except Exception:  # noqa: BLE001  権限の表示だけの判定。失敗で一覧を止めない
            return False
        return bool(permissions & ((1 << 3) | (1 << 5)))   # ADMINISTRATOR | MANAGE_GUILD

    def _reminder_row(self, item) -> dict:
        if type(item["id"]) is not int or not isinstance(item["text"], str):
            raise ValueError("reminder")
        repeat = item["repeat"]
        if repeat not in self.logic.REMIND_REPEATS:
            raise ValueError("repeat")
        creator, target = item["creator"], item["target"]
        channel = item.get("channel")
        return {
            "id": item["id"], "text": item["text"], "due": item["due"], "dueAt": _parse_iso(item["due"]),
            "repeat": repeat,
            "creator": {"id": creator["id"], "name": _text(creator["name"])},
            "target": {"id": target["id"], "name": _text(target["name"])},
            "channel": self._named(channel) if channel is not None else None,
            "creatorId": _user_int(creator["id"]), "targetId": _user_int(target["id"]),
        }

    def _snapshot_reminders(self):
        """写し(reminder_snapshot)を読む。写しが無ければ None。壊れていれば 503(件数を 0 と言わない)。"""
        snapshot = self.store.read_snapshot()
        if snapshot is None:
            return None
        taken_at, body = snapshot
        try:
            items = body["reminders"]
            if not isinstance(items, list):
                raise ValueError("reminders")
            rows = [self._reminder_row(item) for item in items]
        except (KeyError, TypeError, ValueError, AttributeError):
            raise AssistantError(503, "LOAD_FAILED", "リマインドの情報を読めませんでした。") from None
        return taken_at, rows

    def _reminder_out(self, row: dict, actor: int, is_admin: bool) -> dict:
        rem = {"creator_id": row["creatorId"], "target_id": row["targetId"]}
        return {
            "id": row["id"], "text": row["text"], "due": row["due"], "repeat": row["repeat"],
            "creator": row["creator"], "target": row["target"], "channel": row["channel"],
            "canComplete": self.logic.may_complete(actor, is_admin, rem),
            "canDelete": self.logic.may_delete(actor, is_admin, rem),
        }

    def _ledger(self):
        """候補台帳を読み取り専用で開く。書くのは Bot だけ(契約 §1)。ScreeningStore.open は作る・直すので使わない。"""
        if self.ledger_path.is_symlink():
            raise sqlite3.OperationalError("symbolic link")
        uri = self.ledger_path.resolve().as_uri() + "?mode=ro"
        return sqlite3.connect(uri, uri=True, timeout=LEDGER_TIMEOUT_SEC, isolation_level=None)

    def _ledger_rows(self, state: str) -> list:
        columns = self.screening.COLUMNS
        try:
            con = self._ledger()
            try:
                if state == "open":
                    found = con.execute(
                        f"SELECT {columns} FROM candidates WHERE "
                        "(state='posted' AND message_id IS NOT NULL) OR "
                        "(state='created' AND decision='auto' AND message_id IS NOT NULL) ORDER BY id"
                    ).fetchall()
                else:
                    # ScreeningStore.recent(7) と同じ条件(created_at の書式も同じ UTC の ISO)
                    since = (self._now().astimezone(timezone.utc) - timedelta(days=7)).isoformat(timespec="seconds")
                    found = con.execute(
                        f"SELECT {columns} FROM candidates WHERE created_at >= ? ORDER BY id", (since,)
                    ).fetchall()
            finally:
                con.close()
        except sqlite3.Error:
            raise AssistantError(503, "LOAD_FAILED", "タスク候補の台帳を読めませんでした。") from None
        return [self.screening.CandidateRow(*row) for row in found]

    def _candidate_out(self, row) -> dict:
        # 押せるボタンは Discord の投稿があるときだけ(投稿が無ければ Bot も処理できない)。
        posted = row.state == "posted" and row.message_id is not None
        auto = row.state == "created" and row.decision == "auto" and row.message_id is not None
        actions = ["ok", "ng", "return"] if posted else ["undo", "return"] if auto else []
        sources = []
        for source in row.source_list:
            if isinstance(source, dict):
                sources.append({
                    "label": _text(source.get("source")),
                    "excerpt": f'{_text(source.get("ts"))} {_text(source.get("author"))}'.strip(),
                })
        url = None
        if row.message_id is not None:
            url = f"https://discord.com/channels/{self.guild_id}/{row.channel_id}/{row.message_id}"
        return {
            "id": row.id, "state": row.state, "decision": row.decision,
            "title": row.title, "description": row.description, "deadline": row.deadline,
            "departments": row.tag_list, "assigneeName": row.assignee_name,
            "sources": sources, "taskNumber": row.task_number, "discordUrl": url,
            "createdAt": row.created_at, "actions": actions,
        }

    # ---- ジョブ ----

    def _job_json(self, job) -> dict:
        result = None
        if job.state == "done" and isinstance(job.result, dict):
            result = dict(job.result)
            files = result.get("files")
            if isinstance(files, list):
                result["files"] = [self._file_out(job.id, entry) for entry in files]
        error = None
        if job.state == "failed":
            error = {"code": job.error_code or "LOAD_FAILED",
                     "message": job.error_message or "処理できませんでした。"}
        return {
            "id": job.id, "kind": job.kind, "op": job.op, "state": job.state,
            "actor": {"id": job.actor_id, "name": job.actor_name},
            "input": job.input,
            "progress": job.progress if job.state == "running" else None,   # 実行中だけ(store が終了時に消す)
            "result": result, "error": error, "discordUrl": job.discord_url,
            "createdAt": job.created_at, "startedAt": job.started_at, "finishedAt": job.finished_at,
        }

    @staticmethod
    def _file_out(job_id: str, entry):
        if not isinstance(entry, dict) or not isinstance(entry.get("name"), str):
            return entry
        return dict(entry, url=f"{PUBLIC_FILES}/{job_id}/{urllib.parse.quote(entry['name'], safe='')}")

    def _enqueue(self, context, client_op: str, kind: str, op, validated: dict, *, max_active=None):
        name = context.name(self._actor_int(context))
        try:
            job, replayed = self.store.enqueue(context.actor_id, name, client_op, kind, op, validated,
                                               max_active=max_active)
        except self.jobs.TooManyJobs as error:
            raise AssistantError(429, "TOO_MANY_JOBS", str(error)) from None
        # 同じ依頼番号で中身が違う送信に、前の依頼の結果を黙って返さない(task API の IDEMPOTENCY_CONFLICT と同じ)。
        if replayed and (job.kind, job.op, job.input) != (kind, op, validated):
            raise AssistantError(409, "CONFLICT", "同じ依頼番号で別の内容が送られました。")
        return job

    def _wait(self, job_id: str, job):
        """Bot が終えるまで最大 wait_sec 待つ。時計は実時間(注入した時計を使うと待ちが終わらない)。"""
        if job.state in TERMINAL_STATES or self.wait_sec <= 0:
            return job
        if not self.waits.acquire(blocking=False):
            return job  # 待つ枠が埋まっている。タスク API の応答を待ちで止めない
        try:
            deadline = time.monotonic() + self.wait_sec
            current = job
            while current.state not in TERMINAL_STATES:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                time.sleep(min(WAIT_POLL_SEC, remaining))
                latest = self.store.get(job_id)
                if latest is not None:
                    current = latest
            return current
        finally:
            self.waits.release()

    def _settle(self, job) -> tuple[int, dict]:
        """待って、終われば 200、終わらなければ 202(契約 §3-3)。"""
        current = self._wait(job.id, job)
        status = 200 if current.state in TERMINAL_STATES else 202
        return status, {"job": self._job_json(current)}

    def _can_read(self, job, context) -> bool:
        """ask/doc/image は委員なら誰でも(#bottest に出ているため)。remind・screening は本人だけ。"""
        return job.kind in FILE_KINDS or job.actor_id == context.actor_id

    def _validate_file_job(self, kind: str, raw_input: dict, caps: dict) -> dict:
        gemini = caps.get("gemini") is True
        with self._input_guard():
            if kind == "ask":
                return self.logic.ask_input(raw_input, gemini=gemini)
            if kind == "doc":
                return self.logic.doc_input(raw_input, gemini=gemini)
            return self.logic.image_input(raw_input)

    # ---- 経路の処理 ----

    def _route_meta(self, context, raw, payload):
        self._params(raw, set())
        caps = self._capabilities()
        models = [
            {"id": "auto", "label": "自動", "ask": True, "doc": True},
            {"id": "sonnet", "label": "sonnet(標準・速い)", "ask": True, "doc": True},
            {"id": "opus", "label": "opus(高性能・遅め)", "ask": True, "doc": True},
        ]
        if caps.get("gemini") is True:
            models.append({"id": "gemini", "label": "gemini", "ask": True, "doc": True})
        heartbeat = self.store.last_heartbeat()
        return 200, {
            "features": self._features(caps),
            "models": models,
            "docTypes": [{"id": key, "label": label} for key, label in DOC_TYPES],
            "reminderChannels": self._reminder_channels(caps) or [],
            "shareChannel": self._named(caps.get("shareChannel")),
            "isAdmin": self._manages_guild(context),
            "bot": {"alive": self._alive(heartbeat), "lastSeenAt": heartbeat},
        }

    def _route_summary(self, context, raw, payload):
        self._params(raw, set())
        loaded = self._snapshot_reminders()
        if loaded is None:
            raise AssistantError(503, "LOAD_FAILED", "リマインドの情報をまだ取得できていません。")
        _, rows = loaded
        pending = len(self._ledger_rows("open"))
        now = self._now()
        day_start, day_end = self.logic.jst_day_bounds(now)
        horizon = now + timedelta(days=7)
        actor = self._actor_int(context)
        counts = {"overdue": 0, "today": 0, "upcoming7d": 0}
        for row in rows:
            if actor not in (row["creatorId"], row["targetId"]):
                continue
            due = row["dueAt"]
            if due < now:
                counts["overdue"] += 1
            elif day_start <= due < day_end:
                counts["today"] += 1
            elif day_end <= due <= horizon:
                counts["upcoming7d"] += 1
        return 200, {"pendingCandidates": pending, "reminders": counts}

    def _route_create_job(self, context, raw, payload):
        self._params(raw, set())
        body = self._body(payload, {"clientOperationId", "kind", "input"})
        client_op = self._client_op(body.get("clientOperationId"))
        kind = body.get("kind")
        if kind not in FILE_KINDS:
            _invalid("依頼の種類が正しくありません。")
        raw_input = body.get("input")
        if not isinstance(raw_input, dict):
            _invalid()
        caps = self._capabilities()
        self._require_feature(caps, kind)
        validated = self._validate_file_job(kind, raw_input, caps)
        job = self._enqueue(context, client_op, kind, None, validated, max_active=self._max_active(caps))
        return 202, {"job": self._job_json(job)}

    def _route_get_job(self, context, raw, payload, job_id: str):
        self._params(raw, set())
        job = self.store.get(job_id)
        if job is None or not self._can_read(job, context):
            _not_found()  # 本人以外の remind・screening は存在も見せない
        return 200, {"job": self._job_json(job)}

    def _route_list_jobs(self, context, raw, payload):
        params = self._params(raw, {"kind", "mine", "limit", "before"})
        kind = params.get("kind")
        if kind is not None and kind not in KINDS:
            _invalid("種類の指定が正しくありません。")
        mine = params.get("mine", "0")
        if mine not in ("0", "1"):
            _invalid()
        limit = self._number(params.get("limit"), DEFAULT_LIMIT, 1, 50)
        before = params.get("before")
        if before is not None and not self.jobs.JOB_ID_RE.fullmatch(before):
            _invalid()
        actor = context.actor_id
        if kind in ("remind", "screening"):
            kinds, owner = (kind,), actor
        elif kind is not None:
            kinds, owner = (kind,), (actor if mine == "1" else None)
        elif mine == "1":
            kinds, owner = None, actor
        else:
            kinds, owner = FILE_KINDS, None
        try:
            jobs, next_cursor = self.store.list_jobs(kinds=kinds, actor_id=owner, before=before, limit=limit)
        except self.jobs.JobNotFound:
            _invalid("続きの起点が見つかりません。")
        return 200, {"jobs": [self._job_json(job) for job in jobs], "next": next_cursor}

    def _route_similar(self, context, raw, payload):
        params = self._params(raw, {"q"})
        with self._input_guard():
            question = self.logic.clean_text(params.get("q"), field="質問", max_len=1000, min_len=1)
        matches = self.store.similar(question)
        return 200, {"jobs": [{"job": self._job_json(job), "score": score} for job, score in matches]}

    def _route_cancel_job(self, context, raw, payload, job_id: str):
        self._params(raw, set())
        body = self._body(payload, {"clientOperationId"})
        self._client_op(body.get("clientOperationId"))
        try:
            job = self.store.cancel(job_id, context.actor_id)
        except (self.jobs.JobNotFound, self.jobs.JobForbidden):
            _not_found()  # 他人のジョブも存在を見せない
        except self.jobs.JobConflict:
            current = self.store.get(job_id)
            if current is not None and current.state == "canceled" and current.actor_id == context.actor_id:
                return 200, {"job": self._job_json(current)}  # 取り消し済みの再送は同じ結果
            raise AssistantError(409, "CONFLICT", "実行が始まったか終わった依頼は取り消せません。") from None
        return 200, {"job": self._job_json(job)}

    def _route_file(self, context, raw, payload, job_id: str, name_raw: str):
        self._params(raw, set())
        # %2F や %5C で区切りを作って登録外の場所を指すものは、デコード後の検査で 404 にする。
        name = urllib.parse.unquote(name_raw)
        if not name or len(name) > 200 or UNSAFE_NAME_RE.search(name):
            _not_found()
        job = self.store.get(job_id)
        if job is None or job.kind not in FILE_KINDS:
            _not_found()
        entry = self.store.get_file(job_id, name)
        if entry is None:
            _not_found()
        mime, size = entry["mime"], entry["size"]
        if (not self.logic.is_downloadable(mime) or type(size) is not int
                or not 0 <= size <= self.logic.MAX_DOWNLOAD_BYTES):
            _not_found()
        body = self._read_registered(entry["relpath"], size)
        base = mime.split(";")[0].strip().lower()
        if base.startswith("image/") and self.logic.sniff_image_mime(body) != base:
            _not_found()  # 登録された画像の型と中身が違う
        return 200, BinaryFile(content_type=mime, filename=name, body=body)

    def _read_registered(self, relpath, size: int) -> bytes:
        """登録された相対パスの中身を読む。files_dir の外へ出るもの・登録と大きさが違うものは 404。"""
        if not isinstance(relpath, str) or not relpath:
            _not_found()
        try:
            path = (self.files_dir / relpath).resolve()
        except (OSError, RuntimeError, ValueError):
            _not_found()
        # 両側を resolve してから比べる(8.3 形式の短い名前や、シンボリックリンクの経由で外に出ないように)。
        if path == self.files_root or not path.is_relative_to(self.files_root) or not path.is_file():
            _not_found()
        try:
            with open(path, "rb") as stream:
                body = stream.read(self.logic.MAX_DOWNLOAD_BYTES + 1)
        except OSError:
            _not_found()
        if len(body) != size:
            _not_found()
        return body

    def _route_members(self, context, raw, payload):
        self._params(raw, set())
        listed = context.load_member_list(self.guild_id)
        members = []
        for mid, member in sorted(listed.items(), key=lambda item: int(item[0])):
            context.members[(self.guild_id, mid)] = member  # context.name() がこの記録を読む
            if context.committee_role(mid) is None:
                continue
            members.append({"id": "discord-" + mid, "name": context.name(mid)})
        return 200, {"members": members}

    def _route_list_reminders(self, context, raw, payload):
        params = self._params(raw, {"scope"})
        scope = params.get("scope", "mine")
        if scope not in ("mine", "all"):
            _invalid("範囲の指定が正しくありません。")
        loaded = self._snapshot_reminders()
        if loaded is None:
            return 200, {"reminders": [], "snapshotAt": None}  # 写しが無いのは未取得であって、0 件ではない
        taken_at, rows = loaded
        actor = self._actor_int(context)
        is_admin = self._manages_guild(context)
        picked = [row for row in rows if scope == "all" or actor in (row["creatorId"], row["targetId"])]
        picked.sort(key=lambda row: row["dueAt"])
        return 200, {"reminders": [self._reminder_out(row, actor, is_admin) for row in picked],
                     "snapshotAt": taken_at}

    def _route_create_reminder(self, context, raw, payload):
        self._params(raw, set())
        body = self._body(payload, {"clientOperationId", "text", "due", "targetId", "repeat", "channelId"})
        client_op = self._client_op(body.get("clientOperationId"))
        fields = {key: body[key] for key in ("text", "due", "targetId", "repeat", "channelId") if key in body}
        caps = self._capabilities()
        self._require_feature(caps, "remind")
        with self._input_guard():
            validated = self.logic.remind_create_input(fields, now=self._now())
        target = validated["targetId"]
        if target is not None and context.committee_role(target) is None:
            _invalid("対象は委員から選んでください")
        channel = validated["channelId"]
        known = self._reminder_channels(caps)
        if channel is not None and known is not None and channel not in {item["id"] for item in known}:
            _invalid("通知先は一覧から選んでください")
        job = self._enqueue(context, client_op, "remind", "create", validated)
        return self._settle(job)

    def _route_reminder_action(self, context, raw, payload, number_raw: str, action: str):
        self._params(raw, set())
        body = self._body(payload, {"clientOperationId"})
        client_op = self._client_op(body.get("clientOperationId"))
        reminder_id = self._positive_id(number_raw, "リマインドの番号が正しくありません")
        with self._input_guard():
            reminder_id = self.logic.reminder_id(reminder_id)
        self._require_feature(self._capabilities(), "remind")
        job = self._enqueue(context, client_op, "remind", action, {"reminderId": reminder_id})
        return self._settle(job)

    def _route_candidates(self, context, raw, payload):
        params = self._params(raw, {"state"})
        state = params.get("state", "open")
        if state not in ("open", "recent"):
            _invalid("状態の指定が正しくありません。")
        rows = self._ledger_rows(state)
        return 200, {"candidates": [self._candidate_out(row) for row in rows]}

    def _route_candidate_action(self, context, raw, payload, number_raw: str, action: str):
        self._params(raw, set())
        body = self._body(payload, {"clientOperationId", "comment"})
        client_op = self._client_op(body.get("clientOperationId"))
        candidate_id = self._positive_id(number_raw, "候補の番号が正しくありません")
        with self._input_guard():
            fields = self.logic.screening_input(action, {"comment": body["comment"]} if "comment" in body else {})
        self._require_feature(self._capabilities(), "screening")
        job = self._enqueue(context, client_op, "screening", action,
                            {"candidateId": candidate_id, "comment": fields["comment"]})
        return self._settle(job)
