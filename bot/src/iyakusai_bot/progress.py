# -*- coding: utf-8 -*-
"""/ask の進捗表示(2026-10-09 追加)。

エージェント検索(claude -p)は1回に1〜5分かかり、その間 Discord には「考え中…」しか
出なかった。claude CLI の `--output-format stream-json` が流すイベントを受け取り、
「いま何をしているか・何回調べたか」を **defer した元の応答** に数秒おきに書き込む。

部品:
- ProgressTracker  : イベント → 状態 の純ロジック(Discord 非依存・smoke test で固定)
- render_progress  : 状態 → 表示文字列 の純関数
- ProgressReporter : 一定間隔で元の応答を編集するループ。回答の1通目は
                     claim_for_answer() で元の応答に書かせる(knowledge.safe_send)ので、
                     見た目は従来どおり「考え中 → そこに回答」になる。

方針:
- **進捗表示は付加情報。失敗しても /ask の回答を1通も落とさない**(例外はすべて握る)。
- 表示するパスは **ミラー相対だけ**。Pi の絶対パスにはアカウント名が入るため、
  ミラーの外を指すパスは basename に落とす。
- 編集には AllowedMentions.none() を付ける(検索語に @everyone 等が入っても鳴らさない)。
- `[ai] progress = false` で丸ごと無効化できる(このとき CLI も従来の json 出力に戻る)。
"""

from __future__ import annotations

import asyncio
import logging
import time
from pathlib import Path

import discord

from . import contact

log = logging.getLogger("iyakusai.progress")

# 表示上の段階。knowledge Cog が set_phase() で外から切り替えるもの(seed/queue/
# fallback/oneshot)と、ストリームのイベントで自動的に切り替わるもの(search/think/
# write/resume)がある。
PHASE_LABELS = {
    "start": "🧠 質問を読み解いています",
    "seed": "📚 意味検索で手がかりを集めています",
    "queue": "⏳ 順番待ちです(同時に調べられるのは2件まで)",
    "search": "🔎 資料を調べています",
    "think": "🧠 読んだ資料を検討しています",
    "write": "✍️ 回答をまとめています",
    "resume": "⏩ 調査が長引いたので、ここまでの内容で仕上げています",
    "fallback": "🔁 簡易検索に切り替えています",
    "lookup": "🔍 資料を検索しています",
    "oneshot": "🧠 見つかった資料を要約しています",
}
_ACTION_PHASES = ("search", "think", "write", "resume")

try:
    NO_MENTIONS = discord.AllowedMentions.none()
except AttributeError:   # smoke_test_query_fields は discord をスタブに差し替えて読み込む
    NO_MENTIONS = None

# 回答が1通も届かないまま /ask が終わったとき(想定外の例外)に、進捗表示を置き換える文言。
FAILED_NOTE_PREFIX = "⚠ 応答の途中で問題が発生しました。少し待って再実行してください"


def failed_note() -> str:
    return FAILED_NOTE_PREFIX + contact.ask_note()


def _clip(s, n: int, keep_tail: bool = False) -> str:
    """1行化・バッククォート除去・長さ制限。表示専用(インラインコードに入れる前提)。"""
    s = " ".join(str(s or "").replace("`", "'").split())
    if len(s) <= n:
        return s
    return ("…" + s[-(n - 1):]) if keep_tail else (s[: n - 1] + "…")


def fmt_elapsed(sec: float) -> str:
    sec = max(0, int(sec))
    if sec < 60:
        return f"{sec}秒"
    return f"{sec // 60}分{sec % 60:02d}秒"


def fmt_tokens(n: int) -> str:
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n / 1_000:.1f}k"
    return str(n)


