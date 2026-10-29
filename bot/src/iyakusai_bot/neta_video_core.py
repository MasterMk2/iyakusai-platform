"""Bounded local video jobs. No Discord, model, Drive, or shell dependency."""
from __future__ import annotations

import asyncio
from collections import deque
from dataclasses import dataclass, field
import json
import os
from pathlib import Path
import shutil
import signal
import stat
import sys
import tempfile
import time
import unicodedata
import uuid

MAX_TEXT = 80
TEMPLATES = {"fanfare": "壮大なファンファーレ"}
ASSET = Path(__file__).with_name("assets") / "original_fanfare.wav"
ASSET_SHA256 = "1a253b2571f2250a1517e1f33393af459f27b849d041ed23fc548baba7ac87ab"


class VideoError(Exception):
    """Public errors are codes, never raw subprocess output or user text."""


def normalize_text(value: str) -> tuple[str, bool]:
    if not isinstance(value, str) or len(value) > MAX_TEXT or len(value.encode("utf-8")) > 640:
        raise VideoError("text_length")
    value = value.replace("\\n", "\n").replace("\r\n", "\n")
    if any(c not in ("\n", "\u200d") and unicodedata.category(c).startswith("C") for c in value):
        raise VideoError("text_control")
    value = value.strip()
    if not value or len(value.split("\n")) > 3:
        raise VideoError("text_lines")
    output = []
    replaced = False
    labels = {"🔥": "炎", "💀": "ドクロ", "😭": "涙", "🎉": "祝", "🤣": "笑", "🚀": "発射"}
    # Deliberately use readable labels instead of missing/color-font tofu. A title
    # can contain emoji; neither platform font fallback nor remote emoji assets
    # are assumed. Variation selectors and emoji joins are removed with notice.
    for char in value:
        n = ord(char)
        if char in ("\u200d", "\ufe0f", "\ufe0e") or 0x1F3FB <= n <= 0x1F3FF:
            replaced = True
            continue
        if 0x1F000 <= n <= 0x1FAFF or 0x2600 <= n <= 0x27BF:
            output.append("【" + labels.get(char, "絵文字") + "】")
            replaced = True
        elif char == "\n":
            output.append(char)
        elif unicodedata.category(char).startswith("C"):
            raise VideoError("text_control")
        else:
            output.append(char)
    normalized = "".join(output)
    if not normalized.strip() or len(normalized) > 160:
        raise VideoError("text_length")
    return normalized, replaced


def _int(value, low: int, high: int, code: str) -> int:
    if type(value) is not int or not low <= value <= high:
        raise VideoError(code)
    return value


def _exe(value: str) -> str:
    if not isinstance(value, str) or not value or "\n" in value:
        raise VideoError("dependency_missing")
    found = shutil.which(value)
    path = Path(found or value).expanduser()
    if not path.is_absolute() or not path.is_file():
        raise VideoError("dependency_missing")
    # Python discovers a venv from its launch path. Resolving bin/python's
    # symlink would escape the renderer venv and lose its isolated dependencies.
    return str(path.absolute())


def validate_spool(path: Path, private_root: Path | None = None) -> Path:
    """Bot fixes a dedicated home-local root; CLI may select a fixture-only root."""
    root = private_root or Path.home() / ".iyakusai" / "video-jobs"
    if not path.is_absolute() or str(path).startswith(("\\\\", "//")):
        raise VideoError("spool_invalid")
    # Check original ancestors before resolve. Includes NTFS junctions on Python 3.11.
    for part in (path, *path.parents, root, *root.parents):
        try:
            info = part.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise VideoError("spool_invalid")
    resolved = path.resolve(); boundary = root.resolve()
    if not resolved.is_relative_to(boundary):
        raise VideoError("spool_invalid")
    if os.name == "nt":
        import ctypes
        k = ctypes.WinDLL("kernel32", use_last_error=True)
        k.GetDriveTypeW.argtypes = [ctypes.c_wchar_p]
        if k.GetDriveTypeW(resolved.anchor) != 3:  # DRIVE_FIXED only, no network/UNC.
            raise VideoError("spool_invalid")
    elif sys.platform.startswith("linux"):
        mounts = Path("/proc/self/mountinfo")
        local = {"ext2", "ext3", "ext4", "xfs", "btrfs", "tmpfs", "overlay", "zfs", "vfat", "f2fs", "ramfs"}
        found = []
        for line in mounts.read_text().splitlines():
            left, right = line.split(" - ", 1)
            mount = Path(left.split()[4].replace("\\040", " ").replace("\\134", "\\"))
            if resolved.is_relative_to(mount):
                found.append((len(str(mount)), right.split()[0]))
        if not found or max(found)[1] not in local:
            raise VideoError("spool_invalid")
    return resolved


