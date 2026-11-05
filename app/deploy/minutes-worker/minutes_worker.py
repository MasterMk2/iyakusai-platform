"""医薬祭 委員会アプリの議事録の処理役（α 2026-11-02）。

本番ホストで常駐し、アプリに「仕事はあるか」を聞きに行く（アプリからは呼ばない）。
  文字起こし: faster-whisper（このホストの CPU/GPU。音声は外に出さない）
  要約:       Claude Code CLI（ツールをすべて止めた純テキスト生成。渡すのは文字起こしのテキストだけ）
アプリとのやりとりは svc-auth/v1 の署名付き（クライアント iyakusai-minutes-worker、minutes.json と同じ鍵）。

設定は環境変数（systemd の EnvironmentFile。README.md を参照）:
  MINUTES_APP_URL      アプリの URL（例 https://app.example.org）
  MINUTES_KEY_FILE     鍵のファイル（600）
  MINUTES_STAGES       transcribe,summarize（既定は両方）
  WHISPER_MODEL        large-v3（既定） / medium / small
  WHISPER_DEVICE       auto / cpu / cuda
  WHISPER_COMPUTE      既定: cuda は float16、cpu は int8
  WHISPER_THREADS      CPU のスレッド数（0 は自動）
  CLAUDE_COMMAND       claude（既定）
  CLAUDE_MODEL         opus（既定）
  MINUTES_POLL_SEC     仕事が無いときの待ち（既定 30）
"""
from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import hmac
import json
import logging
import math
import os
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

log = logging.getLogger("minutes-worker")

CLIENT = "iyakusai-minutes-worker"
SIGNATURE_VERSION = "svc-auth/v1"
PATHS = {"claim": "/v1/minutes/worker/claim", "audio": "/v1/minutes/worker/audio", "result": "/v1/minutes/worker/result",
         "progress": "/v1/minutes/worker/progress"}
# 進み具合（画面の進捗バー）を知らせる間隔と、その待ち時間。知らせは届かなくても処理を止めない。
PROGRESS_EVERY_SEC = 20
PROGRESS_TIMEOUT_SEC = 10
# 録音の長さを測るのに使う時間の上限（超えたら入れ物に書かれた長さで代える）。
PROBE_LIMIT_SEC = 30
# 純テキスト生成なのでツールは全部止める（タスク候補のスクリーニングと同じ）。
# 文字起こしの中の言葉で AI が何かを実行しないよう、道具は書き出せるものを全部止め、利用者の MCP サーバーも読まない。
DENIED_TOOLS = ("Bash,Edit,MultiEdit,Write,NotebookEdit,Read,Glob,Grep,LS,WebFetch,WebSearch,Task,Agent,Skill,"
                "TodoWrite,BashOutput,KillShell,SlashCommand,ExitPlanMode")
# 古い CLI で使えない引数なら CLAUDE_EXTRA_ARGS を空にする（README の --once で確かめる）。
DEFAULT_EXTRA_ARGS = "--strict-mcp-config"
# 1 回の要約に渡す文字起こしの上限（これを超える会議は区切って要約し、つなぐ）。
PART_CHARS = 60_000
GLOSSARY_CHARS = 400
# 文字起こしは音声を区切って渡す。faster-whisper は渡された音声の特徴量を一度に計算し、音声 1 時間あたり約 3.4GB を
# 使う（2026-11-05 に手元で測定）。モデル（約 3.6GB）と合わせてコンテナの 6GB に収まるよう、10 分ずつにする。
SAMPLE_RATE = 16_000
WINDOW_SEC = 600
# 区切る位置は、10 分の手前 60 秒の中で一番静かな 0.2 秒（言葉の途中で切らないため）。
CUT_SEARCH_SEC = 60
CUT_FRAME_SEC = 0.2


# ---- 署名（src/server/tasks/signing.ts と同じ正規化文字列）

