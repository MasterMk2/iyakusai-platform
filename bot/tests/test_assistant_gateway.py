"""連携口(gateway/assistant_gateway.py)と bot_task_gateway の Bot 用の経路の試験(2026-10-14)。

合成データだけを使う。ネットワークには出ず、127.0.0.1 の一時ポートに実際の ThreadingHTTPServer と
ApiHandler を立てて、署名付きの要求を送る。SQLite は一時フォルダに作る。
"""

from __future__ import annotations

import hashlib
import hmac
import http.client
import importlib.util
import json
import os
import re
import secrets
import shutil
import sqlite3
import sys
import tempfile
import threading
import time
import types
import unittest
import urllib.parse
from datetime import datetime, timedelta, timezone
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parents[1]
GATEWAY = REPO / "gateway"
MODULE_DIR = (REPO / "src" / "iyakusai_bot").resolve()
if str(GATEWAY) not in sys.path:
    sys.path.insert(0, str(GATEWAY))  # assistant_gateway は bot_task_gateway と同じフォルダに置く


def _load_task_gateway():
    spec = importlib.util.spec_from_file_location("bot_task_gateway_assistant_tests", GATEWAY / "bot_task_gateway.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


api = _load_task_gateway()
import assistant_gateway as ag  # noqa: E402

JST = timezone(timedelta(hours=9))
FIXED_NOW = datetime(2026, 10, 14, 10, 0, tzinfo=JST)

# 合成の ID(実在しない値)
GUILD = "1000000000000000001"
BOT = "1000000000000000099"
OWNER = "1000000000000000090"
ROLE_EDITOR = "1000000000000000100"
ROLE_OFFICER = "1000000000000000101"
EDITOR = "1000000000000000002"    # 委員(編集)
OTHER = "1000000000000000003"     # 別の委員(編集)
OFFICER = "1000000000000000004"   # 委員長(管理)
PENDING = "1000000000000000005"   # 承認前(読むだけ)
OUTSIDER = "1000000000000000006"  # 委員ではない
BOT_USER = "1000000000000000007"  # bot アカウント
CHANNEL_A = "1000000000000000011"
CHANNEL_B = "1000000000000000012"
CHANNEL_CAND = 1000000000000003001
MESSAGE_A = 1000000000000002001
MESSAGE_B = 1000000000000002002
KEY = b"synthetic-service-key-0123456789abcdef-0123"

ROLES = [
    {"id": GUILD, "name": "@everyone", "permissions": "0"},
    {"id": ROLE_EDITOR, "name": "委員", "permissions": "0"},
    {"id": ROLE_OFFICER, "name": "委員長", "permissions": "32"},   # サーバー管理(manage_guild)
]


def uid(value: str) -> str:
    return "discord-" + value


def member_record(member_id: str, roles: list[str], name: str, *, pending: bool = False, bot: bool = False) -> dict:
    user = {"id": member_id, "username": "synthetic" + member_id[-4:], "global_name": name}
    if bot:
        user["bot"] = True
    record = {"user": user, "roles": roles}
    if pending:
        record["pending"] = True
    return record


class FakeDiscord:
    """Discord の代わり。合成のサーバー・役職・委員だけを返す(ネットワークに出ない)。"""

    def __init__(self):
        self.members = {
            EDITOR: member_record(EDITOR, [ROLE_EDITOR], "委員A"),
            OTHER: member_record(OTHER, [ROLE_EDITOR], "委員B"),
            OFFICER: member_record(OFFICER, [ROLE_OFFICER], "委員長テスト"),
            PENDING: member_record(PENDING, [ROLE_EDITOR], "承認前テスト", pending=True),
            BOT_USER: member_record(BOT_USER, [ROLE_EDITOR], "bot", bot=True),
        }

    def get(self, path: str, deadline: float, optional_member: bool = False):
        if path == f"/guilds/{GUILD}":
            return {"id": GUILD, "owner_id": OWNER, "roles": ROLES}
        if path == f"/guilds/{GUILD}/members?limit=1000":
            return list(self.members.values())
        found = re.fullmatch(rf"/guilds/{GUILD}/members/([0-9]+)", path)
        if found is None:
            raise AssertionError("unexpected Discord path in test")
        member = self.members.get(found[1])
        if member is None and optional_member:
            return None
        if member is None:
            raise api.ApiError(503, "LOAD_FAILED")
        return member


def caps(**overrides) -> dict:
    value = {
        "features": {"ask": True, "doc": True, "image": True, "remind": True, "screening": True},
        "gemini": False,
        "maxActivePerUser": 3,
        "reminderChannels": [{"id": CHANNEL_A, "name": "総務連絡"}],
        "shareChannel": {"id": CHANNEL_B, "name": "bottest"},
        "updatedAt": "2026-10-14T09:00:00+09:00",
    }
    value.update(overrides)
    return value


def _plain_read(path, limit, owner_only=True):
    """Windows には os.getuid が無いので、所有者の検査だけ省く。サイズと通常ファイルの検査は残す。"""
    path = Path(path)
    if not path.is_file() or path.stat().st_size > limit:
        raise ValueError("unsafe file")
    return path.read_bytes()


class Reply:
    def __init__(self, status: int, headers: list, body: bytes):
        self.status = status
        self.headers = {name.lower(): value for name, value in headers}
        self.body = body

    def json(self):
        return json.loads(self.body)

    def error_code(self) -> str:
        return self.json()["error"]["code"]


class Harness(unittest.TestCase):
    """ApiHandler を実際のサーバーで動かす共通部分。sys.modules は各試験の前後で元に戻す。"""

    def setUp(self):
        self._saved_modules = {k: v for k, v in sys.modules.items() if k.startswith("iyakusai_bot")}
        for key in list(self._saved_modules):
            del sys.modules[key]
        self.addCleanup(self._restore_modules)
        self.dir = Path(tempfile.mkdtemp(prefix="asst-gw-"))
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)
        with mock.patch.object(api, "protected_read", _plain_read):
            self.domain, self.storage, self.ns = api.load_modules(MODULE_DIR, assistant=True)
        self.discord = FakeDiscord()
        self.files = self.dir / "files"
        self.ledger = self.dir / "ledger" / "candidates.sqlite3"

    def _restore_modules(self):
        for key in [k for k in sys.modules if k.startswith("iyakusai_bot")]:
            del sys.modules[key]
        sys.modules.update(self._saved_modules)

    def make_store(self):
        return self.ns.store.AssistantStore.open(self.dir / "jobs" / "assistant.sqlite3")

    def make_gateway(self, store=None, *, wait_sec: float = 0.3, waits=None, clock=None, capabilities=None):
        self.store = store or self.make_store()
        if capabilities is not None:
            self.store.set_meta("capabilities", json.dumps(capabilities, ensure_ascii=False))
        self.gateway = ag.AssistantGateway(self.store, self.ns, self.ledger, self.files, GUILD,
                                           wait_sec=wait_sec, waits=waits, clock=clock)
        return self.gateway

    def start(self, assistant):
        server = ThreadingHTTPServer(("127.0.0.1", 0), api.ApiHandler)
        server.daemon_threads = True
        self.port = server.server_address[1]
        server.allowed_host = f"127.0.0.1:{self.port}"
        server.auth = api.ServiceAuth(KEY)
        server.discord = self.discord
        server.settings = types.SimpleNamespace(guild_ids={int(GUILD)})
        server.bot_id = BOT
        server.domain = self.domain
        server.gateway = types.SimpleNamespace(dispatch=mock.Mock(side_effect=AssertionError("task route")))
        server.assistant = assistant
        server.discord_cache = api.SharedDiscordCache()
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        thread.start()

        def stop():
            server.shutdown()
            server.server_close()
            thread.join(5)

        self.addCleanup(stop)
        return server

    def request(self, method: str, path: str, *, actor: str = EDITOR, body=None, omit=(), extra=None,
                timestamp=None, nonce=None, signature=None, raw_body=None) -> Reply:
        data = raw_body if raw_body is not None else (None if body is None else json.dumps(body).encode("utf-8"))
        payload = data or b""
        stamp = str(timestamp if timestamp is not None else int(time.time() * 1000))
        nonce = nonce or secrets.token_urlsafe(24)
        actor_value = uid(actor)
        canonical = "\n".join(("svc-auth/v1", "web-gateway", method, path, stamp, nonce, actor_value,
                               hashlib.sha256(payload).hexdigest()))
        headers = {
            "X-Svc-Client": "web-gateway", "X-Svc-Timestamp": stamp, "X-Svc-Nonce": nonce,
            "X-Svc-Actor": actor_value,
            "X-Svc-Signature": signature or hmac.new(KEY, canonical.encode(), hashlib.sha256).hexdigest(),
        }
        if data is not None:
            headers["Content-Type"] = "application/json"
        headers.update(extra or {})
        for name in omit:
            headers.pop(name, None)
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        try:
            connection.request(method, path, body=data, headers=headers)
            response = connection.getresponse()
            return Reply(response.status, response.getheaders(), response.read())
        finally:
            connection.close()

    # ---- 合成データの作り方 ----

    def make_ledger(self):
        """候補台帳を ScreeningStore の公開 API で作る(試験の準備だけに使う)。"""
        self.ledger.parent.mkdir(parents=True, exist_ok=True)
        return self.ns.screening.ScreeningStore.open(self.ledger)

    def register_file(self, job_id: str, name: str, data: bytes, mime: str, *, size=None, relpath=None):
        folder = self.files / job_id
        folder.mkdir(parents=True, exist_ok=True)
        (folder / name).write_bytes(data)
        self.store.add_file(job_id, name, mime, len(data) if size is None else size,
                            hashlib.sha256(data).hexdigest(), relpath or f"{job_id}/{name}")

    def enqueue(self, kind="ask", actor=EDITOR, *, client_op=None, op=None, data=None):
        data = data if data is not None else {"question": "会場の予約方法を教えて", "model": "auto",
                                              "effort": "auto", "tone": None, "format": None}
        job, _ = self.store.enqueue(uid(actor), "表示名", client_op or secrets.token_hex(8), kind, op, data)
        return job

    def finish_job(self, job_id: str, kind: str, result: dict):
        claimed = self.store.claim_next([kind])
        self.assertIsNotNone(claimed)
        self.assertEqual(claimed.id, job_id)
        self.assertTrue(self.store.finish(job_id, result))

    def jobs_path(self, *parts: str) -> str:
        return "/api/integration/v1/assistant/" + "/".join(parts)

    def ask_body(self, question="会場の予約方法を教えて", **extra):
        input_value = {"question": question}
        input_value.update(extra)
        return {"clientOperationId": "ui-" + secrets.token_hex(6), "kind": "ask", "input": input_value}


