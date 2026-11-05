"""議事録の処理役の単体試験（python -m unittest test_minutes_worker.py）。音声のモデルと Claude は使わない。"""
import hashlib
import hmac
import unittest
from unittest import mock

import minutes_worker as w

KEY_HEX = "0123456789abcdef" * 4


class Signing(unittest.TestCase):
    def test_parse_key_hex_and_base64url(self):
        self.assertEqual(w.parse_key(KEY_HEX), bytes.fromhex(KEY_HEX))
        self.assertEqual(w.parse_key("﻿" + KEY_HEX + "\n"), bytes.fromhex(KEY_HEX))
        b64 = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
        self.assertEqual(w.parse_key(b64), bytes(range(32)))
        with self.assertRaises(ValueError):
            w.parse_key("00" * 32)  # 同じバイトだけ
        with self.assertRaises(ValueError):
            w.parse_key("abcd")

    def test_signature_is_hmac_of_the_canonical_string(self):
        key = bytes.fromhex(KEY_HEX)
        body = b'{"stages":["transcribe"]}'
        h = w.signed_headers(key, "POST", w.PATHS["claim"], body, now_ms=1_762_000_000_000)
        text = "\n".join(["svc-auth/v1", w.CLIENT, "POST", w.PATHS["claim"], "1762000000000", h["x-svc-nonce"], "", hashlib.sha256(body).hexdigest()])
        self.assertEqual(h["x-svc-signature"], hmac.new(key, text.encode(), hashlib.sha256).hexdigest())
        self.assertNotIn("x-svc-actor", h)


class Summary(unittest.TestCase):
    def test_glossary_is_cut_short(self):
        p = w.glossary_prompt(["名前%d" % i for i in range(500)])
        self.assertLessEqual(len(p), w.GLOSSARY_CHARS + 2)
        self.assertTrue(p.startswith("医薬祭実行委員会の会議。"))

    def test_split_parts_keeps_every_line(self):
        lines = ["あ" * 100 for _ in range(50)]
        parts = w.split_parts(lines, limit=1000)
        self.assertGreater(len(parts), 1)
        self.assertEqual(sum(len(x) for x in parts), 50)

    def test_extract_json_from_a_fenced_answer(self):
        self.assertEqual(w.extract_json('説明\n```json\n{"summary": "x"}\n```'), {"summary": "x"})
        with self.assertRaises(RuntimeError):
            w.extract_json("JSON なし")

    def test_clean_draft_drops_what_does_not_fit(self):
        d = w.clean_draft({
            "summary": " 要点 ",
            "topics": [{"title": "協賛", "points": ["依頼文", 3], "evidence": [{"at": "12", "quote": "依頼文を送る"}, {"at": "x", "quote": "壊れ"}]}, {"title": ""}],
            "decisions": [{"text": "決定", "evidence": "違う型"}],
            "todos": [{"text": "作る", "assignee": None, "due": "11/20"}],
            "unclear": [{"text": "人名", "at": "bad"}],
            "extra": 1,
        })
        self.assertEqual(d["summary"], "要点")
        self.assertEqual(d["topics"], [{"title": "協賛", "points": ["依頼文"], "evidence": [{"at": 12.0, "quote": "依頼文を送る"}]}])
        self.assertEqual(d["decisions"], [{"text": "決定", "evidence": []}])
        self.assertEqual(d["todos"][0]["assignee"], "")
        self.assertEqual(d["unclear"], [{"text": "人名", "at": None}])
        self.assertNotIn("extra", d)

    def test_merge_concatenates_parts(self):
        a = w.clean_draft({"summary": "前半", "decisions": [{"text": "A"}]})
        b = w.clean_draft({"summary": "後半", "decisions": [{"text": "B"}]})
        m = w.merge_drafts([a, b])
        self.assertEqual([x["text"] for x in m["decisions"]], ["A", "B"])
        self.assertIn("第1部分", m["summary"])


try:
    import numpy as np
except ImportError:  # 要約だけの本番ホストの python3 には無い
    np = None
try:
    import av  # noqa: F401
except ImportError:
    av = None


