"""議事録の処理役の単体試験（python -m unittest test_minutes_worker.py）。音声のモデルと Claude は使わない。"""
import hashlib
import hmac
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

# リポジトリの根から python -m unittest app/deploy/minutes-worker/test_minutes_worker.py でも読めるように。
sys.path.insert(0, str(Path(__file__).resolve().parent))
import minutes_worker as w  # noqa: E402

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

    def test_summary_is_told_the_committee_words(self):
        job = {"title": "役員会", "heldOn": "2026-11-07", "glossary": ["協賛", "渉外課", "協賛", " ", "合成 太郎"],
               "review": {"id": 1, "comment": "直して", "draft": {}, "body": "", "earlier": []}}
        for prompt in (w.build_prompt(job, ["[00:00:00|0] 共産の依頼"], 1, 1), w.build_revise_prompt(job, ["[00:00:00|0] 共産の依頼"], 1, 1)):
            rule = next(line for line in prompt.splitlines() if "正しい表記" in line)
            self.assertTrue(rule.endswith(": 協賛、渉外課、合成 太郎"), rule)
            self.assertIn("quote だけは文字起こしのまま", rule)
        # 用語集が無い（古いアプリ）ときは、その行ごと無い。
        bare = w.build_prompt({**job, "glossary": []}, ["[00:00:00|0] あ"], 1, 1)
        self.assertNotIn("正しい表記", bare)
        self.assertIn("unclear に書く。\n- 個人の事情", bare)

    def test_summary_glossary_is_cut_short(self):
        rule = w.glossary_rule(["名前%d" % i for i in range(1000)])
        words = rule.rstrip("\n").split(": ", 1)[1].split("、")
        self.assertLessEqual(sum(len(x) + 1 for x in words), w.SUMMARY_GLOSSARY_CHARS)
        self.assertEqual(words[0], "名前0")

    def test_a_copy_of_the_glossary_is_not_a_line(self):
        words = ["医薬祭", "役員会", "協賛", "山田 花子", "医薬祭実行委員会"]
        prompt = w.glossary_prompt(words)
        # 2026-11-08 の本物の録音で large-v3 が書いた形（読点が入ったものも）と、用語が続いた形は捨てる。
        for text in ("医薬祭実行委員会の会議。", "医薬祭、実行委員会の会議。", " 役員会、協賛、山田花子。 "):
            self.assertTrue(w.echoes_prompt(text, prompt, words), text)
        # 用語 1 つだけ（長い用語も）・短い返事・プロンプトに無い言葉が付いた文は発言として残す。
        for text in ("協賛。", "山田 花子", "医薬祭実行委員会。", "会議。", "医薬祭実行委員会の会議です。", "協賛の件です"):
            self.assertFalse(w.echoes_prompt(text, prompt, words), text)

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

    def test_transcribe_drops_the_copies_of_the_glossary(self):
        class Seg:
            def __init__(self, start, end, text):
                self.start, self.end, self.text = start, end, text

        class Model:
            def transcribe(self, samples, **kw):
                return iter([Seg(18.0, 52.0, "医薬祭実行委員会の会議。"), Seg(53.0, 54.0, "協賛。"), Seg(55.0, 56.0, "始めます")]), None

        job = {"id": "mt_1", "audio": {"ext": "wav"}, "glossary": ["協賛"]}
        windows = [(0.0, np.zeros(16000 * 60, dtype=np.float32))]
        with mock.patch.object(w, "whisper_model", return_value=(Model(), "large-v3")), mock.patch.object(w, "audio_windows", return_value=iter(windows)):
            r = w.transcribe(mock.Mock(), job)
        self.assertEqual([x["text"] for x in r["segments"]], ["協賛。", "始めます"])


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