class AuthTests(Harness):
    def setUp(self):
        super().setUp()
        self.make_gateway(capabilities=caps())
        self.start(self.gateway)

    def test_missing_header_is_401(self):
        reply = self.request("GET", self.jobs_path("meta"), omit=("X-Svc-Nonce",))
        self.assertEqual(reply.status, 401)
        self.assertEqual(reply.error_code(), "UNAUTHENTICATED")

    def test_reused_nonce_is_401(self):
        nonce = secrets.token_urlsafe(24)
        self.assertEqual(self.request("GET", self.jobs_path("meta"), nonce=nonce).status, 200)
        reply = self.request("GET", self.jobs_path("meta"), nonce=nonce)
        self.assertEqual(reply.status, 401)

    def test_wrong_signature_is_401(self):
        reply = self.request("GET", self.jobs_path("meta"), signature="0" * 64)
        self.assertEqual(reply.status, 401)

    def test_stale_timestamp_is_401(self):
        stale = int(time.time() * 1000) - 60_000
        reply = self.request("GET", self.jobs_path("meta"), timestamp=stale)
        self.assertEqual(reply.status, 401)


class MembershipTests(Harness):
    def setUp(self):
        super().setUp()
        self.make_gateway(capabilities=caps())
        self.start(self.gateway)

    def test_non_member_is_403_on_read_and_write(self):
        self.assertEqual(self.request("GET", self.jobs_path("meta"), actor=OUTSIDER).status, 403)
        reply = self.request("POST", self.jobs_path("jobs"), actor=OUTSIDER, body=self.ask_body())
        self.assertEqual(reply.status, 403)
        self.assertEqual(reply.error_code(), "FORBIDDEN")

    def test_bot_account_is_not_a_member(self):
        self.assertEqual(self.request("GET", self.jobs_path("meta"), actor=BOT_USER).status, 403)

    def test_pending_member_reads_but_cannot_write(self):
        self.assertEqual(self.request("GET", self.jobs_path("meta"), actor=PENDING).status, 200)
        reply = self.request("POST", self.jobs_path("jobs"), actor=PENDING, body=self.ask_body())
        self.assertEqual(reply.status, 403)
        self.assertEqual(self.store.count_active(uid(PENDING)), 0)


class DisabledTests(Harness):
    def test_every_assistant_path_is_404_when_disabled(self):
        self.make_gateway(capabilities=caps())
        self.start(None)
        paths = [("GET", "meta"), ("GET", "summary"), ("POST", "jobs"), ("GET", "jobs"),
                 ("GET", "reminders"), ("POST", "reminders"), ("GET", "candidates"),
                 ("GET", "files/j_aaaaaaaaaaaaaaaaaaaa/a.png")]
        for method, route in paths:
            body = self.ask_body() if method == "POST" and route == "jobs" else (
                {"clientOperationId": "ui-disabled-1"} if method == "POST" else None)
            reply = self.request(method, self.jobs_path(route), body=body)
            self.assertEqual(reply.status, 404, (method, route))
            self.assertEqual(reply.error_code(), "NOT_FOUND")
        reply = self.request("GET", "/api/integration/v1/assistant")
        self.assertEqual(reply.status, 404)