@unittest.skipIf(np is None, "numpy が無い")
class Windows(unittest.TestCase):
    def test_quiet_cut_finds_the_silent_frame(self):
        s = np.full(16000, 3000, dtype=np.int16)
        s[9000:9400] = 0
        cut = w.quiet_cut(s, 8000, 400)
        self.assertGreaterEqual(cut, 9000)
        self.assertLess(cut, 9400)
        self.assertEqual(w.quiet_cut(s, 16000, 400), 16000)

    @unittest.skipIf(av is None, "av が無い")
    def test_windows_cut_at_silence_and_keep_every_sample(self):
        import tempfile
        import wave
        from pathlib import Path

        rate = w.SAMPLE_RATE
        t = np.arange(rate * 25) / rate
        s = (np.sin(2 * np.pi * 440 * t) * 8000).astype(np.int16)
        s[int(rate * 7.5):int(rate * 8.0)] = 0  # 1 つ目の窓（10 秒）の終わり 4 秒の中の無音
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "a.wav"
            with wave.open(str(path), "wb") as f:
                f.setnchannels(1)
                f.setsampwidth(2)
                f.setframerate(rate)
                f.writeframes(s.tobytes())
            got = list(w.audio_windows(path, window_sec=10, search_sec=4))
        self.assertGreaterEqual(len(got), 3)
        self.assertEqual(got[0][0], 0)
        self.assertGreaterEqual(got[1][0], 7.5)
        self.assertLess(got[1][0], 8.0)
        for (a, x), (b, _) in zip(got, got[1:]):
            self.assertAlmostEqual(a + x.shape[0] / rate, b)
            self.assertLessEqual(x.shape[0], 10 * rate)
        self.assertEqual(sum(x.shape[0] for _, x in got), s.shape[0])
        self.assertEqual(got[0][1].dtype, np.float32)

    @unittest.skipIf(av is None, "av が無い")
    def test_a_broken_first_aac_frame_does_not_drop_the_rest(self):
        # 2026-11-05 の実例：先頭に中身 2 バイトの ADTS フレーム（9 バイト）がある録音が 0 秒になった。
        import io
        import tempfile
        from pathlib import Path

        buf = io.BytesIO()
        with av.open(buf, "w", format="adts") as out:
            st = out.add_stream("aac", rate=48000, layout="stereo")
            t = np.arange(48000 * 12) / 48000
            x = (0.2 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)
            for i in range(0, len(x), 1024):
                fr = av.AudioFrame.from_ndarray(np.stack([x[i:i + 1024]] * 2), format="fltp", layout="stereo")
                fr.sample_rate = 48000
                fr.pts = i
                for p in st.encode(fr):
                    out.mux(p)
            for p in st.encode(None):
                out.mux(p)
        broken_head = bytes.fromhex("fff94c80013ffc1190")
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "a.aac"
            path.write_bytes(broken_head + buf.getvalue())
            got = list(w.audio_windows(path, window_sec=5, search_sec=2))
        self.assertGreater(sum(x.shape[0] for _, x in got) / w.SAMPLE_RATE, 11.5)

    def test_transcribe_adds_the_window_start(self):
        class Seg:
            def __init__(self, start, end, text):
                self.start, self.end, self.text = start, end, text

        class Model:
            def transcribe(self, samples, **kw):
                self.kw = kw
                return iter([Seg(1.0, 2.5, " はい "), Seg(3.0, float("inf"), "壊れ"), Seg(4.0, 4.0, " ")]), None

        model = Model()
        windows = [(0.0, np.zeros(16000 * 10, dtype=np.float32)), (9.6, np.zeros(16000 * 5, dtype=np.float32))]
        app = mock.Mock()
        job = {"id": "mt_1", "audio": {"ext": "wav"}, "glossary": ["協賛"]}
        with mock.patch.object(w, "whisper_model", return_value=(model, "large-v3")), mock.patch.object(w, "audio_windows", return_value=iter(windows)):
            r = w.transcribe(app, job)
        self.assertEqual([x["start"] for x in r["segments"]], [1.0, 10.6])
        self.assertEqual(r["segments"][1]["end"], 12.1)
        self.assertEqual(r["durationSec"], 14.6)
        self.assertFalse(model.kw["condition_on_previous_text"])
        self.assertIn("協賛", model.kw["initial_prompt"])


