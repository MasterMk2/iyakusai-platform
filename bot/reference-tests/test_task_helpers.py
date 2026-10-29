# -*- coding: utf-8 -*-
"""副担当(2026-10-28)の /todo 保存のテスト。合成データのみ。

一時ディレクトリの置き場は test_task_tags.py と同じ(SCREENING_TEST_DIR、既定 ~/.iyakusai/task-screening/test-tmp)。
"""

from __future__ import annotations

import os
import shutil
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from iyakusai_bot import task_domain as D  # noqa: E402
from iyakusai_bot import task_store as S  # noqa: E402

G, CH, USER = 9001, 9101, 9201
A, B, C = 9301, 9302, 9303  # 委員(合成)

# 副担当の表を足す前(親子の列はある)の旧コードの INSERT。列を明示する。
OLD_INSERT = (f"INSERT INTO tasks(guild_id, channel_id, {S._TASK_COLUMNS}) "
              "VALUES (?,?,?,?,'',?,NULL,'todo','','','','',1,?,1,?,1)")


def tmpdir() -> Path:
    base = Path(os.environ.get("SCREENING_TEST_DIR", Path.home() / ".iyakusai/task-screening/test-tmp"))
    base.mkdir(mode=0o700, parents=True, exist_ok=True)
    return Path(tempfile.mkdtemp(dir=base))


class _StoreCase(unittest.TestCase):
    def setUp(self):
        self.dir = tmpdir()
        self.store = S.TaskStore.open(self.dir)
        self.scope = D.Scope(G, CH)
        self.n = 0

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def actor(self):
        self.n += 1
        return D.Actor(USER, f"helper-op-{self.n:04d}", "web")

    def create(self, title, assignee=None, helpers=()):
        return self.store.create(self.actor(), self.scope, title=title, tags=["kikaku"],
                                 assignee_id=assignee, helpers=helpers).view.task

    def update(self, number, version, changes):
        return self.store.update(self.actor(), self.scope, number, version, changes).view.task

    def assert_code(self, code, fn):
        with self.assertRaises(D.TaskError) as caught:
            fn()
        self.assertEqual(caught.exception.code, code)
        return caught.exception