class Confidence(unittest.TestCase):
    """文ごとの確からしさ（2026-11-06。画面の「聞き直し」が使う）。"""

    class Word:
        def __init__(self, start, end, word, probability):
            self.start, self.end, self.word, self.probability = start, end, word, probability

    class Seg:
        def __init__(self, start, end, text, words=None, lp=-0.13, ns=0.48, cr=1.5):
            self.start, self.end, self.text, self.words = start, end, text, words
            self.avg_logprob, self.no_speech_prob, self.compression_ratio = lp, ns, cr

    def test_keeps_the_weak_words_with_the_window_start(self):
        W = self.Word
        words = [W(0.0, 0.4, " 共", 0.31), W(0.4, 0.8, "産", 0.18), W(0.8, 1.2, "の", 0.99), W(1.2, 1.5, "x", float("nan"))]
        words += [W(2.0 + i, 2.5 + i, f"w{i}", 0.4 - i / 100) for i in range(10)]
        c = w.confidence_of(self.Seg(0.0, 3.0, "共産の", words), 600.0)
        self.assertEqual(c["logprob"], -0.13)
        self.assertEqual(len(c["weak"]), w.WEAK_WORDS_MAX)
        # The lowest are kept, in the order they were said, with the time in the whole recording.
        self.assertEqual(c["weak"][0], {"start": 600.0, "end": 600.4, "word": "共", "p": 0.31})
        self.assertEqual(c["weak"][1]["word"], "産")
        self.assertEqual([x["start"] for x in c["weak"]], sorted(x["start"] for x in c["weak"]))
        self.assertNotIn("の", [x["word"] for x in c["weak"]])

    def test_without_numbers_or_word_timings(self):
        self.assertIsNone(w.confidence_of(self.Seg(0, 1, "x", lp=float("-inf")), 0.0))
        c = w.confidence_of(self.Seg(0, 1, "x", words=None, lp=-200.0, ns=1.5, cr=5000.0), 0.0)
        self.assertEqual(c, {"logprob": -100.0, "noSpeech": 1.0, "compression": 1000.0})

    @unittest.skipIf(np is None, "numpy が無い")
    def test_transcribe_takes_word_timings_unless_turned_off(self):
        Seg = self.Seg

        class Model:
            def transcribe(self, samples, **kw):
                self.kw = kw
                return iter([Seg(1.0, 2.0, "はい", [Confidence.Word(1.0, 1.5, "は", 0.2)])]), None

        model = Model()
        job = {"id": "mt_1", "audio": {"ext": "wav"}, "glossary": []}

        def windows():
            return iter([(0.0, np.zeros(16000 * 3, dtype=np.float32))])

        with mock.patch.object(w, "whisper_model", return_value=(model, "large-v3")), mock.patch.object(w, "audio_windows", return_value=windows()):
            r = w.transcribe(mock.Mock(), job)
        self.assertTrue(model.kw["word_timestamps"])
        self.assertEqual(r["segments"][0]["confidence"]["weak"], [{"start": 1.0, "end": 1.5, "word": "は", "p": 0.2}])
        with mock.patch.dict("os.environ", {"WHISPER_WORD_TIMESTAMPS": "0"}), mock.patch.object(w, "whisper_model", return_value=(model, "large-v3")), \
                mock.patch.object(w, "audio_windows", return_value=windows()):
            w.transcribe(mock.Mock(), job)
        self.assertFalse(model.kw["word_timestamps"])