class ProgressTracker:
    """stream-json のイベントを数えて「いま何をしているか」を保持する(純ロジック)。

    claude CLI の版によってイベントの種類は増減する(thinking_tokens / task_summary は
    新しめの版にしか無い)。**assistant の tool_use と user の tool_result だけで成り立つ**
    ように作り、それ以外は「あれば使う」扱いにする。
    """

    def __init__(self, mirror_root: Path | str | None = None):
        root = str(mirror_root or "").replace("\\", "/").rstrip("/")
        self._root = (root + "/") if root else ""
        self.phase = "start"
        self.greps = 0
        self.reads = 0
        self.globs = 0
        self.others = 0
        self.thinking = 0          # thinking_tokens イベントの累計(推定値)
        self.last_action = ""
        self.resumed = False

    @property
    def tools(self) -> int:
        return self.greps + self.reads + self.globs + self.others

    def set_phase(self, phase: str) -> None:
        if phase in PHASE_LABELS:
            self.phase = phase

    def rel(self, path) -> str:
        """表示用のパス。ミラー配下ならミラー相対、外なら basename(絶対パスを出さない)。"""
        p = str(path or "").replace("\\", "/").strip()
        if not p:
            return ""
        if self._root and p.rstrip("/").lower() == self._root.rstrip("/").lower():
            return ""   # ミラー全体(場所の表示は省く)
        if self._root and p.lower().startswith(self._root.lower()):
            return p[len(self._root):]
        is_abs = p.startswith("/") or (len(p) > 1 and p[1] == ":")
        if is_abs or ".." in p.split("/"):
            return p.rsplit("/", 1)[-1]
        return p[2:] if p.startswith("./") else p

    def describe(self, name: str, inp) -> str:
        inp = inp if isinstance(inp, dict) else {}
        if name == "Read":
            return f"📖 `{_clip(self.rel(inp.get('file_path')), 60, keep_tail=True)}` を読んでいます"
        if name == "Grep":
            where = self.rel(inp.get("path"))
            where = f"(`{_clip(where, 40, keep_tail=True)}`)" if where else ""
            return f"🔎 `{_clip(inp.get('pattern'), 30)}` を検索{where}"
        if name == "Glob":
            return f"🗂 ファイルを探しています(`{_clip(inp.get('pattern'), 40)}`)"
        return f"🔧 {_clip(name, 20)}"

    def feed(self, ev: dict) -> None:
        if not isinstance(ev, dict):
            return
        t = ev.get("type")
        if t == "assistant":
            if ev.get("parent_tool_use_id"):
                return   # サブエージェントの内部(Task は禁止しているので通常来ない)
            content = (ev.get("message") or {}).get("content")
            for b in content if isinstance(content, list) else []:
                if not isinstance(b, dict):
                    continue
                bt = b.get("type")
                if bt == "tool_use":
                    name = str(b.get("name") or "")
                    if name == "Grep":
                        self.greps += 1
                    elif name == "Read":
                        self.reads += 1
                    elif name == "Glob":
                        self.globs += 1
                    else:
                        self.others += 1
                    self.last_action = self.describe(name, b.get("input"))
                    self.phase = "search"
                elif bt == "text" and str(b.get("text") or "").strip():
                    self.phase = "write"
        elif t == "user":
            content = (ev.get("message") or {}).get("content")
            if isinstance(content, list) and any(
                    isinstance(b, dict) and b.get("type") == "tool_result" for b in content):
                self.phase = "think"
        elif t == "system" and ev.get("subtype") == "thinking_tokens":
            try:
                self.thinking += max(0, int(ev.get("estimated_tokens_delta") or 0))
            except (TypeError, ValueError):
                pass
        elif t == "iyakusai" and ev.get("subtype") == "resume":
            # ai_provider が --resume で継続するときに流す合成イベント
            self.resumed = True
            self.phase = "resume"


def render_progress(tr: ProgressTracker, elapsed_sec: float, model: str = "",
                    effort: str = "") -> str:
    lines = [f"{PHASE_LABELS.get(tr.phase, PHASE_LABELS['start'])}… ⏱{fmt_elapsed(elapsed_sec)}"]
    if tr.last_action and tr.phase in _ACTION_PHASES:
        lines.append(f"-# 直近: {tr.last_action}")
    stats = []
    if tr.tools:
        parts = [f"検索 {tr.greps}", f"読込 {tr.reads}"]
        if tr.globs:
            parts.append(f"一覧 {tr.globs}")
        if tr.others:
            parts.append(f"その他 {tr.others}")
        stats.append(f"調べた回数 {tr.tools}({'・'.join(parts)})")
    if tr.thinking:
        stats.append(f"思考 約{fmt_tokens(tr.thinking)}トークン")
    if stats:
        lines.append("-# " + " / ".join(stats))
    meta = []
    if model:
        meta.append(f"モデル: {_clip(model, 20)}")
    meta.append(f"深さ: {_clip(effort, 10) if effort else '既定'}")
    lines.append("-# " + " ・ ".join(meta) + "(資料を横断する質問は数分かかります)")
    return "\n".join(lines)