def parse_key(text: str) -> bytes:
    value = text.strip().lstrip("﻿")
    if re.fullmatch(r"[0-9a-fA-F]+", value) and len(value) % 2 == 0:
        key = bytes.fromhex(value)
    elif re.fullmatch(r"[A-Za-z0-9+/_-]+={0,2}", value):
        padded = value.replace("-", "+").replace("_", "/")
        padded += "=" * (-len(padded) % 4)
        try:
            key = base64.b64decode(padded)
        except binascii.Error as e:
            raise ValueError("鍵の形が正しくありません") from e
    else:
        raise ValueError("鍵の形が正しくありません")
    if len(key) < 32 or len(set(key)) == 1:
        raise ValueError("鍵は 32 バイト以上のランダムな値にしてください")
    return key


def canonical(client: str, method: str, path: str, timestamp: str, nonce: str, actor: str, body: bytes) -> str:
    return "\n".join([SIGNATURE_VERSION, client, method.upper(), path, timestamp, nonce, actor, hashlib.sha256(body).hexdigest()])


def signed_headers(key: bytes, method: str, path: str, body: bytes, now_ms: int | None = None) -> dict[str, str]:
    timestamp = str(now_ms if now_ms is not None else int(time.time() * 1000))
    nonce = secrets.token_urlsafe(18)
    sig = hmac.new(key, canonical(CLIENT, method, path, timestamp, nonce, "", body).encode("utf-8"), hashlib.sha256).hexdigest()
    return {"x-svc-client": CLIENT, "x-svc-timestamp": timestamp, "x-svc-nonce": nonce, "x-svc-signature": sig}


class App:
    def __init__(self, base: str, key: bytes, timeout: int = 120):
        self.base = base.rstrip("/")
        self.key = key
        self.timeout = timeout

    def _open(self, path: str, payload: dict, timeout: float | None = None):
        # allow_nan=False: Infinity や NaN はアプリが JSON として読めないので、送る前に止める。
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
        headers = {"Content-Type": "application/json", "User-Agent": "iyakusai-minutes-worker/1", **signed_headers(self.key, "POST", path, body)}
        req = urllib.request.Request(self.base + path, data=body, method="POST", headers=headers)
        return urllib.request.urlopen(req, timeout=timeout or self.timeout)

    def notify(self, path: str, payload: dict, timeout: float) -> int:
        """届かなくてもよい知らせ。HTTP の状態コードを返し、アプリに届かなければ 0（例外は出さない）。"""
        try:
            with self._open(path, payload, timeout) as res:
                res.read()
                return res.status
        except urllib.error.HTTPError as e:
            return e.code
        except Exception:
            return 0

    def post(self, path: str, payload: dict) -> dict:
        try:
            with self._open(path, payload) as res:
                return json.loads(res.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            detail = e.read()[:300].decode("utf-8", "replace")
            raise RuntimeError(f"アプリが {e.code} を返しました: {detail}") from None

    def download(self, job: dict, dest: Path) -> None:
        h = hashlib.sha256()
        n = 0
        try:
            with self._open(PATHS["audio"], {"id": job["id"], "leaseToken": job["leaseToken"]}) as res, open(dest, "wb") as f:
                while chunk := res.read(1024 * 1024):
                    h.update(chunk)
                    n += len(chunk)
                    f.write(chunk)
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"音声を受け取れませんでした（{e.code}）") from None
        audio = job["audio"]
        if n != audio["bytes"] or h.hexdigest() != audio["sha256"]:
            raise RuntimeError("受け取った音声が記録と一致しません（大きさか SHA-256）")