class SendBack(unittest.TestCase):
    """差し戻しのコメントに沿った手直し（2026-11-06）。"""

    def job(self, segments=None):
        return {"id": "mt_0000000000000001", "stage": "summarize", "leaseToken": "t" * 24, "title": "役員会", "heldOn": "2026-11-06",
                "transcript": {"segments": segments or [{"start": 0, "end": 1, "text": "はい"}, {"start": 300, "end": 306, "text": "協賛の依頼文は総務部が作ります", "checked": True}]},
                "review": {"id": 7, "comment": "期限を 11/20 と書いて", "draft": {"summary": "前の要点", "decisions": [{"text": "依頼文は総務部"}]},
                           "body": "# 役員会\n- 出席者: 合成 太郎\n", "earlier": [{"comment": "要点を短く", "reply": "短くしました"}]}}

    def test_the_rework_reads_the_comment_and_answers_it(self):
        app = mock.Mock()
        app.post.side_effect = [{"job": self.job()}, {"ok": True}]
        answer = '{"summary": "要点", "decisions": [{"text": "依頼文は総務部が 11/20 まで", "evidence": []}], "reply": "期限を足しました。"}'
        with mock.patch.object(w, "ask_claude", return_value=answer) as ask:
            self.assertTrue(w.run_once(app, ["summarize"]))
        prompt = ask.call_args.args[0]
        for text in ("期限を 11/20 と書いて", "前の要点", "- 出席者: 合成 太郎", "要点を短く", "短くしました", "［確認済み］ 協賛の依頼文", '"reply"'):
            self.assertIn(text, prompt)
        sent = app.post.call_args_list[1].args[1]
        self.assertEqual(sent["reviewId"], 7)
        self.assertEqual(sent["reply"], "期限を足しました。")
        self.assertEqual(sent["draft"]["decisions"][0]["text"], "依頼文は総務部が 11/20 まで")
        self.assertNotIn("reply", sent["draft"])

    def test_a_failed_rework_says_so(self):
        app = mock.Mock()
        app.post.side_effect = [{"job": self.job()}, {"ok": True}]
        with mock.patch.object(w, "ask_claude", side_effect=RuntimeError("CLI なし")):
            w.run_once(app, ["summarize"])
        sent = app.post.call_args_list[1].args[1]
        self.assertIn("差し戻しの手直しに失敗しました", sent["error"])
        self.assertNotIn("reviewId", sent)

    def test_the_answers_of_the_parts_are_numbered(self):
        long = [{"start": i, "end": i + 1, "text": "あ" * 900} for i in range(150)]
        with mock.patch.object(w, "ask_claude", side_effect=lambda p: '{"summary": "s", "reply": "直した"}'):
            draft, reply = w.summarize_with_reply(self.job(long))
        self.assertTrue(reply.startswith("（第1部分）直した （第2部分）直した"))
        self.assertIn("（第1部分）s", draft["summary"])

    def test_lines_emptied_by_a_person_are_not_sent(self):
        lines = w.transcript_lines([{"start": 0, "end": 1, "text": ""}, {"start": 2, "end": 3, "text": "はい", "checked": True}])
        self.assertEqual(lines, ["[00:00:02|2]［確認済み］ はい"])


def synthetic_segments(n, empty=(), checked=()):
    """合成の文字起こし（10 秒ごとに 1 文）。本物の会議の文言は使わない（公開リポジトリのため）。"""
    return [{"start": i * 10.0, "end": i * 10.0 + 8.0, "text": "" if i in empty else f"合成の発言{i}です", **({"checked": True} if i in checked else {})}
            for i in range(n)]


def suggest_job(segments, targets, hints=None, glossary=None):
    return {"id": "mt_0000000000000002", "stage": "suggest", "leaseToken": "t" * 24, "title": "合成の会議", "heldOn": "2026-11-10", "audio": None,
            "glossary": glossary or [], "transcript": {"segments": segments, "durationSec": len(segments) * 10.0, "model": "large-v3"},
            "suggest": {"targets": targets, "hints": hints or [], "done": 0, "total": len(targets)}}


def prompt_of(job, answer='{"s": []}'):
    """job で suggest を動かし、Claude に渡った指示文を返す（Claude は偽物）。"""
    with mock.patch.object(w, "ask_claude", return_value=answer) as ask:
        w.suggest(job)
    return ask.call_args.args[0]


def transcript_part(prompt):
    return [line for line in prompt.split("文字起こし（[#番号", 1)[1].splitlines()[1:] if line]


def notes_part(prompt):
    return prompt.split("要確認のメモ（[時:分:秒] メモ）:\n", 1)[1].split("\n\n", 1)[0].splitlines()


