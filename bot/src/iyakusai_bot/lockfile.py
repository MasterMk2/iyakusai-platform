# -*- coding: utf-8 -*-
"""単一インスタンスロック(要件定義 §4.1)。

クラウド(共有ドライブ)上の data/lock.json を全ホストで共有し、
「生きたロックを持つホストだけが Bot を起動できる」を保証する。
二重起動 = 二重返信・二重催促になるため、これは必須の安全装置。

- ハートビート: heartbeat_sec ごとに時刻を書き直す
- 乗っ取り: ハートビートが takeover_after_sec 途絶えたロックは死亡とみなす
- 同一ホスト(2026-08-12 追加・レビュー#5): host が同じでも pid が違うロックは
  **ハートビートが新しく、かつそのプロセスが生きている**ときだけ LockBusy。
  死んでいればハートビートの鮮度を待たずに即時乗っ取り。PID 再利用などで誤って
  拒否されたときの逃げ道は従来どおり --force / lock.json の削除(restart_bot.ps1 は
  旧プロセス kill 後に lock.json を消してから起動するので通常運用は影響を受けない)。
- 手動乗っ取り: acquire(force=True)(CLI の --force)

※ Google Drive の同期遅延があるため厳密なアトミック性はない。
  2ホスト運用・手動切替が前提の、実用上の排他である。
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

LOCK_FILENAME = "lock.json"


class LockBusy(Exception):
    def __init__(self, holder: dict):
        self.holder = holder
        # 2026-08-12: 同一ホストの二重起動も拒否するようになった(#5)ため、
        # 「別ホスト」と言い切らず host/pid を並べる。pid があれば
        # `Stop-Process -Id <pid>` で相手を特定できる(運用保守ガイド §3)。
        super().__init__(
            f"別インスタンスが稼働中です: host={holder.get('host')} "
            f"pid={holder.get('pid')} "
            f"(最終ハートビート {holder.get('heartbeat_at')})。"
            f"確実に停止しているなら --force で乗っ取れます。"
        )


def _now() -> datetime:
    return datetime.now(timezone.utc)


# Windows の生存確認に使う定数(下記 _pid_alive 参照)
_PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
_STILL_ACTIVE = 259
_ERROR_ACCESS_DENIED = 5


def _pid_alive(pid: int) -> bool:
    """pid のプロセスが生きているか。**判定できないときは True(生きている扱い)**。

    2026-08-12(レビュー#5)に追加。同一ホストの2プロセス目を検知するために使う。
    psutil は導入していないので標準ライブラリだけで判定する。

    「分からない」を False(死んでいる)に倒すと、生きている相手のロックを奪って
    二重起動になり、このモジュールが防ぎたい二重返信・二重催促そのものが起きる。
    True に倒した場合の最悪は「起動を拒否されて --force か lock.json 削除が要る」で、
    運用で復旧できる。害の大きさが非対称なので True 側に倒す。

    ※ Windows で os.kill(pid, 0) を使ってはいけない。POSIX と違い CPython の
      Windows 実装は CTRL_C/CTRL_BREAK 以外のシグナルを TerminateProcess に渡すため、
      生存確認のつもりが**相手を終了させてしまう**。Windows は OpenProcess で開けるか
      + 終了コードで判定する。
    """
    if not isinstance(pid, int) or pid <= 0:
        return False                     # pid が無い/壊れている = 生存の証拠なし
    if os.name == "nt":
        try:
            import ctypes
            k32 = ctypes.WinDLL("kernel32", use_last_error=True)
            k32.OpenProcess.argtypes = (ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32)
            k32.OpenProcess.restype = ctypes.c_void_p
            k32.GetExitCodeProcess.argtypes = (ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint32))
            k32.CloseHandle.argtypes = (ctypes.c_void_p,)
            h = k32.OpenProcess(_PROCESS_QUERY_LIMITED_INFORMATION, 0, pid)
            if not h:
                # 開けない理由が「権限が無い」なら**存在はしている**(別ユーザーのプロセス)。
                # 存在しない pid は ERROR_INVALID_PARAMETER(87)になるのでここは False。
                return ctypes.get_last_error() == _ERROR_ACCESS_DENIED
            try:
                code = ctypes.c_uint32()
                if k32.GetExitCodeProcess(h, ctypes.byref(code)):
                    return code.value == _STILL_ACTIVE
                return True              # 問い合わせ失敗 = 判定不能 → 生きている扱い
            finally:
                k32.CloseHandle(h)
        except Exception:
            return True                  # ctypes が使えない環境も判定不能扱い
    try:
        os.kill(pid, 0)                  # POSIX: シグナル0は存在確認のみ(送信しない)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True                      # 別ユーザーのプロセス = 存在する
    except OSError:
        return True                      # 判定不能 → 生きている扱い
    return True


class InstanceLock:
    def __init__(self, data_dir: Path, host: str, takeover_after_sec: int = 900):
        self.path = Path(data_dir) / LOCK_FILENAME
        self.host = host
        self.takeover_after = timedelta(seconds=takeover_after_sec)
        self._held = False

    def _read(self, strict: bool = True) -> dict | None:
        """lock.json を読む。無い・壊れているなら None。

        2026-08-12(レビュー#19): 「Drive の一時I/Oエラーを一律に握って None を返す」は
        **採らない**。読めなかったことを「ロックが無い」に潰すと、acquire は生きている
        相手を踏み潰し、heartbeat は乗っ取りを見落として二重稼働する — このモジュールが
        防ぐべき事故そのものになる。防御の向きは呼び出し元ごとに違うので、
        握ってよい呼び出し元(release = 終了処理)だけが strict=False を渡す。
        壊れた JSON・非UTF-8 は従来どおり「ロックが無い」扱い(次の _write で作り直す)。
        """
        try:
            return json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return None
        except (json.JSONDecodeError, UnicodeDecodeError):
            return None
        except OSError:
            if strict:
                raise
            return None

    def _write(self, started_at: str | None = None) -> None:
        payload = {
            "host": self.host,
            "pid": os.getpid(),
            "started_at": started_at or _now().isoformat(),
            "heartbeat_at": _now().isoformat(),
        }
        tmp = self.path.with_suffix(".json.tmp")
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
            os.replace(tmp, self.path)
        except OSError:
            # 2026-08-12(レビュー#19): ここは**握りつぶさない**。ハートビート書き込みの
            # 失敗を隠すと、相手からは「更新が止まった=死んだ」に見えて乗っ取られ、
            # 二重稼働になる。失敗は OSError のまま投げ、「次回ハートビートに賭ける」
            # 判断を持つ呼び出し元(bot.py:112-114)に委ねる。
            # 途中で失敗して残った .tmp だけは掃除して、ドライブに残骸を置かない。
            try:
                tmp.unlink()
            except OSError:
                pass
            raise

    def acquire(self, force: bool = False) -> None:
        cur = self._read()
        if cur and not force:
            # 2026-08-12(第2ラウンド): ハートビートの鮮度は**両分岐の共通の前提**に
            # 引き上げた。下記の同一ホスト分岐(#5)が鮮度を見ずに pid の生死だけで
            # 拒否していたため、Bot がクラッシュして lock.json が残り、その pid を
            # Windows が無関係なプロセスに再利用すると **--force 無しでは永久に
            # 起動できない**状態を作っていた(従来 takeover_after_sec を過ぎた lock は
            # 必ず乗っ取れたので退行)。稼働中の Bot は heartbeat_sec ごとに書き直すので、
            # #5 が守りたかった「手動の二重起動の検知」はこの条件でも失われない。
            try:
                hb = datetime.fromisoformat(cur["heartbeat_at"])
            except (KeyError, ValueError, TypeError):
                hb = None                # TypeError: heartbeat_at が null 等の壊れた値(#19)
            if hb is not None and hb.tzinfo is None:
                # tz 無しの値は UTC とみなす(_write は _now()=UTC aware で書くので、
                # naive が来るとしたら手編集や旧形式)。naive のまま比較すると
                # `_now() - hb` が **TypeError** になり、上の except を素通りして
                # 起動そのものが落ちる。鮮度不明を「古い」に倒すと生きた相手を
                # 踏み潰して二重稼働になるため、UTC 解釈で鮮度を残す側に倒す。
                hb = hb.replace(tzinfo=timezone.utc)
            fresh = hb is not None and _now() - hb < self.takeover_after
            if cur.get("host") != self.host:
                # 別ホスト: 従来どおりハートビートの鮮度だけで判断する
                # (pid は別マシンの番号なので比較しても意味が無い)。
                if fresh:
                    raise LockBusy(cur)
            else:
                # 同一ホスト(2026-08-12・レビュー#5): 従来はここが素通しで、
                # **2プロセス目が無条件にロックを上書き取得**していた。クロスホストの
                # 乗っ取りより日常的な「手動の二重起動」「再起動時の新旧プロセス重複」で
                # 二重返信・二重催促が起きる=ロックが必須の安全装置である意味を失う。
                # → ハートビートが新しい(=相手がまだ書き続けている)ことを前提に、
                #   さらに pid を見て、そのプロセスが生きているなら拒否。死んでいれば
                #   ハートビートの鮮度を待たずに即時乗っ取り(kill 直後の再起動を待たせない)。
                # pid が無い古い lock.json は判定材料が無いので従来どおり乗っ取る
                # (「pid が読めない=拒否」にすると旧形式のロックで起動不能になる)。
                pid = cur.get("pid")
                if fresh and isinstance(pid, int) and pid != os.getpid() and _pid_alive(pid):
                    raise LockBusy(cur)
        self._write()
        self._held = True

    def heartbeat(self) -> None:
        if not self._held:
            return
        cur = self._read()
        # 自分のロックでなくなっていたら(乗っ取られた)、書き戻さず停止を促す
        if cur and cur.get("host") not in (None, self.host):
            raise LockBusy(cur)
        started = (cur or {}).get("started_at")
        self._write(started_at=started)

    def release(self) -> None:
        if not self._held:
            return
        # 2026-08-12(レビュー#19): 終了処理なのでここだけは OSError を握る
        # (strict=False)。__main__ の finally で例外を投げると終了ログすら残らず、
        # 「なぜ落ちたか」の痕跡が消える。残った lock.json は次回起動時に
        # 同一ホスト判定(自分の pid はもう死んでいる)で即時乗っ取りできるので実害が無い。
        try:
            cur = self._read(strict=False)
            if cur and cur.get("host") == self.host:
                self.path.unlink()
        except OSError:
            pass
        self._held = False
