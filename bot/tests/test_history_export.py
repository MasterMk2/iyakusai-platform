# -*- coding: utf-8 -*-
"""統合アプリの Bot の依頼の履歴を共有ドライブへ書き出す処理(history_export・2026-11-21)の試験。

ジョブ表は一時フォルダの実物(AssistantStore)。ドライブは一時フォルダの `_目録` で代える。
"""

from __future__ import annotations

import contextlib
import io
import json
import shutil
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC))

from iyakusai_bot import history_export as H  # noqa: E402
from iyakusai_bot.assistant_store import AssistantStore  # noqa: E402

ACTOR = "discord-1000000000000000001"


class HistoryExportTests(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="history-export-"))
        self.store_path = self.dir / "local" / "jobs.sqlite3"
        self.store_path.parent.mkdir()
        self.store = AssistantStore.open(self.store_path)
        self.files_dir = self.dir / "local" / "files"
        self.drive = self.dir / "drive" / "_目録"
        self.drive.mkdir(parents=True)
        (self.drive / "INDEX.md").write_text("目録", encoding="utf-8")   # マウントされた _目録 の代わり(空でない)
        self.out = self.drive / "Bot履歴"
        self.state = H.state_path_for(self.store_path)
        self.counter = 0

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    # ---- 作り方 ----

    def job(self, kind, input_obj, *, name="テスト委員", op=None):
        self.counter += 1
        job, _ = self.store.enqueue(ACTOR, name, f"op-{self.counter}", kind, op, input_obj, max_active=50)
        return job

    def done(self, kind, input_obj, text="答えです。", *, files=(), name="テスト委員"):
        job = self.job(kind, input_obj, name=name)
        claimed = self.store.claim_next((kind,))
        self.assertEqual(claimed.id, job.id)
        saved = []
        for file_name, data in files:
            folder = self.files_dir / job.id
            folder.mkdir(parents=True, exist_ok=True)
            (folder / file_name).write_bytes(data)
            self.store.add_file(job.id, file_name, "text/markdown", len(data), "0" * 64, f"{job.id}/{file_name}")
            saved.append({"name": file_name, "mime": "text/markdown", "size": len(data)})
        self.store.finish(job.id, {"text": text, "files": saved}, None)
        return self.store.get(job.id)

    def failed(self, kind, input_obj, code="AI_ERROR", message="いま使えません。"):
        job = self.job(kind, input_obj)
        self.store.claim_next((kind,))
        self.store.fail(job.id, code, message)
        return self.store.get(job.id)

    def set_times(self, job_id, created, updated=None):
        con = sqlite3.connect(self.store_path)
        with con:
            con.execute("UPDATE jobs SET created_at = ?, updated_at = ? WHERE id = ?",
                        (created, updated or created, job_id))
        con.close()

    def export(self, **kw):
        return H.export(self.store_path, self.files_dir, self.out, self.state, **kw)

    def records(self, month):
        lines = (self.out / f"{month}.jsonl").read_text("utf-8").splitlines()
        return [json.loads(line) for line in lines]

    @staticmethod
    def ask(question="発電機のレンタルは?"):
        return {"question": question, "model": "auto", "effort": "auto", "tone": None, "format": None}

    # ---- 試験 ----

    def test_exports_only_finished_ask_doc_image(self):
        ask = self.done("ask", self.ask())
        doc = self.done("doc", {"docType": "mail", "content": "見積の依頼", "format": "txt",
                                "useSources": True, "model": "auto"})
        image = self.failed("image", {"prompt": "値段表", "aspect": "1:1"}, "LIMIT", "1 日 1 枚までです。")
        self.done("taskdraft", {"overview": "本人だけが読む下書き"})       # 本人だけ → 入れない
        self.done("remind", {"text": "リマインド"})                      # 入れない
        self.job("ask", self.ask("まだ待っている質問"))                    # queued → 入れない
        canceled = self.job("ask", self.ask("取り消した質問"))
        self.store.cancel(canceled.id, ACTOR)                            # canceled → 入れない
        stats = self.export()
        month = ask.created_at[:7]
        self.assertEqual(stats["months"], [month])
        self.assertEqual(stats["jobs"], 3)
        records = self.records(month)
        self.assertEqual([r["id"] for r in records], [ask.id, doc.id, image.id])
        self.assertEqual(records[0]["text"], "答えです。")
        self.assertEqual(records[0]["actor"], "テスト委員")
        self.assertNotIn("discord-", json.dumps(records, ensure_ascii=False))   # ID は書かない
        self.assertEqual(records[2]["error"], {"code": "LIMIT", "message": "1 日 1 枚までです。"})
        self.assertEqual(records[2]["text"], "")
        md = (self.out / f"{month}.md").read_text("utf-8")
        self.assertIn("質問 — テスト委員", md)
        self.assertIn("文書(メール文面) — テスト委員", md)
        self.assertIn("- 状態: 失敗(LIMIT)", md)
        self.assertIn("> 1 日 1 枚までです。", md)
        self.assertNotIn("本人だけが読む下書き", md)
        self.assertNotIn("まだ待っている質問", md)
        self.assertNotIn("取り消した質問", md)
        self.assertTrue((self.out / "README.md").is_file())

    def test_only_known_input_fields_are_written(self):
        job = self.done("ask", {**self.ask(), "secretNote": "書かない"})
        self.export()
        record = self.records(job.created_at[:7])[0]
        self.assertEqual(set(record["input"]), {"question", "format", "model", "effort", "tone"})
        self.assertNotIn("書かない", (self.out / f"{job.created_at[:7]}.md").read_text("utf-8"))

    def test_answer_headings_are_quoted_so_they_do_not_break_the_page(self):
        job = self.done("ask", self.ask(), "# 見出し\n\n本文\n---")
        self.export()
        md = (self.out / f"{job.created_at[:7]}.md").read_text("utf-8")
        self.assertIn("> # 見出し\n>\n> 本文\n> ---", md)

    def test_files_are_copied_once_and_links_point_at_them(self):
        job = self.done("doc", {"docType": "report", "content": "報告", "format": "md", "useSources": False,
                                "model": "auto"}, files=[("【AI】報告.md", "中身".encode("utf-8"))])
        first = self.export()
        self.assertEqual(first["files_copied"], 1)
        copied = self.out / "files" / job.id / "【AI】報告.md"
        self.assertEqual(copied.read_text("utf-8"), "中身")
        md = (self.out / f"{job.created_at[:7]}.md").read_text("utf-8")
        self.assertIn(f"- ファイル: [【AI】報告.md](<files/{job.id}/【AI】報告.md>)", md)
        again = self.export(full=True)
        self.assertEqual(again["files_copied"], 0)   # 同じ大きさなら写し直さない

    def test_file_paths_outside_the_files_folder_are_not_copied(self):
        job = self.job("doc", {"docType": "free", "content": "x", "format": "md", "useSources": False,
                               "model": "auto"})
        self.store.claim_next(("doc",))
        outside = self.dir / "local" / "secret.txt"
        outside.write_text("外", encoding="utf-8")
        self.store.add_file(job.id, "secret.txt", "text/plain", 3, "0" * 64, "../secret.txt")
        self.store.finish(job.id, {"text": "", "files": []}, None)
        stats = self.export()
        self.assertEqual(stats["files_copied"], 0)
        self.assertFalse((self.out / "files").exists())

    def test_nothing_new_means_nothing_written(self):
        job = self.done("ask", self.ask())
        self.export()
        path = self.out / f"{job.created_at[:7]}.md"
        before = path.stat().st_mtime_ns
        stats = self.export()
        self.assertEqual(stats, {"months": [], "jobs": 0, "files_copied": 0})
        self.assertEqual(path.stat().st_mtime_ns, before)

    def test_only_months_with_new_jobs_are_rewritten(self):
        old = self.done("ask", self.ask("10 月の質問"))
        self.set_times(old.id, "2026-10-05T10:00:00+09:00")
        new = self.done("ask", self.ask("11 月の質問"))
        self.set_times(new.id, "2026-11-20T10:00:00+09:00")
        self.assertEqual(self.export()["months"], ["2026-10", "2026-11"])
        later = self.done("ask", self.ask("11 月の次の質問"))
        self.set_times(later.id, "2026-11-21T10:00:00+09:00")
        stats = self.export()
        self.assertEqual(stats["months"], ["2026-11"])
        self.assertEqual([r["id"] for r in self.records("2026-11")], [new.id, later.id])
        self.assertEqual([r["id"] for r in self.records("2026-10")], [old.id])

    def test_a_job_finishing_in_the_same_second_as_the_cursor_is_not_lost(self):
        first = self.done("ask", self.ask("1 つ目"))
        self.set_times(first.id, "2026-11-21T10:00:00+09:00")
        self.export()
        second = self.done("ask", self.ask("2 つ目"))
        self.set_times(second.id, "2026-11-21T10:00:00+09:00")   # カーソルと同じ秒
        stats = self.export()
        self.assertEqual(stats["jobs"], 2)
        self.assertEqual([r["id"] for r in self.records("2026-11")], [first.id, second.id])

    def test_missing_parent_folder_writes_nothing(self):
        # ドライブのマウントが外れている(_目録 が見えない)ときは、マウント先のローカルに作らない
        self.done("ask", self.ask())
        shutil.rmtree(self.drive)
        with self.assertRaises(H.ExportError):
            self.export()
        self.assertFalse(self.drive.exists())
        self.assertFalse(self.state.exists())   # カーソルを進めない

    def test_empty_parent_folder_writes_nothing(self):
        # 本番は _目録 そのものをマウントしている。外れると空のマウント先だけが残るので、空なら書かない
        self.done("ask", self.ask())
        (self.drive / "INDEX.md").unlink()   # 空のマウント先だけが残った形
        with self.assertRaises(H.ExportError):
            self.export()
        self.assertEqual(list(self.drive.iterdir()), [])
        self.assertFalse(self.state.exists())

    def test_broken_state_starts_over(self):
        job = self.done("ask", self.ask())
        self.export()
        self.state.write_text("壊れた", encoding="utf-8")
        self.assertEqual(self.export()["months"], [job.created_at[:7]])

    def test_cli_runs_and_reports(self):
        self.done("ask", self.ask())
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = H.main(["--store", str(self.store_path), "--files", str(self.files_dir), "--out", str(self.out)])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out.getvalue())["jobs"], 1)
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            code = H.main(["--store", str(self.store_path), "--files", str(self.files_dir),
                           "--out", str(self.dir / "無い" / "Bot履歴")])
        self.assertEqual(code, 1)
        self.assertIn("書き出せませんでした", err.getvalue())


if __name__ == "__main__":
    unittest.main()
