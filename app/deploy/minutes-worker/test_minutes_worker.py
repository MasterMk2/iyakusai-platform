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
