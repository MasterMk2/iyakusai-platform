"""Contract and security tests; Bot storage tests use private temporary databases."""
import base64
import concurrent.futures
from email.message import Message
import hashlib
import hmac
import http.client
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import ssl
import subprocess
import tempfile
import threading
import time
import types
import unittest

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("bot_task_gateway", Path(__file__).with_name("bot_task_gateway.py"))
api = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = api
spec.loader.exec_module(api)

GUILD, CHANNEL, OTHER, ALICE, BOB, BOT = (str(1000000000000000000 + n) for n in range(1, 7))


def signed(key, path="/api/integration/v1/me", method="GET", body=b"", nonce=None,
           actor=None, timestamp=1800000000000, client="web-gateway"):
    nonce = nonce or base64.urlsafe_b64encode(os.urandom(18)).decode().rstrip("=")
    actor = actor or api.uid(ALICE)
    timestamp = str(timestamp)
    canonical = "\n".join(("svc-auth/v1", client, method, path, timestamp, nonce,
                          actor, hashlib.sha256(body).hexdigest()))
    headers = Message()
    for name, value in zip(("Client", "Timestamp", "Nonce", "Actor", "Signature"),
                           (client, timestamp, nonce, actor, hmac.new(key, canonical.encode(), hashlib.sha256).hexdigest())):
        headers["X-Svc-" + name] = value
    return headers


class SignatureTests(unittest.TestCase):
    def setUp(self):
        self.key = os.urandom(32)
        self.auth = api.ServiceAuth(self.key, clock=lambda: 1800000000)

    def denied(self, headers, path="/api/integration/v1/me", body=b""):
        with self.assertRaises(api.ApiError) as failure:
            self.auth.verify("GET", path, headers, body)
        self.assertEqual(failure.exception.status, 401)

    def test_signed_actor_is_preserved(self):
        self.assertEqual(self.auth.verify("GET", "/api/integration/v1/me", signed(self.key), b""), api.uid(ALICE))

    def test_nonce_replay_is_rejected(self):
        headers = signed(self.key)
        self.auth.verify("GET", "/api/integration/v1/me", headers, b"")
        self.denied(headers)

    def test_body_tampering_does_not_consume_nonce(self):
        headers = signed(self.key)
        self.denied(headers, body=b"changed")
        self.auth.verify("GET", "/api/integration/v1/me", headers, b"")

    def test_query_tampering_is_rejected(self):
        self.denied(signed(self.key), path="/api/integration/v1/me?actor=other")

    def test_actor_tampering_is_rejected(self):
        headers = signed(self.key)
        headers.replace_header("X-Svc-Actor", api.uid(BOB))
        self.denied(headers)

    def test_other_service_key_is_rejected(self):
        self.denied(signed(os.urandom(32)))

    def test_discord_bridge_cannot_use_web_routes(self):
        self.denied(signed(self.key, client="discord-bridge"))

    def test_timestamp_outside_window_is_rejected(self):
        self.denied(signed(self.key, timestamp=1800000030001))
        self.denied(signed(self.key, timestamp=1799999969999))

    def test_duplicate_auth_headers_are_rejected(self):
        headers = signed(self.key)
        headers["X-Svc-Actor"] = api.uid(BOB)
        self.denied(headers)

    def test_concurrent_nonce_has_only_one_winner(self):
        headers = signed(self.key)
        barrier = threading.Barrier(2)
        def attempt(_):
            barrier.wait()
            try:
                self.auth.verify("GET", "/api/integration/v1/me", headers, b"")
                return True
            except api.ApiError:
                return False
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            self.assertEqual(sum(pool.map(attempt, range(2))), 1)

    def test_replay_capacity_does_not_evict_valid_nonces(self):
        auth = api.ServiceAuth(self.key, clock=lambda: 1800000000, capacity=1)
        first = signed(self.key)
        auth.verify("GET", "/api/integration/v1/me", first, b"")
        for headers in (signed(self.key), first):
            with self.assertRaises(api.ApiError):
                auth.verify("GET", "/api/integration/v1/me", headers, b"")


class PermissionTests(unittest.TestCase):
    def setUp(self):
        self.guild = {"id": GUILD, "owner_id": OTHER,
                      "roles": [{"id": GUILD, "permissions": str(api.VIEW | api.SEND)},
                                {"id": CHANNEL, "permissions": "0"}]}
        self.channel = {"id": CHANNEL, "guild_id": GUILD, "type": 0, "name": "Synthetic channel",
                        "permission_overwrites": []}
        self.member = {"user": {"id": ALICE, "username": "Synthetic Alice"}, "roles": [CHANNEL]}
        self.bot = {"user": {"id": BOT, "username": "Synthetic Bot", "bot": True}, "roles": []}

    def test_view_and_send_grants_editor(self):
        self.assertEqual(api.role_for(self.guild, self.channel, self.member, self.bot), "editor")

    def test_channel_manager_is_admin(self):
        self.guild["roles"][1]["permissions"] = str(api.MANAGE_CHANNEL)
        self.assertEqual(api.role_for(self.guild, self.channel, self.member, self.bot), "admin")

    def test_member_overwrite_wins_over_role_allow(self):
        self.channel["permission_overwrites"] = [
            {"id": CHANNEL, "type": 0, "allow": str(api.VIEW), "deny": "0"},
            {"id": ALICE, "type": 1, "allow": "0", "deny": str(api.VIEW)},
        ]
        self.assertIsNone(api.role_for(self.guild, self.channel, self.member, self.bot))

    def test_role_allow_is_combined_after_role_denies(self):
        self.guild["roles"].append({"id": BOB, "permissions": "0"})
        self.member["roles"].append(BOB)
        self.channel["permission_overwrites"] = [
            {"id": CHANNEL, "type": 0, "allow": "0", "deny": str(api.VIEW)},
            {"id": BOB, "type": 0, "allow": str(api.VIEW), "deny": "0"},
        ]
        self.assertEqual(api.role_for(self.guild, self.channel, self.member, self.bot), "editor")

    def test_administrator_bypasses_channel_overwrites(self):
        self.guild["roles"][1]["permissions"] = str(api.ADMIN)
        self.channel["permission_overwrites"] = [{"id": ALICE, "type": 1, "allow": "0", "deny": str(api.VIEW | api.SEND)}]
        self.assertEqual(api.role_for(self.guild, self.channel, self.member, self.bot), "admin")

    def test_bot_without_send_cannot_enable_edits(self):
        self.channel["permission_overwrites"] = [{"id": BOT, "type": 1, "allow": "0", "deny": str(api.SEND)}]
        self.assertEqual(api.role_for(self.guild, self.channel, self.member, self.bot), "viewer")

    def test_pending_member_cannot_edit(self):
        self.member["pending"] = True
        self.assertEqual(api.role_for(self.guild, self.channel, self.member, self.bot), "viewer")

    def test_expired_permission_snapshot_does_not_grant_unknown_role(self):
        self.member["roles"].append(BOB)
        with self.assertRaises(api.ApiError):
            api.role_for(self.guild, self.channel, self.member, self.bot)


