# -*- coding: utf-8 -*-
"""SVG → PNG の変換だけをする子プロセス(/image・2026-10-14 追加)。

Bot 本体(images.py)が `<python> -I svg_render.py` で起動する。Bot のプロセスでは変換しない:
悪い形の SVG で変換が重くなっても、時間切れで子プロセスを殺せば Bot は止まらない。

- 標準入力: JSON {"svg", "width", "height", "font_dir", "resources_dir"}(svg は無害化済み)
- 標準出力: PNG のバイト列
- 終了コード: 0 成功 / 2 入力が読めない / 3 変換に失敗 / 4 resvg_py が無い。理由は標準エラーに 1 行
- import は標準ライブラリと resvg_py だけ(-I で起動するので、同じフォルダの他のモジュールは読まない)
- システムのフォントは読まない(font_dir の書体だけ)。resources_dir は空のフォルダを渡す
  (無害化で外部参照は消してあるが、万一残っても読む先が空になる二重の守り)
- Linux ではメモリと CPU 時間に上限をかける
"""

import json
import sys

MEMORY_LIMIT_BYTES = 1024 * 1024 * 1024
CPU_LIMIT_SEC = 60
MAX_SIDE = 4096


def _limit() -> None:
    try:
        import resource
    except ImportError:   # Windows(開発機の試験)
        return
    resource.setrlimit(resource.RLIMIT_AS, (MEMORY_LIMIT_BYTES, MEMORY_LIMIT_BYTES))
    resource.setrlimit(resource.RLIMIT_CPU, (CPU_LIMIT_SEC, CPU_LIMIT_SEC))


def _fail(code: int, message: str) -> int:
    # -I では PYTHONIOENCODING が効かないので、端末の文字コードに頼らず UTF-8 で書く
    sys.stderr.buffer.write((message.replace("\n", " ")[:300] + "\n").encode("utf-8"))
    sys.stderr.buffer.flush()
    return code


def main() -> int:
    _limit()
    try:
        request = json.loads(sys.stdin.buffer.read().decode("utf-8"))
        svg = request["svg"]
        width, height = int(request["width"]), int(request["height"])
        font_dir, resources_dir = str(request["font_dir"]), str(request["resources_dir"])
        if not isinstance(svg, str) or not svg or not (0 < width <= MAX_SIDE and 0 < height <= MAX_SIDE):
            raise ValueError("svg/width/height")
    except Exception as error:  # noqa: BLE001
        return _fail(2, f"入力が読めません: {type(error).__name__}")
    try:
        import resvg_py
    except ImportError:
        return _fail(4, "resvg_py がありません")
    try:
        png = resvg_py.svg_to_bytes(
            svg_string=svg, width=width, height=height,
            skip_system_fonts=True, font_dirs=[font_dir], resources_dir=resources_dir,
            languages=["ja", "en"],
            font_family="Noto Sans JP", sans_serif_family="Noto Sans JP", serif_family="Noto Serif JP",
            monospace_family="Noto Sans JP", cursive_family="Klee One", fantasy_family="Dela Gothic One",
        )
    except Exception as error:  # noqa: BLE001
        return _fail(3, f"変換に失敗: {type(error).__name__}: {error}")
    sys.stdout.buffer.write(bytes(png))
    sys.stdout.buffer.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