@dataclass(frozen=True)
class VideoSettings:
    enabled: bool = False
    worker_python: str = sys.executable
    ffmpeg: str = "ffmpeg"
    ffprobe: str = "ffprobe"
    font: str = ""
    spool_dir: str = ""
    spool_root: str = ""  # Internal boundary, never accepted from Bot config.
    height: int = 720
    fps: int = 24
    max_bytes: int = 8 * 1024 * 1024
    render_timeout_sec: int = 180
    queue_timeout_sec: int = 360
    max_waiting: int = 2
    cooldown_sec: int = 60
    local_spool_confirmed: bool = False
    guild_ids: tuple[int, ...] = ()
    channel_ids: tuple[int, ...] = ()

    @classmethod
    def from_mapping(cls, raw: dict, *, private_root: Path | None = None) -> "VideoSettings":
        if not isinstance(raw, dict) or type(raw.get("enabled", False)) is not bool:
            raise VideoError("settings_invalid")
        allowed = set(cls.__dataclass_fields__) - {"spool_root"}
        if set(raw) - allowed:
            raise VideoError("settings_invalid")
        if not raw.get("enabled", False):
            return cls()
        if raw.get("local_spool_confirmed") is not True:
            raise VideoError("spool_not_confirmed")
        numbers = {"height": (360, 720, 720), "fps": (12, 30, 24),
                   "max_bytes": (512 * 1024, 8 * 1024 * 1024, 8 * 1024 * 1024),
                   "render_timeout_sec": (10, 240, 180), "queue_timeout_sec": (10, 360, 360),
                   "max_waiting": (0, 2, 2), "cooldown_sec": (1, 600, 60)}
        values = {k: _int(raw.get(k, default), low, high, "settings_invalid")
                  for k, (low, high, default) in numbers.items()}
        if values["height"] not in (360, 480, 720):
            raise VideoError("settings_invalid")
        ids = {}
        for key in ("guild_ids", "channel_ids"):
            seq = raw.get(key)
            if not isinstance(seq, list) or not seq or len(seq) > 100 or any(type(n) is not int or n <= 0 for n in seq):
                raise VideoError("audience_not_configured")
            ids[key] = tuple(seq)
        if not isinstance(raw.get("font"), str) or not isinstance(raw.get("spool_dir"), str):
            raise VideoError("settings_invalid")
        font = Path(raw.get("font", "")).expanduser()
        spool = Path(raw.get("spool_dir", "")).expanduser()
        if not font.is_absolute() or not font.is_file() or not spool.is_absolute():
            raise VideoError("settings_invalid")
        return cls(enabled=True, local_spool_confirmed=True, **values, **ids,
                   worker_python=_exe(raw.get("worker_python", sys.executable)),
                   ffmpeg=_exe(raw.get("ffmpeg", "ffmpeg")), ffprobe=_exe(raw.get("ffprobe", "ffprobe")),
                   font=str(font.resolve()), spool_dir=str(validate_spool(spool, private_root)),
                   spool_root=str(private_root or Path.home() / ".iyakusai" / "video-jobs"))

    def allows(self, guild_id: int | None, channel_id: int | None) -> bool:
        return self.enabled and guild_id in self.guild_ids and channel_id in self.channel_ids


@dataclass(frozen=True)
class VideoResult:
    data: bytes
    emoji_replaced: bool
    filename: str = "neta_video.mp4"