class Progress:
    """進み具合をアプリに知らせる（画面の進捗バー用）。文字起こしは音声の秒、要約は部分の数で数える。
    知らせは PROGRESS_EVERY_SEC に 1 回まで。届かなくても処理は続ける。進み具合を受け取らない古い版のアプリ（404）や、
    借りが切れた（409）ときは、それ以降知らせない。"""

    def __init__(self, app: App, job: dict, every: float | None = None, clock=time.monotonic):
        self.app, self.job, self.clock = app, job, clock
        self.every = PROGRESS_EVERY_SEC if every is None else every
        self.last: float | None = None
        self.off = False
        self.warned = False

    def report(self, done: float, total: float | None, force: bool = False) -> None:
        if self.off:
            return
        t = self.clock()
        if not force and self.last is not None and t - self.last < self.every:
            return
        self.last = t
        try:
            if not math.isfinite(done):
                return
            payload = {"id": self.job.get("id"), "leaseToken": self.job.get("leaseToken"), "stage": self.job.get("stage"), "done": round(max(0.0, float(done)), 2),
                       "total": None if total is None or not math.isfinite(total) or total <= 0 else round(float(total), 2)}
            status = self.app.notify(PATHS["progress"], payload, PROGRESS_TIMEOUT_SEC)
        except Exception:  # 知らせのために文字起こし・要約を失敗させない
            status = 0
        if status in (404, 409):
            self.off = True
            log.info("進み具合は知らせません（アプリの答え %s）: %s", status, self.job["id"])
        elif status != 200 and not self.warned:
            self.warned = True
            log.warning("進み具合をアプリに知らせられませんでした（%s）。処理は続けます", status or "届かない")


def audio_duration(path: Path, limit_sec: float = PROBE_LIMIT_SEC) -> float | None:
    """録音の長さ（秒）。分からなければ None（進捗バーが割合を出さないだけ）。
    デコードせずにパケットを最後までたどって測る（ADTS の AAC は入れ物に長さが無く、ffmpeg の値はビットレートからの推定。
    ブラウザの webm にも長さが書かれていないことがある）。手元で 3 時間の AAC が数秒。limit_sec を超えたら入れ物の値で代える。"""
    try:
        import av

        with av.open(str(path), mode="r", metadata_errors="ignore") as container:
            stream = container.streams.audio[0]
            declared = container.duration / av.time_base if container.duration else None
            started = time.monotonic()
            end = 0.0
            for packet in container.demux(stream):
                if packet.size == 0 or packet.pts is None or packet.time_base is None:
                    continue
                end = max(end, float((packet.pts + (packet.duration or 0)) * packet.time_base))
                if time.monotonic() - started > limit_sec:
                    return declared
            return end if end > 0 else declared
    except Exception:
        log.warning("録音の長さを測れませんでした（進み具合は割合なしで知らせます）")
        return None


# ---- 文字起こし

_model = None


def whisper_model():
    global _model
    if _model is None:
        from faster_whisper import WhisperModel  # 要約だけの処理役では読み込まない

        device = os.environ.get("WHISPER_DEVICE", "auto")
        if device == "auto":
            try:
                import ctranslate2
                device = "cuda" if ctranslate2.get_cuda_device_count() > 0 else "cpu"
            except Exception:
                device = "cpu"
        compute = os.environ.get("WHISPER_COMPUTE") or ("float16" if device == "cuda" else "int8")
        name = os.environ.get("WHISPER_MODEL", "large-v3")
        log.info("音声のモデルを読み込みます: %s（%s・%s）", name, device, compute)
        _model = (WhisperModel(name, device=device, compute_type=compute, cpu_threads=int(os.environ.get("WHISPER_THREADS", "0"))), name)
    return _model


def glossary_prompt(words: list[str]) -> str:
    """固有名詞を Whisper に知らせる初期プロンプト（長すぎると効かなくなるので短く切る）。"""
    out = "医薬祭実行委員会の会議。"
    for w in words:
        if len(out) + len(w) + 1 > GLOSSARY_CHARS:
            break
        out += w + "、"
    return out.rstrip("、") + "。"


def quiet_cut(samples, start: int, frame: int) -> int:
    """samples[start:] を frame ずつに分け、一番静かな（二乗の和が小さい）ところの真ん中の位置を返す。"""
    import numpy as np

    n = (len(samples) - start) // frame
    if n <= 0:
        return len(samples)
    tail = samples[start:start + n * frame].astype(np.float32).reshape(n, frame)
    return start + int(np.argmin(np.square(tail).sum(axis=1))) * frame + frame // 2