class FixtureContext:
    """2026-10-14: committee membership decides access; departments are tags, not channels."""

    def __init__(self, domain, role="editor", allowed=True):
        self.domain, self.access_role, self.allowed = domain, role, allowed
        self.actor_id = api.uid(ALICE)
        self.guild_id = GUILD
        self.others = set()  # ほかの委員(副担当の試験用)

    def role(self, department=None, member_id=None):
        if not self.allowed or str(member_id or ALICE) not in {ALICE, *self.others}:
            return None
        if department is not None and department not in self.domain.DEPARTMENTS:
            return None
        return self.access_role

    def authorize(self, department=None, level="viewer"):
        role = self.role(department)
        if role is None:
            raise api.ApiError(404, "NOT_FOUND")
        if level == "editor" and role == "viewer" or level == "admin" and role != "admin":
            raise api.ApiError(403, "FORBIDDEN")
        return role

    def scope(self, domain, department=None):
        return domain.Scope(int(GUILD), 0)

    def name(self, member_id):
        return "Synthetic Alice" if str(member_id) == ALICE else "Synthetic member"


class SqliteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        module_dir = os.environ.get("BOT_MODULE_DIR")
        source = Path(module_dir) if module_dir else None
        if source is None or not source.is_dir():
            raise unittest.SkipTest("requires Bot host's installed native storage modules")
        cls.domain, cls.storage = api.load_modules(source)

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="task-api-test-")
        self.addCleanup(self.tmp.cleanup)
        self.store = self.storage.TaskStore.open(Path(self.tmp.name))
        self.gateway = api.SqliteGateway(self.domain, self.store)
        self.context = FixtureContext(self.domain)
        self.scope = self.domain.Scope(int(GUILD), 0)
        self.collection = f"/api/integration/v1/workspaces/{api.department_workspace('naimu')}/tasks"

    def create(self, **fields):
        payload = {"title": "Synthetic shared task", "operationId": "shared-create-1", **fields}
        return self.gateway.dispatch("POST", self.collection, payload, self.context)[1]

    def path(self, created):
        return "/api/integration/v1/tasks/" + created["task"]["id"]

    def test_web_create_is_visible_to_bot_store(self):
        created = self.create()
        other = self.storage.TaskStore.open(Path(self.tmp.name))
        rows = other.list_tasks(self.scope)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].task.title, created["task"]["title"])

    def test_bot_update_is_immediately_visible_to_web(self):
        created = self.create()
        other = self.storage.TaskStore.open(Path(self.tmp.name))
        other.update(self.domain.Actor(int(ALICE), "bot-update-1", "discord"), self.scope, 1, 1,
                     {"title": "Synthetic Bot edit"})
        status, row = self.gateway.dispatch("GET", self.path(created), {}, self.context)
        self.assertEqual((status, row["title"], row["version"]), (200, "Synthetic Bot edit", 2))

    def test_web_replay_survives_gateway_recreation(self):
        first = self.create()
        self.gateway = api.SqliteGateway(self.domain, self.storage.TaskStore.open(Path(self.tmp.name)))
        replay = self.create()
        self.assertTrue(replay["replayed"])
        self.assertEqual(replay["task"]["id"], first["task"]["id"])
        self.assertEqual(len(self.store.list_tasks(self.scope)), 1)

    def test_operation_reuse_with_different_payload_is_rejected(self):
        self.create()
        with self.assertRaises(self.domain.TaskError) as failure:
            self.create(title="Different synthetic task")
        self.assertEqual(failure.exception.code, "IDEMPOTENCY_CONFLICT")

    def test_old_version_does_not_overwrite_bot_update(self):
        created = self.create()
        self.store.update(self.domain.Actor(int(ALICE), "bot-version-update", "discord"), self.scope, 1, 1, {"status": "in_progress"})
        with self.assertRaises(self.domain.TaskError) as failure:
            self.gateway.dispatch("PATCH", self.path(created), {"expectedVersion": 1, "changes": {"status": "blocked"}}, self.context)
        self.assertEqual(failure.exception.code, "VERSION_CONFLICT")
        self.assertEqual(self.store.get_task(self.scope, 1).task.status, "in_progress")

    def test_requirements_are_projected_and_written_without_copying_state(self):
        created = self.create(requirements={"purpose": "Synthetic purpose", "completionCriteria": "Synthetic criterion"})
        self.assertEqual(created["task"]["requirements"]["completionCriteria"], "Synthetic criterion")
        self.gateway.dispatch("PATCH", self.path(created), {"expectedVersion": 1, "changes": {"requirements": {"openQuestions": "Synthetic question"}}}, self.context)
        row = self.store.get_task(self.scope, 1).task
        self.assertEqual(row.requirements["open_questions"], "Synthetic question")
        self.assertEqual(row.requirements["purpose"], "Synthetic purpose")

    def test_assignee_must_be_visible_in_same_channel(self):
        with self.assertRaises(api.ApiError) as failure:
            self.create(assigneeId=api.uid(BOB))
        self.assertEqual(failure.exception.code, "VALIDATION")
        self.assertEqual(self.store.list_tasks(self.scope), [])

    def test_viewer_cannot_create(self):
        self.context.access_role = "viewer"
        with self.assertRaises(api.ApiError) as failure:
            self.create()
        self.assertEqual(failure.exception.status, 403)
        self.assertEqual(self.store.list_tasks(self.scope), [])

    def test_non_member_cannot_reveal_existing_task(self):
        created = self.create()
        self.context.allowed = False
        with self.assertRaises(api.ApiError) as failure:
            self.gateway.dispatch("GET", self.path(created), {}, self.context)
        self.assertEqual(failure.exception.status, 404)

    def test_department_lists_include_sections_and_multi_tagged_tasks(self):
        self.create(operationId="tag-create-1", title="Naimu only")
        self.create(operationId="tag-create-2", title="Kikaku and Koho", tags=["kikaku", "koho"])
        self.create(operationId="tag-create-3", title="Gaimu only", tags=["gaimu"])
        def titles(dept):
            path = f"/api/integration/v1/workspaces/{api.department_workspace(dept)}/tasks"
            return sorted(row["title"] for row in self.gateway.dispatch("GET", path, {}, self.context)[1])
        self.assertEqual(titles("naimu"), ["Kikaku and Koho", "Naimu only"])     # 部はその部の課も含む
        self.assertEqual(titles("kikaku"), ["Kikaku and Koho"])
        self.assertEqual(titles("gaimu"), ["Gaimu only", "Kikaku and Koho"])     # 広報課は外務部
        self.assertEqual(titles("yakuin"), [])
        with self.assertRaises(api.ApiError):
            self.gateway.dispatch("GET", "/api/integration/v1/workspaces/dept-nothing/tasks", {}, self.context)
        with self.assertRaises(api.ApiError):
            self.gateway.dispatch("GET", "/api/integration/v1/workspaces/channel-1000000000000000002/tasks", {}, self.context)

    def test_task_ids_are_global_numbers_and_tags_are_editable(self):
        first = self.create(operationId="global-1")
        second = self.create(operationId="global-2", tags=["soumu"])
        self.assertEqual((first["task"]["id"], second["task"]["id"]), ("task-1", "task-2"))
        self.assertEqual((second["task"]["workspaceId"], second["task"]["tags"], second["task"]["tagLabels"]),
                         ("dept-soumu", ["soumu"], ["総務部"]))
        status, result = self.gateway.dispatch("PATCH", self.path(second), {"expectedVersion": 1,
                                               "changes": {"tags": ["koho", "kaikei"]}}, self.context)
        self.assertEqual((status, result["task"]["tags"]), (200, ["kaikei", "koho"]))
        _, entries = self.gateway.dispatch("GET", self.path(second) + "/history", {}, self.context)
        self.assertEqual(entries[0]["changes"], [{"field": "tags", "before": "soumu", "after": "kaikei,koho"}])
        with self.assertRaises(api.ApiError):
            self.gateway.dispatch("PATCH", self.path(second), {"expectedVersion": 2, "changes": {"tags": []}}, self.context)
        with self.assertRaises(api.ApiError):
            self.create(operationId="global-3", tags=["unknown"])

    def test_all_tasks_list_returns_every_department_in_one_read(self):
        # 2026-10-25: 画面で部局を複数選ぶための全件の口。部局ごとの一覧と同じ形で、全部局の分を 1 回で返す。
        self.create(operationId="all-create-1", title="Naimu only")
        self.create(operationId="all-create-2", title="Koho only", tags=["koho"])
        self.create(operationId="all-create-3", title="Yakuin only", tags=["yakuin"])
        status, rows = self.gateway.dispatch("GET", "/api/integration/v1/tasks", {}, self.context)
        self.assertEqual(status, 200)
        self.assertEqual(sorted(r["title"] for r in rows), ["Koho only", "Naimu only", "Yakuin only"])
        self.assertTrue(all(r.get("parentId") is None for r in rows))
        with self.assertRaises(api.ApiError):                                     # 絞り込みの引数は受けない
            self.gateway.dispatch("GET", "/api/integration/v1/tasks?status=todo", {}, self.context)
        with self.assertRaises(api.ApiError):
            self.gateway.dispatch("POST", "/api/integration/v1/tasks", {}, self.context)
        self.context.allowed = False
        with self.assertRaises(api.ApiError) as failure:
            self.gateway.dispatch("GET", "/api/integration/v1/tasks", {}, self.context)
        self.assertEqual(failure.exception.status, 404)

    def test_parent_id_is_created_moved_and_cleared_over_web(self):
        if not self.gateway.parents:
            self.skipTest("Bot without parent tasks")
        project = self.create(operationId="parent-create-1", title="Synthetic project")
        child = self.create(operationId="parent-create-2", title="Synthetic child", parentId=project["task"]["id"])
        self.assertEqual((child["task"]["id"], child["task"]["parentId"]), ("task-2", "task-1"))
        self.assertEqual(self.store.get_task(self.scope, 2).task.parent, 1)
        other = self.create(operationId="parent-create-3", title="Synthetic other")
        status, moved = self.gateway.dispatch("PATCH", self.path(other), {"expectedVersion": 1,
                                              "changes": {"parentId": "task-1"}}, self.context)
        self.assertEqual((status, moved["task"]["parentId"], moved["task"]["version"]), (200, "task-1", 2))
        _, entries = self.gateway.dispatch("GET", self.path(other) + "/history", {}, self.context)
        self.assertEqual(entries[0]["changes"], [{"field": "parentId", "before": None, "after": "1"}])
        _, cleared = self.gateway.dispatch("PATCH", self.path(other), {"expectedVersion": 2,
                                           "changes": {"parentId": None}}, self.context)
        self.assertIsNone(cleared["task"]["parentId"])
        _, rows = self.gateway.dispatch("GET", "/api/integration/v1/tasks", {}, self.context)
        self.assertEqual({r["id"]: r["parentId"] for r in rows}, {"task-1": None, "task-2": "task-1", "task-3": None})

    def test_invalid_parent_is_rejected_without_mutation(self):
        if not self.gateway.parents:
            self.skipTest("Bot without parent tasks")
        project = self.create(operationId="bad-parent-1", title="Synthetic project")
        child = self.create(operationId="bad-parent-2", title="Synthetic child", parentId="task-1")
        for bad in ("1", 1, "task-0", "task-x", ["task-1"]):
            with self.assertRaises(api.ApiError) as failure:
                self.gateway.dispatch("PATCH", self.path(project), {"expectedVersion": 1, "changes": {"parentId": bad}}, self.context)
            self.assertEqual(failure.exception.code, "VALIDATION")
        # 子のある親を子の下へ・無い番号・自分自身 → 段数と存在の検査。同じ親の指定は変更なし。
        for parent, target, code in (("task-2", project, "INVALID_PARENT"), ("task-9", project, "INVALID_PARENT"),
                                     ("task-2", child, "INVALID_PARENT"), ("task-1", child, "NO_CHANGE")):
            with self.assertRaises(self.domain.TaskError) as failure:
                self.gateway.dispatch("PATCH", self.path(target), {"expectedVersion": 1, "changes": {"parentId": parent}}, self.context)
            self.assertEqual(failure.exception.code, code)
        with self.assertRaises(self.domain.TaskError) as failure:
            self.create(operationId="bad-parent-3", title="Synthetic grandchild", parentId="task-2")
        self.assertEqual(failure.exception.code, "INVALID_PARENT")
        self.assertEqual([v.task.version for v in self.store.list_tasks(self.scope)], [1, 1])

    def test_bot_without_parents_neither_shows_nor_takes_parent_id(self):
        # 親子の前の Bot(TASK_FIELDS に parent が無い)では parentId を出さず、送られても受け付けない
        domain = types.SimpleNamespace(**{k: getattr(self.domain, k) for k in dir(self.domain) if not k.startswith("__")})
        domain.TASK_FIELDS = tuple(f for f in self.domain.TASK_FIELDS if f != "parent")
        gateway = api.SqliteGateway(domain, self.store)
        self.assertFalse(gateway.parents)
        status, created = gateway.dispatch("POST", self.collection, {"operationId": "no-parent-1", "title": "Synthetic"}, self.context)
        self.assertEqual(status, 201)
        self.assertNotIn("parentId", created["task"])
        for parent in (None, "task-1"):
            with self.assertRaises(api.ApiError) as failure:
                gateway.dispatch("POST", self.collection, {"operationId": "no-parent-2", "title": "Synthetic", "parentId": parent}, self.context)
            self.assertEqual(failure.exception.code, "VALIDATION")
            with self.assertRaises(api.ApiError) as failure:
                gateway.dispatch("PATCH", self.path(created), {"expectedVersion": 1, "changes": {"parentId": parent}}, self.context)
            self.assertEqual(failure.exception.code, "VALIDATION")
        self.assertEqual([v.task.version for v in self.store.list_tasks(self.scope)], [1])

    def test_helpers_are_created_changed_listed_and_cleared_over_web(self):
        if not self.gateway.helpers:
            self.skipTest("Bot without helpers")
        self.context.others = {BOB}
        created = self.create(operationId="helper-create-1", assigneeId=api.uid(ALICE), helperIds=[api.uid(BOB)])
        task = created["task"]
        self.assertEqual((task["assigneeId"], task["helperIds"]), (api.uid(ALICE), [api.uid(BOB)]))
        self.assertEqual(task["helpers"], [{"id": api.uid(BOB), "displayName": "Synthetic member", "active": True}])
        self.assertEqual(self.store.get_task(self.scope, 1).task.helpers, (int(BOB),))
        plain = self.create(operationId="helper-create-2", title="Synthetic plain")
        self.assertEqual((plain["task"]["helperIds"], plain["task"]["helpers"]), ([], []))
        # 担当者の絞り込みは副担当のタスクも含める
        def listed(query):
            return [r["id"] for r in self.gateway.dispatch("GET", self.collection + query, {}, self.context)[1]]
        self.assertEqual(listed(f"?assignee={api.uid(BOB)}"), ["task-1"])
        self.assertEqual(listed("?assignee=unassigned"), ["task-2"])
        # 副担当の人を主担当にすると副担当から外れる。履歴は helperIds の項目で残る
        _, moved = self.gateway.dispatch("PATCH", self.path(created), {"expectedVersion": 1,
                                         "changes": {"assigneeId": api.uid(BOB)}}, self.context)
        self.assertEqual((moved["task"]["assigneeId"], moved["task"]["helperIds"]), (api.uid(BOB), []))
        _, entries = self.gateway.dispatch("GET", self.path(created) + "/history", {}, self.context)
        self.assertEqual(entries[0]["changes"], [{"field": "assigneeId", "before": ALICE, "after": BOB},
                                                 {"field": "helperIds", "before": BOB, "after": None}])
        # 画面に出す側は表示名(担当者の変更も、10/28 までは ID のまま出ていた)
        self.assertEqual(entries[0]["displayChanges"], [
            {"field": "assigneeId", "before": "Synthetic Alice", "after": "Synthetic member"},
            {"field": "helperIds", "before": "Synthetic member", "after": None}])
        self.assertIn({"field": "helperIds", "before": None, "after": "Synthetic member"}, entries[-1]["displayChanges"])
        _, back = self.gateway.dispatch("PATCH", self.path(created), {"expectedVersion": 2,
                                        "changes": {"helperIds": [api.uid(ALICE)]}}, self.context)
        self.assertEqual(back["task"]["helperIds"], [api.uid(ALICE)])
        _, cleared = self.gateway.dispatch("PATCH", self.path(created), {"expectedVersion": 3,
                                           "changes": {"assigneeId": None, "helperIds": []}}, self.context)
        self.assertEqual((cleared["task"]["assigneeId"], cleared["task"]["helperIds"]), (None, []))

    def test_invalid_helpers_are_rejected_without_mutation(self):
        if not self.gateway.helpers:
            self.skipTest("Bot without helpers")
        created = self.create(operationId="bad-helper-1", assigneeId=api.uid(ALICE))
        for bad in (api.uid(BOB), [api.uid(BOB)], [None], [BOB], "discord-" + BOB, [api.uid(ALICE)] * 21):
            with self.assertRaises(api.ApiError) as failure:
                self.gateway.dispatch("PATCH", self.path(created), {"expectedVersion": 1, "changes": {"helperIds": bad}}, self.context)
            self.assertEqual(failure.exception.code, "VALIDATION")                 # BOB は委員でない
        self.context.others = {BOB}
        for changes in ({"helperIds": [api.uid(ALICE)]}, {"assigneeId": None, "helperIds": [api.uid(BOB)]}):
            with self.assertRaises(self.domain.TaskError) as failure:
                self.gateway.dispatch("PATCH", self.path(created), {"expectedVersion": 1, "changes": changes}, self.context)
            self.assertEqual(failure.exception.code, "INVALID_ASSIGNEES")
        with self.assertRaises(self.domain.TaskError) as failure:
            self.create(operationId="bad-helper-2", helperIds=[api.uid(BOB)])      # 主担当なし
        self.assertEqual(failure.exception.code, "INVALID_ASSIGNEES")
        self.assertEqual([(v.task.version, v.task.helpers) for v in self.store.list_tasks(self.scope)], [(1, ())])

    def test_bot_without_helpers_neither_shows_nor_takes_helper_ids(self):
        # 副担当の前の Bot(TASK_FIELDS に helpers が無い)では helperIds を出さず、送られても受け付けない
        domain = types.SimpleNamespace(**{k: getattr(self.domain, k) for k in dir(self.domain) if not k.startswith("__")})
        domain.TASK_FIELDS = tuple(f for f in self.domain.TASK_FIELDS if f != "helpers")
        gateway = api.SqliteGateway(domain, self.store)
        self.assertFalse(gateway.helpers)
        status, created = gateway.dispatch("POST", self.collection, {"operationId": "no-helper-1", "title": "Synthetic",
                                                                     "assigneeId": api.uid(ALICE)}, self.context)
        self.assertEqual(status, 201)
        self.assertNotIn("helperIds", created["task"])
        self.assertNotIn("helpers", created["task"])
        for helpers in ([], [api.uid(ALICE)]):
            with self.assertRaises(api.ApiError) as failure:
                gateway.dispatch("POST", self.collection, {"operationId": "no-helper-2", "title": "Synthetic", "helperIds": helpers}, self.context)
            self.assertEqual(failure.exception.code, "VALIDATION")
            with self.assertRaises(api.ApiError) as failure:
                gateway.dispatch("PATCH", self.path(created), {"expectedVersion": 1, "changes": {"helperIds": helpers}}, self.context)
            self.assertEqual(failure.exception.code, "VALIDATION")
        self.assertEqual([v.task.version for v in self.store.list_tasks(self.scope)], [1])

    def test_reopen_requires_officer(self):
        created = self.create()
        with self.assertRaises(api.ApiError) as failure:
            self.gateway.dispatch("POST", self.path(created) + "/reopen", {"expectedVersion": 1}, self.context)
        self.assertEqual(failure.exception.status, 403)

    def test_explicit_web_completion_satisfies_bot_confirmation(self):
        created = self.create(requirements={"purpose": "Synthetic purpose", "deliverable": "Synthetic output",
                                            "completionCriteria": "Synthetic criteria", "openQuestions": "None"})
        path = self.path(created)
        self.gateway.dispatch("PATCH", path, {"expectedVersion": 1, "changes": {"status": "in_progress"}}, self.context)
        status, result = self.gateway.dispatch("PATCH", path, {"expectedVersion": 2, "changes": {"status": "done"}}, self.context)
        self.assertEqual((status, result["task"]["status"], result["task"]["version"]), (200, "done", 3))

    def test_boolean_version_is_rejected_without_mutation(self):
        created = self.create()
        with self.assertRaises(api.ApiError):
            self.gateway.dispatch("PATCH", self.path(created), {"expectedVersion": True, "changes": {"status": "blocked"}}, self.context)
        self.assertEqual(self.store.get_task(self.scope, 1).task.version, 1)

    def test_history_records_web_and_discord_against_same_task(self):
        created = self.create()
        self.store.update(self.domain.Actor(int(ALICE), "bot-history-update", "discord"), self.scope, 1, 1, {"status": "in_progress"})
        _, entries = self.gateway.dispatch("GET", self.path(created) + "/history", {}, self.context)
        self.assertEqual({row["source"] for row in entries}, {"web", "discord"})
        self.assertTrue(all(row["taskId"] == created["task"]["id"] for row in entries))

    def test_concurrent_updates_have_one_winner_and_one_history_entry(self):
        created = self.create()
        barrier = threading.Barrier(2)
        def update(index):
            gateway = api.SqliteGateway(self.domain, self.storage.TaskStore.open(Path(self.tmp.name)))
            barrier.wait()
            try:
                gateway.dispatch("PATCH", self.path(created), {"expectedVersion": 1,
                                 "operationId": "race-update-" + str(index),
                                 "changes": {"title": "Synthetic contender " + str(index)}}, self.context)
                return "success"
            except self.domain.TaskError as error:
                return error.code
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            results = list(pool.map(update, range(2)))
        self.assertEqual(sorted(results), ["VERSION_CONFLICT", "success"])
        entries, _ = self.store.history(self.scope, 1)
        self.assertEqual(len(entries), 2)
        self.assertEqual(self.store.get_task(self.scope, 1).task.version, 2)


class TransportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        SqliteTests.setUpClass()
        cls.domain, cls.storage = SqliteTests.domain, SqliteTests.storage
        cls.cert_dir = tempfile.TemporaryDirectory(prefix="task-api-tls-test-")
        cls.addClassCleanup(cls.cert_dir.cleanup)
        cls.cert = str(Path(cls.cert_dir.name) / "certificate.pem")
        cls.key_file = str(Path(cls.cert_dir.name) / "key.pem")
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                        "-days", "1", "-subj", "/CN=Task API test",
                        "-addext", "subjectAltName=IP:127.0.0.1",
                        "-keyout", cls.key_file, "-out", cls.cert],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def setUp(self):
        SqliteTests.setUp(self)
        self.key = os.urandom(32)
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.load_cert_chain(self.cert, self.key_file)
        self.server = api.ApiServer(("127.0.0.1", 0), api.ApiHandler, tls, {"127.0.0.1"})
        self.server.auth = api.ServiceAuth(self.key)
        self.server.domain, self.server.gateway = self.domain, self.gateway
        self.server.settings = types.SimpleNamespace(guild_ids={int(GUILD)}, allows=lambda *_: True)
        self.server.bot_id = BOT
        self.host = "127.0.0.1:" + str(self.server.server_port)
        self.server.allowed_host = self.host
        guild = {"id": GUILD, "owner_id": BOB,
                 "roles": [{"id": GUILD, "permissions": str(api.VIEW | api.SEND)}]}
        channel = {"id": CHANNEL, "guild_id": GUILD, "name": "Synthetic channel",
                   "type": 0, "permission_overwrites": []}
        def discord_get(path, deadline, optional_member=False):
            if path == f"/guilds/{GUILD}":
                return guild
            if path == f"/guilds/{GUILD}/channels":
                return [channel]
            for identifier in (ALICE, BOT):
                if path == f"/guilds/{GUILD}/members/{identifier}":
                    return {"user": {"id": identifier, "username": "Synthetic member", "bot": identifier == BOT}, "roles": []}
            raise AssertionError("unexpected synthetic Discord request")
        self.server.discord = types.SimpleNamespace(get=discord_get)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.02})
        self.thread.start()
        def stop():
            self.server.shutdown()
            self.server.server_close()
            self.thread.join(timeout=2)
        self.addCleanup(stop)

    def request(self, method, path, body=b"", headers=None, sign=True):
        pairs = list(headers or [])
        if sign:
            pairs.extend(signed(self.key, path=path, method=method, body=body,
                                timestamp=int(time.time() * 1000)).items())
        connection = http.client.HTTPSConnection("127.0.0.1", self.server.server_port,
                                                context=ssl.create_default_context(cafile=self.cert), timeout=5)
        self.addCleanup(connection.close)
        connection.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
        if not any(key.lower() == "host" for key, _ in pairs):
            pairs.append(("Host", self.host))
        if not any(key.lower() == "content-length" for key, _ in pairs):
            pairs.append(("Content-Length", str(len(body))))
        if body and not any(key.lower() == "content-type" for key, _ in pairs):
            pairs.append(("Content-Type", "application/json"))
        for key, value in pairs:
            connection.putheader(key, value)
        connection.endheaders(body)
        response = connection.getresponse()
        return response.status, json.loads(response.read())

    def test_tls_health_and_no_public_root(self):
        self.assertEqual(self.request("GET", "/api/health", sign=False), (200, {"ok": True}))
        self.assertEqual(self.request("GET", "/", sign=False)[0], 404)

    def test_unsigned_request_is_rejected(self):
        status, body = self.request("GET", "/api/integration/v1/me", sign=False)
        self.assertEqual((status, body["error"]["code"]), (401, "UNAUTHENTICATED"))

    def test_signed_request_uses_live_discord_permissions(self):
        status, body = self.request("GET", "/api/integration/v1/me")
        self.assertEqual(status, 200)
        self.assertEqual(body["user"]["id"], api.uid(ALICE))
        self.assertEqual(body["memberships"][0]["role"], "editor")

    def test_duplicate_host_is_rejected(self):
        self.assertEqual(self.request("GET", "/api/health", headers=[("Host", self.host), ("Host", self.host)], sign=False)[0], 421)

    def test_duplicate_length_is_rejected(self):
        self.assertEqual(self.request("GET", "/api/health", headers=[("Content-Length", "0"), ("Content-Length", "0")], sign=False)[0], 400)

    def test_duplicate_json_fields_cannot_mutate(self):
        status, _ = self.request("POST", self.collection, b'{"title":"one","title":"two","operationId":"duplicate-json"}')
        self.assertEqual(status, 400)
        self.assertEqual(self.store.list_tasks(self.scope), [])

    def test_nonce_replay_over_https_is_rejected(self):
        headers = list(signed(self.key, timestamp=int(time.time() * 1000)).items())
        self.assertEqual(self.request("GET", "/api/integration/v1/me", headers=headers, sign=False)[0], 200)
        self.assertEqual(self.request("GET", "/api/integration/v1/me", headers=headers, sign=False)[0], 401)

    def test_version_conflict_returns_current_task_over_https(self):
        status, created = self.request("POST", self.collection,
                                       b'{"title":"Synthetic task","operationId":"http-create"}')
        self.assertEqual(status, 201)
        path = "/api/integration/v1/tasks/" + created["task"]["id"]
        self.store.update(self.domain.Actor(int(ALICE), "bot-http-update", "discord"),
                          self.scope, 1, 1, {"status": "in_progress"})
        status, body = self.request("PATCH", path, b'{"expectedVersion":1,"changes":{"status":"blocked"}}')
        self.assertEqual(status, 409)
        self.assertEqual(body["error"]["code"], "VERSION_CONFLICT")
        self.assertEqual(body["error"]["current"]["version"], 2)