class ProgressReports(unittest.TestCase):
    JOB = {"id": "mt_0000000000000001", "stage": "transcribe", "leaseToken": "t" * 24}

    def test_reports_at_most_once_per_interval_unless_forced(self):
        app = mock.Mock()
        app.notify.return_value = 200
        now = [0.0]
        p = w.Progress(app, self.JOB, every=20, clock=lambda: now[0])
        p.report(0, 600.0, force=True)
        now[0] = 5
        p.report(30, 600.0)
        now[0] = 21
        p.report(60, 600.0)
        now[0] = 22
        p.report(90, 600.0, force=True)
        sent = [c.args[1] for c in app.notify.call_args_list]
        self.assertEqual([s["done"] for s in sent], [0, 60, 90])
        self.assertEqual(sent[0], {"id": self.JOB["id"], "leaseToken": self.JOB["leaseToken"], "stage": "transcribe", "done": 0, "total": 600.0})
        self.assertEqual(app.notify.call_args.args[0], w.PATHS["progress"])

    def test_an_old_app_or_a_lost_lease_stops_the_reports_and_errors_never_escape(self):
        for status in (403, 404, 409):
            app = mock.Mock()
            app.notify.return_value = status
            p = w.Progress(app, self.JOB, every=0)
            p.report(1, None)
            p.report(2, None)
            self.assertEqual(app.notify.call_count, 1)
        app = mock.Mock()
        app.notify.side_effect = RuntimeError("壊れた")
        p = w.Progress(app, self.JOB, every=0)
        p.report(1, float("nan"))
        p.report(float("inf"), None)
        p.report(2, None)
        self.assertEqual([c.args[1]["total"] for c in app.notify.call_args_list], [None, None])

    @unittest.skipIf(np is None, "numpy が無い")
    def test_transcription_reports_the_seconds_done_across_windows(self):
        class Seg:
            def __init__(self, start, end, text):
                self.start, self.end, self.text = start, end, text

        class Model:
            def transcribe(self, samples, **kw):
                return iter([Seg(1.0, 2.5, "はい")]), None

        windows = [(0.0, np.zeros(16000 * 10, dtype=np.float32)), (10.0, np.zeros(16000 * 5, dtype=np.float32))]
        app = mock.Mock()
        app.notify.return_value = 200
        with mock.patch.object(w, "whisper_model", return_value=(Model(), "large-v3")), mock.patch.object(w, "audio_windows", return_value=iter(windows)), \
                mock.patch.object(w, "audio_duration", return_value=15.0), mock.patch.object(w, "PROGRESS_EVERY_SEC", 3600):
            w.transcribe(app, dict(self.JOB, audio={"ext": "wav"}))
        sent = [(c.args[1]["done"], c.args[1]["total"]) for c in app.notify.call_args_list]
        # 始め（0）と、区切りの終わりごと（10 秒・15 秒）。間の発言ごとの知らせは間隔で間引かれる。
        self.assertEqual(sent, [(0, 15.0), (10.0, 15.0), (15.0, 15.0)])

    def test_summary_reports_the_parts_done(self):
        app = mock.Mock()
        app.notify.return_value = 200
        job = {"id": "mt_1", "stage": "summarize", "leaseToken": "t" * 24, "title": "t", "heldOn": "2026-11-05",
               "transcript": {"segments": [{"start": i, "end": i + 1, "text": "あ" * 1000} for i in range(150)]}}
        with mock.patch.object(w, "ask_claude", return_value='{"summary": "x"}'):
            w.summarize(job, w.Progress(app, job, every=3600))
        self.assertEqual([(c.args[1]["done"], c.args[1]["total"]) for c in app.notify.call_args_list], [(0, 3.0), (1, 3.0), (2, 3.0)])

    @unittest.skipIf(av is None or np is None, "av が無い")
    def test_duration_of_an_adts_recording_and_of_no_file(self):
        import tempfile
        from pathlib import Path

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "a.aac"
            with av.open(str(path), "w", format="adts") as out:
                st = out.add_stream("aac", rate=48000, layout="mono")
                x = (0.2 * np.sin(2 * np.pi * 440 * np.arange(48000 * 30) / 48000)).astype(np.float32)
                for i in range(0, len(x), 1024):
                    fr = av.AudioFrame.from_ndarray(x[i:i + 1024].reshape(1, -1), format="fltp", layout="mono")
                    fr.sample_rate = 48000
                    fr.pts = i
                    for p in st.encode(fr):
                        out.mux(p)
                for p in st.encode(None):
                    out.mux(p)
            self.assertAlmostEqual(w.audio_duration(path), 30.0, delta=0.2)
            self.assertIsNone(w.audio_duration(Path(tmp) / "無い.aac"))