class MetaTests(Harness):
    def test_defaults_when_capabilities_are_absent(self):
        self.make_gateway()
        self.start(self.gateway)
        body = self.request("GET", self.jobs_path("meta")).json()
        self.assertEqual(body["features"], {"ask": False, "doc": False, "image": False, "remind": False, "screening": False})
        self.assertEqual([m["id"] for m in body["models"]], ["auto", "sonnet", "opus"])
        self.assertEqual([d["id"] for d in body["docTypes"]],
                         ["request", "notice", "report", "minutes", "mail", "free"])
        self.assertEqual(body["reminderChannels"], [])
        self.assertIsNone(body["shareChannel"])
        self.assertFalse(body["isAdmin"])
        self.assertEqual(body["bot"], {"alive": False, "lastSeenAt": None})

    def test_reports_capabilities_admin_and_heartbeat(self):
        self.make_gateway(capabilities=caps(gemini=True))
        self.store.write_snapshot({"reminders": []})
        self.store.heartbeat()
        self.start(self.gateway)
        body = self.request("GET", self.jobs_path("meta")).json()
        self.assertTrue(all(body["features"].values()))
        self.assertEqual([m["id"] for m in body["models"]], ["auto", "sonnet", "opus", "gemini"])
        self.assertEqual(body["models"][3]["label"], "gemini")
        self.assertEqual(body["reminderChannels"], [{"id": CHANNEL_A, "name": "総務連絡"}])
        self.assertEqual(body["shareChannel"], {"id": CHANNEL_B, "name": "bottest"})
        self.assertTrue(body["bot"]["alive"])
        self.assertIsNotNone(body["bot"]["lastSeenAt"])
        self.assertFalse(body["isAdmin"])
        self.assertTrue(self.request("GET", self.jobs_path("meta"), actor=OFFICER).json()["isAdmin"])

    def test_gemini_model_absent_when_disabled(self):
        self.make_gateway(capabilities=caps(gemini=False))
        self.start(self.gateway)
        ids = [m["id"] for m in self.request("GET", self.jobs_path("meta")).json()["models"]]
        self.assertNotIn("gemini", ids)


class JobInputTests(Harness):
    def setUp(self):
        super().setUp()
        self.make_gateway(capabilities=caps())
        self.start(self.gateway)

    def post_job(self, body, actor=EDITOR):
        return self.request("POST", self.jobs_path("jobs"), actor=actor, body=body)

    def test_bad_client_operation_id_is_400(self):
        reply = self.post_job({"clientOperationId": "bad id!", "kind": "ask", "input": {"question": "x"}})
        self.assertEqual(reply.status, 400)
        self.assertEqual(reply.error_code(), "VALIDATION")

    def test_unknown_top_level_key_is_400(self):
        body = self.ask_body()
        body["extra"] = 1
        self.assertEqual(self.post_job(body).status, 400)

    def test_empty_question_is_400(self):
        self.assertEqual(self.post_job(self.ask_body(question="   ")).status, 400)

    def test_question_over_1000_is_400(self):
        self.assertEqual(self.post_job(self.ask_body(question="あ" * 1001)).status, 400)

    def test_control_characters_are_stripped(self):
        reply = self.post_job(self.ask_body(question="質問\x00\x07テスト\n二行目"))
        self.assertEqual(reply.status, 202)
        self.assertEqual(reply.json()["job"]["input"]["question"], "質問テスト 二行目")

    def test_gemini_model_is_unavailable_when_disabled(self):
        reply = self.post_job(self.ask_body(model="gemini"))
        self.assertEqual(reply.status, 400)
        self.assertEqual(reply.error_code(), "MODEL_UNAVAILABLE")

    def test_gemini_model_is_accepted_when_enabled(self):
        self.store.set_meta("capabilities", json.dumps(caps(gemini=True)))
        self.assertEqual(self.post_job(self.ask_body(model="gemini")).status, 202)

    def test_doc_use_sources_must_be_bool(self):
        body = {"clientOperationId": "ui-doc-1", "kind": "doc",
                "input": {"docType": "notice", "content": "本文", "format": "md", "useSources": "yes"}}
        reply = self.post_job(body)
        self.assertEqual(reply.status, 400)
        self.assertEqual(reply.error_code(), "VALIDATION")

    def test_image_aspect_must_be_listed(self):
        body = {"clientOperationId": "ui-img-1", "kind": "image", "input": {"prompt": "絵", "aspect": "2:1"}}
        self.assertEqual(self.post_job(body).status, 400)

    def test_kind_must_be_a_file_kind(self):
        body = {"clientOperationId": "ui-kind-1", "kind": "remind", "input": {}}
        self.assertEqual(self.post_job(body).status, 400)

    def test_feature_turned_off_by_bot_is_400_not_503(self):
        self.store.set_meta("capabilities", json.dumps(caps(features={"ask": False})))
        reply = self.post_job(self.ask_body())
        self.assertEqual(reply.status, 400)  # 503 は Pi の接続失敗に使うので、設定による拒否は 400
        self.assertEqual(reply.error_code(), "FEATURE_UNAVAILABLE")
        self.assertEqual(self.store.count_active(uid(EDITOR)), 0)

    def test_post_returns_202_with_queued_job(self):
        reply = self.post_job(self.ask_body())
        self.assertEqual(reply.status, 202)
        job = reply.json()["job"]
        self.assertEqual((job["kind"], job["state"], job["op"]), ("ask", "queued", None))
        self.assertEqual(job["actor"], {"id": uid(EDITOR), "name": "委員A"})
        self.assertIsNone(job["result"])
        self.assertIsNone(job["error"])


class QuotaAndIdempotencyTests(Harness):
    def setUp(self):
        super().setUp()
        self.make_gateway(capabilities=caps())
        self.start(self.gateway)

    def test_fourth_active_ask_is_429_and_other_actor_is_unaffected(self):
        for _ in range(3):
            self.assertEqual(self.request("POST", self.jobs_path("jobs"), body=self.ask_body()).status, 202)
        reply = self.request("POST", self.jobs_path("jobs"), body=self.ask_body())
        self.assertEqual(reply.status, 429)
        self.assertEqual(reply.error_code(), "TOO_MANY_JOBS")
        self.assertEqual(reply.json()["error"]["message"],
                         "同時に依頼できる件数の上限です。完了を待ってから、もう一度依頼してください。")
        other = self.request("POST", self.jobs_path("jobs"), actor=OTHER, body=self.ask_body())
        self.assertEqual(other.status, 202)

    def test_quota_uses_bot_value_when_given(self):
        self.store.set_meta("capabilities", json.dumps(caps(maxActivePerUser=1)))
        self.assertEqual(self.request("POST", self.jobs_path("jobs"), body=self.ask_body()).status, 202)
        self.assertEqual(self.request("POST", self.jobs_path("jobs"), body=self.ask_body()).status, 429)

    def test_same_client_operation_id_returns_same_job(self):
        body = self.ask_body()
        first = self.request("POST", self.jobs_path("jobs"), body=body).json()["job"]["id"]
        replay = self.request("POST", self.jobs_path("jobs"), body=body)
        self.assertEqual(replay.status, 202)
        self.assertEqual(replay.json()["job"]["id"], first)

    def test_same_client_operation_id_with_other_content_is_409(self):
        body = self.ask_body(question="一つ目の質問です")
        self.request("POST", self.jobs_path("jobs"), body=body)
        changed = dict(body, input={"question": "別の質問です"})
        reply = self.request("POST", self.jobs_path("jobs"), body=changed)
        self.assertEqual(reply.status, 409)
        self.assertEqual(reply.error_code(), "CONFLICT")