class HelperTests(_StoreCase):
    def test_create_with_helpers_and_read_them_back_in_order(self):
        task = self.create("ステージの進行", assignee=A, helpers=[C, B, C])
        self.assertEqual((task.assignee_id, task.helpers), (A, (C, B)))                 # 重複は 1 つ、順は指定どおり
        self.assertEqual(self.store.get_task(self.scope, 1).task.helpers, (C, B))
        self.assertEqual(self.store.list_tasks(D.Scope(G))[0].task.helpers, (C, B))
        entries, _ = self.store.history(self.scope, 1)
        self.assertIn({"field": "helpers", "before": None, "after": f"{C},{B}"}, [c.as_dict() for c in entries[0].changes])

    def test_create_without_helpers_keeps_the_old_fingerprint(self):
        payload = {"title": "仕事", "description": "", "assignee_id": A, "deadline": None,
                   "requirements": {f: "" for f in D.REQUIREMENT_FIELDS}, "tags": ["kikaku"]}
        self.store.create(D.Actor(USER, "same-op-0001", "web"), self.scope, title="仕事", tags=["kikaku"], assignee_id=A)
        con = sqlite3.connect(self.store.db_path)
        stored = con.execute("SELECT fingerprint FROM operations").fetchone()[0]
        con.close()
        self.assertEqual(stored, D.fingerprint("create-task", None, payload, self.scope))

    def test_helpers_need_a_main_assignee_who_is_not_one_of_them(self):
        self.assert_code("INVALID_ASSIGNEES", lambda: self.create("主なし", helpers=[B]))
        self.assert_code("INVALID_ASSIGNEES", lambda: self.create("同じ人", assignee=A, helpers=[A]))
        task = self.create("仕事", assignee=A, helpers=[B])
        self.assert_code("INVALID_ASSIGNEES", lambda: self.update(1, 1, {"assignee_id": None}))
        self.assert_code("INVALID_ASSIGNEES", lambda: self.update(1, 1, {"helpers": [A]}))
        self.assert_code("VALIDATION", lambda: self.update(1, 1, {"helpers": [B, "x"]}))
        self.assert_code("VALIDATION", lambda: self.update(1, 1, {"helpers": list(range(1, 12))}))
        self.assertEqual(self.store.get_task(self.scope, 1).task.version, task.version)  # どれも保存していない

    def test_main_and_helpers_can_be_cleared_together(self):
        self.create("仕事", assignee=A, helpers=[B])
        task = self.update(1, 1, {"assignee_id": None, "helpers": []})
        self.assertEqual((task.assignee_id, task.helpers), (None, ()))

    def test_making_a_helper_the_main_assignee_takes_them_off_the_helpers(self):
        self.create("仕事", assignee=A, helpers=[B, C])
        task = self.update(1, 1, {"assignee_id": B})
        self.assertEqual((task.assignee_id, task.helpers), (B, (C,)))
        entries, _ = self.store.history(self.scope, 1)
        self.assertEqual([c.as_dict() for c in entries[0].changes],
                         [{"field": "assignee_id", "before": str(A), "after": str(B)},
                          {"field": "helpers", "before": f"{B},{C}", "after": str(C)}])
        # 主担当と副担当を入れ替える
        task = self.update(1, 2, {"assignee_id": C, "helpers": [B]})
        self.assertEqual((task.assignee_id, task.helpers), (C, (B,)))

    def test_same_helpers_is_no_change(self):
        self.create("仕事", assignee=A, helpers=[B, C])
        self.assert_code("NO_CHANGE", lambda: self.update(1, 1, {"helpers": [B, C]}))
        task = self.update(1, 1, {"helpers": [C, B]})                                    # 並べ替えは変更
        self.assertEqual(task.helpers, (C, B))

    def test_other_changes_do_not_check_the_assignees(self):
        # 旧コードが主担当を外した(副担当は表に残った)タスクでも、ほかの項目は直せる
        self.create("仕事", assignee=A, helpers=[B])
        con = sqlite3.connect(self.store.db_path)
        con.execute("UPDATE tasks SET assignee_id=NULL, version=2 WHERE number=1")
        con.commit()
        con.close()
        self.assertEqual(self.update(1, 2, {"title": "直した"}).title, "直した")

    def test_assignee_filter_includes_helpers(self):
        self.create("Aが主", assignee=A, helpers=[B])
        self.create("Bが主", assignee=B)
        self.create("未割当")
        self.assertEqual([v.task.number for v in self.store.list_tasks(D.Scope(G), assignee=B)], [1, 2])
        self.assertEqual([v.task.number for v in self.store.list_tasks(D.Scope(G), assignee=A)], [1])
        self.assertEqual([v.task.number for v in self.store.list_tasks(D.Scope(G), assignee=None)], [3])
        self.assertTrue(self.store.get_task(self.scope, 1).task.is_assigned_to(B))

    def test_children_carry_their_helpers(self):
        self.create("プロジェクト")
        self.store.create(self.actor(), self.scope, title="子", tags=["kikaku"], parent=1, assignee_id=A, helpers=[B])
        self.assertEqual([v.task.helpers for v in self.store.children(self.scope, 1)], [(B,)])

    def test_todo_texts_show_the_helpers(self):
        from iyakusai_bot import task_cog as Cog
        self.create("仕事", assignee=A, helpers=[B, C])
        self.create("一人", assignee=A)
        view = self.store.get_task(self.scope, 1)
        self.assertIn(f"担当: <@{A}>（副 <@{B}>、<@{C}>）／", Cog.summary_line(view))
        self.assertIn(f"\n副担当: <@{B}>、<@{C}>\n", Cog.detail_text(view, []))
        one = self.store.get_task(self.scope, 2)
        self.assertIn(f"担当: <@{A}>／", Cog.summary_line(one))
        self.assertNotIn("副担当", Cog.detail_text(one, []))
        self.assertEqual(Cog._change_value("helpers", f"{B},{C}"), f"<@{B}>、<@{C}>")
        self.assertEqual(Cog._change_value("helpers", None), "（なし）")
        entries, total = self.store.history(self.scope, 1)
        self.assertIn(f"・副担当: （なし） → <@{B}>、<@{C}>", Cog.history_text(1, entries, total, 1))

    def test_clean_helpers(self):
        self.assertEqual(D.clean_helpers([]), ())
        self.assertEqual(D.clean_helpers((B, B, A)), (B, A))
        for bad in ("1,2", [0], [True], [-1], None):
            with self.assertRaises(D.TaskError):
                D.clean_helpers(bad)
        self.assertEqual(D.parse_helpers(D.format_helpers((A, B))), (A, B))
        self.assertIsNone(D.format_helpers(()))


