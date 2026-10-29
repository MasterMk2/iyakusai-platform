"""Signed Web API for IyakusaiBot's existing, authoritative SQLite TaskStore.

The Bot modules stay on their host. This process does not start a Discord gateway,
send messages, seed production data, or maintain a second copy of the tasks.
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import hashlib
import hmac
import importlib
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import re
import shlex
import signal
import socket
import ssl
import stat
import sys
import threading
import time
import tomllib
import types
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


FIELD_MAP = {
    "purpose": "purpose", "deliverable": "deliverable",
    "completionCriteria": "completion_criteria", "openQuestions": "open_questions",
    "assigneeId": "assignee_id",
    # 2026-10-25 追加: 親子。履歴の項目名を parentId にする(値は親タスクの番号)。
    "parentId": "parent",
    # 2026-10-28 追加: 副担当。履歴の値はユーザー ID(数字)をカンマでつないだもの。
    "helperIds": "helpers",
}
REVERSE_FIELDS = {value: key for key, value in FIELD_MAP.items()}
STATUSES = {"todo", "in_progress", "blocked", "done"}
VIEW, SEND, ADMIN, MANAGE_CHANNEL = 1 << 10, 1 << 11, 1 << 3, 1 << 4
ID_PATTERN = re.compile(r"[1-9][0-9]{16,19}\Z")
MAX_BODY = 65536
# 2026-10-14 追加: Bot タブの連携口(assistant_gateway.py)。タスクの経路とは別の枝で処理する。
ASSISTANT_PREFIX = "/api/integration/v1/assistant"
ASSISTANT_MODULES = ("assistant_store.py", "assistant_logic.py", "remind_logic.py", "screening_store.py")
ASSISTANT_PATH_KEYS = ("assistant_store_path", "assistant_files_dir", "screening_store_path")


class ApiError(Exception):
    def __init__(self, status: int, code: str):
        self.status, self.code = status, code


def invalid() -> None:
    raise ApiError(400, "VALIDATION")


def snowflake(value: object) -> str:
    if not isinstance(value, str) or not ID_PATTERN.fullmatch(value) or int(value) >= 2**64:
        invalid()
    return value


def user_id(value: object) -> int:
    if not isinstance(value, str) or not value.startswith("discord-"):
        invalid()
    return int(snowflake(value[8:]))


def uid(value: int | str) -> str:
    return "discord-" + str(value)


def task_key(number: int) -> str:
    """2026-10-14 からタスク番号はサーバー全体の通し番号(task-<番号>)。"""
    return f"task-{number}"


def protected_read(path: Path, limit: int, owner_only: bool = True) -> bytes:
    info = path.lstat()
    if path.resolve() != path or not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise ValueError("unsafe file")
    if info.st_uid != os.getuid() or (owner_only and info.st_mode & 0o077):
        raise ValueError("unsafe file ownership or permissions")
    if info.st_size > limit:
        raise ValueError("oversized file")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        opened = os.fstat(fd)
        if (opened.st_dev, opened.st_ino, opened.st_uid, opened.st_nlink) != (
            info.st_dev, info.st_ino, info.st_uid, 1
        ):
            raise ValueError("file changed")
        with os.fdopen(fd, "rb", closefd=False) as stream:
            body = stream.read(limit + 1)
        if len(body) > limit:
            raise ValueError("oversized file")
        return body
    finally:
        os.close(fd)


def load_bot_token(path: Path) -> str:
    fields = {}
    for line in protected_read(path, 131072).decode("utf-8").splitlines():
        match = re.match(r"(?:export\s+)?(DISCORD_TOKEN(?:_FILE)?)\s*=(.*)\Z", line)
        if not match:
            continue
        parsed = shlex.split(match[2], comments=True)
        if len(parsed) != 1:
            raise ValueError("invalid Bot credential reference")
        fields[match[1]] = parsed[0]
    if fields.get("DISCORD_TOKEN_FILE"):
        token_path = Path(fields["DISCORD_TOKEN_FILE"]).expanduser()
        if not token_path.is_absolute():
            raise ValueError("absolute credential path required")
        token = protected_read(token_path, 4096).decode("ascii").strip()
    else:
        token = fields.get("DISCORD_TOKEN", "")
    if not token or len(token) > 2048 or any(char.isspace() for char in token):
        raise ValueError("Bot credential unavailable")
    return token


def load_modules(source: Path, *, assistant: bool = False):
    """タスクの domain・store を読む。assistant のとき連携口が読むモジュールも読む(2026-10-14)。

    連携口が無効なら追加のモジュールを読まない。古い Bot のフォルダに新しいファイルが無くても、
    連携口を使わない構成ではタスク API が起動できるようにするため。
    戻り値は従来どおり (domain, storage)。assistant のときだけ 3 つ目に連携口のモジュールを足す
    (既存の契約試験 test_gateway.py の呼び方を変えないため)。
    """
    sys.dont_write_bytecode = True
    if source.resolve() != source or not source.is_dir():
        raise ValueError("unsafe module directory")
    filenames = ["task_domain.py", "task_store.py"] + (list(ASSISTANT_MODULES) if assistant else [])
    for filename in filenames:
        protected_read(source / filename, 262144, owner_only=False)
    package = types.ModuleType("iyakusai_bot")
    package.__path__ = [str(source)]
    sys.modules["iyakusai_bot"] = package
    # Bypass the Bot package entrypoint; only its storage and domain are imported.
    domain = importlib.import_module("iyakusai_bot.task_domain")
    storage = importlib.import_module("iyakusai_bot.task_store")
    if not assistant:
        return domain, storage
    assistant_ns = types.SimpleNamespace(
        store=importlib.import_module("iyakusai_bot.assistant_store"),
        logic=importlib.import_module("iyakusai_bot.assistant_logic"),
        remind=importlib.import_module("iyakusai_bot.remind_logic"),
        screening=importlib.import_module("iyakusai_bot.screening_store"),
    )
    return domain, storage, assistant_ns


class ServiceAuth:
    def __init__(self, key: bytes, clock=time.time, capacity: int = 4096):
        if len(key) < 32:
            raise ValueError("short service key")
        self.key, self.clock, self.capacity = key, clock, capacity
        self.used = {}
        self.lock = threading.Lock()

    def verify(self, method: str, path: str, headers, body: bytes) -> str:
        values = []
        for name in ("Client", "Timestamp", "Nonce", "Actor", "Signature"):
            entries = headers.get_all("X-Svc-" + name, [])
            if len(entries) != 1:
                raise ApiError(401, "UNAUTHENTICATED")
            values.append(entries[0])
        client, timestamp, nonce, actor, signature = values
        now = int(self.clock() * 1000)
        if (client != "web-gateway" or not re.fullmatch(r"[0-9]{13}", timestamp)
                or abs(now - int(timestamp)) > 30000
                or not re.fullmatch(r"[A-Za-z0-9_-]{22,64}", nonce)
                or not re.fullmatch(r"[0-9a-f]{64}", signature)):
            raise ApiError(401, "UNAUTHENTICATED")
        try:
            user_id(actor)
        except ApiError:
            raise ApiError(401, "UNAUTHENTICATED") from None
        canonical = "\n".join((
            "svc-auth/v1", client, method, path, timestamp, nonce, actor,
            hashlib.sha256(body).hexdigest(),
        ))
        expected = hmac.new(self.key, canonical.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, signature):
            raise ApiError(401, "UNAUTHENTICATED")
        with self.lock:
            self.used = {key: expiry for key, expiry in self.used.items() if expiry >= now}
            if nonce in self.used or len(self.used) >= self.capacity:
                raise ApiError(401, "UNAUTHENTICATED")
            self.used[nonce] = int(timestamp) + 30001
        return actor


def permission_number(value: object) -> int:
    if not isinstance(value, str) or not re.fullmatch(r"[0-9]{1,30}", value):
        raise ApiError(503, "LOAD_FAILED")
    return int(value)


def channel_permissions(guild: dict, channel: dict, member: dict) -> int:
    member_id = snowflake(member["user"]["id"])
    if member_id == guild["owner_id"]:
        return (1 << 64) - 1
    role_map = {snowflake(role["id"]): permission_number(role["permissions"])
                for role in guild["roles"]}
    guild_id = snowflake(guild["id"])
    roles = {snowflake(value) for value in member["roles"]}
    if guild_id not in role_map or not roles.issubset(role_map):
        raise ApiError(503, "LOAD_FAILED")
    permissions = role_map[guild_id]
    for role_id in roles:
        permissions |= role_map[role_id]
    if permissions & ADMIN:
        return (1 << 64) - 1
    overwrites = channel["permission_overwrites"]
    for overwrite in overwrites:
        if overwrite["type"] == 0 and overwrite["id"] == guild_id:
            permissions &= ~permission_number(overwrite["deny"])
            permissions |= permission_number(overwrite["allow"])
    denied = allowed = 0
    for overwrite in overwrites:
        if overwrite["type"] == 0 and overwrite["id"] in roles:
            denied |= permission_number(overwrite["deny"])
            allowed |= permission_number(overwrite["allow"])
    permissions = (permissions & ~denied) | allowed
    for overwrite in overwrites:
        if overwrite["type"] == 1 and overwrite["id"] == member_id:
            permissions &= ~permission_number(overwrite["deny"])
            permissions |= permission_number(overwrite["allow"])
    return permissions


def role_for(guild: dict, channel: dict, member: dict, bot_member: dict) -> str | None:
    permissions = channel_permissions(guild, channel, member)
    bot_permissions = channel_permissions(guild, channel, bot_member)
    if not permissions & VIEW or not bot_permissions & VIEW:
        return None
    timeout = member.get("communication_disabled_until")
    timed_out = False
    if timeout:
        deadline = dt.datetime.fromisoformat(timeout.replace("Z", "+00:00"))
        timed_out = deadline > dt.datetime.now(dt.timezone.utc)
    if member.get("pending") or timed_out or not permissions & SEND or not bot_permissions & SEND:
        return "viewer"
    return "admin" if permissions & (ADMIN | MANAGE_CHANNEL) else "editor"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class DiscordReadClient:
    def __init__(self, token: str):
        self.token = token
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def get(self, path: str, deadline: float, optional_member: bool = False):
        if not re.fullmatch(r"/(?:users/@me|guilds/[0-9]+(?:/channels|/members(?:/[0-9]+|\?limit=1000(?:&after=[0-9]+)?)?)?)", path):
            raise ApiError(503, "LOAD_FAILED")
        for attempt in range(3):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ApiError(503, "LOAD_FAILED")
            request = urllib.request.Request(
                "https://discord.com/api/v10" + path,
                headers={"Authorization": "Bot " + self.token,
                         "User-Agent": "IyakusaiTaskWeb/1.0"},
            )
            try:
                with self.opener.open(request, timeout=min(2.5, remaining)) as response:
                    body = response.read(2097153)
                    if len(body) > 2097152 or time.monotonic() > deadline:
                        raise ApiError(503, "LOAD_FAILED")
                    return json.loads(body)
            except urllib.error.HTTPError as error:
                if error.code == 404 and optional_member:
                    return None
                # Rate limited (2026-10-14): wait as Discord asks, if that still fits the deadline.
                if error.code == 429 and attempt < 2:
                    wait = retry_after(error)
                    if wait is not None and time.monotonic() + wait + 0.3 < deadline:
                        time.sleep(wait + 0.05)
                        continue
                raise ApiError(503, "LOAD_FAILED") from None
            except (OSError, ValueError, TimeoutError):
                raise ApiError(503, "LOAD_FAILED") from None
        raise ApiError(503, "LOAD_FAILED")


def retry_after(error) -> float | None:
    """Seconds to wait from a Discord 429 (Retry-After header or JSON retry_after), capped at 5."""
    values = []
    try:
        values.append(float(error.headers.get("Retry-After")))
    except (TypeError, ValueError, AttributeError):
        pass
    try:
        values.append(float(json.loads(error.read(4096) or b"{}").get("retry_after")))
    except (TypeError, ValueError, AttributeError, OSError):
        pass
    values = [v for v in values if 0 <= v <= 5]
    return max(values) if values else None


class SharedDiscordCache:
    """Discord data reused across requests for a short time (added 2026-10-14).

    Each request used to load the guild, the channel list and every member it needed from
    Discord. The channel list allows about 10 requests per 30 seconds and a member lookup
    5 per second, so the Web task screen (several requests at once, lists with many
    assignees) ran into 429s and showed "cannot connect". Now:
    - guild and channel data (roles, channel overwrites) is reused for GUILD_TTL seconds
      (up to GUILD_STALE seconds only while Discord itself fails);
    - member records are reused for MEMBER_TTL seconds, and a task list loads the whole
      member list once instead of one lookup per assignee;
    - the same guild data or member list is fetched by one request at a time.
    So a permission change in Discord reaches this API within those seconds, not instantly.
    """

    GUILD_TTL, GUILD_STALE, MEMBER_TTL = 60.0, 180.0, 20.0

    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self.lock = threading.Lock()
        self.guild_lock = threading.Lock()
        self.list_lock = threading.Lock()
        self.guilds = {}   # guild_id -> (at, guild, channels)
        self.members = {}  # (guild_id, member_id) -> (at, member or None)
        self.lists = {}    # guild_id -> (at, {member_id: member})

    def guild(self, guild_id: str, fetch):
        entry = self.guilds.get(guild_id)
        if entry and self.clock() - entry[0] < self.GUILD_TTL:
            return entry[1], entry[2]
        with self.guild_lock:
            entry = self.guilds.get(guild_id)
            if entry and self.clock() - entry[0] < self.GUILD_TTL:
                return entry[1], entry[2]
            try:
                guild, channels = fetch()
            except ApiError:
                if entry and self.clock() - entry[0] < self.GUILD_STALE:
                    return entry[1], entry[2]
                raise
            self.guilds[guild_id] = (self.clock(), guild, channels)
            return guild, channels

    def member(self, key):
        """(known, member). member is None when the person is known not to be a member."""
        now = self.clock()
        with self.lock:
            entry = self.members.get(key)
            listed = self.lists.get(key[0])
        fresh_entry = entry if entry and now - entry[0] < self.MEMBER_TTL else None
        fresh_list = listed if listed and now - listed[0] < self.MEMBER_TTL else None
        if fresh_entry and (not fresh_list or fresh_entry[0] >= fresh_list[0]):
            return True, fresh_entry[1]
        if fresh_list:
            return True, fresh_list[1].get(key[1])
        return False, None

    def put_member(self, key, member) -> None:
        with self.lock:
            self.members[key] = (self.clock(), member)

    def member_list(self, guild_id: str):
        with self.lock:
            listed = self.lists.get(guild_id)
        return listed[1] if listed and self.clock() - listed[0] < self.MEMBER_TTL else None

    def put_member_list(self, guild_id: str, members: dict) -> None:
        with self.lock:
            self.lists[guild_id] = (self.clock(), members)



OFFICER_ROLE_NAMES = {"委員長", "副委員長", "役員会"}
MANAGE_GUILD = 1 << 5


def department_from_workspace(value: str, departments) -> str:
    """ワークスペース ID(dept-<部局キー>)→ 部局キー。2026-10-14 から委員会 = 部局。"""
    match = re.fullmatch(r"dept-([a-z]{2,16})", value)
    if not match or match[1] not in departments:
        raise ApiError(404, "NOT_FOUND")
    return match[1]


def department_workspace(key: str) -> str:
    return "dept-" + key


class LiveContext:
    """Permission data for one request (2026-10-14: department tags, not channels).

    Every human member of the configured guild may read and edit every department's tasks
    (committee decision). Officers (roles 委員長・副委員長・役員会, guild owner, Administrator
    or Manage Server) are "admin" and may also reopen. Pending or timed-out members read only.
    Discord data comes through SharedDiscordCache, reused across requests for a few seconds.
    """

    def __init__(self, client, settings, actor_id: str, bot_id: str, cache: SharedDiscordCache | None = None,
                 departments=None):
        self.client, self.settings, self.actor_id, self.bot_id = client, settings, actor_id, bot_id
        self.cache = cache or SharedDiscordCache()
        self.departments = departments or {}
        self.deadline = time.monotonic() + 7
        self.guilds, self.members = {}, {}
        self.guild_id = str(min(settings.guild_ids))

    def load_guild(self, guild_id: str):
        if guild_id in self.guilds:
            return self.guilds[guild_id]

        def fetch():
            guild = self.client.get(f"/guilds/{guild_id}", self.deadline)
            if not isinstance(guild, dict) or guild.get("id") != guild_id:
                raise ApiError(503, "LOAD_FAILED")
            snowflake(guild["owner_id"])
            if not isinstance(guild.get("roles"), list):
                raise ApiError(503, "LOAD_FAILED")
            return guild, []

        guild, _ = self.cache.guild(guild_id, fetch)
        self.guilds[guild_id] = guild
        return guild

    def member(self, guild_id: str, member_id: str):
        key = guild_id, member_id
        if key not in self.members:
            known, member = self.cache.member(key)
            if not known:
                member = self.client.get(
                    f"/guilds/{guild_id}/members/{member_id}", self.deadline, optional_member=True,
                )
                self.check_member(member, member_id)
                self.cache.put_member(key, member)
            self.members[key] = member
        member = self.members[key]
        self.check_member(member, member_id)
        return member

    @staticmethod
    def check_member(member, member_id: str) -> None:
        if member is not None and (not isinstance(member, dict)
                                   or member.get("user", {}).get("id") != member_id
                                   or not isinstance(member.get("roles"), list)):
            raise ApiError(503, "LOAD_FAILED")

    def load_member_list(self, guild_id: str) -> dict:
        """The whole member list (one or a few requests), shared for a few seconds."""
        listed = self.cache.member_list(guild_id)
        if listed is not None:
            return listed
        with self.cache.list_lock:
            listed = self.cache.member_list(guild_id)
            if listed is not None:
                return listed
            found, after = {}, None
            for _ in range(5):
                path = f"/guilds/{guild_id}/members?limit=1000" + ("&after=" + after if after else "")
                page = self.client.get(path, self.deadline)
                if not isinstance(page, list) or len(page) > 1000:
                    raise ApiError(503, "LOAD_FAILED")
                for member in page:
                    mid = snowflake(member["user"]["id"])
                    if after and int(mid) <= int(after):
                        raise ApiError(503, "LOAD_FAILED")
                    self.check_member(member, mid)
                    found[mid] = member
                if len(page) < 1000:
                    self.cache.put_member_list(guild_id, found)
                    return found
                next_after = max((snowflake(m["user"]["id"]) for m in page), key=int)
                if after and int(next_after) <= int(after):
                    raise ApiError(503, "LOAD_FAILED")
                after = next_after
            raise ApiError(503, "LOAD_FAILED")

    def prefetch_members(self, _workspace=None) -> None:
        """Before resolving many assignees: load the member list once instead of one lookup each.
        If that fails, fall back to the individual lookups."""
        try:
            self.load_member_list(self.guild_id)
        except ApiError:
            pass

    def committee_role(self, member_id: str | None = None) -> str | None:
        member_id = member_id or str(user_id(self.actor_id))
        guild = self.load_guild(self.guild_id)
        member = self.member(self.guild_id, member_id)
        if member is None or member["user"].get("bot"):
            return None
        timeout = member.get("communication_disabled_until")
        timed_out = False
        if timeout:
            deadline = dt.datetime.fromisoformat(timeout.replace("Z", "+00:00"))
            timed_out = deadline > dt.datetime.now(dt.timezone.utc)
        if member.get("pending") or timed_out:
            return "viewer"
        roles = {snowflake(value) for value in member["roles"]}
        permissions, names = 0, set()
        for role in guild["roles"]:
            rid = snowflake(role["id"])
            if rid == self.guild_id or rid in roles:
                permissions |= permission_number(role["permissions"])
                if rid in roles:
                    names.add(role.get("name"))
        if member_id == guild["owner_id"] or permissions & (ADMIN | MANAGE_GUILD) or names & OFFICER_ROLE_NAMES:
            return "admin"
        return "editor"

    def role(self, department: str | None = None, member_id: str | None = None):
        if department is not None and department not in self.departments:
            return None
        return self.committee_role(member_id)

    def authorize(self, department: str | None = None, level: str = "viewer"):
        role = self.role(department)
        if role is None:
            raise ApiError(404, "NOT_FOUND")
        if level == "editor" and role == "viewer" or level == "admin" and role != "admin":
            raise ApiError(403, "FORBIDDEN")
        return role

    def scope(self, domain, _department=None):
        return domain.Scope(int(self.guild_id), 0)

    def name(self, member_id: int | str):
        # 2026-10-28: 先に権限を確かめた人だけでなく、誰の名前でも引く(名簿を読んであれば共有キャッシュから)。
        # 以前は self.members に入っている人だけで、一覧の担当者や履歴の人が「Discordユーザー」になっていた。
        try:
            member = self.member(self.guild_id, str(member_id))
        except ApiError:
            member = None
        if member is None:
            return "Discordユーザー"
        return member.get("nick") or member["user"].get("global_name") or member["user"]["username"]

    def workspace(self, key: str):
        label, parent = self.departments[key]
        note = "部の課のタスクも含む" if any(p == key for _, p in self.departments.values()) else "部局タグのタスク"
        # 2026-10-25 追加: 課の親の部(部は None)。画面で部を選ぶとその課も含めるため。
        return {"id": department_workspace(key), "name": label, "description": note,
                "parentId": department_workspace(parent) if parent else None}

    def me(self):
        role = self.committee_role()
        if role is None:
            raise ApiError(403, "FORBIDDEN")
        memberships = [{"workspace": self.workspace(key), "role": role} for key in self.departments]
        if not memberships:
            raise ApiError(403, "FORBIDDEN")
        return {"user": {"id": self.actor_id, "displayName": self.name(user_id(self.actor_id))},
                "memberships": memberships}

    def list_members(self, department: str):
        self.authorize(department)
        members = []
        for mid, member in sorted(self.load_member_list(self.guild_id).items(), key=lambda item: int(item[0])):
            self.members[(self.guild_id, mid)] = member
            role = self.committee_role(mid)
            if role:
                members.append({"userId": uid(mid), "displayName": self.name(mid), "role": role, "active": True})
        return members


class SqliteGateway:
    def __init__(self, domain, store):
        self.domain, self.store = domain, store
        self.departments = getattr(domain, "DEPARTMENTS", {})
        # 2026-10-25: 親子を保存できる Bot か(親子の前の Bot では parentId を出さず、受け付けない)
        self.parents = "parent" in getattr(domain, "TASK_FIELDS", ())
        # 2026-10-28: 副担当を保存できる Bot か(副担当の前の Bot では helperIds を出さず、受け付けない)
        self.helpers = "helpers" in getattr(domain, "TASK_FIELDS", ())

    @staticmethod
    def person(user, context):
        return {"id": uid(user), "displayName": context.name(user), "active": context.role(None, str(user)) is not None}

    @staticmethod
    def people(views) -> set:
        """一覧に出る担当者(主担当と副担当)。名簿をまとめて読むかの判断に使う。"""
        return {u for v in views for u in (v.task.assignee_id, *getattr(v.task, "helpers", ())) if u is not None}

    def task_view(self, view, context, _department=None):
        task = view.task
        tags = list(task.tags)
        assignee = None if task.assignee_id is None else self.person(task.assignee_id, context)
        helpers = list(getattr(task, "helpers", ()))
        return {
            "id": task_key(task.number), "workspaceId": department_workspace(tags[0] if tags else "yakuin"),
            "title": task.title, "description": task.description,
            "assigneeId": uid(task.assignee_id) if task.assignee_id is not None else None,
            "deadline": task.deadline, "status": task.status,
            "requirements": {REVERSE_FIELDS.get(key, key): value for key, value in task.requirements.items()},
            "version": task.version, "createdAt": task.created_at, "createdBy": uid(task.created_by),
            "updatedAt": task.updated_at, "updatedBy": uid(task.updated_by),
            "assignee": assignee, "overdue": view.overdue,
            "missingRequirements": [REVERSE_FIELDS.get(key, key) for key in view.missing],
            # 2026-10-14 追加(共通 Web は未使用): 部局タグ
            "tags": tags, "tagLabels": [self.departments[t][0] for t in tags if t in self.departments],
            # 2026-10-25 追加: 親タスクの ID(親子は 1 段)。親子を保存できない Bot では項目ごと出さない
            **({"parentId": task_key(task.parent) if task.parent is not None else None} if self.parents else {}),
            # 2026-10-28 追加: 副担当(付けた順)。副担当を保存できない Bot では項目ごと出さない
            **({"helperIds": [uid(u) for u in helpers], "helpers": [self.person(u, context) for u in helpers]}
               if self.helpers else {}),
        }

    def requirements(self, value):
        if not isinstance(value, dict) or set(value) - {"purpose", "deliverable", "completionCriteria", "openQuestions"}:
            invalid()
        return {FIELD_MAP[key]: text for key, text in value.items()}

    def tags(self, value):
        if not isinstance(value, list) or not value or len(value) > 10 or any(t not in self.departments for t in value):
            invalid()
        return value

    def parent(self, value):
        """親タスクの ID(task-<番号>)→ 番号。None は親なし。存在と段数は保存処理が確かめる。"""
        if not self.parents:
            invalid()
        if value is None:
            return None
        match = re.fullmatch(r"task-([1-9][0-9]{0,9})", value) if isinstance(value, str) else None
        if not match:
            invalid()
        return int(match[1])

    def operation(self, value, required: bool = False):
        if value is None and not required:
            return None
        if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,160}", value):
            invalid()
        return value

    def actor(self, context, operation):
        return self.domain.Actor(user_id(context.actor_id), operation, "web")

    def assigned(self, value, context):
        if value is None:
            return None
        assigned = user_id(value)
        if context.role(None, str(assigned)) is None:
            invalid()
        return assigned

    def helper_ids(self, value, context):
        """副担当の ID の並び → ユーザー ID の並び。委員だけ。人数の上限と主担当との規則は保存処理が確かめる。"""
        if not self.helpers or not isinstance(value, list) or len(value) > 20 or None in value:
            invalid()
        return [self.assigned(item, context) for item in value]

    def expected(self, value):
        if type(value) is not int or value < 1 or value > 2**53 - 1:
            invalid()
        return value

    def task_number(self, value: str, context) -> int:
        """task-<通し番号>。形式 1 の task-<チャンネル>-<番号> も読み替える(古いリンク用)。"""
        match = re.fullmatch(r"task-([1-9][0-9]{0,9})", value)
        if match:
            return int(match[1])
        legacy = re.fullmatch(r"task-([1-9][0-9]{16,19})-([1-9][0-9]{0,9})", value)
        if legacy:
            legacy_number = getattr(self.store, "legacy_number", None)
            number = legacy_number(int(context.guild_id), int(snowflake(legacy[1])), int(legacy[2])) if legacy_number else None
            if number is not None:
                return number
        raise ApiError(404, "NOT_FOUND")

    def summary(self, context, now=None):
        # The department API authorizes human committee members for all departments.
        # One authorization and one SQLite read; no assignee lookups or per-department requests.
        context.authorize(None, "viewer")
        now = now or dt.datetime.now(dt.timezone.utc)
        today = now.astimezone(dt.timezone(dt.timedelta(hours=9))).date()
        tomorrow, week_end = today + dt.timedelta(days=1), today + dt.timedelta(days=7)
        views = self.store.list_tasks(context.scope(self.domain))
        if len(views) > 2000:
            raise ApiError(503, "LOAD_FAILED")
        rows = [v.task for v in views if v.task.status != "done"]
        buckets = dict.fromkeys(("overdue", "today", "tomorrow", "upcoming", "later", "none"), 0)
        dates = {}
        departments = []
        for key, (name, parent) in self.departments.items():
            keys = {key} | {k for k, (_, p) in self.departments.items() if p == key}
            selected = [t for t in rows if keys.intersection(t.tags)]
            departments.append({"workspaceId": department_workspace(key), "name": name,
                                "parentId": department_workspace(parent) if parent else None,
                                "remaining": len(selected),
                                "overdue": sum(t.deadline is not None and t.deadline < today.isoformat() for t in selected),
                                "today": sum(t.deadline == today.isoformat() for t in selected)})
        for task in rows:
            deadline = dt.date.fromisoformat(task.deadline) if task.deadline is not None else None
            bucket = ("none" if deadline is None else "overdue" if deadline < today else
                      "today" if deadline == today else "tomorrow" if deadline == tomorrow else
                      "upcoming" if deadline <= week_end else "later")
            buckets[bucket] += 1
            if deadline is not None:
                dates[task.deadline] = dates.get(task.deadline, 0) + 1
        return {"today": today.isoformat(), "generatedAt": now.isoformat(), "total": len(rows),
                "deadlines": buckets, "departments": departments,
                "byDate": [{"deadline": d, "remaining": n} for d, n in sorted(dates.items())]}

    def dispatch(self, method: str, path: str, payload: dict, context):
        parsed = urllib.parse.urlsplit(path)
        prefix = "/api/integration/v1"
        if not parsed.path.startswith(prefix + "/"):
            raise ApiError(404, "NOT_FOUND")
        route = parsed.path[len(prefix):]
        if parsed.fragment or "%" in route:
            invalid()
        if method == "GET" and route == "/me" and not parsed.query:
            return 200, context.me()
        if method == "GET" and route == "/summary" and not parsed.query:
            return 200, self.summary(context)
        if method == "GET" and route == "/tasks" and not parsed.query:
            # 2026-10-25 追加: ギルドの全タスクを 1 回で返す。画面で部局を複数選ぶとき、部局ごとに呼ばずに済む。
            # 委員なら全部局を読めるので、権限の確認も 1 回(summary と同じ)。
            context.authorize(None, "viewer")
            views = self.store.list_tasks(context.scope(self.domain))
            if len(views) > 2000:
                raise ApiError(503, "LOAD_FAILED")
            prefetch = getattr(context, "prefetch_members", None)
            if prefetch and len(self.people(views)) >= 2:
                prefetch()
            return 200, [self.task_view(view, context) for view in views]
        workspace = re.fullmatch(r"/workspaces/([^/]+)/(tasks|members)", route)
        task_route = re.fullmatch(r"/tasks/([^/]+)(?:/(history|reopen))?", route)
        if workspace:
            department = department_from_workspace(workspace[1], self.departments)
            context.authorize(department, "editor" if method == "POST" else "viewer")
            scope = context.scope(self.domain, department)
            if workspace[2] == "members" and method == "GET" and not parsed.query:
                return 200, context.list_members(department)
            if workspace[2] != "tasks":
                raise ApiError(404, "NOT_FOUND")
            if method == "GET":
                pairs = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True, max_num_fields=6)
                query = dict(pairs)
                if len(pairs) != len(query) or set(query) - {"status", "assignee", "deadline"}:
                    invalid()
                status, assignee, deadline = (query.get(key) for key in ("status", "assignee", "deadline"))
                if status and status not in STATUSES | {"all"} or deadline and deadline not in {"overdue", "set", "none", "all"}:
                    invalid()
                if assignee and assignee not in {"me", "none", "unassigned", "all"}:
                    user_id(assignee)
                views = self.store.list_tasks(scope, tag=department)
                if len(views) > 2000:
                    raise ApiError(503, "LOAD_FAILED")
                prefetch = getattr(context, "prefetch_members", None)
                if prefetch and len(self.people(views)) >= 2:
                    prefetch(department)
                result = []
                for view in views:
                    row = view.task
                    # 担当者で絞るときは副担当のタスクも含める(2026-10-28)
                    mine = (row.assignee_id, *getattr(row, "helpers", ()))
                    if status and status != "all" and row.status != status:
                        continue
                    if assignee in {"none", "unassigned"} and row.assignee_id is not None:
                        continue
                    if assignee == "me" and user_id(context.actor_id) not in mine:
                        continue
                    if assignee and assignee not in {"all", "none", "unassigned", "me"} and user_id(assignee) not in mine:
                        continue
                    if deadline == "overdue" and not view.overdue or deadline == "set" and row.deadline is None or deadline == "none" and row.deadline is not None:
                        continue
                    result.append(self.task_view(view, context))
                return 200, result
            if method == "POST" and not parsed.query:
                if set(payload) - {"title", "description", "assigneeId", "deadline", "requirements", "operationId", "tags", "parentId", "helperIds"}:
                    invalid()
                operation = self.operation(payload.get("operationId"), required=True)
                parent = self.parent(payload["parentId"]) if "parentId" in payload else None
                helpers = self.helper_ids(payload["helperIds"], context) if "helperIds" in payload else []
                created = self.store.create(
                    self.actor(context, operation), scope,
                    title=payload.get("title"), description=payload.get("description", ""),
                    assignee_id=self.assigned(payload.get("assigneeId"), context),
                    deadline=payload.get("deadline"),
                    requirements=self.requirements(payload["requirements"]) if "requirements" in payload else None,
                    tags=self.tags(payload["tags"]) if "tags" in payload else [department],
                    # 親なしは従来と同じ呼び方(親子の前の Bot の保存処理でも作成できる)
                    **({"parent": parent} if parent is not None else {}),
                    **({"helpers": helpers} if helpers else {}),
                )
                return 201, {"task": self.task_view(created.view, context), "replayed": created.replayed}
        if task_route and not parsed.query:
            level = "admin" if task_route[2] == "reopen" else "editor" if method == "PATCH" else "viewer"
            context.authorize(None, level)
            number = self.task_number(task_route[1], context)
            scope = context.scope(self.domain)
            if method == "GET" and task_route[2] is None:
                return 200, self.task_view(self.store.get_task(scope, number), context)
            if method == "GET" and task_route[2] == "history":
                current = self.store.get_task(scope, number)
                entries, total = self.store.history(scope, number)
                if total > len(entries):
                    raise ApiError(503, "LOAD_FAILED")
                tags = list(current.task.tags)
                # 2026-10-28: 担当者・副担当の変更は、画面に出す側(displayChanges)を表示名にする
                people = {int(u) for e in entries for c in e.changes if c.field in ("assignee_id", "helpers")
                          for u in (c.before or "").split(",") + (c.after or "").split(",") if u.isdigit()}
                prefetch = getattr(context, "prefetch_members", None)
                if prefetch and len(people) >= 2:
                    prefetch()

                def shown(field, value):
                    if value is None or field not in ("assignee_id", "helpers"):
                        return value
                    return "、".join(context.name(int(u)) for u in value.split(",") if u.isdigit()) or None

                return 200, [
                    {"id": f"history-{number}-{entry.version}",
                     "taskId": task_key(number), "workspaceId": department_workspace(tags[0] if tags else "yakuin"),
                     "version": entry.version, "action": entry.action,
                     "actorId": uid(entry.actor_id), "actorName": context.name(entry.actor_id),
                     "at": entry.at, "source": entry.source, "operationId": entry.operation_id,
                     "changes": [{"field": REVERSE_FIELDS.get(change.field, change.field),
                                  "before": change.before, "after": change.after} for change in entry.changes],
                     "displayChanges": [{"field": REVERSE_FIELDS.get(change.field, change.field),
                                         "before": shown(change.field, change.before),
                                         "after": shown(change.field, change.after)} for change in entry.changes]}
                    for entry in entries
                ]
            if method == "PATCH" and task_route[2] is None:
                if set(payload) - {"changes", "expectedVersion", "operationId"}:
                    invalid()
                changes = payload.get("changes")
                if not isinstance(changes, dict) or set(changes) - {"title", "description", "assigneeId", "deadline", "status", "requirements", "tags", "parentId", "helperIds"}:
                    invalid()
                translated = {}
                for key, value in changes.items():
                    if key == "requirements":
                        translated.update(self.requirements(value))
                    elif key == "assigneeId":
                        translated["assignee_id"] = self.assigned(value, context)
                    elif key == "tags":
                        translated["tags"] = self.tags(value)
                    elif key == "parentId":
                        translated["parent"] = self.parent(value)
                    elif key == "helperIds":
                        translated["helpers"] = self.helper_ids(value, context)
                    else:
                        translated[key] = value
                updated = self.store.update(
                    self.actor(context, self.operation(payload.get("operationId"))), scope, number,
                    self.expected(payload.get("expectedVersion")), translated,
                    # Selecting and submitting "done" is the Web completion action.
                    # Other edits keep the Bot store's default confirmation rules.
                    confirmed=translated.get("status") == "done",
                )
                return 200, {"task": self.task_view(updated.view, context), "replayed": updated.replayed}
            if method == "POST" and task_route[2] == "reopen":
                if set(payload) - {"expectedVersion", "operationId"}:
                    invalid()
                updated = self.store.reopen(
                    self.actor(context, self.operation(payload.get("operationId"))), scope, number,
                    self.expected(payload.get("expectedVersion")), confirmed=True,
                )
                return 200, {"task": self.task_view(updated.view, context), "replayed": updated.replayed}
        raise ApiError(404, "NOT_FOUND")



def strict_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            invalid()
        result[key] = value
    return result


class ApiHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "IyakusaiTask"
    sys_version = ""

    def log_message(self, *args):
        pass

    def respond(self, status: int, body):
        encoded = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(encoded)
        self.close_connection = True

    def respond_file(self, status: int, file):
        """生成物の本体を返す(2026-10-14 追加)。ファイル名は UTF-8 の percent 形式で送る。

        ヘッダに日本語の名前をそのまま入れると送信の途中で失敗するため、ASCII だけにする。
        file は content_type・filename・body を持つ(assistant_gateway.BinaryFile)。
        """
        name = urllib.parse.quote(file.filename, safe="")
        self.send_response(status)
        self.send_header("Content-Type", file.content_type)
        self.send_header("Content-Length", str(len(file.body)))
        self.send_header("Content-Disposition", "attachment; filename*=UTF-8''" + name)
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(file.body)
        self.close_connection = True

    def handle_api(self):
        try:
            self.connection.settimeout(5)
            hosts = self.headers.get_all("Host", [])
            if hosts != [self.server.allowed_host]:
                raise ApiError(421, "BAD_HOST")
            if self.headers.get_all("Transfer-Encoding"):
                invalid()
            lengths = self.headers.get_all("Content-Length", [])
            if len(lengths) > 1 or lengths and not re.fullmatch(r"[0-9]{1,6}", lengths[0]):
                invalid()
            length = int(lengths[0]) if lengths else 0
            if length > MAX_BODY or self.command == "GET" and length:
                invalid()
            body = self.rfile.read(length)
            if len(body) != length:
                invalid()
            if self.command == "GET" and self.path == "/api/health":
                self.respond(200, {"ok": True})
                return
            if not self.path.startswith("/api/integration/v1/"):
                raise ApiError(404, "NOT_FOUND")
            actor_id = self.server.auth.verify(self.command, self.path, self.headers, body)
            if self.command != "GET":
                content_types = self.headers.get_all("Content-Type", [])
                if len(content_types) != 1 or content_types[0].split(";")[0].strip().lower() != "application/json":
                    invalid()
                try:
                    payload = json.loads(body, object_pairs_hook=strict_object,
                                         parse_constant=lambda _: invalid())
                except (ValueError, UnicodeError):
                    invalid()
                if not isinstance(payload, dict):
                    invalid()
            else:
                payload = {}
            context = LiveContext(self.server.discord, self.server.settings, actor_id, self.server.bot_id,
                                  getattr(self.server, "discord_cache", None),
                                  getattr(self.server.domain, "DEPARTMENTS", None))
            # 2026-10-14 追加: Bot タブの連携口。連携口が無効なら、経路が無いのと同じ 404 にする。
            path = self.path.split("?", 1)[0]
            if path == ASSISTANT_PREFIX or path.startswith(ASSISTANT_PREFIX + "/"):
                assistant = getattr(self.server, "assistant", None)
                if assistant is None:
                    raise ApiError(404, "NOT_FOUND")
                try:
                    status, result = assistant.handle(self.command, self.path, payload, context)
                except assistant.Error as error:
                    self.respond(error.status, {"error": {"code": error.code, "message": error.message}})
                    return
                if isinstance(result, dict):
                    self.respond(status, result)
                else:
                    self.respond_file(status, result)
                return
            try:
                status, result = self.server.gateway.dispatch(self.command, self.path, payload, context)
            except self.server.domain.TaskError as error:
                status = 409 if error.code in {"VERSION_CONFLICT", "IDEMPOTENCY_CONFLICT"} else 404 if error.code == "NOT_FOUND" else 400
                result = {"error": {"code": error.code, "message": "操作を反映できませんでした。"}}
                current = getattr(error, "current", None)
                match = re.fullmatch(r"/api/integration/v1/tasks/(task-[0-9-]+)(?:/reopen)?", self.path)
                if current is not None and match:
                    context.authorize(None)
                    result["error"]["current"] = self.server.gateway.task_view(current, context)
            self.respond(status, result)
        except ApiError as error:
            self.respond(error.status, {"error": {"code": error.code, "message": "操作を受け付けられませんでした。"}})
        except Exception:
            self.respond(503, {"error": {"code": "LOAD_FAILED", "message": "現在利用できません。"}})

    do_GET = do_POST = do_PATCH = handle_api


class ApiServer(ThreadingHTTPServer):
    daemon_threads = False
    block_on_close = True

    def __init__(self, address, handler, context, allowed_clients):
        self.tls_context, self.allowed_clients = context, allowed_clients
        self.slots = threading.BoundedSemaphore(24)
        self.discord_cache = SharedDiscordCache()
        super().__init__(address, handler)

    def get_request(self):
        connection, address = self.socket.accept()
        if address[0] not in self.allowed_clients or not self.slots.acquire(blocking=False):
            connection.close()
            raise OSError("untrusted client or request capacity")
        try:
            connection.settimeout(3)
            return self.tls_context.wrap_socket(connection, server_side=True), address
        except Exception:
            connection.close()
            self.slots.release()
            raise OSError("TLS handshake failed") from None

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()

    def handle_error(self, request, client_address):
        # Do not log request paths, headers, records, or Bot source tracebacks.
        sys.stderr.write("Task API request failed.\n")


def load_assistant_gateway(release: Path):
    """このファイルと同じリリースフォルダの assistant_gateway.py を読む(2026-10-14)。

    本番は `python3 -I`(隔離モード)で起動するので、スクリプトのフォルダが import の検索先に
    入らない。`from assistant_gateway import ...` では起動に失敗するため、場所を明示して読む。
    Bot のモジュールと同じく、本人の持ち物でリンクでない普通のファイルだけを受ける。
    """
    path = release / "assistant_gateway.py"
    protected_read(path, 262144, owner_only=False)
    spec = importlib.util.spec_from_file_location("assistant_gateway", path)
    if spec is None or spec.loader is None:
        raise ValueError("assistant gateway unavailable")
    module = importlib.util.module_from_spec(spec)
    sys.modules["assistant_gateway"] = module
    spec.loader.exec_module(module)
    return module.AssistantGateway


def assistant_settings(config: dict):
    """連携口の設定。キーが無いか false なら None。有効なのにパスが絶対パスでなければ起動を止める(2026-10-14)。"""
    enabled = config.get("assistant_enabled", False)
    if type(enabled) is not bool:
        raise ValueError("invalid assistant_enabled")
    if not enabled:
        return None
    settings = {}
    for key in ASSISTANT_PATH_KEYS:
        value = config.get(key)
        if not isinstance(value, str) or not Path(value).is_absolute():
            raise ValueError("absolute assistant path required: " + key)
        settings[key] = value
    return settings


PRIVATE_NETWORKS = tuple(ipaddress.IPv4Network(net) for net in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))


def load_site(directory: Path) -> tuple[str, frozenset[str]]:
    """この配置だけの待ち受けと接続元。公開する木には置かず、配布フォルダの site.json から読む。

    既定値は持たない。無い・形が違う・本人以外が読み書きできるときは起動しない。
    """
    site = json.loads(protected_read(directory / "site.json", 4096))
    if type(site) is not dict or set(site) != {"listenHost", "trustedClientAddresses"}:
        raise ValueError("invalid site file")
    addresses = [site["listenHost"], *site["trustedClientAddresses"]]
    if (type(site["trustedClientAddresses"]) is not list or not site["trustedClientAddresses"]
            or any(type(a) is not str or not any(ipaddress.IPv4Address(a) in n for n in PRIVATE_NETWORKS)
                   for a in addresses)):
        raise ValueError("invalid site file")
    return site["listenHost"], frozenset(site["trustedClientAddresses"])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    config = json.loads(protected_read(Path(args.config), 65536))
    assistant_config = assistant_settings(config)
    assistant_ns = None
    if assistant_config is None:
        domain, storage = load_modules(Path(config["bot_module_directory"]))
    else:
        domain, storage, assistant_ns = load_modules(Path(config["bot_module_directory"]), assistant=True)
    bot_config = tomllib.loads(protected_read(Path(config["bot_configuration"]), 262144).decode())
    settings = storage.TaskSettings.from_mapping(bot_config["tasks"])
    if not settings.enabled or not settings.guild_ids:
        raise ValueError("Bot task configuration unavailable")
    store_directory = Path(settings.store_dir)
    protected_read(store_directory / "tasks.sqlite3", 67108864)
    store = storage.TaskStore.open(store_directory)
    encoded = protected_read(Path(config["gateway_key_file"]), 4096).strip()
    try:
        key = bytes.fromhex(encoded.decode("ascii"))
    except ValueError:
        key = base64.b64decode(encoded, validate=True)
    discord = DiscordReadClient(load_bot_token(Path(config["bot_environment_file"])))
    bot = discord.get("/users/@me", time.monotonic() + 5)
    if not bot.get("bot"):
        raise ValueError("Bot identity unavailable")
    bot_id = snowflake(bot["id"])
    certificate = Path(config["tls_certificate_file"])
    private_key = Path(config["tls_private_key_file"])
    protected_read(certificate, 65536)
    protected_read(private_key, 65536)
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tls.minimum_version = ssl.TLSVersion.TLSv1_2
    tls.load_cert_chain(certificate, private_key)
    listen_host, trusted_clients = load_site(Path(__file__).resolve().parent)
    if config["host"] != listen_host or type(config["port"]) is not int or not 1024 <= config["port"] <= 65535:
        raise ValueError("invalid private bind")
    clients = set(config["trusted_client_addresses"])
    if not clients or not clients <= trusted_clients:
        raise ValueError("invalid trusted clients")
    server = ApiServer((config["host"], config["port"]), ApiHandler, tls, clients)
    server.auth, server.discord, server.settings, server.bot_id = ServiceAuth(key), discord, settings, bot_id
    server.domain, server.gateway = domain, SqliteGateway(domain, store)
    server.allowed_host = f"{config['host']}:{config['port']}"
    server.assistant = None
    if assistant_config is not None:
        # 同じフォルダの assistant_gateway.py は連携口が有効なときだけ読む(無効なら取り込まない)。
        AssistantGateway = load_assistant_gateway(Path(__file__).resolve().parent)
        job_store = assistant_ns.store.AssistantStore.open(Path(assistant_config["assistant_store_path"]))
        server.assistant = AssistantGateway(
            job_store, assistant_ns, assistant_config["screening_store_path"],
            assistant_config["assistant_files_dir"], min(settings.guild_ids),
        )
    def stop(*_):
        threading.Thread(target=server.shutdown, daemon=True).start()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        server.serve_forever(poll_interval=0.2)
    finally:
        server.server_close()


if __name__ == "__main__":
    try:
        main()
    except Exception:
        sys.stderr.write("Task API startup failed; production data was not seeded.\n")
        sys.exit(1)