class JobReadTests(Harness):
    def setUp(self):
        super().setUp()
        self.make_gateway(capabilities=caps())
        self.start(self.gateway)

    def test_ask_is_visible_to_members_but_remind_only_to_actor(self):
        ask = self.enqueue("ask", EDITOR)
        remind = self.enqueue("remind", EDITOR, op="create",
                              data={"text": "報告", "due": "7/20", "targetId": None, "repeat": "none", "channelId": None})
        self.assertEqual(self.request("GET", self.jobs_path("jobs", ask.id), actor=OTHER).status, 200)
        self.assertEqual(self.request("GET", self.jobs_path("jobs", remind.id), actor=OTHER).status, 404)
        self.assertEqual(self.request("GET", self.jobs_path("jobs", remind.id), actor=EDITOR).status, 200)

    def test_missing_or_malformed_job_id_is_404(self):
        self.assertEqual(self.request("GET", self.jobs_path("jobs", "j_" + "a" * 20)).status, 404)
        self.assertEqual(self.request("GET", self.jobs_path("jobs", "../../secret")).status, 404)
        self.assertEqual(self.request("GET", self.jobs_path("jobs", "J_" + "A" * 20)).status, 404)

    def test_list_filters_paging_and_validation(self):
        self.enqueue("ask", EDITOR)
        self.enqueue("ask", EDITOR)
        self.enqueue("ask", EDITOR)
        self.enqueue("ask", OTHER)
        self.enqueue("remind", EDITOR, op="create", data={"text": "x", "due": "7/1", "targetId": None,
                                                          "repeat": "none", "channelId": None})
        everyone = self.request("GET", self.jobs_path("jobs"), actor=EDITOR).json()["jobs"]
        self.assertEqual(len(everyone), 4)  # mine 省略は全員の ask/doc/image
        self.assertTrue(all(job["kind"] == "ask" for job in everyone))
        mine = self.request("GET", self.jobs_path("jobs") + "?mine=1&kind=ask", actor=EDITOR).json()["jobs"]
        self.assertEqual(len(mine), 3)
        mine_all = self.request("GET", self.jobs_path("jobs") + "?mine=1", actor=EDITOR).json()["jobs"]
        self.assertEqual(sorted(job["kind"] for job in mine_all), ["ask", "ask", "ask", "remind"])
        self.assertEqual(self.request("GET", self.jobs_path("jobs") + "?kind=remind", actor=OTHER).json()["jobs"], [])
        self.assertEqual(len(self.request("GET", self.jobs_path("jobs") + "?kind=remind", actor=EDITOR).json()["jobs"]), 1)
        page = self.request("GET", self.jobs_path("jobs") + "?kind=ask&limit=2", actor=EDITOR).json()
        self.assertEqual(len(page["jobs"]), 2)
        self.assertIsNotNone(page["next"])
        rest = self.request("GET", self.jobs_path("jobs") + f"?kind=ask&limit=2&before={page['next']}",
                            actor=EDITOR).json()
        self.assertEqual(len(rest["jobs"]), 2)
        self.assertIsNone(rest["next"])
        self.assertEqual(len({job["id"] for job in page["jobs"] + rest["jobs"]}), 4)
        for query in ("?kind=bogus", "?limit=0", "?limit=51", "?limit=x", "?limit=%2B5", "?mine=2",
                      "?before=j_bad", "?unknown=1", "?kind=ask&kind=doc", "?before=j_" + "b" * 20):
            with self.subTest(query=query):
                self.assertEqual(self.request("GET", self.jobs_path("jobs") + query).status, 400)

    def test_cancel_own_queued_job(self):
        job = self.enqueue("ask", EDITOR)
        reply = self.request("POST", self.jobs_path("jobs", job.id, "cancel"), body={"clientOperationId": "ui-c1"})
        self.assertEqual(reply.status, 200)
        self.assertEqual(reply.json()["job"]["state"], "canceled")
        again = self.request("POST", self.jobs_path("jobs", job.id, "cancel"), body={"clientOperationId": "ui-c2"})
        self.assertEqual(again.status, 200)
        self.assertEqual(again.json()["job"]["state"], "canceled")

    def test_cancel_other_members_job_is_404_and_leaves_it_queued(self):
        job = self.enqueue("ask", EDITOR)
        reply = self.request("POST", self.jobs_path("jobs", job.id, "cancel"), actor=OTHER,
                             body={"clientOperationId": "ui-c3"})
        self.assertEqual(reply.status, 404)
        self.assertEqual(self.store.get(job.id).state, "queued")

    def test_cancel_running_job_is_409(self):
        job = self.enqueue("ask", EDITOR)
        self.store.claim_next(["ask"])
        reply = self.request("POST", self.jobs_path("jobs", job.id, "cancel"), body={"clientOperationId": "ui-c4"})
        self.assertEqual(reply.status, 409)
        self.assertEqual(reply.error_code(), "CONFLICT")

    def test_cancel_requires_client_operation_id(self):
        job = self.enqueue("ask", EDITOR)
        reply = self.request("POST", self.jobs_path("jobs", job.id, "cancel"), body={})
        self.assertEqual(reply.status, 400)

    def test_similar_returns_finished_asks_above_threshold(self):
        done = self.enqueue("ask", EDITOR, data={"question": "会場の予約方法を教えて", "model": "auto",
                                                 "effort": "auto", "tone": None, "format": None})
        self.finish_job(done.id, "ask", {"text": "回答", "files": []})
        self.enqueue("ask", EDITOR, data={"question": "明日の天気は何ですか", "model": "auto",
                                          "effort": "auto", "tone": None, "format": None})
        reply = self.request("GET", self.jobs_path("similar") + "?q=" + urllib.parse.quote("会場の予約方法は？"))
        self.assertEqual(reply.status, 200)
        found = reply.json()["jobs"]
        self.assertEqual([item["job"]["id"] for item in found], [done.id])
        self.assertGreaterEqual(found[0]["score"], 0.35)
        self.assertEqual(self.request("GET", self.jobs_path("similar") + "?q=%20").status, 400)
        self.assertEqual(self.request("GET", self.jobs_path("similar")).status, 400)