class Loop(unittest.TestCase):
    def test_a_failure_is_reported_to_the_app(self):
        app = mock.Mock()
        app.post.side_effect = [{"job": {"id": "mt_0000000000000001", "stage": "summarize", "leaseToken": "t" * 24, "title": "役員会", "heldOn": "2026-11-02", "transcript": {"segments": [{"start": 0, "end": 1, "text": "はい"}]}}}, {"ok": True}]
        with mock.patch.object(w, "ask_claude", side_effect=RuntimeError("CLI なし")):
            self.assertTrue(w.run_once(app, ["summarize"]))
        sent = app.post.call_args_list[1].args
        self.assertEqual(sent[0], w.PATHS["result"])
        self.assertIn("要約に失敗しました", sent[1]["error"])

    def test_a_refused_result_is_reported_as_a_failure(self):
        app = mock.Mock()
        job = {"id": "mt_0000000000000001", "stage": "summarize", "leaseToken": "t" * 24, "title": "t", "heldOn": "2026-11-02", "transcript": {"segments": [{"start": 0, "end": 1, "text": "はい"}]}}
        app.post.side_effect = [{"job": job}, RuntimeError("アプリが 400 を返しました"), {"ok": True}]
        with mock.patch.object(w, "ask_claude", return_value='{"summary": "x"}'):
            self.assertTrue(w.run_once(app, ["summarize"]))
        last = app.post.call_args_list[2].args[1]
        self.assertIn("結果をアプリに送れませんでした", last["error"])
        self.assertNotIn("draft", last)

    def test_infinite_times_are_dropped(self):
        d = w.clean_draft({"decisions": [{"text": "A", "evidence": [{"at": "inf", "quote": "q"}, {"at": 1e9, "quote": "r"}]}], "unclear": [{"text": "u", "at": "nan"}]})
        self.assertEqual(d["decisions"][0]["evidence"], [{"at": 86400.0, "quote": "r"}])
        self.assertIsNone(d["unclear"][0]["at"])

    def test_unreadable_audio_is_a_failure_not_an_empty_draft(self):
        app = mock.Mock()
        job = {"id": "mt_0000000000000001", "stage": "transcribe", "leaseToken": "t" * 24, "audio": {"ext": "aac"}}
        app.post.side_effect = [{"job": job}, {"ok": True}]
        with mock.patch.object(w, "whisper_model", return_value=(mock.Mock(), "large-v3")), mock.patch.object(w, "audio_windows", return_value=iter([])):
            self.assertTrue(w.run_once(app, ["transcribe"]))
        sent = app.post.call_args_list[1].args[1]
        self.assertIn("文字起こしに失敗しました", sent["error"])
        self.assertIn("読み取れませんでした", sent["error"])
        self.assertNotIn("transcript", sent)

    def test_no_job(self):
        app = mock.Mock()
        app.post.return_value = {"job": None}
        self.assertFalse(w.run_once(app, ["transcribe"]))

    def test_empty_transcript_needs_no_ai(self):
        with mock.patch.object(w, "ask_claude") as ask:
            d = w.summarize({"id": "mt_1", "title": "t", "heldOn": "2026-11-02", "transcript": {"segments": []}})
        ask.assert_not_called()
        self.assertIn("発言がありませんでした", d["summary"])


if __name__ == "__main__":
    unittest.main()