def audio_windows(path: Path, window_sec: float = WINDOW_SEC, search_sec: float = CUT_SEARCH_SEC):
    """音声を 16kHz・モノラルの float32 にして、(開始の秒, 配列) を window_sec ごとに返す。全体を一度にメモリに置かない。
    区切りは窓の終わりの search_sec の中で一番静かなところ。変換は faster_whisper.audio.decode_audio と同じ
    （s16・モノラル、時刻の確認はしない）。壊れたフレームはパケットごとに飛ばす。"""
    import gc

    import av
    import numpy as np

    window = int(window_sec * SAMPLE_RATE)
    search = min(int(search_sec * SAMPLE_RATE), window - 1)
    frame = max(1, int(CUT_FRAME_SEC * SAMPLE_RATE))
    resampler = av.audio.resampler.AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)
    fifo = av.audio.fifo.AudioFifo()
    pending: list = []
    have = 0
    offset = 0

    def packet_frames(container):
        # container.decode() の中で例外が出ると generator ごと終わり、残りの音声を全部捨ててしまう
        # （faster-whisper の decode_audio も同じ）。先頭に壊れた ADTS フレームがある AAC の録音が
        # 0 秒になったので、パケットごとにデコードして、断られたパケットだけを飛ばす。
        stream = container.streams.audio[0]
        skipped = 0
        try:
            for packet in container.demux(stream):
                try:
                    yield from packet.decode()
                except av.error.InvalidDataError:
                    skipped += 1
        except av.error.InvalidDataError:
            log.warning("音声の途中から先を読めませんでした（読めた所までで文字起こしします）")
        if skipped:
            log.warning("読めないフレームを %d 個飛ばしました", skipped)

    def decoded(container):
        for f in packet_frames(container):
            f.pts = None
            fifo.write(f)
            if fifo.samples >= 500_000:
                yield from resampler.resample(fifo.read())
        if fifo.samples > 0:
            yield from resampler.resample(fifo.read())
        yield from resampler.resample(None)

    try:
        with av.open(str(path), mode="r", metadata_errors="ignore") as container:
            for f in decoded(container):
                pending.append(f.to_ndarray().reshape(-1))
                have += pending[-1].shape[0]
                while have >= window:
                    buf = np.concatenate(pending)
                    cut = quiet_cut(buf[:window], window - search, frame)
                    yield offset / SAMPLE_RATE, buf[:cut].astype(np.float32) / 32768.0
                    offset += cut
                    pending = [buf[cut:]]
                    have = pending[0].shape[0]
        if have > 0:
            yield offset / SAMPLE_RATE, np.concatenate(pending).astype(np.float32) / 32768.0
    finally:
        # faster-whisper と同じく、変換器まわりが残らないように片付ける。
        del resampler
        gc.collect()


def transcribe(app: App, job: dict) -> dict:
    model, name = whisper_model()
    prompt = glossary_prompt(job.get("glossary") or [])
    out: list[dict] = []
    duration = 0.0
    with tempfile.TemporaryDirectory(prefix="iyk-minutes-") as tmp:
        audio = Path(tmp) / f"audio.{job['audio']['ext']}"
        app.download(job, audio)
        progress = Progress(app, job)
        total = audio_duration(audio)
        progress.report(0, total, force=True)
        started = time.monotonic()
        windows = 0
        # 区切りごとに独立して文字起こしする（もともと前の文脈を使わない設定なので、つなぎ目で失うものは少ない）。
        for offset, samples in audio_windows(audio):
            windows += 1
            # segments は文字起こしを進めながら返す（取り出すまで処理されない）ので、取り出した所までを知らせる。
            segments, _ = model.transcribe(samples, language="ja", vad_filter=True, beam_size=5,
                                           initial_prompt=prompt, condition_on_previous_text=False)
            for s in segments:
                if s.text.strip() and math.isfinite(s.start) and math.isfinite(s.end):
                    out.append({"start": round(offset + s.start, 2), "end": round(offset + max(s.start, s.end), 2), "text": s.text.strip()[:1000]})
                    progress.report(offset + max(s.start, s.end), total)
            duration = offset + samples.shape[0] / SAMPLE_RATE
            progress.report(duration, total, force=True)
        if windows == 0:
            # 空の下書きにすると、録った人には何が起きたか分からない。失敗にして画面に理由を出す。
            raise RuntimeError("音声を 1 秒も読み取れませんでした（録音の形式が読めないか、ファイルが壊れています）")
        log.info("文字起こし %s: 音声 %.0f 秒を %.0f 秒で（%d 区切り・%d 文）", job["id"], duration, time.monotonic() - started, windows, len(out))
    return {"segments": out, "durationSec": round(duration, 2), "model": name}


