# -*- coding: utf-8 -*-
"""意味検索をフォルダで絞る口(KnowledgeBase.search_docs_under・2026-10-25)の試験。偽の小さな索引で動かす。"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC))

from types import SimpleNamespace  # noqa: E402

from iyakusai_bot.knowledge_search import KnowledgeBase  # noqa: E402


class _Vec(list):
    """numpy の代わり(試験の環境に numpy が無くても動くように)。_search_vectors が使う形だけ。"""

    def __neg__(self):
        return _Vec(-x for x in self)


class _Mat:
    def __init__(self, scores):
        self.scores = scores

    def __matmul__(self, query):
        return _Vec(self.scores)   # 問いとの類似度をそのまま持たせる


np = SimpleNamespace(argsort=lambda values: [i for i, _ in sorted(enumerate(values), key=lambda p: p[1])])

# (文書, チャンク, 先頭の抜き書き, 問いとの類似度)
ROWS = [
    ("委員会再編前ファイル/2025/協賛/価格表.docx", 0, "", 0.90),
    ("委員会再編前ファイル/2025/協賛/価格表.docx", 1, "", 0.89),   # 同じ文書の別チャンク(畳まれる)
    ("委員会再編前ファイル/2025/協賛/価格表のコピー.docx", 0, "", 0.88),
    ("委員会再編前ファイル/2023/協賛/料金表.docx", 0, "", 0.87),
    ("委員会再編前ファイル/2025/電話原稿.pdf", 0, "", 0.86),
    ("委員会再編前ファイル/2024/協賛/依頼文.docx", 0, "", 0.85),
    ("2026医薬祭/外務部/渉外課/2026協賛のお願い.docx", 0, "", 0.76),
    ("2026医薬祭/外務部/渉外課/2026協賛申込書.docx", 0, "", 0.70),
    ("2026医薬祭/外務部/渉外課/古いメモ.docx", 0, "", 0.40),         # 閾値(0.5)未満
]


def make_kb():
    kb = KnowledgeBase.__new__(KnowledgeBase)   # 本物の索引・ドライブには触れない
    kb.root = Path(tempfile.mkdtemp(prefix="kb-"))
    kb.vector = True
    kb.vector_topk = 4
    kb.vector_min_score = 0.5
    kb._vec_snippet_warned = False
    mat = _Mat([s for *_, s in ROWS])
    rows = [(rel, idx, snip) for rel, idx, snip, _ in ROWS]
    kb._load_vectors = lambda: (np, mat, rows, "raw")
    kb._embed = lambda query: "q"
    kb._raw_chunk_text = lambda rel, idx, eligible=None: f"{rel} の本文 {idx}"
    kb._blocked = lambda source: False
    return kb


class SearchDocsUnderTests(unittest.TestCase):
    def test_the_usual_search_is_unchanged(self):
        out = make_kb()._search_vectors("問い")
        self.assertEqual([e.source for e in out], [
            "(文書) 委員会再編前ファイル/2025/協賛/価格表.docx",
            "(文書) 委員会再編前ファイル/2025/協賛/価格表のコピー.docx",
            "(文書) 委員会再編前ファイル/2023/協賛/料金表.docx",
            "(文書) 委員会再編前ファイル/2025/電話原稿.pdf",
        ])

    def test_only_the_folder_and_above_the_threshold(self):
        out = make_kb().search_docs_under("問い", ("2026医薬祭/",), 3)
        self.assertEqual([e.source for e in out], [
            "(文書) 2026医薬祭/外務部/渉外課/2026協賛のお願い.docx",
            "(文書) 2026医薬祭/外務部/渉外課/2026協賛申込書.docx",
        ])
        self.assertEqual(out[0].text, "2026医薬祭/外務部/渉外課/2026協賛のお願い.docx の本文 0")

    def test_limit(self):
        out = make_kb().search_docs_under("問い", ("2026医薬祭/",), 1)
        self.assertEqual(len(out), 1)

    def test_no_prefix_returns_nothing(self):
        self.assertEqual(make_kb().search_docs_under("問い", (), 2), [])

    def test_blocked_sources_are_dropped(self):
        kb = make_kb()
        kb._blocked = lambda source: "申込書" in source
        out = kb.search_docs_under("問い", ("2026医薬祭/",), 3)
        self.assertEqual([e.source for e in out], ["(文書) 2026医薬祭/外務部/渉外課/2026協賛のお願い.docx"])


if __name__ == "__main__":
    unittest.main()
