"""Original procedural fanfare template. Worker only; Pillow is optional to Bot."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import random
import subprocess
import sys
import time
import wave

from .neta_video_core import ASSET_SHA256, VideoError, _int

DURATION = 10
IMPACT = 4.8


def lower_priority():
    if os.name == "nt":
        import ctypes
        k = ctypes.WinDLL("kernel32", use_last_error=True)
        k.GetCurrentProcess.restype = ctypes.c_void_p
        k.SetPriorityClass.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
        k.SetProcessAffinityMask.argtypes = [ctypes.c_void_p, ctypes.c_size_t]
        k.GetProcessAffinityMask.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_size_t), ctypes.POINTER(ctypes.c_size_t)]
        if not k.SetPriorityClass(k.GetCurrentProcess(), 0x4000):
            raise VideoError("process_priority")
        # Only the worker/its encoder are constrained, never user applications.
        permitted = ctypes.c_size_t(); system = ctypes.c_size_t()
        if not k.GetProcessAffinityMask(k.GetCurrentProcess(), ctypes.byref(permitted), ctypes.byref(system)):
            raise VideoError("process_priority")
        if not k.SetProcessAffinityMask(k.GetCurrentProcess(), permitted.value & -permitted.value):
            raise VideoError("process_priority")
    else:
        os.nice(10)
        if hasattr(os, "sched_getaffinity"):
            os.sched_setaffinity(0, {min(os.sched_getaffinity(0))})


def layout_text(text, font_path, width, height):
    from PIL import ImageFont
    for size in range(128, 31, -2):
        font = ImageFont.truetype(font_path, size)
        lines = []
        for paragraph in text.split("\n"):
            line = ""
            for char in paragraph:
                if line and font.getlength(line + char) > width:
                    lines.append(line); line = ""
                line += char
            lines.append(line)
        line_height = size * 1.32
        if len(lines) <= 5 and len(lines) * line_height <= height and all(font.getlength(l) <= width for l in lines):
            return font, lines, round(line_height)
    raise VideoError("text_layout")


class FanfareScene:
    def __init__(self, text, font_path, width, height):
        from PIL import Image, ImageDraw, ImageFont, ImageFilter
        self.Image = Image; self.Draw = ImageDraw; self.Filter = ImageFilter
        self.w = width; self.h = height; self.scale = height / 720
        rng = random.Random(108)
        # Make the low-resolution nebula once. No SciPy/NumPy or model required.
        small = Image.new("RGB", (160, 90)); pixels = []
        for y in range(90):
            for x in range(160):
                nx = (x - 80) / 80; ny = (y - 45) / 45
                blue = math.exp(-((nx + .45) ** 2 + (ny + .15) ** 2 * 3))
                gold = math.exp(-((nx - .5) ** 2 * 2 + (ny - .3) ** 2 * 5))
                haze = .5 + .3 * math.sin(x * .08 + y * .11) + rng.random() * .2
                pixels.append((int(5 + 28 * gold * haze), int(9 + 30 * blue * haze + 18 * gold), int(20 + 50 * blue * haze)))
        small.putdata(pixels)
        self.background = small.resize((width, height), Image.Resampling.BICUBIC)
        self.stars = [(rng.randrange(width), rng.randrange(height), rng.random(), rng.random() * 6) for _ in range(100)]
        self.rays = [(rng.random() * math.tau, rng.uniform(.25, .85)) for _ in range(34)]
        self.particles = [(rng.random() * math.tau, rng.uniform(100, 400), rng.uniform(0, .4)) for _ in range(60)]
        font, lines, line_h = layout_text(text, font_path, width - round(180 * self.scale), round(370 * self.scale))
        # Confirm a Japanese font exists instead of silently drawing replacement boxes.
        probe = ImageFont.truetype(font_path, 32)
        if bytes(probe.getmask("医")) == bytes(probe.getmask("\uffff")):
            raise VideoError("japanese_font")
        mask = Image.new("L", (width, height)); d = ImageDraw.Draw(mask)
        y = height // 2 - len(lines) * line_h // 2
        for line in lines:
            box = font.getbbox(line)
            d.text(((width - font.getlength(line)) / 2, y - box[1]), line, font=font, fill=255, stroke_width=1)
            y += line_h
        gold = Image.new("RGB", (width, height)); gd = ImageDraw.Draw(gold)
        stops = [(0, (139, 79, 22)), (.35, (251, 226, 159)), (.49, (255, 250, 216)), (.55, (151, 83, 23)), (1, (240, 190, 83))]
        for y in range(height):
            p = y / height
            for i in range(len(stops) - 1):
                lo, a = stops[i]; hi, b = stops[i + 1]
                if lo <= p <= hi:
                    q = (p - lo) / (hi - lo)
                    gd.line((0, y, width, y), fill=tuple(round(a[j] * (1 - q) + b[j] * q) for j in range(3)))
                    break
        self.title = gold.convert("RGBA"); self.title.putalpha(mask)
        edge = Image.new("RGBA", (width, height), (50, 28, 9, 0)); edge.putalpha(mask.filter(ImageFilter.MaxFilter(5)))
        edge.alpha_composite(self.title); self.title = edge
        self.caption = ImageFont.truetype(font_path, max(16, round(34 * self.scale)))

    def frame(self, t):
        from PIL import Image, ImageDraw
        im = self.background.copy(); d = ImageDraw.Draw(im)
        for x, y, strength, phase in self.stars:
            brightness = round(100 + 125 * strength * (.5 + .5 * math.sin(t * 2 + phase)))
            d.ellipse((x, y, x + 2, y + 2), fill=(brightness, brightness, min(255, brightness + 25)))
        # Planetary limb and restrained gold orbit.
        d.arc((-self.w * .2, self.h * .62, self.w * 1.2, self.h * 2.1), 180, 360, fill=(88, 116, 156), width=max(1, round(3 * self.scale)))
        if t < IMPACT:
            caption = "その時が来た" if t >= 1 else ""
            if caption:
                d.text((self.w / 2, self.h / 2), caption, font=self.caption, anchor="mm", fill=(205, 221, 237))
        else:
            age = t - IMPACT; cx = self.w / 2; cy = self.h / 2
            strength = max(0, 1 - age / 3)
            for angle, length in self.rays:
                r0 = (50 + age * 50) * self.scale; r1 = (300 + length * 440 + age * 80) * self.scale
                color = (round(135 * strength), round(105 * strength), round(48 * strength))
                d.line((cx + math.cos(angle) * r0, cy + math.sin(angle) * r0,
                        cx + math.cos(angle) * r1, cy + math.sin(angle) * r1), fill=color, width=max(1, round(2 * self.scale)))
            for angle, speed, delay in self.particles:
                a = age - delay
                if a > 0 and a < 3.3:
                    x = cx + math.cos(angle) * speed * a * self.scale
                    y = cy + math.sin(angle) * speed * a * self.scale + a * a * 30 * self.scale
                    d.ellipse((x, y, x + 3, y + 3), fill=(245, 195, 96))
            scale = 1 + .12 * math.exp(-age * 7)
            tile = self.title.resize((round(self.w * scale), round(self.h * scale)), Image.Resampling.BICUBIC)
            rgba = im.convert("RGBA"); rgba.alpha_composite(tile, (round((self.w - tile.width) / 2), round((self.h - tile.height) / 2)))
            im = rgba.convert("RGB")
            if age < .13:
                im = Image.blend(im, Image.new("RGB", im.size, (255, 239, 201)), .45 * (1 - age / .13))
        # Smooth ending; the original score has its own corresponding release.
        fade = min(1, t / .4, (10 - t) / .6)
        if fade < 1:
            im = Image.blend(Image.new("RGB", im.size), im, max(0, fade))
        return im


def render(request: dict, job_dir: Path) -> dict:
    if not isinstance(request, dict) or set(request) != {"text", "template", "height", "fps", "max_bytes", "ffmpeg", "ffprobe", "font", "audio", "normalized"}:
        raise VideoError("worker_protocol")
    if request["normalized"] is not True or request["template"] != "fanfare":
        raise VideoError("worker_protocol")
    # Normalized input may be longer due to emoji labels, but stays tightly bounded.
    text = request["text"]
    if not isinstance(text, str) or not 0 < len(text) <= 160 or len(text.split("\n")) > 3:
        raise VideoError("text_length")
    import unicodedata
    if any(c != "\n" and unicodedata.category(c).startswith("C") for c in text):
        raise VideoError("text_control")
    height = _int(request["height"], 360, 720, "settings_invalid")
    if height not in (360, 480, 720):
        raise VideoError("settings_invalid")
    width = {360: 640, 480: 854, 720: 1280}[height]
    fps = _int(request["fps"], 12, 30, "settings_invalid")
    limit = _int(request["max_bytes"], 512 * 1024, 8 * 1024 * 1024, "video_size")
    output = job_dir / "clip.mp4"
    if not job_dir.is_dir() or job_dir.is_symlink() or output.exists():
        raise VideoError("output_exists")
    audio = Path(request["audio"])
    if audio.stat().st_size != 1920044 or hashlib.sha256(audio.read_bytes()).hexdigest() != ASSET_SHA256:
        raise VideoError("audio_invalid")
    with wave.open(str(audio), "rb") as w:
        if (w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()) != (2, 2, 48000, 480000):
            raise VideoError("audio_invalid")
    scene = FanfareScene(text, request["font"], width, height)
    cmd = [request["ffmpeg"], "-hide_banner", "-loglevel", "error", "-nostdin", "-n", "-threads", "1",
           "-filter_threads", "1", "-filter_complex_threads", "1", "-f", "rawvideo", "-pix_fmt", "rgb24",
           "-s", f"{width}x{height}", "-r", str(fps), "-i", "pipe:0", "-i", str(audio),
           "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264", "-preset", "veryfast", "-crf", "27",
           "-maxrate", "1800k", "-bufsize", "3600k", "-threads", "1", "-pix_fmt", "yuv420p",
           "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-t", "10", "-fs", str(limit),
           "-movflags", "+faststart", str(output)]
    started = time.monotonic()
    with subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) as proc:
        try:
            for n in range(DURATION * fps):
                proc.stdin.write(scene.frame(n / fps).tobytes())
            proc.stdin.close()
            if proc.wait(timeout=30):
                raise VideoError("render_failed")
        except BaseException:
            proc.kill(); proc.wait()
            raise
    if not 0 < output.stat().st_size <= limit:
        raise VideoError("video_size")
    probe = subprocess.run([request["ffprobe"], "-v", "error", "-show_streams", "-show_format", "-of", "json", str(output)],
                           capture_output=True, timeout=15, check=True)
    info = json.loads(probe.stdout)
    videos = [s for s in info["streams"] if s["codec_type"] == "video"]
    audios = [s for s in info["streams"] if s["codec_type"] == "audio"]
    if len(videos) != 1 or len(audios) != 1:
        raise VideoError("output_invalid")
    v = videos[0]; a = audios[0]
    if (v["width"], v["height"], v["codec_name"], v["pix_fmt"]) != (width, height, "h264", "yuv420p") or int(v.get("nb_frames", 0)) != DURATION * fps:
        raise VideoError("output_invalid")
    if abs(float(info["format"]["duration"]) - 10) > .1 or a["codec_name"] != "aac" or a["channels"] != 2:
        raise VideoError("output_invalid")
    return {"ok": True, "bytes": output.stat().st_size, "width": width, "height": height, "fps": fps,
            "frames": DURATION * fps, "duration": 10, "elapsed_seconds": round(time.monotonic() - started, 3), "impact_seconds": IMPACT}


def main():
    p = argparse.ArgumentParser(); p.add_argument("--job-dir", required=True); args = p.parse_args()
    try:
        lower_priority()
        data = sys.stdin.buffer.read(8193)
        if len(data) > 8192:
            raise VideoError("worker_protocol")
        report = render(json.loads(data), Path(args.job_dir))
        print(json.dumps(report), flush=True)
        return 0
    except Exception:
        # Parent supplies a stable error message. Do not print the title, font,
        # executable path, filesystem details, or input-bearing exceptions.
        print('{"ok":false,"error":"render_failed"}', flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