# ---- 要約

def fmt(sec: float) -> str:
    s = int(sec)
    return f"{s // 3600:02d}:{s % 3600 // 60:02d}:{s % 60:02d}"


def transcript_lines(segments: list[dict]) -> list[str]:
    return [f"[{fmt(s['start'])}|{s['start']:.0f}] {s['text']}" for s in segments]


def split_parts(lines: list[str], limit: int = PART_CHARS) -> list[list[str]]:
    parts: list[list[str]] = [[]]
    size = 0
    for line in lines:
        if size + len(line) > limit and parts[-1]:
            parts.append([])
            size = 0
        parts[-1].append(line)
        size += len(line) + 1
    return parts


SCHEMA_TEXT = """{
  "summary": "会議全体の要点（3〜5文）",
  "topics": [{"title": "議題", "points": ["要点", "..."], "evidence": [{"at": 秒, "quote": "原文の抜粋"}]}],
  "decisions": [{"text": "決まったこと", "evidence": [{"at": 秒, "quote": "原文の抜粋"}]}],
  "todos": [{"text": "やること", "assignee": "担当（発言に無ければ空）", "due": "期限（発言に無ければ空）", "department": "部局（発言に無ければ空）", "evidence": [{"at": 秒, "quote": "原文の抜粋"}]}],
  "carryOver": [{"text": "持ち越し・保留になったこと", "evidence": [{"at": 秒, "quote": "原文の抜粋"}]}],
  "unclear": [{"text": "聞き取れない・意味が取れない・数字が食い違う所", "at": 秒または null}]
}"""


def build_prompt(job: dict, lines: list[str], part: int, parts: int) -> str:
    where = f"（全 {parts} 部分のうち第 {part} 部分。ほかの部分は別に要約してつなぐので、この部分の内容だけを書く）" if parts > 1 else ""
    return f"""あなたは富山大学 医学薬学祭（医薬祭）実行委員会の議事録係です。次の会議の文字起こしから、議事録の下書きを JSON で作ってください{where}。

会議名: {job['title']}
日付: {job['heldOn']}

決まり:
- 文字起こしにあることだけを書く。推測で補わない。担当・期限・部局は、発言ではっきり言われたときだけ書き、無ければ空文字にする。
- 「決定事項」は会議で決まったと言える事柄だけ。検討中・提案だけのものは議題の要点か持ち越しに書く。
- ToDo は「誰かがやることになった作業」だけ。
- evidence の quote は、根拠になった発言を文字起こしからそのまま（言い換えずに）8〜40 字ほど抜き出す。at はその行の [時刻|秒] の秒の数字。
- 文字起こしは音声認識なので誤変換がある。意味が取れない所、人名・数字が怪しい所は unclear に書く。
- 個人の事情・健康などの私的な話は要点に書かない。
- 出力は次の形の JSON だけ（前後に説明を書かない）。

{SCHEMA_TEXT}

文字起こし（[時:分:秒|秒] 発言）:
{chr(10).join(lines)}
"""