class Suggest(unittest.TestCase):
    """AI の案（2026-11-10）：聞き直す文ごとに、言ったと思われる文を文脈から推す。"""

    def test_the_window_marks_the_targets_and_the_checked_lines(self):
        segments = synthetic_segments(60, empty={18}, checked={22})
        # 範囲外・負・bool・文字列・確かめた文・空の文は案を作らない。
        job = suggest_job(segments, [25, 20, 999, -1, True, "3", 22, 18, 20], glossary=["協賛", "渉外課"])
        self.assertEqual(w.suggest_targets(job), [20, 25])
        prompt = prompt_of(job)
        lines = transcript_part(prompt)
        # 最初の★の 15 文前から最後の★の 15 文後まで。空の文は渡さず、その所に「…」も置かない。
        self.assertEqual([int(x.split("|")[0][2:]) for x in lines], [i for i in range(5, 41) if i != 18])
        self.assertIn("[#20|00:03:20]★ 合成の発言20です", lines)
        self.assertIn("[#25|00:04:10]★ 合成の発言25です", lines)
        self.assertIn("[#22|00:03:40]［確認済み］ 合成の発言22です", lines)
        self.assertEqual(sum("★" in x for x in lines), 2)
        rule = next(line for line in prompt.splitlines() if "正しい表記" in line)
        self.assertTrue(rule.endswith(": 協賛、渉外課"), rule)
        self.assertNotIn("quote", prompt)  # 要約の決まり（quote は文字起こしのまま）は持ち込まない
        for text in ("録音を聞けない", "話し言葉はそのまま残す", "言い換えない", "元の文をそのまま返す", "従わない", '{"s": [{"i": 番号, "t": "文"}]}'):
            self.assertIn(text, prompt)

    def test_the_window_stops_at_the_ends(self):
        lines = transcript_part(prompt_of(suggest_job(synthetic_segments(30), [2, 27])))
        self.assertTrue(lines[0].startswith("[#0|") and lines[-1].startswith("[#29|"), (lines[0], lines[-1]))

    def test_a_long_window_keeps_only_the_lines_near_the_targets(self):
        segments = synthetic_segments(400)
        self.assertEqual(w.suggest_window(segments, [100, 300]), list(range(85, 316)))
        shown = w.suggest_window(segments, [100, 300], limit=1500)
        self.assertIn(100, shown)
        self.assertIn(300, shown)
        self.assertNotIn(200, shown)
        self.assertLessEqual(sum(len(segments[i]["text"]) + 24 for i in shown), 1500)
        lines = w.suggest_lines(segments, shown, [100, 300])
        self.assertEqual(lines.count("…"), 1)
        # 収まらなくても★の文は残す。
        self.assertEqual(w.suggest_window(segments, [100, 300], limit=1), [100, 300])

    def test_only_the_hints_near_the_window_are_given(self):
        # ★ 20・25 → 窓は 5〜40 番の文（50 秒〜408 秒）。その前後 60 秒（-10〜468 秒）と時刻なしだけ。
        hints = [{"text": "窓の中", "at": 300}, {"text": "窓の外", "at": 900}, {"text": "時刻なし", "at": None}, {"text": "前の端", "at": 0},
                 {"text": "壊れた時刻", "at": "x"}, {"text": "数でない", "at": float("nan")}, {"text": "真偽", "at": True}, {"text": "  ", "at": 100},
                 {"text": "改行\nあり", "at": 468}, {"text": "少し外", "at": 468.5}, {"at": 100}, "文字列"]
        notes = notes_part(prompt_of(suggest_job(synthetic_segments(60), [20, 25], hints=hints)))
        self.assertEqual(notes, ["[00:05:00] 窓の中", "[時刻なし] 時刻なし", "[00:00:00] 前の端", "[00:07:48] 改行 あり"])
        many = [{"text": f"メモ{i}", "at": None} for i in range(40)]
        self.assertEqual(len(notes_part(prompt_of(suggest_job(synthetic_segments(60), [20], hints=many)))), w.SUGGEST_HINTS_MAX)
        self.assertEqual(notes_part(prompt_of(suggest_job(synthetic_segments(60), [20]))), ["なし"])

    def test_the_answer_is_checked(self):
        segments = synthetic_segments(60)
        segments[20]["text"] = "共産の依頼を出します"
        segments[21]["text"] = "合成の 発言21です "
        job = suggest_job(segments, [1, 20, 21, 22, 23, 24, 26, 28])
        answer = {"s": [
            {"i": 20, "t": "協賛の依頼を出します"},
            {"i": 21, "t": " 合成の 発言21です\n"},  # 直さず（空白と改行の違いだけ）
            {"i": 22, "t": "一つ目"}, {"i": 22, "t": "二つ目"},  # 同じ番号は先のもの
            {"i": 23, "t": ""}, {"i": 23, "t": " \n "},  # 空は捨てる
            {"i": 24, "t": 5}, {"i": 24, "t": "あ" * 1500},  # 文字列でないものは捨て、長すぎるものは切る
            {"i": "#26", "t": "改行\nを含む\r\n案"},
            {"i": 25, "t": "頼んでいない"}, {"i": 999, "t": "範囲外"}, {"i": -1, "t": "負"}, {"i": True, "t": "真偽"}, {"i": 2.5, "t": "小数"},
            "文字列", {"t": "番号なし"},
        ]}
        with mock.patch.object(w, "ask_claude", return_value="説明\n```json\n" + json.dumps(answer, ensure_ascii=False) + "\n```"):
            got = w.suggest(job)
        self.assertEqual(got, [
            {"index": 20, "heard": "共産の依頼を出します", "text": "協賛の依頼を出します"},
            {"index": 21, "heard": "合成の 発言21です ", "text": "合成の 発言21です "},  # text は渡された文そのまま
            {"index": 22, "heard": "合成の発言22です", "text": "一つ目"},
            {"index": 24, "heard": "合成の発言24です", "text": "あ" * w.SUGGEST_TEXT_CHARS},
            {"index": 26, "heard": "合成の発言26です", "text": "改行 を含む 案"},
        ])

    def test_an_answer_without_the_list_is_a_failure(self):
        job = suggest_job(synthetic_segments(30), [10])
        for answer in ('{"x": 1}', '{"s": {"i": 10}}', "JSON なし"):
            with mock.patch.object(w, "ask_claude", return_value=answer), self.assertRaises(RuntimeError):
                w.suggest(job)

    def test_nothing_to_guess_needs_no_ai(self):
        job = suggest_job(synthetic_segments(30, empty={3}, checked={4}), [3, 4, 50])
        with mock.patch.object(w, "ask_claude") as ask:
            self.assertEqual(w.suggest(job), [])
        ask.assert_not_called()