def synthetic_member(identifier, bot=False):
    return {"user": {"id": identifier, "username": "Synthetic member", "bot": bot}, "roles": []}


def counting_discord(calls, members):
    """Synthetic Discord REST: records every path it is asked for."""
    guild = {"id": GUILD, "owner_id": BOB, "roles": [{"id": GUILD, "permissions": str(api.VIEW | api.SEND)}]}
    channel = {"id": CHANNEL, "guild_id": GUILD, "name": "Synthetic channel", "type": 0, "permission_overwrites": []}

    def get(path, deadline, optional_member=False):
        calls.append(path)
        if path == f"/guilds/{GUILD}":
            return guild
        if path == f"/guilds/{GUILD}/channels":
            return [channel]
        if path.startswith(f"/guilds/{GUILD}/members?limit=1000"):
            return [members[key] for key in sorted(members, key=int)]
        for identifier, member in members.items():
            if path == f"/guilds/{GUILD}/members/{identifier}":
                return member
        if optional_member and path.startswith(f"/guilds/{GUILD}/members/"):
            return None
        raise AssertionError("unexpected synthetic Discord request")
    return types.SimpleNamespace(get=get)


SETTINGS = types.SimpleNamespace(guild_ids={int(GUILD)}, allows=lambda *_: True)
DEPTS = {"naimu": ("Naimu", None), "kikaku": ("Kikaku", "naimu")}