def ask_claude(prompt: str) -> str:
    exe = shutil.which(os.environ.get("CLAUDE_COMMAND", "claude"))
    if not exe:
        raise RuntimeError("Claude Code CLI が見つかりません")
    args = [exe, "-p", "--model", os.environ.get("CLAUDE_MODEL", "opus"), "--output-format", "json", "--disallowedTools", DENIED_TOOLS,
            *os.environ.get("CLAUDE_EXTRA_ARGS", DEFAULT_EXTRA_ARGS).split()]
    # 空の作業ディレクトリで動かす（CLAUDE.md などを読み込ませない）
    with tempfile.TemporaryDirectory(prefix="iyk-minutes-ai-") as cwd:
        proc = subprocess.run(args, input=prompt.encode("utf-8"), capture_output=True, cwd=cwd, timeout=int(os.environ.get("CLAUDE_TIMEOUT_SEC", "1500")))
    raw = proc.stdout.decode("utf-8", "replace").strip()
    if proc.returncode != 0:
        raise RuntimeError(f"Claude CLI が異常終了しました（code={proc.returncode}）: {raw[:200] or proc.stderr[:200]!r}")
    try:
        outer = json.loads(raw)
    except ValueError as e:
        raise RuntimeError("Claude CLI の出力が JSON ではありません") from e
    if outer.get("is_error") or outer.get("subtype") not in (None, "success"):
        raise RuntimeError(f"Claude CLI がエラーを返しました: {str(outer.get('result'))[:200]}")
    return str(outer.get("result") or "")


def extract_json(text: str) -> dict:
    t = text.strip()
    m = re.search(r"```(?:json)?\s*(\{.*\})\s*```", t, re.S)
    if m:
        t = m.group(1)
    start, end = t.find("{"), t.rfind("}")
    if start < 0 or end <= start:
        raise RuntimeError("要約の答えに JSON がありません")
    data = json.loads(t[start:end + 1])
    if not isinstance(data, dict):
        raise RuntimeError("要約の答えがオブジェクトではありません")
    return data


LIST_KEYS = ("topics", "decisions", "todos", "carryOver", "unclear")


def clean_draft(data: dict) -> dict:
    """アプリの形に寄せる（型の違う項目は捨てる。最終的な検査はアプリ側）。"""
    def ev(items):
        out = []
        for e in items if isinstance(items, list) else []:
            if isinstance(e, dict) and isinstance(e.get("quote"), str):
                try:
                    at = float(e.get("at") or 0)
                except (TypeError, ValueError):
                    continue
                if math.isfinite(at):
                    out.append({"at": min(max(0.0, at), 86400.0), "quote": e["quote"][:200]})
        return out[:5]

    def s(v, n):
        return v.strip()[:n] if isinstance(v, str) else ""

    d = {"summary": s(data.get("summary"), 4000), "topics": [], "decisions": [], "todos": [], "carryOver": [], "unclear": []}
    for t in data.get("topics") or []:
        if isinstance(t, dict) and s(t.get("title"), 200):
            d["topics"].append({"title": s(t["title"], 200), "points": [s(p, 1000) for p in (t.get("points") or []) if s(p, 1000)][:30], "evidence": ev(t.get("evidence"))})
    for key in ("decisions", "carryOver"):
        for x in data.get(key) or []:
            if isinstance(x, dict) and s(x.get("text"), 1000):
                d[key].append({"text": s(x["text"], 1000), "evidence": ev(x.get("evidence"))})
    for x in data.get("todos") or []:
        if isinstance(x, dict) and s(x.get("text"), 1000):
            d["todos"].append({"text": s(x["text"], 1000), "assignee": s(x.get("assignee"), 100), "due": s(x.get("due"), 40), "department": s(x.get("department"), 60), "evidence": ev(x.get("evidence"))})
    for x in data.get("unclear") or []:
        if isinstance(x, dict) and s(x.get("text"), 1000):
            at = x.get("at")
            try:
                at = None if at is None else float(at)
            except (TypeError, ValueError):
                at = None
            at = min(max(0.0, at), 86400.0) if at is not None and math.isfinite(at) else None
            d["unclear"].append({"text": s(x["text"], 1000), "at": at})
    for key in LIST_KEYS:
        d[key] = d[key][:100]
    return d


