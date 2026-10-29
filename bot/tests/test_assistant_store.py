# -*- coding: utf-8 -*-
"""ジョブ表(assistant_store)の試験。合成データのみ・一時フォルダ・実 Discord なし。"""

from __future__ import annotations

import shutil
import sys
import tempfile
import threading
import unittest
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC))

from iyakusai_bot import assistant_store as S  # noqa: E402

ACTOR = "discord-1000000000000000001"
OTHER = "discord-1000000000000000002"


class StoreCase(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="assistant-store-"))
        self.store = S.AssistantStore.open(self.dir / "jobs.sqlite3")

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def enqueue(self, opid, kind="ask", actor=ACTOR, question="発電機のレンタルは?", max_active=3):
        return self.store.enqueue(actor, "テスト委員", opid, kind, None,
                                  {"question": question} if kind == "ask" else {"prompt": question},
                                  max_active=max_active)


class EnqueueTests(StoreCase):
    def test_same_actor_and_operation_returns_the_same_job(self):
        first, replayed1 = self.enqueue("op-1")
        second, replayed2 = self.enqueue("op-1")
        self.assertFalse(replayed1)
        self.assertTrue(replayed2)
        self.assertEqual(first.id, second.id)
        self.assertTrue(first.id.startswith("j_") and len(first.id) == 22)
        self.assertEqual(first.state, "queued")

    def test_other_actor_with_same_operation_id_gets_its_own_job(self):
        a, _ = self.enqueue("op-1", actor=ACTOR)
        b, replayed = self.enqueue("op-1", actor=OTHER)
        self.assertFalse(replayed)
        self.assertNotEqual(a.id, b.id)

    def test_active_limit_counts_queued_and_running_ask_doc_image_only(self):
        for n in range(3):
            self.enqueue(f"op-{n}")
        with self.assertRaises(S.TooManyJobs) as ctx:
            self.enqueue("op-3")
        self.assertEqual(ctx.exception.code, "TOO_MANY_JOBS")
        # 別の人は影響を受けない
        self.enqueue("other-0", actor=OTHER)
        # remind/screening は数えない
        self.store.enqueue(ACTOR, "テスト委員", "rem-1", "remind", "create", {"text": "x"}, max_active=3)
        self.assertEqual(self.store.count_active(ACTOR), 3)

    def test_finished_jobs_free_a_slot(self):
        job, _ = self.enqueue("op-a")
        self.enqueue("op-b")
        self.enqueue("op-c")
        claimed = self.store.claim_next(("ask",))
        self.assertTrue(self.store.finish(claimed.id, {"text": "ok", "files": []}))
        self.enqueue("op-d")   # 完了したので4件目が通る(受付中は 3 件)
        self.assertEqual(self.store.count_active(ACTOR), 3)