class _WindowsJob:
    """Terminate this owned worker and all descendants when its handle closes."""
    def __init__(self, pid: int):
        import ctypes
        from ctypes import wintypes as w
        class BASIC(ctypes.Structure):
            _fields_ = [("process_time", ctypes.c_int64), ("job_time", ctypes.c_int64),
                        ("flags", w.DWORD), ("min_ws", ctypes.c_size_t), ("max_ws", ctypes.c_size_t),
                        ("active", w.DWORD), ("affinity", ctypes.c_size_t), ("priority", w.DWORD), ("scheduling", w.DWORD)]
        class IO(ctypes.Structure):
            _fields_ = [(n, ctypes.c_uint64) for n in ("read_ops", "write_ops", "other_ops", "read_bytes", "write_bytes", "other_bytes")]
        class EXT(ctypes.Structure):
            _fields_ = [("basic", BASIC), ("io", IO), ("process_memory", ctypes.c_size_t),
                        ("job_memory", ctypes.c_size_t), ("peak_process_memory", ctypes.c_size_t), ("peak_job_memory", ctypes.c_size_t)]
        k = ctypes.WinDLL("kernel32", use_last_error=True)
        k.CreateJobObjectW.argtypes = [ctypes.c_void_p, w.LPCWSTR]; k.CreateJobObjectW.restype = w.HANDLE
        k.SetInformationJobObject.argtypes = [w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD]
        k.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]; k.OpenProcess.restype = w.HANDLE
        k.AssignProcessToJobObject.argtypes = [w.HANDLE, w.HANDLE]
        k.CloseHandle.argtypes = [w.HANDLE]
        self.k = k; self.handle = k.CreateJobObjectW(None, None)
        info = EXT(); info.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        process = None
        try:
            if not self.handle or not k.SetInformationJobObject(self.handle, 9, ctypes.byref(info), ctypes.sizeof(info)):
                raise VideoError("process_isolation")
            process = k.OpenProcess(0x0100 | 0x0001, False, pid)  # SET_QUOTA | TERMINATE
            if not process or not k.AssignProcessToJobObject(self.handle, process):
                raise VideoError("process_isolation")
        except BaseException:
            self.close()
            raise
        finally:
            if process:
                k.CloseHandle(process)

    def close(self):
        if self.handle:
            self.k.CloseHandle(self.handle)
            self.handle = None


async def owned_process(args: list[str], payload: bytes, timeout: float, *, env: dict | None = None) -> bytes:
    """No shell. Assign isolation before stdin allows any child encoder to start."""
    options = {"start_new_session": True} if os.name != "nt" else {"creationflags": 0x08000000 | 0x4000}
    proc = await asyncio.create_subprocess_exec(*args, stdin=asyncio.subprocess.PIPE,
                                              stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
                                              env=env, **options)
    job = None
    try:
        if os.name == "nt":
            job = _WindowsJob(proc.pid)
        output, _ = await asyncio.wait_for(proc.communicate(payload), timeout)
        if proc.returncode or len(output) > 4096:
            raise VideoError("render_failed")
        return output
    except asyncio.TimeoutError:
        raise VideoError("render_timeout") from None
    finally:
        if job:
            job.close()
        elif os.name != "nt":
            # The process group belongs to this worker, even after its leader exits.
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        if proc.returncode is None:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
        await proc.wait()


