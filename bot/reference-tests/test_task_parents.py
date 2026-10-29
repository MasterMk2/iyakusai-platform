# -*- coding: utf-8 -*-
"""親子(2026-10-25)の /todo 保存のテスト。合成データのみ。

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

# 親子の列を足す前(10/25 までの本番)の INSERT。旧コードは列を明示する。
OLD_INSERT = (f"INSERT INTO tasks(guild_id, channel_id, {S._TASK_COLUMNS}) "
              "VALUES (?,?,?,?,'',NULL,NULL,'todo','','','','',1,?,1,?,1)")


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
        return D.Actor(USER, f"parent-op-{self.n:04d}", "web")

    def create(self, title, parent=None, tags=("kikaku",)):
        return self.store.create(self.actor(), self.scope, title=title, tags=list(tags), parent=parent).view.task

    def update(self, number, version, changes, **kw):
        return self.store.update(self.actor(), self.scope, number, version, changes, **kw).view.task

    def assert_invalid_parent(self, fn):
        with self.assertRaises(D.TaskError) as caught:
            fn()
        self.assertEqual(caught.exception.code, "INVALID_PARENT")


class ParentTests(_StoreCase):
    def test_create_child_and_read_it_back(self):
        project = self.create("ステージ企画")
        child = self.create("出演者に連絡", parent=project.number, tags=("kikaku", "koho"))
        self.assertEqual((child.number, child.parent), (2, 1))
        self.assertIsNone(project.parent)
        self.assertEqual(self.store.get_task(self.scope, 2).task.parent, 1)
        self.assertEqual({v.task.number: v.task.parent for v in self.store.list_tasks(D.Scope(G))}, {1: None, 2: 1})
        self.assertEqual({v.task.number: v.task.parent for v in self.store.list_tasks(D.Scope(G), tag="gaimu")}, {2: 1})
        self.assertEqual([v.task.number for v in self.store.children(self.scope, 1)], [2])
        self.assertEqual(self.store.children(self.scope, 2), [])
        entries, _ = self.store.history(self.scope, 2)
        self.assertIn({"field": "parent", "before": None, "after": "1"}, [c.as_dict() for c in entries[-1].changes])

    def test_create_without_parent_keeps_the_old_fingerprint(self):
        # 親なしの作成の再送は、親子の前と同じ内容として扱う(操作 ID の記録を引き継ぐ)
        payload = {"title": "仕事", "description": "", "assignee_id": None, "deadline": None,
                   "requirements": {f: "" for f in D.REQUIREMENT_FIELDS}, "tags": ["kikaku"]}
        self.store.create(D.Actor(USER, "same-op-0001", "web"), self.scope, title="仕事", tags=["kikaku"])
        con = sqlite3.connect(self.store.db_path)
        saved = con.execute("SELECT fingerprint FROM operations").fetchone()[0]
        con.close()
        self.assertEqual(saved, D.fingerprint("create-task", None, payload, self.scope))

    def test_parent_rules_are_one_level(self):
        project = self.create("プロジェクト")
        child = self.create("子", parent=project.number)
        other = self.create("ほかの仕事")
        self.assert_invalid_parent(lambda: self.create("孫", parent=child.number))          # 子は親になれない
        self.assert_invalid_parent(lambda: self.create("存在しない親", parent=99))
        self.assert_invalid_parent(lambda: self.update(other.number, 1, {"parent": other.number}))  # 自分自身
        self.assert_invalid_parent(lambda: self.update(other.number, 1, {"parent": child.number}))
        self.assert_invalid_parent(lambda: self.update(project.number, 1, {"parent": other.number}))  # 子がある
        # 失敗した操作は何も変えない(版も同じ)
        self.assertEqual(self.store.get_task(self.scope, other.number).task.version, 1)
        self.assertEqual(self.store.get_task(self.scope, project.number).task.parent, None)
        self.assertEqual(len(self.store.list_tasks(D.Scope(G))), 3)
        for bad in (0, -1, "1", 1.0, True):
            with self.assertRaises(D.TaskError):
                self.update(other.number, 1, {"parent": bad})

    def test_move_and_clear_parent_is_versioned(self):
        a = self.create("プロジェクトA")
        b = self.create("プロジェクトB")
        task = self.create("仕事")
        moved = self.update(task.number, 1, {"parent": a.number})
        self.assertEqual((moved.parent, moved.version), (a.number, 2))
        moved = self.update(task.number, 2, {"parent": b.number})
        self.assertEqual((moved.parent, moved.version), (b.number, 3))
        with self.assertRaises(D.TaskError) as caught:
            self.update(task.number, 3, {"parent": b.number})
        self.assertEqual(caught.exception.code, "NO_CHANGE")
        cleared = self.update(task.number, 3, {"parent": None})
        self.assertEqual((cleared.parent, cleared.version), (None, 4))
        entries, _ = self.store.history(self.scope, task.number)
        self.assertEqual([e.changes[0].as_dict() for e in entries[:3]],
                         [{"field": "parent", "before": "2", "after": None},
                          {"field": "parent", "before": "1", "after": "2"},
                          {"field": "parent", "before": None, "after": "1"}])
        # 親の版は子の付け外しでは上がらない
        self.assertEqual(self.store.get_task(self.scope, a.number).task.version, 1)
        # 子が無くなった A はほかのタスクの下に入れられる
        self.assertEqual(self.update(a.number, 1, {"parent": b.number}).parent, b.number)

    def test_done_confirmation_mentions_open_children(self):
        project = self.create("プロジェクト")
        self.create("子1", parent=project.number)
        done = self.create("子2", parent=project.number)
        self.update(done.number, 1, {"status": "done"}, confirmed=True)
        with self.assertRaises(D.TaskError) as caught:
            self.update(project.number, 1, {"status": "done"})
        self.assertEqual(caught.exception.code, "CONFIRM_REQUIRED")
        self.assertIn("未完了の子タスクが 1 件", caught.exception.message)
        # 確認すれば完了にできる(子は完了にならない)
        self.assertEqual(self.update(project.number, 1, {"status": "done"}, confirmed=True).status, "done")
        self.assertEqual(self.store.get_task(self.scope, 2).task.status, "todo")


class DiscordShowTests(_StoreCase):
    def test_show_lists_parent_and_children(self):
        from iyakusai_bot import task_cog as C
        project = self.create("プロジェクト")
        self.create("子1", parent=project.number)
        done = self.create("子2", parent=project.number)
        self.update(done.number, 1, {"status": "done"}, confirmed=True)
        text = C.detail_text(self.store.get_task(self.scope, 1), self.store.children(self.scope, 1))
        self.assertIn("子タスク（1/2 完了）: #2 [未着手]、#3 [完了]", text)
        self.assertNotIn("親タスク:", text)
        self.assertIn("親タスク: #1", C.detail_text(self.store.get_task(self.scope, 2), []))
        self.assertEqual(C._change_value("parent", "1"), "#1")
        # 親子の無いタスクの表示は従来どおり
        self.assertNotIn("子タスク", C.detail_text(self.store.get_task(self.scope, 1), []))


class ColumnMigrationTests(unittest.TestCase):
    """10/25 までの DB(親子の列なし)への追加と、旧コードとの両立。"""

    def setUp(self):
        self.dir = tmpdir()
        self.dir.chmod(0o700)
        db = self.dir / S.DB_NAME
        con = sqlite3.connect(db)
        con.executescript(S._SCHEMA + S._SCHEMA_V2)
        con.execute("INSERT INTO meta(key, value) VALUES ('schema_version', '2')")
        for n in (1, 2):
            at = f"2026-10-24T10:0{n}:00+00:00"
            con.execute(OLD_INSERT, (G, CH, n, f"既存{n}", at, at))
            con.execute("INSERT INTO task_tags(task_id, tag) VALUES (?, 'kaijo')", (n,))
        con.commit()
        con.close()
        db.chmod(0o600)
        self.db = db

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_store_without_the_column_is_not_opened(self):
        with self.assertRaises(S.TaskStoreUnavailable):
            S.TaskStore.open(self.dir)

    def test_add_column_once_then_open(self):
        self.assertTrue(S.add_parent_column(self.db))
        self.assertFalse(S.add_parent_column(self.db))                                  # 2 回目は何もしない
        S.add_helpers_table(self.db)                                                    # 今の版は副担当の表も要る(10/28)
        store = S.TaskStore.open(self.dir)
        self.assertEqual({v.task.number: (v.task.title, v.task.parent) for v in store.list_tasks(D.Scope(G))},
                         {1: ("既存1", None), 2: ("既存2", None)})
        store.update(D.Actor(USER, "mig-op-0001", "web"), D.Scope(G), 2, 1, {"parent": 1})
        # 旧コードの INSERT・UPDATE は列を明示するので、列を足したあとも通り、親を消さない
        con = sqlite3.connect(self.db)
        at = "2026-10-25T10:00:00+00:00"
        con.execute(OLD_INSERT, (G, CH, 3, "旧コードの作成", at, at))
        con.execute("UPDATE tasks SET title=?, version=version+1 WHERE number=2", ("旧コードの更新",))
        con.commit()
        con.close()
        found = {v.task.number: (v.task.title, v.task.parent) for v in store.list_tasks(D.Scope(G))}
        self.assertEqual(found, {1: ("既存1", None), 2: ("旧コードの更新", 1), 3: ("旧コードの作成", None)})

    def test_add_column_refuses_other_schema_versions(self):
        con = sqlite3.connect(self.db)
        con.execute("UPDATE meta SET value='1' WHERE key='schema_version'")
        con.commit()
        con.close()
        with self.assertRaises(S.TaskStoreUnavailable):
            S.add_parent_column(self.db)
        con = sqlite3.connect(self.db)
        self.assertNotIn("parent_id", {r[1] for r in con.execute("PRAGMA table_info(tasks)")})
        con.close()


if __name__ == "__main__":
    unittest.main()
