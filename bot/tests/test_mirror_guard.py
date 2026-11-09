# -*- coding: utf-8 -*-
"""ミラー同期の削除の歯止め(2026-11-09)の試験。

サーバーの再起動で rclone のマウントが先に外れ、止める途中の同期がソースの一覧を空と読んで
ミラーから 1,905 件を消した。ソースが読めないとき・大量に消えたときは削除を保留し、
遮断リスト(機微)に入ったものだけは保留せずに消すことを確かめる。"""

from __future__ import annotations

import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SRC = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC))

from iyakusai_bot import mirror as m  # noqa: E402


class MirrorRemoveGuardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.root = base / "root"
        self.mirror = base / "mirror"
        self.digest = self.root / "discord" / "digest"
        self.digest.mkdir(parents=True)

    def tearDown(self):
        self.tmp.cleanup()

    def _make(self, names):
        for n in names:
            (self.digest / n).write_text("本文\n", encoding="utf-8")

    def _mirrored(self):
        return sorted(p.name for p in (self.mirror / "discord" / "digest").glob("*.md"))

    def test_small_removal_is_applied(self):
        self._make([f"d{i}.md" for i in range(10)])
        m.sync_mirror(self.root, self.mirror)
        (self.digest / "d0.md").unlink()
        st = m.sync_mirror(self.root, self.mirror)
        self.assertEqual(st["removed"], 1)
        self.assertEqual(st["removal_held"], 0)
        self.assertIsNone(st["hold_reason"])
        self.assertNotIn("d0.md", self._mirrored())
        self.assertEqual(len(self._mirrored()), 9)

    def test_mass_removal_is_held_until_allowed(self):
        self._make([f"d{i:03d}.md" for i in range(120)])
        m.sync_mirror(self.root, self.mirror)
        for i in range(100):
            (self.digest / f"d{i:03d}.md").unlink()
        st = m.sync_mirror(self.root, self.mirror)
        self.assertEqual(st["removed"], 0)
        self.assertEqual(st["removal_held"], 100)
        self.assertEqual(st["hold_reason"], "too_many")
        self.assertEqual(len(self._mirrored()), 120)
        # 保留したものは manifest に残り、次の同期で判断し直される
        st = m.sync_mirror(self.root, self.mirror, allow_mass_remove=True)
        self.assertEqual(st["removed"], 100)
        self.assertEqual(st["removal_held"], 0)
        self.assertEqual(len(self._mirrored()), 20)

    def test_source_unavailable_at_start_skips_everything(self):
        self._make([f"d{i}.md" for i in range(5)])
        m.sync_mirror(self.root, self.mirror)
        shutil.rmtree(self.root)
        self.root.mkdir()  # マウントが外れたあとの空のマウント先
        st = m.sync_mirror(self.root, self.mirror)
        self.assertEqual(st["skipped"], "source_unavailable")
        self.assertEqual(st["removed"], 0)
        self.assertEqual(len(self._mirrored()), 5)

    def test_missing_root_skips(self):
        self._make(["d0.md"])
        m.sync_mirror(self.root, self.mirror)
        st = m.sync_mirror(self.root / "no-such-dir", self.mirror)
        self.assertEqual(st["skipped"], "source_unavailable")
        self.assertEqual(self._mirrored(), ["d0.md"])

    def test_source_lost_during_scan_holds_removal(self):
        self._make([f"d{i}.md" for i in range(5)])
        m.sync_mirror(self.root, self.mirror)
        (self.digest / "d0.md").unlink()
        (self.digest / "d1.md").unlink()
        # 始める前は読めたが、走査のあと(削除の直前)には読めなくなっていた
        with mock.patch.object(m, "_source_alive", side_effect=[True, False]):
            st = m.sync_mirror(self.root, self.mirror)
        self.assertEqual(st["removed"], 0)
        self.assertEqual(st["removal_held"], 2)
        self.assertEqual(st["hold_reason"], "source_unavailable")
        self.assertEqual(len(self._mirrored()), 5)

    def test_blocked_files_are_removed_even_in_bulk(self):
        self._make([f"secret{i:03d}.md" for i in range(120)] + ["plain.md"])
        m.sync_mirror(self.root, self.mirror, blocklist=["no-match-pattern"])
        self.assertEqual(len(self._mirrored()), 121)
        st = m.sync_mirror(self.root, self.mirror, blocklist=["secret"])
        self.assertEqual(st["removed"], 120)
        self.assertEqual(st["removal_held"], 0)
        self.assertEqual(self._mirrored(), ["plain.md"])


if __name__ == "__main__":
    unittest.main()