async def render_job(settings: VideoSettings, text: str, template: str, max_bytes: int) -> VideoResult:
    text, changed = normalize_text(text)
    if template not in TEMPLATES:
        raise VideoError("template_invalid")
    spool = validate_spool(Path(settings.spool_dir), Path(settings.spool_root) if settings.spool_root else None)
    spool.mkdir(parents=True, exist_ok=True, mode=0o700)
    validate_spool(spool, Path(settings.spool_root) if settings.spool_root else None)
    with tempfile.TemporaryDirectory(prefix="neta-video-", dir=spool) as temp:
        request = {"text": text, "template": template, "height": settings.height, "fps": settings.fps,
                   "max_bytes": max_bytes, "ffmpeg": settings.ffmpeg, "ffprobe": settings.ffprobe,
                   "font": settings.font, "audio": str(ASSET), "normalized": True}
        # Render workers do not need the Bot token, API keys, or provider settings.
        env = {k: v for k, v in os.environ.items() if k.upper() in
               {"PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "LANG", "LC_ALL", "LD_LIBRARY_PATH"}}
        env.update(PYTHONIOENCODING="utf-8", OMP_NUM_THREADS="1", OPENBLAS_NUM_THREADS="1")
        env["PYTHONPATH"] = str(Path(__file__).resolve().parent.parent)
        output = await owned_process([settings.worker_python, "-m", "iyakusai_bot.neta_video_render", "--job-dir", temp],
                                     json.dumps(request, ensure_ascii=False).encode("utf-8"), settings.render_timeout_sec, env=env)
        try:
            report = json.loads(output)
        except (ValueError, UnicodeError):
            raise VideoError("worker_protocol") from None
        clip = Path(temp) / "clip.mp4"
        if not isinstance(report, dict) or report.get("ok") is not True or clip.is_symlink() or not clip.is_file():
            raise VideoError("worker_protocol")
        size = clip.stat().st_size
        if not 0 < size <= max_bytes or report.get("bytes") != size:
            raise VideoError("video_size")
        return VideoResult(clip.read_bytes(), changed)


@dataclass
class VideoJob:
    id: str
    owner: tuple[int, int]
    text: str
    template: str
    max_bytes: int
    created: float
    future: asyncio.Future
    state: str = "queued"
    task: asyncio.Task | None = None


class VideoQueue:
    """One active job, at most two waiting, one outstanding job per guild/user."""
    def __init__(self, settings: VideoSettings, runner=render_job):
        self.settings = settings; self.runner = runner
        self.jobs: dict[str, VideoJob] = {}; self.pending = deque()
        self.wake = asyncio.Event(); self.loop_task = None; self.closed = False
        self.cooldowns = {}

    def submit(self, guild: int, user: int, text: str, template: str = "fanfare", *, max_bytes: int | None = None) -> VideoJob:
        if self.closed or not self.settings.enabled:
            raise VideoError("disabled")
        normalize_text(text)
        if template not in TEMPLATES:
            raise VideoError("template_invalid")
        owner = (guild, user); now = time.monotonic()
        if any(j.owner == owner and not j.future.done() for j in self.jobs.values()):
            raise VideoError("already_pending")
        self.cooldowns = {k: v for k, v in self.cooldowns.items() if v > now}
        if self.cooldowns.get(owner, 0) > now:
            raise VideoError("cooldown")
        if sum(j.state == "rendering" or not j.future.done() for j in self.jobs.values()) >= self.settings.max_waiting + 1:
            raise VideoError("queue_full")
        limit = min(self.settings.max_bytes, max_bytes if max_bytes is not None else self.settings.max_bytes)
        if limit < 512 * 1024:
            raise VideoError("video_size")
        job = VideoJob(uuid.uuid4().hex[:16], owner, text, template, limit, now, asyncio.get_running_loop().create_future())
        self.jobs[job.id] = job; self.pending.append(job); self.cooldowns[owner] = now + self.settings.cooldown_sec
        if self.loop_task is None or self.loop_task.done():
            self.loop_task = asyncio.create_task(self._loop())
        self.wake.set()
        return job

    def cancel(self, job_id: str, guild: int, user: int) -> bool:
        job = self.jobs.get(job_id)
        if not job or job.owner != (guild, user):
            return False
        if not job.future.done():
            job.future.set_exception(VideoError("cancelled"))
            job.future.exception()  # Caller can still await it; abandoned request is quiet.
        if job.task:
            if not job.task.done() and not job.task.cancelling():
                job.task.cancel()
        else:
            self.pending.remove(job)
            self.jobs.pop(job.id, None)
            job.text = ""
        return True

    async def _loop(self):
        while not self.closed:
            await self.wake.wait(); self.wake.clear()
            while self.pending and not self.closed:
                job = self.pending.popleft()
                try:
                    if job.future.done():
                        continue
                    if time.monotonic() - job.created > self.settings.queue_timeout_sec:
                        raise VideoError("queue_timeout")
                    job.state = "rendering"
                    job.task = asyncio.create_task(self.runner(self.settings, job.text, job.template, job.max_bytes))
                    try:
                        result = await asyncio.wait_for(job.task, self.settings.render_timeout_sec + 5)
                    except asyncio.TimeoutError:
                        raise VideoError("render_timeout") from None
                    if not job.future.done():
                        job.future.set_result(result)
                except asyncio.CancelledError:
                    if not job.future.done():
                        job.future.set_exception(VideoError("cancelled"))
                except Exception as error:
                    if not job.future.done():
                        job.future.set_exception(error if isinstance(error, VideoError) else VideoError("render_failed"))
                finally:
                    self.jobs.pop(job.id, None)
                    job.text = ""  # Retain no title after the response is ready.

    async def close(self):
        self.closed = True
        for job in list(self.jobs.values()):
            self.cancel(job.id, *job.owner)
        self.wake.set()
        if self.loop_task:
            await self.loop_task
        self.jobs.clear(); self.pending.clear(); self.cooldowns.clear()