class ClaimTests(StoreCase):
    def test_claim_is_fifo_and_moves_to_running(self):
        a, _ = self.enqueue("op-1")
        b, _ = self.enqueue("op-2")
        first = self.store.claim_next(("ask",))
        self.assertEqual(first.id, a.id)
        self.assertEqual(first.state, "running")
        self.assertEqual(first.attempts, 1)
        self.assertEqual(self.store.claim_next(("ask",)).id, b.id)
        self.assertIsNone(self.store.claim_next(("ask",)))

    def test_claim_respects_kinds(self):
        self.enqueue("op-1", kind="ask")
        self.assertIsNone(self.store.claim_next(("image",)))

    def test_two_connections_never_claim_the_same_job(self):
        self.enqueue("op-1")
        other = S.AssistantStore(self.store.path)   # 別の接続(別プロセスの代わり)
        results = []
        barrier = threading.Barrier(2)

        def worker(store):
            barrier.wait()
            results.append(store.claim_next(("ask",)))

        threads = [threading.Thread(target=worker, args=(s,)) for s in (self.store, other)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        claimed = [job for job in results if job is not None]
        self.assertEqual(len(claimed), 1)

    def test_finish_and_fail_only_apply_to_running_jobs(self):
        job, _ = self.enqueue("op-1")
        self.assertFalse(self.store.finish(job.id, {"text": "x"}))   # まだ queued
        self.store.claim_next(("ask",))
        self.assertTrue(self.store.set_progress(job.id, {"phase": "search", "text": "調べています"}))
        self.assertEqual(self.store.get(job.id).progress["phase"], "search")
        self.assertTrue(self.store.finish(job.id, {"text": "回答", "files": []}, "https://example.invalid/m/1"))
        done = self.store.get(job.id)
        self.assertEqual((done.state, done.result["text"], done.discord_url, done.progress), ("done", "回答", "https://example.invalid/m/1", None))
        self.assertFalse(self.store.fail(job.id, "X", "y"))

    def test_failure_is_recorded_with_code_and_message(self):
        job, _ = self.enqueue("op-1")
        self.store.claim_next(("ask",))
        self.assertTrue(self.store.fail(job.id, "NO_ANSWER", "回答を作れませんでした。"))
        failed = self.store.get(job.id)
        self.assertEqual((failed.state, failed.error_code, failed.error_message),
                         ("failed", "NO_ANSWER", "回答を作れませんでした。"))


class CancelRecoveryTests(StoreCase):
    def test_owner_can_cancel_only_queued_jobs(self):
        job, _ = self.enqueue("op-1")
        with self.assertRaises(S.JobForbidden):
            self.store.cancel(job.id, OTHER)
        canceled = self.store.cancel(job.id, ACTOR)
        self.assertEqual(canceled.state, "canceled")
        running, _ = self.enqueue("op-2")
        self.store.claim_next(("ask",))
        with self.assertRaises(S.JobConflict):
            self.store.cancel(running.id, ACTOR)
        with self.assertRaises(S.JobNotFound):
            self.store.cancel("j_" + "a" * 20, ACTOR)

    def test_recover_interrupted_marks_only_running_jobs(self):
        queued, _ = self.enqueue("op-1")
        running, _ = self.enqueue("op-2")
        self.store.claim_next(("ask",))   # op-1 が running になる
        self.assertEqual(self.store.recover_interrupted(), 1)
        self.assertEqual(self.store.get(queued.id).state, "failed")
        got = self.store.get(queued.id)
        self.assertEqual(got.error_code, "INTERRUPTED")
        self.assertIn("Bot", got.error_message)
        self.assertEqual(self.store.get(running.id).state, "queued")


class ListSimilarTests(StoreCase):
    def test_list_is_newest_first_with_cursor_paging(self):
        ids = [self.enqueue(f"op-{n}", max_active=10)[0].id for n in range(5)]
        page1, next1 = self.store.list_jobs(kinds=("ask",), limit=2)
        self.assertEqual([j.id for j in page1], [ids[4], ids[3]])
        page2, next2 = self.store.list_jobs(kinds=("ask",), limit=2, before=next1)
        self.assertEqual([j.id for j in page2], [ids[2], ids[1]])
        page3, next3 = self.store.list_jobs(kinds=("ask",), limit=2, before=next2)
        self.assertEqual([j.id for j in page3], [ids[0]])
        self.assertIsNone(next3)
        with self.assertRaises(S.JobNotFound):
            self.store.list_jobs(before="j_" + "b" * 20)

    def test_list_filters_by_actor_and_kind(self):
        self.enqueue("a-1", kind="ask", actor=ACTOR)
        self.enqueue("o-1", kind="doc", actor=OTHER, question="x")
        jobs, _ = self.store.list_jobs(actor_id=ACTOR)
        self.assertEqual([j.kind for j in jobs], ["ask"])
        jobs, _ = self.store.list_jobs(kinds=("doc", "image"))
        self.assertEqual([j.kind for j in jobs], ["doc"])

    def test_similar_uses_done_ask_jobs_only_and_scores_character_bigrams(self):
        done, _ = self.enqueue("d-1", question="発電機のレンタルはどうなっていますか")
        self.store.claim_next(("ask",))
        self.store.finish(done.id, {"text": "回答"})
        queued, _ = self.enqueue("q-1", question="発電機のレンタルはどうなっていますか")   # 未完了は対象外
        self.enqueue("d-2", kind="doc", question="発電機のレンタルはどうなっていますか")
        self.enqueue("u-1", question="まったく別の話題です")
        hits = self.store.similar("発電機のレンタルは？")
        self.assertEqual([job.id for job, _ in hits], [done.id])
        self.assertGreaterEqual(hits[0][1], S.SIMILAR_MIN_SCORE)
        self.assertEqual(self.store.similar("まったく別の話題"), [])   # 閾値未満は出さない
        self.assertNotIn(queued.id, [job.id for job, _ in hits])

    def test_similarity_is_normalised_and_bounded(self):
        self.assertEqual(S.similarity("ＡＢＣ", "abc"), 1.0)
        self.assertEqual(S.similarity("", "abc"), 0.0)
        self.assertAlmostEqual(S.similarity("ab", "cd"), 0.0)


class FilesSnapshotMetaTests(StoreCase):
    def test_files_are_registered_per_job_and_name(self):
        job, _ = self.enqueue("op-1")
        self.store.add_file(job.id, "回答.md", "text/markdown; charset=utf-8", 3, "00" * 32, f"{job.id}/回答.md")
        row = self.store.get_file(job.id, "回答.md")
        self.assertEqual(row["relpath"], f"{job.id}/回答.md")
        self.assertIsNone(self.store.get_file(job.id, "別の名前.md"))
        self.assertEqual(len(self.store.files_for(job.id)), 1)
        with self.assertRaises(Exception):   # 同じ名前は二度登録できない
            self.store.add_file(job.id, "回答.md", "text/plain", 1, "00" * 32, "x")

    def test_snapshot_heartbeat_and_meta_round_trip(self):
        self.assertIsNone(self.store.read_snapshot())
        self.assertIsNone(self.store.last_heartbeat())
        self.store.write_snapshot({"reminders": [{"id": 1, "text": "資料"}], "manageGuildIds": []})
        taken, body = self.store.read_snapshot()
        self.assertTrue(taken)
        self.assertEqual(body["reminders"][0]["text"], "資料")
        self.store.heartbeat()
        self.assertIsNotNone(self.store.last_heartbeat())
        self.assertIsNone(self.store.get_meta("capabilities"))
        self.store.set_meta("capabilities", '{"gemini": false}')
        self.assertEqual(self.store.get_meta("capabilities"), '{"gemini": false}')

    def test_open_requires_an_absolute_path(self):
        with self.assertRaises(S.AssistantStoreError):
            S.AssistantStore.open(Path("relative.sqlite3"))


if __name__ == "__main__":
    unittest.main()