class SuggestClaim(unittest.TestCase):
    """AI の案の頼み方（2026-11-10）：会議の段が先、無いときだけ suggest を別に。古いアプリの 401 では 10 分止まる。"""

    def setUp(self):
        self.now = [1000.0]
        self.gate = w.SuggestGate(clock=lambda: self.now[0])
        env = mock.patch.dict("os.environ", {"MINUTES_SUGGEST": "1"})
        env.start()
        self.addCleanup(env.stop)

    def claims(self, app):
        return [c.args[1]["stages"] for c in app.post.call_args_list if c.args[0] == w.PATHS["claim"]]

    def test_when_suggest_is_taken(self):
        import os

        cases = [(["summarize"], "1", True), (["summarize"], "0", False), (["summarize"], " 0 ", False), (["transcribe"], "1", False),
                 (["transcribe", "summarize"], "1", True), (["suggest"], "1", True), ([], "1", False)]
        for stages, value, expected in cases:
            with mock.patch.dict("os.environ", {"MINUTES_SUGGEST": value}):
                self.assertEqual(w.suggest_enabled(stages), expected, (stages, value))
        with mock.patch.dict("os.environ"):
            os.environ.pop("MINUTES_SUGGEST", None)
            self.assertTrue(w.suggest_enabled(["summarize"]))  # 既定は受け持つ
        self.assertEqual(w.stages_from("transcribe, summarize,suggest,whisper"), ["transcribe", "summarize", "suggest"])

    def test_the_meeting_stages_come_first(self):
        job = suggest_job(synthetic_segments(30), [10])
        app = mock.Mock()
        app.notify.return_value = 200
        app.post.side_effect = [{"job": None}, {"job": job}, {"ok": True}, {"job": None}, {"job": None}]
        with mock.patch.object(w, "ask_claude", return_value='{"s": [{"i": 10, "t": "合成の案"}]}'):
            self.assertTrue(w.run_once(app, ["summarize"], self.gate))
        self.assertFalse(w.run_once(app, ["summarize"], self.gate))
        # 2 回目も会議の段から聞く。
        self.assertEqual(self.claims(app), [["summarize"], ["suggest"], ["summarize"], ["suggest"]])
        sent = app.post.call_args_list[2].args
        self.assertEqual(sent[0], w.PATHS["result"])
        self.assertEqual(sent[1], {"id": job["id"], "leaseToken": job["leaseToken"], "stage": "suggest",
                                   "suggestions": [{"index": 10, "heard": "合成の発言10です", "text": "合成の案"}]})
        # Claude を待つ前に 1 回だけ知らせる（借りを延ばす）。
        self.assertEqual([c.args[1] for c in app.notify.call_args_list],
                         [{"id": job["id"], "leaseToken": job["leaseToken"], "stage": "suggest", "done": 0, "total": 1.0}])

    def test_suggest_waits_while_there_is_meeting_work_and_is_not_mixed_in(self):
        summarize = {"id": "mt_0000000000000001", "stage": "summarize", "leaseToken": "t" * 24, "title": "t", "heldOn": "2026-11-10",
                     "transcript": {"segments": [{"start": 0, "end": 1, "text": "はい"}]}}
        app = mock.Mock()
        app.post.side_effect = [{"job": summarize}, {"ok": True}]
        with mock.patch.object(w, "ask_claude", return_value='{"summary": "x"}'):
            self.assertTrue(w.run_once(app, ["summarize", "suggest"], self.gate))
        self.assertEqual(self.claims(app), [["summarize"]])

    def test_who_asks_for_suggest(self):
        for stages, value, expected in ((["transcribe"], "1", [["transcribe"]]), (["summarize"], "0", [["summarize"]]),
                                        (["suggest"], "1", [["suggest"]]), ([], "1", [])):
            app = mock.Mock()
            app.post.return_value = {"job": None}
            with mock.patch.dict("os.environ", {"MINUTES_SUGGEST": value}):
                self.assertFalse(w.run_once(app, stages, self.gate))
            self.assertEqual(self.claims(app), expected, (stages, value))

    def test_an_old_app_pauses_suggest_for_ten_minutes(self):
        def post(path, payload):
            if payload == {"stages": ["suggest"]}:
                raise RuntimeError('アプリが 401 を返しました: {"error":"rejected"}')
            return {"job": None}

        app = mock.Mock()
        app.post.side_effect = post
        with self.assertLogs(w.log, "INFO") as logs:
            self.assertFalse(w.run_once(app, ["summarize"], self.gate))
            for t in (1300.0, 1599.0):
                self.now[0] = t
                self.assertFalse(w.run_once(app, ["summarize"], self.gate))
            self.now[0] = 1600.0
            self.assertFalse(w.run_once(app, ["summarize"], self.gate))
        # 会議の段は毎回聞き、suggest は 10 分たってから聞き直す。
        self.assertEqual(self.claims(app), [["summarize"], ["suggest"], ["summarize"], ["summarize"], ["summarize"], ["suggest"]])
        self.assertEqual(sum("受け付けません" in x for x in logs.output), 1)
        self.assertTrue(self.gate.closed())

    def test_other_errors_are_not_taken_for_an_old_app(self):
        app = mock.Mock()
        app.post.side_effect = [{"job": None}, RuntimeError("アプリが 500 を返しました: x")]
        with self.assertRaises(RuntimeError):
            w.run_once(app, ["summarize"], self.gate)
        self.assertFalse(self.gate.closed())

    def test_a_failed_guess_says_so(self):
        job = suggest_job(synthetic_segments(30), [10])
        app = mock.Mock()
        app.notify.return_value = 200
        app.post.side_effect = [{"job": None}, {"job": job}, {"ok": True}]
        with mock.patch.object(w, "ask_claude", side_effect=RuntimeError("CLI なし")):
            self.assertTrue(w.run_once(app, ["summarize"], self.gate))
        sent = app.post.call_args_list[2].args[1]
        self.assertEqual(sent["stage"], "suggest")
        self.assertIn("AI の案づくりに失敗しました: CLI なし", sent["error"])
        self.assertNotIn("suggestions", sent)


if __name__ == "__main__":
    unittest.main()