class RemindWriteTests(Harness):
    def setUp(self):
        super().setUp()
        self.make_gateway(capabilities=caps(), wait_sec=0.3)
        self.start(self.gateway)

    def reminder_body(self, **extra):
        body = {"clientOperationId": "ui-r-" + secrets.token_hex(4), "text": "会計中間報告", "due": "2026-10-20 18:00"}
        body.update(extra)
        return body

    def post(self, path, body, actor=EDITOR):
        return self.request("POST", self.jobs_path(*path), actor=actor, body=body)

    def test_unreadable_due_is_400(self):
        reply = self.post(("reminders",), self.reminder_body(due="来世"))
        self.assertEqual(reply.status, 400)
        self.assertEqual(reply.error_code(), "VALIDATION")

    def test_channel_not_in_bot_list_is_400(self):
        reply = self.post(("reminders",), self.reminder_body(channelId="1000000000000000099"))
        self.assertEqual(reply.status, 400)

    def test_target_must_be_a_committee_member(self):
        reply = self.post(("reminders",), self.reminder_body(targetId=uid(OUTSIDER)))
        self.assertEqual(reply.status, 400)
        self.assertEqual(reply.json()["error"]["message"], "対象は委員から選んでください")

    def test_target_member_and_channel_are_accepted(self):
        reply = self.post(("reminders",), self.reminder_body(targetId=uid(OTHER), channelId=CHANNEL_A))
        self.assertEqual(reply.status, 202)
        job = reply.json()["job"]
        self.assertEqual((job["kind"], job["op"]), ("remind", "create"))
        self.assertEqual(job["input"]["targetId"], OTHER)
        self.assertEqual(job["input"]["channelId"], CHANNEL_A)

    def test_returns_202_quickly_when_no_bot_finishes(self):
        started = time.monotonic()
        reply = self.post(("reminders",), self.reminder_body())
        elapsed = time.monotonic() - started
        self.assertEqual(reply.status, 202)
        self.assertEqual(reply.json()["job"]["state"], "queued")
        self.assertLess(elapsed, 3.0)

    def test_returns_200_when_bot_finishes_during_the_wait(self):
        self.gateway.wait_sec = 2.0  # 負荷の高い環境でも、依頼が入ってから終えるまでの余裕を取る

        def bot():
            # 依頼が入るまで待ってから終える(固定の待ち時間だと、受付が遅いときに依頼を取り逃がす)
            deadline = time.monotonic() + 5
            claimed = None
            while claimed is None and time.monotonic() < deadline:
                claimed = self.store.claim_next(["remind"])
                if claimed is None:
                    time.sleep(0.01)
            if claimed is not None:
                self.store.finish(claimed.id, {"text": "登録しました", "files": [], "message": "登録しました。"})

        worker = threading.Thread(target=bot)
        worker.start()
        self.addCleanup(worker.join, 10)
        reply = self.post(("reminders",), self.reminder_body())
        self.assertEqual(reply.status, 200)
        job = reply.json()["job"]
        self.assertEqual(job["state"], "done")
        self.assertEqual(job["result"]["message"], "登録しました。")

    def test_no_wait_when_all_wait_slots_are_taken(self):
        self.make_gateway(capabilities=caps(), wait_sec=5, waits=threading.BoundedSemaphore(4))
        self.start(self.gateway)
        for _ in range(4):
            self.assertTrue(self.gateway.waits.acquire(blocking=False))
        started = time.monotonic()
        reply = self.post(("reminders",), self.reminder_body())
        self.assertEqual(reply.status, 202)
        self.assertLess(time.monotonic() - started, 2.0)

    def test_done_and_delete_enqueue_with_reminder_id(self):
        done = self.post(("reminders", "42", "done"), {"clientOperationId": "ui-d1"})
        delete = self.post(("reminders", "42", "delete"), {"clientOperationId": "ui-d2"})
        self.assertEqual((done.status, delete.status), (202, 202))
        self.assertEqual(done.json()["job"]["input"], {"reminderId": 42})
        self.assertEqual(delete.json()["job"]["op"], "delete")

    def test_reminder_path_id_must_be_digits(self):
        for number in ("abc", "0", "4294967296", "-1"):
            with self.subTest(number=number):
                reply = self.post(("reminders", number, "done"), {"clientOperationId": "ui-d3"})
                self.assertEqual(reply.status, 400)

    def test_action_needs_client_operation_id(self):
        self.assertEqual(self.post(("reminders", "42", "done"), {}).status, 400)


class SnapshotTests(Harness):
    def setUp(self):
        super().setUp()
        self.make_gateway(capabilities=caps(), clock=lambda: FIXED_NOW)
        self.start(self.gateway)

    def write_snapshot(self, reminders):
        self.store.write_snapshot({
            "takenAt": FIXED_NOW.isoformat(timespec="seconds"),
            "reminders": reminders,
        })

    def reminder(self, number, creator, target, due):
        return {"id": number, "text": f"件名{number}", "due": due.isoformat(timespec="seconds"), "repeat": "none",
                "creator": {"id": uid(creator), "name": "登録者"}, "target": {"id": uid(target), "name": "対象"},
                "channel": {"id": CHANNEL_A, "name": "総務連絡"}}

    def test_mine_and_all_with_permissions(self):
        self.write_snapshot([
            self.reminder(1, EDITOR, OTHER, FIXED_NOW + timedelta(days=1)),
            self.reminder(2, OTHER, OTHER, FIXED_NOW - timedelta(days=1)),
        ])
        mine = self.request("GET", self.jobs_path("reminders") + "?scope=mine", actor=EDITOR).json()
        self.assertEqual([r["id"] for r in mine["reminders"]], [1])
        self.assertEqual((mine["reminders"][0]["canComplete"], mine["reminders"][0]["canDelete"]), (True, True))
        self.assertIsNotNone(mine["snapshotAt"])
        everyone = self.request("GET", self.jobs_path("reminders") + "?scope=all", actor=EDITOR).json()
        self.assertEqual([r["id"] for r in everyone["reminders"]], [2, 1])
        self.assertEqual((everyone["reminders"][0]["canComplete"], everyone["reminders"][0]["canDelete"]), (False, False))
        target_view = self.request("GET", self.jobs_path("reminders") + "?scope=all", actor=OTHER).json()
        flags = {r["id"]: (r["canComplete"], r["canDelete"]) for r in target_view["reminders"]}
        self.assertEqual(flags, {1: (True, False), 2: (True, True)})
        officer = self.request("GET", self.jobs_path("reminders") + "?scope=all", actor=OFFICER).json()
        self.assertTrue(all(r["canComplete"] and r["canDelete"] for r in officer["reminders"]))

    def test_default_scope_is_mine_and_bad_scope_is_400(self):
        self.write_snapshot([self.reminder(1, EDITOR, OTHER, FIXED_NOW + timedelta(days=1)),
                             self.reminder(2, OTHER, OTHER, FIXED_NOW + timedelta(days=2))])
        self.assertEqual([r["id"] for r in self.request("GET", self.jobs_path("reminders")).json()["reminders"]], [1])
        self.assertEqual(self.request("GET", self.jobs_path("reminders") + "?scope=none").status, 400)

    def test_no_snapshot_is_empty_with_null_time(self):
        body = self.request("GET", self.jobs_path("reminders") + "?scope=all").json()
        self.assertEqual(body, {"reminders": [], "snapshotAt": None})

    def test_broken_snapshot_is_503_not_zero(self):
        self.store.write_snapshot({"reminders": "not a list"})
        reply = self.request("GET", self.jobs_path("reminders") + "?scope=all")
        self.assertEqual(reply.status, 503)
        self.assertEqual(self.request("GET", self.jobs_path("summary")).status, 503)
        meta = self.request("GET", self.jobs_path("meta"))
        self.assertEqual((meta.status, meta.json()["isAdmin"]), (200, False))

    def test_summary_requires_snapshot_and_counts_only_mine(self):
        self.make_ledger()
        self.assertEqual(self.request("GET", self.jobs_path("summary")).status, 503)
        self.write_snapshot([
            self.reminder(1, EDITOR, OTHER, FIXED_NOW - timedelta(days=1)),        # 超過
            self.reminder(2, OTHER, EDITOR, FIXED_NOW + timedelta(hours=2)),       # 今日(対象が自分)
            self.reminder(3, EDITOR, EDITOR, FIXED_NOW + timedelta(days=3)),       # 7日以内
            self.reminder(4, EDITOR, EDITOR, FIXED_NOW + timedelta(days=10)),      # 7日より先: 数えない
            self.reminder(5, OTHER, OTHER, FIXED_NOW - timedelta(days=2)),         # 他人の超過: 数えない
        ])
        body = self.request("GET", self.jobs_path("summary")).json()
        self.assertEqual(body, {"pendingCandidates": 0, "reminders": {"overdue": 1, "today": 1, "upcoming7d": 1}})

    def test_summary_counts_open_candidates(self):
        ledger = self.make_ledger()
        self.write_snapshot([])
        run = ledger.start_run()
        cid = ledger.add(run, candidate_row("fp-open", "auto", "開く候補"))
        ledger.claim_new(10)
        ledger.transition(cid, "publishing", "created", message_id=MESSAGE_A)
        body = self.request("GET", self.jobs_path("summary")).json()
        self.assertEqual(body["pendingCandidates"], 1)