class HelpersTableMigrationTests(unittest.TestCase):
    """10/25 の DB(親子の列あり・副担当の表なし)への追加と、旧コードとの両立。"""

    def setUp(self):
        self.dir = tmpdir()
        self.dir.chmod(0o700)
        db = self.dir / S.DB_NAME
        con = sqlite3.connect(db)
        con.executescript(S._SCHEMA + S._SCHEMA_V2 + S._SCHEMA_PARENT)
        con.execute("INSERT INTO meta(key, value) VALUES ('schema_version', '2')")
        for n in (1, 2):
            at = f"2026-10-27T10:0{n}:00+00:00"
            con.execute(OLD_INSERT, (G, CH, n, f"既存{n}", A, at, at))
            con.execute("INSERT INTO task_tags(task_id, tag) VALUES (?, 'kaijo')", (n,))
        con.commit()
        con.close()
        db.chmod(0o600)
        self.db = db

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_store_without_the_table_is_not_opened(self):
        with self.assertRaises(S.TaskStoreUnavailable):
            S.TaskStore.open(self.dir)

    def test_add_table_once_then_open_and_old_code_still_works(self):
        self.assertTrue(S.add_helpers_table(self.db))
        self.assertFalse(S.add_helpers_table(self.db))                                  # 2 回目は何もしない
        store = S.TaskStore.open(self.dir)
        self.assertEqual({v.task.number: (v.task.assignee_id, v.task.helpers) for v in store.list_tasks(D.Scope(G))},
                         {1: (A, ()), 2: (A, ())})
        store.update(D.Actor(USER, "mig-op-0001", "web"), D.Scope(G), 2, 1, {"helpers": [B]})
        # 旧コードの INSERT・UPDATE は列を明示し、副担当の表を読まないので、そのまま通り副担当も消さない
        con = sqlite3.connect(self.db)
        at = "2026-10-28T10:00:00+00:00"
        con.execute(OLD_INSERT, (G, CH, 3, "旧コードの作成", None, at, at))
        con.execute("UPDATE tasks SET title=?, version=version+1 WHERE number=2", ("旧コードの更新",))
        con.commit()
        con.close()
        found = {v.task.number: (v.task.title, v.task.helpers) for v in store.list_tasks(D.Scope(G))}
        self.assertEqual(found, {1: ("既存1", ()), 2: ("旧コードの更新", (B,)), 3: ("旧コードの作成", ())})

    def test_add_table_needs_the_parent_column_and_schema_2(self):
        bare = self.dir / "bare"
        bare.mkdir()
        db = bare / S.DB_NAME
        con = sqlite3.connect(db)
        con.executescript(S._SCHEMA + S._SCHEMA_V2)
        con.execute("INSERT INTO meta(key, value) VALUES ('schema_version', '2')")
        con.commit()
        con.close()
        with self.assertRaises(S.TaskStoreUnavailable):
            S.add_helpers_table(db)
        con = sqlite3.connect(self.db)
        con.execute("UPDATE meta SET value='1' WHERE key='schema_version'")
        con.commit()
        con.close()
        with self.assertRaises(S.TaskStoreUnavailable):
            S.add_helpers_table(self.db)
        for path in (db, self.db):
            con = sqlite3.connect(path)
            self.assertIsNone(con.execute("SELECT 1 FROM sqlite_master WHERE name='task_helpers'").fetchone())
            con.close()


if __name__ == "__main__":
    unittest.main()
