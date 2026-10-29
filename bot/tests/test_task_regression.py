"""既存のタスク経路が連携口の追加で変わらないことの確認(2026-10-14)。

実際の ThreadingHTTPServer(127.0.0.1)と ApiHandler に、一時フォルダの本物の TaskStore をつないで、
既存の経路(health・集計・タスク一覧・作成・更新・取得・エラーの形)を署名付きで呼ぶ。
連携口が無効のときと有効のとき(別の要求だけ)の両方で、状態と応答の形を確かめる。
合成データだけ。ネットワークには出ない。
"""

from __future__ import annotations

import hashlib
import hmac
import http.client
import importlib.util
import json
import secrets
import shutil
import sys
import tempfile
import threading
import time
import types
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parents[1]
GATEWAY = REPO / "gateway"
MODULE_DIR = (REPO / "src" / "iyakusai_bot").resolve()
if str(GATEWAY) not in sys.path:
    sys.path.insert(0, str(GATEWAY))


def _load_task_gateway():
    spec = importlib.util.spec_from_file_location("bot_task_gateway_regression_tests", GATEWAY / "bot_task_gateway.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


api = _load_task_gateway()

GUILD = "1000000000000000001"
BOT = "1000000000000000099"
OWNER = "1000000000000000090"
ROLE_EDITOR = "1000000000000000100"
EDITOR = "1000000000000000002"
KEY = b"synthetic-service-key-0123456789abcdef-0123"
ROLES = [
    {"id": GUILD, "name": "@everyone", "permissions": "0"},
    {"id": ROLE_EDITOR, "name": "委員", "permissions": "0"},
]


class FakeDiscord:
    """合成の委員 1 人だけがいる Discord の代わり。"""

    def get(self, path, deadline, optional_member=False):
        if path == f"/guilds/{GUILD}":
            return {"id": GUILD, "owner_id": OWNER, "roles": ROLES}
        if path == f"/guilds/{GUILD}/members?limit=1000":
            return [self._member()]
        if path == f"/guilds/{GUILD}/members/{EDITOR}":
            return self._member()
        if optional_member:
            return None
        raise api.ApiError(503, "LOAD_FAILED")

    @staticmethod
    def _member():
        return {"user": {"id": EDITOR, "username": "synthetic", "global_name": "委員A"},
                "roles": [ROLE_EDITOR]}


class RegressionTests(unittest.TestCase):
    def setUp(self):
        self._saved_modules = {k: v for k, v in sys.modules.items() if k.startswith("iyakusai_bot")}
        for key in list(self._saved_modules):
            del sys.modules[key]
        self.addCleanup(self._restore_modules)
        self.dir = Path(tempfile.mkdtemp(prefix="task-regression-"))
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)
        with mock.patch.object(api, "protected_read", self._plain_read):
            self.domain, self.storage = api.load_modules(MODULE_DIR)
        self.task_store = self.storage.TaskStore.open(self.dir / "tasks")
        self.gateway = api.SqliteGateway(self.domain, self.task_store)

    @staticmethod
    def _plain_read(path, limit, owner_only=True):
        """Windows には os.getuid が無いので所有者の検査だけ省く。サイズと通常ファイルの検査は残す。"""
        path = Path(path)
        if not path.is_file() or path.stat().st_size > limit:
            raise ValueError("unsafe file")
        return path.read_bytes()

    def _restore_modules(self):
        for key in [k for k in sys.modules if k.startswith("iyakusai_bot")]:
            del sys.modules[key]
        sys.modules.update(self._saved_modules)

    def start(self, assistant=None):
        server = ThreadingHTTPServer(("127.0.0.1", 0), api.ApiHandler)
        server.daemon_threads = True
        self.port = server.server_address[1]
        server.allowed_host = f"127.0.0.1:{self.port}"
        server.auth = api.ServiceAuth(KEY)
        server.discord = FakeDiscord()
        server.settings = types.SimpleNamespace(guild_ids={int(GUILD)})
        server.bot_id = BOT
        server.domain = self.domain
        server.gateway = self.gateway
        server.assistant = assistant
        server.discord_cache = api.SharedDiscordCache()
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        thread.start()

        def stop():
            server.shutdown()
            server.server_close()
            thread.join(5)

        self.addCleanup(stop)

    def call(self, method, path, body=None, *, sign=True, actor=EDITOR):
        data = None if body is None else json.dumps(body).encode("utf-8")
        payload = data or b""
        headers = {}
        if sign:
            stamp = str(int(time.time() * 1000))
            nonce = secrets.token_urlsafe(24)
            canonical = "\n".join(("svc-auth/v1", "web-gateway", method, path, stamp, nonce,
                                   "discord-" + actor, hashlib.sha256(payload).hexdigest()))
            headers = {
                "X-Svc-Client": "web-gateway", "X-Svc-Timestamp": stamp, "X-Svc-Nonce": nonce,
                "X-Svc-Actor": "discord-" + actor,
                "X-Svc-Signature": hmac.new(KEY, canonical.encode(), hashlib.sha256).hexdigest(),
            }
        if data is not None:
            headers["Content-Type"] = "application/json"
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        try:
            connection.request(method, path, body=data, headers=headers)
            response = connection.getresponse()
            raw = response.read()
            return response.status, json.loads(raw) if raw else None
        finally:
            connection.close()

    def test_health_is_unchanged(self):
        self.start(assistant=None)
        self.assertEqual(self.call("GET", "/api/health", sign=False), (200, {"ok": True}))

    def test_existing_task_routes_keep_status_and_shape(self):
        self.start(assistant=None)
        status, summary = self.call("GET", "/api/integration/v1/summary")
        self.assertEqual(status, 200)
        self.assertTrue({"total", "deadlines", "departments", "byDate", "today", "generatedAt"} <= set(summary))
        self.assertEqual(summary["total"], 0)

        status, listed = self.call("GET", "/api/integration/v1/workspaces/dept-naimu/tasks")
        self.assertEqual((status, listed), (200, []))

        status, created = self.call("POST", "/api/integration/v1/workspaces/dept-naimu/tasks",
                                    {"title": "合成のタスク", "description": "説明", "operationId": "op-create-1"})
        self.assertEqual(status, 201)
        self.assertEqual(set(created), {"task", "replayed"})
        task = created["task"]
        self.assertEqual(task["workspaceId"], "dept-naimu")
        self.assertEqual(task["status"], "todo")
        self.assertEqual(task["tags"], ["naimu"])
        self.assertFalse(created["replayed"])
        task_id = task["id"]
        self.assertRegex(task_id, r"^task-[1-9][0-9]*$")

        status, fetched = self.call("GET", f"/api/integration/v1/tasks/{task_id}")
        self.assertEqual((status, fetched["id"]), (200, task_id))  # 取得は task をそのまま返す(包まない)

        status, updated = self.call("PATCH", f"/api/integration/v1/tasks/{task_id}",
                                    {"changes": {"status": "in_progress"}, "expectedVersion": task["version"],
                                     "operationId": "op-update-1"})
        self.assertEqual(status, 200)
        self.assertEqual(updated["task"]["status"], "in_progress")

        status, listed = self.call("GET", "/api/integration/v1/workspaces/dept-naimu/tasks?status=in_progress")
        self.assertEqual(status, 200)
        self.assertEqual([t["id"] for t in listed], [task_id])

    def test_task_errors_keep_the_standard_body(self):
        self.start(assistant=None)
        status, body = self.call("GET", "/api/integration/v1/tasks/task-999999")
        self.assertEqual(status, 404)
        self.assertEqual(body["error"]["code"], "NOT_FOUND")
        status, body = self.call("GET", "/api/integration/v1/workspaces/dept-naimu/tasks", sign=False)
        self.assertEqual((status, body["error"]["code"]), (401, "UNAUTHENTICATED"))
        status, body = self.call("GET", "/api/integration/v1/nothing-here")
        self.assertEqual((status, body["error"]["code"]), (404, "NOT_FOUND"))

    def test_disabled_assistant_path_is_404_and_tasks_still_work(self):
        self.start(assistant=None)
        status, body = self.call("GET", "/api/integration/v1/assistant/meta")
        self.assertEqual(status, 404)
        self.assertEqual(body["error"]["code"], "NOT_FOUND")
        status, _ = self.call("POST", "/api/integration/v1/assistant/jobs", {"clientOperationId": "ui-x-1"})
        self.assertEqual(status, 404)
        status, summary = self.call("GET", "/api/integration/v1/summary")
        self.assertEqual(status, 200)

    def test_enabled_assistant_does_not_change_task_routes(self):
        assistant = types.SimpleNamespace(
            Error=RuntimeError,
            handle=mock.Mock(return_value=(200, {"features": {}})),
        )
        self.start(assistant=assistant)
        status, listed = self.call("GET", "/api/integration/v1/workspaces/dept-naimu/tasks")
        self.assertEqual((status, listed), (200, []))
        assistant.handle.assert_not_called()
        status, meta = self.call("GET", "/api/integration/v1/assistant/meta")
        self.assertEqual((status, meta), (200, {"features": {}}))
        assistant.handle.assert_called_once()


if __name__ == "__main__":
    unittest.main()