class SharedCacheTests(unittest.TestCase):
    """2026-10-14: Discord data is reused across requests for a few seconds (rate limits)."""

    def setUp(self):
        self.calls = []
        self.members = {ALICE: synthetic_member(ALICE), BOB: synthetic_member(BOB), BOT: synthetic_member(BOT, True)}
        self.client = counting_discord(self.calls, self.members)
        self.now = [1000.0]
        self.cache = api.SharedDiscordCache(clock=lambda: self.now[0])

    def context(self):
        return api.LiveContext(self.client, SETTINGS, api.uid(ALICE), BOT, self.cache, DEPTS)

    def test_guild_channels_and_members_are_shared_across_requests(self):
        for _ in range(3):
            self.assertEqual(self.context().authorize("naimu"), "editor")
        self.assertEqual(self.calls.count(f"/guilds/{GUILD}"), 1)
        self.assertEqual(self.calls.count(f"/guilds/{GUILD}/members/{ALICE}"), 1)

    def test_me_names_the_department_of_each_section(self):
        # 2026-10-25: 画面で部を選ぶとその課も含めるため、課のワークスペースに親の部を載せる
        workspaces = [m["workspace"] for m in self.context().me()["memberships"]]
        self.assertEqual([(w["id"], w["parentId"]) for w in workspaces], [("dept-naimu", None), ("dept-kikaku", "dept-naimu")])

    def test_shared_data_expires(self):
        self.context().authorize("naimu")
        self.now[0] += api.SharedDiscordCache.MEMBER_TTL + 1
        self.context().authorize("naimu")
        self.assertEqual(self.calls.count(f"/guilds/{GUILD}/members/{ALICE}"), 2)
        self.assertEqual(self.calls.count(f"/guilds/{GUILD}"), 1)
        self.now[0] += api.SharedDiscordCache.GUILD_TTL
        self.context().authorize("naimu")
        self.assertEqual(self.calls.count(f"/guilds/{GUILD}"), 2)

    def test_removed_member_loses_access_after_member_ttl(self):
        self.context().authorize("naimu")
        del self.members[ALICE]
        self.assertEqual(self.context().authorize("naimu"), "editor")   # within the short reuse window
        self.now[0] += api.SharedDiscordCache.MEMBER_TTL + 1
        with self.assertRaises(api.ApiError):
            self.context().authorize("naimu")

    def test_stale_guild_only_while_discord_fails(self):
        self.context().authorize("naimu")
        failing = types.SimpleNamespace(get=lambda *a, **k: (_ for _ in ()).throw(api.ApiError(503, "LOAD_FAILED")))
        self.now[0] += api.SharedDiscordCache.GUILD_TTL + 1
        ctx = api.LiveContext(failing, SETTINGS, api.uid(ALICE), BOT, self.cache, DEPTS)
        self.assertEqual(ctx.load_guild(GUILD)["id"], GUILD)
        self.now[0] += api.SharedDiscordCache.GUILD_STALE
        with self.assertRaises(api.ApiError):
            api.LiveContext(failing, SETTINGS, api.uid(ALICE), BOT, self.cache, DEPTS).load_guild(GUILD)

    def test_member_list_is_one_request_and_marks_non_members(self):
        ctx = self.context()
        ctx.authorize("naimu")
        ctx.prefetch_members("naimu")
        other = "1000000000000000099"
        self.assertIsNone(ctx.member(GUILD, other))
        self.assertIsNotNone(ctx.member(GUILD, BOB))
        self.assertEqual(sum(p.startswith(f"/guilds/{GUILD}/members?limit=1000") for p in self.calls), 1)
        self.assertNotIn(f"/guilds/{GUILD}/members/{BOB}", self.calls)
        self.assertNotIn(f"/guilds/{GUILD}/members/{other}", self.calls)
        self.assertEqual(len(self.context().list_members("naimu")), 2)       # Alice and Bob (Bot excluded)
        self.assertEqual(sum(p.startswith(f"/guilds/{GUILD}/members?limit=1000") for p in self.calls), 1)