def merge_drafts(drafts: list[dict]) -> dict:
    if len(drafts) == 1:
        return drafts[0]
    out = {"summary": "\n".join(f"（第{i + 1}部分）{d['summary']}" for i, d in enumerate(drafts) if d["summary"])[:4000]}
    for key in LIST_KEYS:
        out[key] = [x for d in drafts for x in d[key]][:100]
    return out


def summarize(job: dict, progress: Progress | None = None) -> dict:
    segments = (job.get("transcript") or {}).get("segments") or []
    if not segments:
        return {"summary": "文字起こしに発言がありませんでした（無音か、録音できていない可能性）。", "topics": [], "decisions": [], "todos": [], "carryOver": [], "unclear": []}
    parts = split_parts(transcript_lines(segments))
    drafts = []
    for i, lines in enumerate(parts, 1):
        if progress:
            progress.report(i - 1, len(parts), force=True)
        started = time.monotonic()
        drafts.append(clean_draft(extract_json(ask_claude(build_prompt(job, lines, i, len(parts))))))
        log.info("要約 %s: 第 %d/%d 部分を %.0f 秒で", job["id"], i, len(parts), time.monotonic() - started)
    return merge_drafts(drafts)


# ---- 本体

def run_once(app: App, stages: list[str]) -> bool:
    """仕事を 1 つ処理したら True。"""
    job = app.post(PATHS["claim"], {"stages": stages}).get("job")
    if not job:
        return False
    stage = job["stage"]
    log.info("仕事を受けました: %s（%s）", job["id"], stage)
    payload = {"id": job["id"], "leaseToken": job["leaseToken"], "stage": stage}
    try:
        if stage == "transcribe":
            payload["transcript"] = transcribe(app, job)
        else:
            payload["draft"] = summarize(job, Progress(app, job))
    except Exception as e:  # 失敗はアプリに伝え、画面から「やり直す」できるようにする
        log.exception("処理に失敗しました: %s", job["id"])
        payload = failure(job, f"{'文字起こし' if stage == 'transcribe' else '要約'}に失敗しました: {str(e)[:300]}")
    try:
        app.post(PATHS["result"], payload)
    except Exception as e:
        # 結果そのものを受け取ってもらえない（大きすぎる・形が違う）ときも、黙って借りたままにしない。
        log.exception("結果を送れませんでした: %s", job["id"])
        if "error" in payload:
            raise
        app.post(PATHS["result"], failure(job, f"結果をアプリに送れませんでした: {str(e)[:300]}"))
    return True


def failure(job: dict, message: str) -> dict:
    return {"id": job["id"], "leaseToken": job["leaseToken"], "stage": job["stage"], "error": message[:480]}


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--once", action="store_true", help="仕事を 1 つ（無ければ何もせず）処理して終わる")
    args = p.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    base = os.environ.get("MINUTES_APP_URL")
    key_file = os.environ.get("MINUTES_KEY_FILE")
    if not base or not key_file:
        log.error("MINUTES_APP_URL と MINUTES_KEY_FILE を設定してください")
        return 2
    if os.name != "nt" and os.stat(key_file).st_mode & 0o077:
        log.error("鍵のファイルは所有者だけが読める権限（600）にしてください")
        return 2
    app = App(base, parse_key(Path(key_file).read_text("utf-8")))
    stages = [s for s in os.environ.get("MINUTES_STAGES", "transcribe,summarize").split(",") if s in ("transcribe", "summarize")]
    poll = int(os.environ.get("MINUTES_POLL_SEC", "30"))
    if args.once:
        run_once(app, stages)
        return 0
    log.info("議事録の処理役を始めます（%s）", ",".join(stages))
    while True:
        try:
            if run_once(app, stages):
                continue
        except Exception as e:
            log.warning("アプリに問い合わせられませんでした: %s", str(e)[:200])
        time.sleep(poll)


if __name__ == "__main__":
    sys.exit(main())