class ProgressReporter:
    """元の応答(defer した「考え中」)を一定間隔で進捗表示に書き換える。

    edit は `itx.edit_original_response` 相当の非同期関数(content=, allowed_mentions= を取る)。
    テストでは偽物を渡す。
    """

    MAX_FAILS = 3   # 連続でこれだけ編集に失敗したら進捗表示をあきらめる(回答には影響しない)

    def __init__(self, edit, *, t0: float | None = None, interval: float = 7.0,
                 mirror_root: Path | str | None = None, model: str = "", effort: str = ""):
        self._edit = edit
        self._t0 = time.monotonic() if t0 is None else t0
        self._interval = max(0.01, float(interval))
        self.tracker = ProgressTracker(mirror_root)
        self.model = model
        self.effort = effort
        self._lock = asyncio.Lock()
        self._closed = False
        self._shown = False      # 元の応答を一度でも進捗表示に書き換えたか
        self._consumed = False   # 回答の1通目で元の応答を使ったか
        self._last_text: str | None = None
        self._fails = 0
        self._task: asyncio.Task | None = None

    # ---- 外から状態を更新する(すべて同期・例外を出さない) ----
    def feed(self, ev: dict) -> None:
        try:
            self.tracker.feed(ev)
        except Exception:  # noqa: BLE001  表示のための集計で /ask を落とさない
            log.debug("進捗イベントの解釈に失敗", exc_info=True)

    def set_phase(self, phase: str) -> None:
        self.tracker.set_phase(phase)

    def set_meta(self, model: str | None = None, effort: str | None = None) -> None:
        if model is not None:
            self.model = model
        if effort is not None:
            self.effort = effort

    def render(self) -> str:
        return render_progress(self.tracker, time.monotonic() - self._t0,
                               self.model, self.effort)

    @property
    def shown(self) -> bool:
        return self._shown

    # ---- ループ ----
    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.get_running_loop().create_task(self._loop())

    async def _loop(self) -> None:
        try:
            while not self._closed:
                await asyncio.sleep(self._interval)
                if self._closed:
                    break
                await self._push()
        except asyncio.CancelledError:
            pass
        except Exception:  # noqa: BLE001
            log.exception("進捗表示ループが想定外の例外で停止(回答には影響なし)")

    async def _push(self) -> None:
        text = self.render()
        if text == self._last_text:
            return
        async with self._lock:
            if self._closed:
                return
            try:
                await self._edit(content=text, allowed_mentions=NO_MENTIONS)
                self._shown = True
                self._last_text = text
                self._fails = 0
            except Exception as e:  # noqa: BLE001  HTTPException・期限切れなど
                self._fails += 1
                log.warning("進捗表示の更新に失敗(%d/%d): %s", self._fails, self.MAX_FAILS, e)
                if self._fails >= self.MAX_FAILS:
                    self._closed = True

    async def _stop(self) -> None:
        self._closed = True
        async with self._lock:   # 送信中の編集があれば終わるのを待つ(回答と競合させない)
            pass
        task, self._task = self._task, None
        if task is not None and not task.done() and task is not asyncio.current_task():
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass

    async def claim_for_answer(self) -> bool:
        """回答を送る直前に呼ぶ。進捗を止め、**元の応答を回答の1通目に使うべきなら True**。

        一度も進捗を出していなければ元の応答はまだ「考え中」なので False(従来どおり
        followup.send が「考え中」を置き換える)。2通目以降も False。
        """
        await self._stop()
        if self._shown and not self._consumed:
            self._consumed = True
            return True
        return False

    async def close(self) -> None:
        """/ask の最後に必ず呼ぶ。進捗を出したのに回答で上書きされなかったときだけ後始末する。"""
        await self._stop()
        if self._shown and not self._consumed:
            self._consumed = True
            try:
                await self._edit(content=failed_note(), allowed_mentions=NO_MENTIONS)
            except Exception as e:  # noqa: BLE001
                log.warning("進捗表示の後始末に失敗: %s", e)
