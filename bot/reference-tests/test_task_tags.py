# -*- coding: utf-8 -*-
"""部局タグ(2026-10-14)の /todo 保存と移行のテスト。合成データのみ。

TaskStore はローカルディスク上でしか開けないため、一時ディレクトリは SCREENING_TEST_DIR
(既定 ~/.iyakusai/task-screening/test-tmp)の下に作り、終わったら消す(Bot ホストで実行)。
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

G, NAIMU_CH, YAKUIN_CH, SOUMU_CH, USER = 9001, 9101, 9102, 9103, 9201


def tmpdir() -> Path:
    base = Path(os.environ.get("SCREENING_TEST_DIR", Path.home() / ".iyakusai/task-screening/test-tmp"))
    base.mkdir(mode=0o700, parents=True, exist_ok=True)
    return Path(tempfile.mkdtemp(dir=base))


class DomainTests(unittest.TestCase):
    def test_tags_are_validated_and_ordered(self):
        self.assertEqual(D.clean_tags(["koho", "企画課", "koho"]), ("kikaku", "koho"))
        self.assertEqual(D.clean_tags("内務部、渉外課"), ("naimu", "shogai"))
        for bad in ([], "", ["unknown"], None, ["yakuin", "soumu", "kaikei", "system", "naimu", "kikaku"]):
            with self.assertRaises(D.TaskError):
                D.clean_tags(bad)

    def test_department_filter_and_channel_names(self):
        self.assertEqual(D.department_filter("naimu"), ("naimu", "kikaku", "kaijo"))
        self.assertEqual(D.department_filter("kikaku"), ("kikaku",))
        self.assertEqual(D.department_filter("yakuin"), ("yakuin",))
        self.assertEqual(D.department_from_name("内務部todo"), "naimu")
        self.assertEqual(D.department_from_name("システム課todo"), "system")
        self.assertEqual(D.department_from_name("役員会"), "yakuin")
        self.assertIsNone(D.department_from_name("雑談"))
        self.assertIsNone(D.department_from_name("会計作業"))
        self.assertEqual(D.format_tags(("kikaku", "koho")), "企画課・広報課")


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.dir = tmpdir()
        self.store = S.TaskStore.open(self.dir)
        self.scope = D.Scope(G, NAIMU_CH)

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def create(self, title, tags, channel=NAIMU_CH, op=None):
        return self.store.create(D.Actor(USER, op, "discord"), D.Scope(G, channel), title=title, tags=tags)

    def test_global_numbers_tags_and_department_lists(self):
        a = self.create("内務の仕事", ["naimu"])
        b = self.create("企画と広報の仕事", ["kikaku", "koho"], channel=YAKUIN_CH)
        c = self.create("役員の仕事", ["役員会"], channel=SOUMU_CH)
        self.assertEqual([m.view.task.number for m in (a, b, c)], [1, 2, 3])
        self.assertEqual(b.view.task.tags, ("kikaku", "koho"))

        def titles(tag):
            return sorted(v.task.title for v in self.store.list_tasks(D.Scope(G), tag=tag))
        self.assertEqual(titles("naimu"), ["企画と広報の仕事", "内務の仕事"])
        self.assertEqual(titles("gaimu"), ["企画と広報の仕事"])
        self.assertEqual(titles("koho"), ["企画と広報の仕事"])
        self.assertEqual(titles("yakuin"), ["役員の仕事"])
        self.assertEqual(len(self.store.list_tasks(D.Scope(G))), 3)
        # どのチャンネルから見ても同じタスク
        self.assertEqual(self.store.get_task(D.Scope(G, 1), 2).task.title, "企画と広報の仕事")
        with self.assertRaises(D.TaskError):
            self.store.list_tasks(D.Scope(G), tag="nothing")
        with self.assertRaises(D.TaskError):
            self.create("部局なし", [])

    def test_tags_update_is_versioned_and_in_history(self):
        self.create("仕事", ["naimu"])
        m = self.store.update(D.Actor(USER, "tag-update-1", "discord"), self.scope, 1, 1, {"tags": ["kaijo", "system"]})
        self.assertEqual((m.view.task.tags, m.view.task.version), (("system", "kaijo"), 2))
        entries, _ = self.store.history(self.scope, 1)
        self.assertEqual(entries[0].changes[0].as_dict(), {"field": "tags", "before": "naimu", "after": "system,kaijo"})
        self.assertEqual(entries[-1].changes[-1].field, "tags")                  # 作成時の部局も履歴に残る
        with self.assertRaises(D.TaskError):
            self.store.update(D.Actor(USER, "tag-update-2", "discord"), self.scope, 1, 2, {"tags": ["system", "kaijo"]})
        replay = self.store.update(D.Actor(USER, "tag-update-1", "discord"), self.scope, 1, 1, {"tags": ["kaijo", "system"]})
        self.assertTrue(replay.replayed)


V1_TASK = ("INSERT INTO tasks(guild_id, channel_id, number, title, description, assignee_id, deadline, status, "
           "purpose, deliverable, completion_criteria, open_questions, version, created_at, created_by, updated_at, "
           "updated_by) VALUES (?,?,?,?,'',NULL,NULL,'todo','','','','',1,?,1,?,1)")


class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.dir = tmpdir()
        self.dir.chmod(0o700)
        db = self.dir / S.DB_NAME
        con = sqlite3.connect(db)
        con.executescript(S._SCHEMA)
        con.execute("INSERT INTO meta(key, value) VALUES ('schema_version', '1')")
        rows = [(NAIMU_CH, n, f"内務{n}", f"2026-10-13T13:0{n}:00+00:00") for n in (1, 2, 3)]
        rows += [(YAKUIN_CH, 1, "役員1", "2026-10-13T13:05:30+00:00"), (YAKUIN_CH, 2, "役員2", "2026-10-13T13:01:30+00:00"),
                 (SOUMU_CH, 1, "総務1", "2026-10-13T13:03:30+00:00")]
        for ch, n, title, at in rows:
            con.execute(V1_TASK, (G, ch, n, title, at, at))
        con.commit()
        con.close()
        db.chmod(0o600)
        self.db = db

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_v1_store_is_not_opened_until_migrated(self):
        with self.assertRaises(S.TaskStoreUnavailable):
            S.TaskStore.open(self.dir)

    def test_unknown_channel_stops_migration_without_changes(self):
        with self.assertRaises(S.TaskConfigError):
            S.migrate_v1_to_v2(self.db, {NAIMU_CH: ("naimu",)})
        con = sqlite3.connect(self.db)
        self.assertEqual(con.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone(), ("1",))
        con.close()

    def test_migration_keeps_largest_channel_numbers_and_tags_by_channel(self):
        result = S.migrate_v1_to_v2(self.db, {NAIMU_CH: ("naimu",), YAKUIN_CH: ("yakuin",), SOUMU_CH: ("soumu",)})
        # 内務(3 件)の番号はそのまま、ほかは作成順に 4,5,6
        self.assertEqual(result["renumbered"], [(YAKUIN_CH, 2, 4), (SOUMU_CH, 1, 5), (YAKUIN_CH, 1, 6)])
        store = S.TaskStore.open(self.dir)
        titles = {v.task.number: (v.task.title, v.task.tags) for v in store.list_tasks(D.Scope(G))}
        self.assertEqual(titles, {1: ("内務1", ("naimu",)), 2: ("内務2", ("naimu",)), 3: ("内務3", ("naimu",)),
                                  4: ("役員2", ("yakuin",)), 5: ("総務1", ("soumu",)), 6: ("役員1", ("yakuin",))})
        self.assertEqual(store.legacy_number(G, YAKUIN_CH, 1), 6)
        self.assertEqual(store.legacy_number(G, NAIMU_CH, 2), 2)
        self.assertIsNone(store.legacy_number(G, NAIMU_CH, 9))
        new = store.create(D.Actor(USER, None, "web"), D.Scope(G), title="新しい仕事", tags=["koho"])
        self.assertEqual(new.view.task.number, 7)
        with self.assertRaises(S.TaskStoreUnavailable):
            S.migrate_v1_to_v2(self.db, {NAIMU_CH: ("naimu",)})                 # 2 回目は形式が違うので止まる


if __name__ == "__main__":
    unittest.main()