class RateLimitTests(unittest.TestCase):
    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def read(self, limit=-1):
            return b'{"id": "1"}'

    def client(self, retry_after):
        attempts = []

        def open_(request, timeout):
            attempts.append(request.full_url)
            if len(attempts) == 1:
                headers = Message()
                headers["Retry-After"] = str(retry_after)
                raise api.urllib.error.HTTPError(request.full_url, 429, "Too Many Requests", headers,
                                                 io.BytesIO(json.dumps({"retry_after": retry_after}).encode()))
            return self.Response()
        client = api.DiscordReadClient("synthetic-token")
        client.opener = types.SimpleNamespace(open=open_)
        return client, attempts

    def test_429_is_retried_when_it_fits_the_deadline(self):
        client, attempts = self.client(0.05)
        self.assertEqual(client.get("/users/@me", time.monotonic() + 3), {"id": "1"})
        self.assertEqual(len(attempts), 2)

    def test_429_beyond_the_deadline_fails_at_once(self):
        client, attempts = self.client(4.0)
        started = time.monotonic()
        with self.assertRaises(api.ApiError):
            client.get("/users/@me", time.monotonic() + 1)
        self.assertLess(time.monotonic() - started, 0.5)
        self.assertEqual(len(attempts), 1)


class ListPrefetchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        SqliteTests.setUpClass()
        cls.domain, cls.storage = SqliteTests.domain, SqliteTests.storage

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="task-api-test-")
        self.addCleanup(self.tmp.cleanup)
        self.store = self.storage.TaskStore.open(Path(self.tmp.name))
        self.gateway = api.SqliteGateway(self.domain, self.store)

    def test_task_list_with_many_assignees_loads_the_member_list_once(self):
        gone = "1000000000000000098"
        scope = self.domain.Scope(int(GUILD), 0)
        for n, assignee in enumerate((ALICE, BOB, gone), 1):
            self.store.create(self.domain.Actor(int(BOT), f"prefetch-create-{n}", "screening"), scope,
                              title=f"Synthetic task {n}", assignee_id=int(assignee), tags=["kikaku"])
        calls = []
        members = {ALICE: synthetic_member(ALICE), BOB: synthetic_member(BOB), BOT: synthetic_member(BOT, True)}
        cache = api.SharedDiscordCache()
        path = f"/api/integration/v1/workspaces/{api.department_workspace('naimu')}/tasks"
        for _ in range(2):
            ctx = api.LiveContext(counting_discord(calls, members), SETTINGS, api.uid(ALICE), BOT, cache, self.domain.DEPARTMENTS)
            status, rows = self.gateway.dispatch("GET", path, {}, ctx)
            self.assertEqual(status, 200)
            self.assertEqual([r["assignee"]["active"] for r in rows], [True, True, False])
        self.assertEqual(sum(p.startswith(f"/guilds/{GUILD}/members?limit=1000") for p in calls), 1)
        # 個別の問い合わせは本人と Bot の権限確認だけ(担当者ごとには問い合わせない)
        self.assertFalse([p for p in calls if p.startswith(f"/guilds/{GUILD}/members/") and not p.endswith((ALICE, BOT))])

    def test_all_tasks_list_with_many_assignees_loads_the_member_list_once(self):
        # 2026-10-25: 全部局の一覧(GET /tasks)も、担当者が 2 人以上なら名簿を 1 回だけ読む
        scope = self.domain.Scope(int(GUILD), 0)
        for n, (assignee, tag) in enumerate(((ALICE, "kikaku"), (BOB, "koho")), 1):
            self.store.create(self.domain.Actor(int(BOT), f"prefetch-all-{n}", "screening"), scope,
                              title=f"Synthetic task {n}", assignee_id=int(assignee), tags=[tag])
        calls = []
        members = {ALICE: synthetic_member(ALICE), BOB: synthetic_member(BOB), BOT: synthetic_member(BOT, True)}
        ctx = api.LiveContext(counting_discord(calls, members), SETTINGS, api.uid(ALICE), BOT, api.SharedDiscordCache(), self.domain.DEPARTMENTS)
        status, rows = self.gateway.dispatch("GET", "/api/integration/v1/tasks", {}, ctx)
        self.assertEqual(status, 200)
        self.assertEqual([(r["tags"], r["assignee"]["active"]) for r in rows], [(["kikaku"], True), (["koho"], True)])
        self.assertEqual(sum(p.startswith(f"/guilds/{GUILD}/members?limit=1000") for p in calls), 1)
        self.assertFalse([p for p in calls if p.startswith(f"/guilds/{GUILD}/members/") and not p.endswith((ALICE, BOT))])

    def test_assignees_and_history_people_are_named_not_only_the_reader(self):
        # 2026-10-28: 一覧の担当者と履歴の人は、読んでいる本人以外も名簿の名前で出す(「Discordユーザー」にしない)
        gone = "1000000000000000098"
        scope = self.domain.Scope(int(GUILD), 0)
        for n, assignee in enumerate((BOB, gone), 1):
            self.store.create(self.domain.Actor(int(BOT), f"names-create-{n}", "screening"), scope,
                              title=f"Synthetic task {n}", assignee_id=int(assignee), tags=["kikaku"])
        self.store.update(self.domain.Actor(int(BOB), "names-update-1", "web"), scope, 1, 1, {"assignee_id": int(ALICE)})
        named = lambda identifier, nick: {**synthetic_member(identifier), "nick": nick}
        members = {ALICE: named(ALICE, "Synthetic Alice"), BOB: named(BOB, "Synthetic Bob"), BOT: synthetic_member(BOT, True)}
        ctx = lambda: api.LiveContext(counting_discord([], members), SETTINGS, api.uid(ALICE), BOT,
                                      api.SharedDiscordCache(), self.domain.DEPARTMENTS)
        status, rows = self.gateway.dispatch("GET", "/api/integration/v1/tasks", {}, ctx())
        self.assertEqual(status, 200)
        self.assertEqual([r["assignee"]["displayName"] for r in rows], ["Synthetic Alice", "Discordユーザー"])
        status, entries = self.gateway.dispatch("GET", f"/api/integration/v1/tasks/{rows[0]['id']}/history", {}, ctx())
        self.assertEqual(status, 200)
        updated = next(e for e in entries if e["action"] == "updated")
        self.assertEqual(updated["actorName"], "Synthetic Bob")
        self.assertIn({"field": "assigneeId", "before": "Synthetic Bob", "after": "Synthetic Alice"}, updated["displayChanges"])