def candidate_row(fingerprint: str, decision: str, title: str) -> dict:
    """ScreeningStore.add に渡す行の形(reference-tests の row() と同じ列。コピーした形だけ使う)。"""
    return {
        "fingerprint": fingerprint, "route_key": "naimu", "route_label": "内務部", "channel_id": CHANNEL_CAND,
        "title": title, "description": "説明", "purpose": "目的", "deliverable": "", "completion_criteria": "連絡済み",
        "open_questions": "", "assignee_name": None, "assignee_id": None, "deadline": "2026-10-15",
        "confidence": "high", "decision": decision, "decision_note": "テスト", "reason": "理由",
        "sources": '[{"kind": "discord", "source": "#企画課", "ts": "2026-10-13T11:30:00+00:00", '
                   '"author": "柏葉", "link": "https://discord.com/channels/1/2/3"}]',
    }


class MembersTests(Harness):
    def setUp(self):
        super().setUp()
        self.make_gateway(capabilities=caps())
        self.start(self.gateway)

    def test_lists_committee_members_only(self):
        members = self.request("GET", self.jobs_path("members")).json()["members"]
        ids = [m["id"] for m in members]
        self.assertEqual(ids, [uid(EDITOR), uid(OTHER), uid(OFFICER), uid(PENDING)])
        self.assertEqual(members[0]["name"], "委員A")


class CandidateTests(Harness):
    def setUp(self):
        super().setUp()
        self.make_gateway(capabilities=caps())
        self.start(self.gateway)
        ledger = self.make_ledger()
        run = ledger.start_run()
        self.ids = {}
        specs = [
            ("posted", "fp-a", "auto", "posted", MESSAGE_A),       # 承認待ち
            ("auto", "fp-b", "auto", "created", MESSAGE_B),        # 自動起票(差し戻し可)
            ("review-created", "fp-c", "review", "created", 1000000000000002003),
            ("posted-no-message", "fp-d", "auto", "posted", None),
            ("rejected", "fp-e", "review", "rejected", None),
        ]
        for key, fingerprint, decision, state, message in specs:
            cid = ledger.add(run, candidate_row(fingerprint, decision, f"候補{key}"))
            self.ids[key] = cid
        ledger.claim_new(20)
        for key, fingerprint, decision, state, message in specs:
            cid = self.ids[key]
            if state == "posted":
                ledger.transition(cid, "publishing", "posted", message_id=message)
            elif state == "created":
                ledger.transition(cid, "publishing", "created", message_id=message)
            else:
                ledger.transition(cid, "publishing", "rejected")

    def candidates(self, state=None):
        query = "" if state is None else f"?state={state}"
        reply = self.request("GET", self.jobs_path("candidates") + query)
        self.assertEqual(reply.status, 200)
        return {item["id"]: item for item in reply.json()["candidates"]}

    def test_open_lists_posted_and_auto_created_with_actions(self):
        open_items = self.candidates("open")
        self.assertEqual(set(open_items), {self.ids["posted"], self.ids["auto"]})
        posted = open_items[self.ids["posted"]]
        self.assertEqual(posted["actions"], ["ok", "ng", "return"])
        self.assertEqual(posted["state"], "posted")
        self.assertEqual(posted["discordUrl"], f"https://discord.com/channels/{GUILD}/{CHANNEL_CAND}/{MESSAGE_A}")
        self.assertEqual(posted["departments"], ["naimu"])
        self.assertEqual(posted["sources"], [{"label": "#企画課", "excerpt": "2026-10-13T11:30:00+00:00 柏葉"}])
        self.assertEqual(open_items[self.ids["auto"]]["actions"], ["undo", "return"])
        self.assertEqual(open_items[self.ids["auto"]]["decision"], "auto")

    def test_default_state_is_open(self):
        self.assertEqual(set(self.candidates()), {self.ids["posted"], self.ids["auto"]})

    def test_recent_lists_every_state_with_actions_only_when_actionable(self):
        recent = self.candidates("recent")
        self.assertEqual(set(recent), set(self.ids.values()))
        self.assertEqual(recent[self.ids["review-created"]]["actions"], [])
        self.assertEqual(recent[self.ids["posted-no-message"]]["actions"], [])
        self.assertIsNone(recent[self.ids["posted-no-message"]]["discordUrl"])
        self.assertEqual(recent[self.ids["rejected"]]["actions"], [])

    def test_unknown_state_is_400(self):
        self.assertEqual(self.request("GET", self.jobs_path("candidates") + "?state=all").status, 400)

    def test_ledger_is_opened_read_only(self):
        opened = []
        real_connect = sqlite3.connect

        def recording_connect(*args, **kwargs):
            opened.append((args[0], kwargs.get("uri")))
            return real_connect(*args, **kwargs)

        with mock.patch.object(ag.sqlite3, "connect", side_effect=recording_connect):
            self.candidates("open")
        self.assertEqual(len(opened), 1)
        uri, uses_uri = opened[0]
        self.assertTrue(uses_uri)
        self.assertTrue(uri.endswith("?mode=ro"), uri)
        connection = self.gateway._ledger()
        try:
            with self.assertRaises(sqlite3.OperationalError):
                connection.execute("UPDATE candidates SET title = 'x'")
        finally:
            connection.close()

    def test_missing_ledger_is_503_not_zero(self):
        shutil.rmtree(self.ledger.parent)
        reply = self.request("GET", self.jobs_path("candidates"))
        self.assertEqual(reply.status, 503)
        self.assertEqual(reply.error_code(), "LOAD_FAILED")

    def test_candidate_action_enqueues_screening_job(self):
        reply = self.request("POST", self.jobs_path("candidates", str(self.ids["posted"]), "ok"),
                             body={"clientOperationId": "ui-ok-1"})
        self.assertEqual(reply.status, 202)
        job = reply.json()["job"]
        self.assertEqual((job["kind"], job["op"]), ("screening", "ok"))
        self.assertEqual(job["input"], {"candidateId": self.ids["posted"], "comment": None})

    def test_return_requires_comment_and_unknown_action_is_400(self):
        path = self.jobs_path("candidates", str(self.ids["posted"]), "return")
        self.assertEqual(self.request("POST", path, body={"clientOperationId": "ui-ret-1"}).status, 400)
        reply = self.request("POST", path, body={"clientOperationId": "ui-ret-2", "comment": "日付を直してください"})
        self.assertEqual(reply.status, 202)
        self.assertEqual(reply.json()["job"]["input"]["comment"], "日付を直してください")
        self.assertEqual(self.request("POST", self.jobs_path("candidates", "5", "delete"),
                                      body={"clientOperationId": "ui-x-1"}).status, 400)

    def test_candidate_id_must_be_digits(self):
        path = self.jobs_path("candidates", "abc", "ok")
        self.assertEqual(self.request("POST", path, body={"clientOperationId": "ui-ok-2"}).status, 400)

    def test_candidate_action_does_not_check_existence(self):
        reply = self.request("POST", self.jobs_path("candidates", "999999", "ok"),
                             body={"clientOperationId": "ui-ok-3"})
        self.assertEqual(reply.status, 202)