class SiteFileTests(unittest.TestCase):
    """待ち受けと接続元は配布フォルダの site.json だけから読み、既定値を持たない。"""

    def write(self, site):
        directory = Path(tempfile.mkdtemp(prefix="task-api-site-"))
        self.addCleanup(lambda: __import__("shutil").rmtree(directory))
        if site is not None:
            (directory / "site.json").write_text(json.dumps(site), encoding="utf-8")
            (directory / "site.json").chmod(0o600)
        return directory

    def test_private_addresses_load(self):
        directory = self.write({"listenHost": "10.0.0.50", "trustedClientAddresses": ["10.0.0.19", "10.0.0.50"]})
        self.assertEqual(api.load_site(directory), ("10.0.0.50", frozenset({"10.0.0.19", "10.0.0.50"})))

    def test_site_readable_by_others_is_refused(self):
        directory = self.write({"listenHost": "10.0.0.50", "trustedClientAddresses": ["10.0.0.19"]})
        (directory / "site.json").chmod(0o644)
        with self.assertRaises(ValueError):
            api.load_site(directory)

    def test_missing_or_malformed_site_is_refused(self):
        bad = [
            None,
            {"listenHost": "10.0.0.50"},
            {"listenHost": "0.0.0.0", "trustedClientAddresses": ["10.0.0.19"]},
            {"listenHost": "10.0.0.50", "trustedClientAddresses": ["203.0.113.9"]},
            {"listenHost": "10.0.0.50", "trustedClientAddresses": []},
            {"listenHost": "10.0.0.50", "trustedClientAddresses": ["10.0.0.19"], "extra": 1},
        ]
        for site in bad:
            with self.subTest(site=site):
                with self.assertRaises((OSError, ValueError)):
                    api.load_site(self.write(site))


if __name__ == "__main__":
    suite = unittest.defaultTestLoader.loadTestsFromModule(sys.modules[__name__])
    logs = io.StringIO()
    result = unittest.TextTestRunner(stream=logs, verbosity=1).run(suite)
    print(json.dumps({"tests_run": result.testsRun,
                      "passed": result.testsRun - len(result.failures) - len(result.errors) - len(result.skipped),
                      "failed_tests": [test.id().split(".")[-2:] for test, _ in result.failures + result.errors],
                      "skipped": len(result.skipped), "production_database_used": False,
                      "real_discord_api_used": False}))
    if result.failures or result.errors:
        # Retain diagnostics privately, without sharing Bot source tracebacks.
        with tempfile.NamedTemporaryFile(prefix="task-api-test-log-", suffix=".log", delete=False, mode="w") as file:
            file.write(logs.getvalue())
    sys.exit(0 if result.wasSuccessful() else 1)