class FileTests(Harness):
    PNG = b"\x89PNG\r\n\x1a\n" + b"synthetic image body"

    def setUp(self):
        super().setUp()
        self.make_gateway(capabilities=caps())
        self.start(self.gateway)
        self.job = self.enqueue("image", EDITOR, data={"prompt": "絵", "aspect": "1:1"})

    def get(self, *parts, actor=EDITOR, raw=None):
        path = raw if raw is not None else self.jobs_path("files", *parts)
        return self.request("GET", path, actor=actor)

    def test_registered_png_is_served_as_attachment(self):
        self.register_file(self.job.id, "a.png", self.PNG, "image/png")
        reply = self.get(self.job.id, "a.png")
        self.assertEqual(reply.status, 200)
        self.assertEqual(reply.headers["content-type"], "image/png")
        self.assertEqual(reply.headers["content-disposition"], "attachment; filename*=UTF-8''a.png")
        self.assertEqual(reply.headers["content-length"], str(len(self.PNG)))
        self.assertEqual(reply.headers["cache-control"], "no-store")
        self.assertEqual(reply.headers["x-content-type-options"], "nosniff")
        self.assertEqual(reply.body, self.PNG)

    def test_japanese_name_is_percent_encoded_in_disposition(self):
        name = "資料 最終.png"
        self.register_file(self.job.id, name, self.PNG, "image/png")
        reply = self.get(self.job.id, urllib.parse.quote(name, safe=""))
        self.assertEqual(reply.status, 200)
        disposition = reply.headers["content-disposition"]
        self.assertTrue(disposition.isascii())
        self.assertEqual(disposition, "attachment; filename*=UTF-8''" + urllib.parse.quote(name, safe=""))

    def test_unregistered_name_is_404(self):
        self.assertEqual(self.get(self.job.id, "missing.png").status, 404)

    def test_traversal_names_are_404(self):
        secret = self.dir / "secret.txt"
        secret.write_text("synthetic secret", encoding="utf-8")
        for raw_name in ("..%2F..%2Fsecret", "..%5C..%5Csecret", "%2Fetc%2Fpasswd", "a%0Ab.png"):
            with self.subTest(name=raw_name):
                self.assertEqual(self.get(self.job.id, raw_name).status, 404)

    def test_non_downloadable_mime_is_404(self):
        self.register_file(self.job.id, "a.exe", b"MZ synthetic", "application/x-msdownload")
        self.assertEqual(self.get(self.job.id, "a.exe").status, 404)

    def test_registered_size_over_limit_is_404(self):
        limit = self.ns.logic.MAX_DOWNLOAD_BYTES
        self.register_file(self.job.id, "big.png", self.PNG, "image/png", size=limit + 1)
        self.assertEqual(self.get(self.job.id, "big.png").status, 404)

    def test_actual_file_size_must_match_registration(self):
        self.register_file(self.job.id, "a.png", self.PNG, "image/png", size=10)
        self.assertEqual(self.get(self.job.id, "a.png").status, 404)

    def test_image_bytes_must_match_the_registered_type(self):
        self.register_file(self.job.id, "a.png", b"not an image at all", "image/png")
        self.assertEqual(self.get(self.job.id, "a.png").status, 404)

    def test_files_of_remind_jobs_are_not_served(self):
        remind = self.enqueue("remind", EDITOR, op="create",
                              data={"text": "x", "due": "7/1", "targetId": None, "repeat": "none", "channelId": None})
        self.register_file(remind.id, "a.png", self.PNG, "image/png")
        self.assertEqual(self.get(remind.id, "a.png").status, 404)

    def test_symlink_out_of_files_dir_is_404(self):
        secret = self.dir / "outside-secret.png"
        secret.write_bytes(self.PNG)
        link_folder = self.files / self.job.id
        link_folder.mkdir(parents=True, exist_ok=True)
        try:
            os.symlink(secret, link_folder / "leak.png")
        except (OSError, NotImplementedError):
            self.skipTest("symbolic links are not available here")
        self.store.add_file(self.job.id, "leak.png", "image/png", len(self.PNG),
                            hashlib.sha256(self.PNG).hexdigest(), f"{self.job.id}/leak.png")
        self.assertEqual(self.get(self.job.id, "leak.png").status, 404)

    def test_relpath_outside_files_dir_is_404(self):
        outside = self.dir / "outside.png"
        outside.write_bytes(self.PNG)
        self.store.add_file(self.job.id, "b.png", "image/png", len(self.PNG),
                            hashlib.sha256(self.PNG).hexdigest(), "../outside.png")
        self.assertEqual(self.get(self.job.id, "b.png").status, 404)

    def test_files_need_membership(self):
        self.register_file(self.job.id, "a.png", self.PNG, "image/png")
        self.assertEqual(self.get(self.job.id, "a.png", actor=OUTSIDER).status, 403)
        self.assertEqual(self.get(self.job.id, "a.png", actor=OTHER).status, 200)

    def test_finished_job_lists_download_urls_with_encoded_names(self):
        name = "資料 最終.png"
        self.register_file(self.job.id, name, self.PNG, "image/png")
        self.finish_job(self.job.id, "image", {"text": "できました", "files": [
            {"name": name, "mime": "image/png", "size": len(self.PNG)}]})
        job = self.request("GET", self.jobs_path("jobs", self.job.id), actor=OTHER).json()["job"]
        self.assertEqual(job["state"], "done")
        self.assertEqual(job["result"]["files"][0]["url"],
                         f"/assistant/files/{self.job.id}/" + urllib.parse.quote(name, safe=""))
        self.assertIsNone(job["progress"])
        self.assertEqual(self.get(self.job.id, urllib.parse.quote(name, safe="")).status, 200)


class ReminderSnapshotHelpers(unittest.TestCase):
    """_reminder_row など内部の純粋な部分の確認(Discord 不要)。"""

    def test_snapshot_user_ids_must_be_discord_form(self):
        self.assertEqual(ag._user_int("discord-" + EDITOR), int(EDITOR))
        for value in ("1000000000000000002", "discord-12", "discord-0123456789012345678", None):
            with self.subTest(value=value), self.assertRaises(ValueError):
                ag._user_int(value)


class LoadModuleTests(Harness):
    def test_assistant_modules_are_read_only_when_enabled(self):
        real = _plain_read
        seen = []

        def recording(path, limit, owner_only=True):
            seen.append((Path(path).name, owner_only))
            return real(path, limit, owner_only)

        with mock.patch.object(api, "protected_read", side_effect=recording):
            api.load_modules(MODULE_DIR, assistant=True)
        names = [name for name, _ in seen]
        for expected in ("assistant_store.py", "assistant_logic.py", "remind_logic.py", "screening_store.py"):
            self.assertIn(expected, names)
        self.assertTrue(all(owner_only is False for _, owner_only in seen))

    def test_task_only_load_skips_assistant_modules(self):
        seen = []

        def recording(path, limit, owner_only=True):
            seen.append(Path(path).name)
            return _plain_read(path, limit, owner_only)

        with mock.patch.object(api, "protected_read", side_effect=recording):
            loaded = api.load_modules(MODULE_DIR)
        # 既定の呼び方は従来と同じ 2 つの戻り値(Pi の既存の契約試験 test_gateway.py の呼び方)
        self.assertEqual(len(loaded), 2)
        domain, storage = loaded
        self.assertEqual(sorted(seen), ["task_domain.py", "task_store.py"])
        self.assertTrue(hasattr(domain, "DEPARTMENTS"))
        self.assertTrue(hasattr(storage, "TaskStore"))

    def test_assistant_modules_do_not_import_discord(self):
        for name in ("assistant_store.py", "assistant_logic.py", "remind_logic.py", "screening_store.py"):
            text = (MODULE_DIR / name).read_text(encoding="utf-8")
            self.assertIsNone(re.search(r"^\s*(import|from)\s+discord", text, re.M), name)
        gateway_text = (GATEWAY / "assistant_gateway.py").read_text(encoding="utf-8")
        self.assertIsNone(re.search(r"^\s*(import|from)\s+(discord|bot_task_gateway)", gateway_text, re.M))

    def test_assistant_settings(self):
        self.assertIsNone(api.assistant_settings({}))
        self.assertIsNone(api.assistant_settings({"assistant_enabled": False, "assistant_store_path": "relative"}))
        with self.assertRaises(ValueError):
            api.assistant_settings({"assistant_enabled": "yes"})
        with self.assertRaises(ValueError):
            api.assistant_settings({"assistant_enabled": True, "assistant_store_path": "jobs.sqlite3",
                                    "assistant_files_dir": str(self.dir), "screening_store_path": str(self.dir)})
        absolute = {"assistant_enabled": True, "assistant_store_path": str(self.dir / "jobs.sqlite3"),
                    "assistant_files_dir": str(self.dir / "files"),
                    "screening_store_path": str(self.dir / "candidates.sqlite3")}
        self.assertEqual(api.assistant_settings(absolute)["assistant_files_dir"], str(self.dir / "files"))


class GatewayConstructionTests(Harness):
    def test_rejects_relative_paths_and_bad_guild(self):
        store = self.make_store()
        with self.assertRaises(ValueError):
            ag.AssistantGateway(store, self.ns, "relative.sqlite3", self.files, GUILD)
        with self.assertRaises(ValueError):
            ag.AssistantGateway(store, self.ns, self.ledger, "relative", GUILD)
        with self.assertRaises(ValueError):
            ag.AssistantGateway(store, self.ns, self.ledger, self.files, "guild")


class UnknownRouteTests(Harness):
    def test_unknown_routes_and_wrong_methods_are_404(self):
        self.make_gateway(capabilities=caps())
        self.start(self.gateway)
        self.assertEqual(self.request("GET", self.jobs_path("nothing")).status, 404)
        self.assertEqual(self.request("POST", self.jobs_path("meta"), body={}).status, 404)
        self.assertEqual(self.request("GET", self.jobs_path("reminders", "1", "done")).status, 404)


class DiscordCallBudgetTests(Harness):
    """アプリは依頼の進み具合を 2〜3 秒ごとに取りに来る。そのたびに Discord を呼ぶと、10/13 の障害
    (タスク画面まで 503)と同じ形になる。委員確認は共有キャッシュ(委員 20 秒・サーバー 60 秒)から
    返り、保持時間の中では 1 人 1 回・サーバー 1 回しか Discord を呼ばないこと。"""

    def test_polling_by_several_members_reuses_the_cache(self):
        self.make_gateway(capabilities=caps())
        self.start(self.gateway)
        calls = []
        real_get = self.discord.get

        def counting(path, deadline, optional_member=False):
            calls.append(path)
            return real_get(path, deadline, optional_member)

        self.discord.get = counting
        job = self.request("POST", self.jobs_path("jobs"), body={
            "clientOperationId": "ui-poll-0001", "kind": "ask", "input": {"question": "発電機は?"}}).json()["job"]
        actors = (EDITOR, OTHER, OFFICER)
        for _ in range(15):   # 3 人 × 15 回 × 6 経路(取りに来る間隔の数分ぶんを、保持時間の中で詰めて)
            for actor in actors:
                for path in (self.jobs_path("jobs", job["id"]), self.jobs_path("jobs"), self.jobs_path("meta"),
                             self.jobs_path("summary"), self.jobs_path("reminders"),
                             self.jobs_path("similar") + "?q=" + urllib.parse.quote("発電機")):
                    reply = self.request("GET", path, actor=actor)
                    self.assertIn(reply.status, (200, 503), path)   # summary は写しが無いと 503(0 件と言わない)
        guild_calls = [p for p in calls if p == f"/guilds/{GUILD}"]
        member_calls = [p for p in calls if "/members/" in p]
        self.assertEqual(len(guild_calls), 1)
        self.assertEqual(sorted(member_calls), sorted({f"/guilds/{GUILD}/members/{a}" for a in actors}))
        self.assertLessEqual(len(calls), 1 + len(actors))


class IsolatedStartupTests(unittest.TestCase):
    """本番の task-web-api は `python3 -I`(隔離モード)で起動する。スクリプトのフォルダが import の
    検索先に入らなくても、同じリリースフォルダの assistant_gateway.py を読めること。"""

    def test_loads_the_gateway_module_by_path_under_isolated_mode(self):
        import subprocess
        script = (
            "import importlib.util, sys\n"
            f"spec = importlib.util.spec_from_file_location('btg', {str(GATEWAY / 'bot_task_gateway.py')!r})\n"
            "api = importlib.util.module_from_spec(spec); spec.loader.exec_module(api)\n"
            "api.protected_read = lambda path, limit, owner_only=True: open(path, 'rb').read()\n"
            f"cls = api.load_assistant_gateway(__import__('pathlib').Path({str(GATEWAY)!r}))\n"
            "assert cls.__name__ == 'AssistantGateway'\n"
            "assert 'assistant_gateway' in sys.modules\n"
            "print('ok')\n"
        )
        done = subprocess.run([sys.executable, "-I", "-c", script], cwd=tempfile.gettempdir(),
                              capture_output=True, text=True, timeout=60)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(done.stdout.strip(), "ok")


class ManageGuildTests(unittest.TestCase):
    """リマインドの「役員」は Discord の /remind と同じ manage_guild(所有者・管理者・サーバー管理)。
    委員長などの役職名だけ(権限なし)では役員にしない。読めなければ役員にしない。"""

    def context(self, roles, *, actor=OFFICER, owner=OWNER, member_roles=(ROLE_OFFICER,), fail=False):
        class Ctx:
            guild_id = GUILD
            actor_id = uid(actor)

            def load_guild(self, _gid):
                if fail:
                    raise RuntimeError("discord down")
                return {"id": GUILD, "owner_id": owner, "roles": roles}

            def member(self, _gid, mid):
                return {"user": {"id": mid}, "roles": list(member_roles)}

        return Ctx()

    def check(self, ctx) -> bool:
        return ag.AssistantGateway._manages_guild(object.__new__(ag.AssistantGateway), ctx)

    def test_role_name_alone_is_not_admin(self):
        roles = [{"id": GUILD, "permissions": "0"}, {"id": ROLE_OFFICER, "name": "委員長", "permissions": "0"}]
        self.assertFalse(self.check(self.context(roles)))

    def test_manage_guild_administrator_and_owner_are_admin(self):
        for perms in ("32", "8"):
            roles = [{"id": GUILD, "permissions": "0"}, {"id": ROLE_OFFICER, "permissions": perms}]
            self.assertTrue(self.check(self.context(roles)), perms)
        roles = [{"id": GUILD, "permissions": "0"}]
        self.assertTrue(self.check(self.context(roles, owner=OFFICER, member_roles=())))

    def test_unreadable_is_not_admin(self):
        self.assertFalse(self.check(self.context([], fail=True)))


if __name__ == "__main__":
    unittest.main()
