# -*- coding: utf-8 -*-
"""メールの草案(mail_draft・/mail・/doc の「メール文面」)の試験(2026-10-25)。実 Discord・実 AI には接続しない。"""

from __future__ import annotations

import asyncio
import sys
import unittest
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from zoneinfo import ZoneInfo

SRC = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC))

import discord  # noqa: E402

from iyakusai_bot import assistant_cog as AC  # noqa: E402
from iyakusai_bot import assistant_logic as L  # noqa: E402
from iyakusai_bot import documents as D  # noqa: E402
from iyakusai_bot import mail_draft as M  # noqa: E402
from iyakusai_bot.ai_provider import AIError, AIResult  # noqa: E402


class ComposeTests(unittest.TestCase):
    def test_compose_uses_the_labels_the_app_also_uses(self):
        text = M.compose_request(" 学務課 ご担当者様 ", "会計書類を提出します\n提出先は?", sender="総務部 山田",
                                 relation="ongoing", received="学務課の担当です。\n書類をお願いします。")
        self.assertEqual(text, "【相手】学務課 ご担当者様\n【差出人】総務部 山田\n【これまでのやりとり】以前からやりとりがある\n"
                               "【要件】\n会計書類を提出します\n提出先は?\n"
                               "【届いたメール(これへの返信を書く)】\n学務課の担当です。\n書類をお願いします。")

    def test_empty_optional_parts_are_left_out(self):
        self.assertEqual(M.compose_request("先方", "お礼", sender="  ", relation="auto", received=""),
                         "【相手】先方\n【要件】\nお礼")

    def test_the_largest_request_fits_the_doc_content_limit(self):
        # アプリは /doc の内容(2000 字まで)として送る。各欄を上限まで埋めても収まること
        text = M.compose_request("相" * M.MAX_TO, "要" * M.MAX_PURPOSE, sender="差" * M.MAX_SENDER,
                                 relation="ongoing", received="届" * M.MAX_RECEIVED)
        self.assertLessEqual(len(text), 2000)
        inp = L.doc_input({"docType": "mail", "content": text, "format": "txt", "useSources": True,
                           "model": "auto"}, gemini=False)
        self.assertEqual(inp["content"], text)

    def test_search_text_drops_labels_and_most_of_the_received_mail(self):
        text = M.compose_request("サンプルレンタル", "発電機の見積依頼", received="あ" * 500)
        query = M.search_text(text)
        self.assertNotIn("【", query)
        self.assertTrue(query.startswith("サンプルレンタル 発電機の見積依頼 "))
        self.assertEqual(query.count("あ"), 200)

    def test_kind_value_matches_the_doc_choices_and_the_app_labels(self):
        self.assertIn(M.MAIL_KIND_VALUE, [c.value for c in D.DOC_TYPES])
        self.assertEqual(AC.DOC_TYPE_LABELS["mail"][1], M.MAIL_KIND_VALUE)
        self.assertTrue(M.is_mail_kind(M.MAIL_KIND_VALUE))
        self.assertFalse(M.is_mail_kind("依頼文(学外の企業・団体宛)"))


class PromptTests(unittest.TestCase):
    def test_prompt_has_rules_today_sources_and_request(self):
        now = datetime(2026, 10, 25, 9, 0, tzinfo=ZoneInfo("Asia/Tokyo"))
        prompt = M.build_prompt("【相手】先方\n【要件】\nお礼", "[1] 資料.md\n本文", now=now)
        self.assertIn("1 行目は「件名：<件名>」", prompt)
        self.assertIn("拝啓・敬具などの頭語と結語", prompt)
        self.assertIn("# 今日の日付\n2026年10月25日(日)", prompt)
        self.assertIn("# 資料抜粋(参考)\n[1] 資料.md", prompt)
        self.assertTrue(prompt.rstrip().endswith("# 依頼\n【相手】先方\n【要件】\nお礼"))

    def test_prompt_asks_for_this_years_numbers_and_conditions_as_conditions(self):
        prompt = M.build_prompt("依頼", "")
        self.assertIn("今年度の資料に書かれているものだけを使う", prompt)
        self.assertIn("【口数・金額(今年度の協賛体系で確認)】", prompt)
        self.assertIn("条件のまま相手に伝える", prompt)
        self.assertIn("確かめていないこと", prompt)
        self.assertIn("資料から部署名などを足さない", prompt)

    def test_fiscal_year_starts_in_april(self):
        jst = ZoneInfo("Asia/Tokyo")
        self.assertEqual(M.fiscal_year(datetime(2026, 10, 25, tzinfo=jst)), 2026)
        self.assertEqual(M.fiscal_year(datetime(2027, 3, 31, 23, 59, tzinfo=jst)), 2026)
        self.assertEqual(M.fiscal_year(datetime(2027, 4, 1, tzinfo=jst)), 2027)

    def test_past_sources(self):
        past = [
            "(文書) 委員会再編前ファイル/疎開資料【GoogleDrive】/2025/協賛/広告協賛依頼文/協賛依頼文2025_病院価格表_返信必須.docx",
            "過去アーカイブ運営プレイブック.md",
            "(文書) 2025医薬祭/会計/決算.xlsx",
            "(文書) 協賛/令和7年度_申込書.pdf",
            "(文書) 報告/R5医学薬学祭報告書.docx",
        ]
        current = [
            "mail/digest/月次_2026-07.md",
            "(文書) 2026医薬祭/外務部/渉外課/協賛・協力・寄付マスター_20260929.xlsx",
            "(Discord #渉外課) 2026-10-02",
            "discord/digest/渉外課.md",              # 年が書いていない＝過去と決めない(中身の日付で読む)
            "(文書) 2026医薬祭/2025年度との比較.md",   # 新しいほうの年で決める
        ]
        for source in past:
            self.assertTrue(M.is_past_source(source, 2026), source)
        for source in current:
            self.assertFalse(M.is_past_source(source, 2026), source)

    def test_context_headings_are_marked_and_bodies_untouched(self):
        context = ("[出典1: mail/digest/月次_2026-07.md]\n2025年の口数は 8 口でした。\n\n"
                   "[出典2: (文書) 委員会再編前ファイル/2025/協賛/価格表.docx]\n1/4ページ(横) 12口\n")
        marked = M.mark_past_sources(context, datetime(2026, 10, 25, tzinfo=ZoneInfo("Asia/Tokyo")))
        self.assertEqual(marked, ("[出典1: mail/digest/月次_2026-07.md]\n2025年の口数は 8 口でした。\n\n"
                                  "[出典2: (文書) 委員会再編前ファイル/2025/協賛/価格表.docx]" + M.PAST_MARK
                                  + "\n1/4ページ(横) 12口\n"))
        self.assertTrue(M.PAST_MARK.startswith("(過去年度の資料"))
        prompt = M.build_prompt("依頼", context, datetime(2026, 10, 25, tzinfo=ZoneInfo("Asia/Tokyo")))
        self.assertIn("価格表.docx]" + M.PAST_MARK, prompt)
        self.assertIn("(今年度は 2026 年度＝医学薬学祭2026)", prompt)

    def test_no_sources_section_without_context(self):
        self.assertNotIn("# 資料抜粋", M.build_prompt("依頼", ""))

    def test_signature_has_no_real_phone_or_member_address(self):
        # GitHub に置くリポジトリなので、署名は【 】のまま。委員会の住所(大学の公開住所)だけ実物
        self.assertIn("【連絡先メールアドレス】", M.MAIL_INSTRUCTIONS)
        self.assertNotRegex(M.MAIL_INSTRUCTIONS, r"\d{2,4}-\d{2,4}-\d{3,4}")
        self.assertNotIn("@", M.MAIL_INSTRUCTIONS)


class NormalizeTests(unittest.TestCase):
    def test_signature_address_comes_from_the_config(self):
        self.assertIn("【住所】", M.build_prompt("依頼", ""))
        try:
            M.set_address("〒000-0000 架空市本町 1-2-3")
            prompt = M.build_prompt("依頼", "")
            self.assertIn("〒000-0000 架空市本町 1-2-3", prompt)
            self.assertNotIn(M.ADDRESS_SLOT, prompt)
        finally:
            M.set_address(None)

    def test_fences_markdown_and_subject_variants(self):
        raw = "```text\n# 件名: **お見積りのお願い**\n\n\n\n株式会社◯◯\n**【担当者名】**様\n```\n"
        draft = M.normalize(raw)
        self.assertEqual(draft, "件名：お見積りのお願い\n\n株式会社◯◯\n【担当者名】様\n")
        self.assertEqual(M.split(draft), ("お見積りのお願い", "株式会社◯◯\n【担当者名】様"))

    def test_missing_subject_gets_a_placeholder(self):
        draft = M.normalize("\n株式会社◯◯\nご担当者様\n")
        self.assertTrue(draft.startswith("件名：【件名】\n\n株式会社◯◯"))
        self.assertEqual(M.split(draft)[0], "【件名】")

    def test_crlf_and_english_subject(self):
        self.assertEqual(M.normalize("Subject: Re: 打合せ\r\n\r\n本文\r\n"), "件名：Re: 打合せ\n\n本文\n")

    def test_empty_output(self):
        self.assertEqual(M.normalize(""), "件名：【件名】\n\n\n")

    def test_placeholders_in_order_without_duplicates(self):
        draft = "件名：【件名】\n\n【担当者名】様\n【日時】に【場所】で。【日時】\n【氏名】【所属(部・課)】"
        self.assertEqual(M.placeholders(draft), ["【件名】", "【担当者名】", "【日時】", "【場所】", "【氏名】", "【所属(部・課)】"])
        self.assertEqual(len(M.placeholders(draft, limit=3)), 3)


# ---- /mail(Discord)の本体を、送信を記録する偽の Interaction で動かす ----

class RecordingItx:
    def __init__(self):
        self.id = 4242
        self.user = "テスト委員"
        self.sent: list[tuple[str | None, dict]] = []
        self.deferred = False
        self.response = SimpleNamespace(defer=self._defer, send_message=self._send_message)
        self.followup = SimpleNamespace(send=self._send)

    async def _defer(self, *, ephemeral=False, thinking=False):
        self.deferred = True

    async def _send_message(self, content=None, **kw):
        self.sent.append((content, kw))

    async def _send(self, content=None, **kw):
        self.sent.append((content, kw))


class FakeKB:
    def __init__(self, fail=False):
        self.fail = fail
        self.queries = []

    def search(self, query, max_excerpts=10, use_fields=True):
        self.queries.append((query, use_fields))
        if self.fail:
            raise OSError("索引が読めない")
        from iyakusai_bot.knowledge_search import Excerpt, SearchResult
        return SearchResult(terms=[], excerpts=[Excerpt(source="mail/raw/mail_2026-10.jsonl", text="提出期限は11/6", score=5)])


class FakeProvider:
    def __init__(self, text="件名：会計書類の提出について\n\n学務課\nご担当者様\n\n本文です。@everyone\n", error=None):
        self.text = text
        self.error = error
        self.prompts = []
        self.chosen = []

    def choose_model(self, text, kind=None, override=None):
        self.chosen.append((kind, override))
        return override if override and override != "auto" else "opus"

    async def complete(self, prompt, model=None, timeout=None, effort=None):
        self.prompts.append(prompt)
        if self.error:
            raise self.error
        return AIResult(text=self.text, model=model, usage={"input_tokens": 100, "output_tokens": 50})

    async def draft(self, *args, **kwargs):
        raise AssertionError("メールは draft(文書の指示)を通らない")


def run_mail(provider, kb=None, **opts):
    itx = RecordingItx()
    docs = D.Documents(SimpleNamespace(), kb if kb is not None else FakeKB(), provider, None, 160.0)
    args = dict(相手="学務課 ご担当者様", 要件="会計書類を11/6までに提出します", 届いたメール=None, 差出人=None,
                やりとり=None, 資料参照=True, モデル=None)
    args.update(opts)
    asyncio.run(docs.mail.callback(docs, itx, *args.values()))
    return itx


class MailCommandTests(unittest.TestCase):
    def test_note_and_txt_first_then_the_draft_without_mentions(self):
        provider = FakeProvider()
        itx = run_mail(provider)
        self.assertTrue(itx.deferred)
        self.assertEqual(len(itx.sent), 2)
        note, kw = itx.sent[0]
        self.assertTrue(note.startswith("✉️ **会計書類の提出について**(メールの草案)\n"))
        self.assertIn("送る前に必ず確かめて", note)
        self.assertIn("-# model: opus", note)
        self.assertNotIn("要記入", note)   # 【】が無い草案
        self.assertTrue(kw["file"].filename.endswith(".txt"))
        self.assertEqual(kw["file"].fp.read().decode("utf-8"),
                         "件名：会計書類の提出について\n\n学務課\nご担当者様\n\n本文です。@everyone\n")
        body, kw2 = itx.sent[1]
        self.assertEqual(body, "件名：会計書類の提出について\n\n学務課\nご担当者様\n\n本文です。@everyone")
        mentions = kw2["allowed_mentions"]
        self.assertFalse(mentions.everyone or mentions.users or mentions.roles)
        self.assertEqual(provider.chosen, [(M.MAIL_KIND_VALUE, None)])

    def test_options_reach_the_prompt_and_search(self):
        provider, kb = FakeProvider(), FakeKB()
        relation = discord.app_commands.Choice(name="初めて連絡する", value="first")
        model = discord.app_commands.Choice(name="sonnet", value="sonnet")
        itx = run_mail(provider, kb, 届いたメール="学務課の担当です。期限を教えてください。", 差出人="会計課 佐藤",
                       やりとり=relation, モデル=model)
        prompt = provider.prompts[0]
        self.assertIn("【差出人】会計課 佐藤", prompt)
        self.assertIn("【これまでのやりとり】初めて連絡する", prompt)
        self.assertIn("【届いたメール(これへの返信を書く)】\n学務課の担当です。", prompt)
        self.assertIn("提出期限は11/6", prompt)
        self.assertEqual(kb.queries, [("学務課 ご担当者様 会計課 佐藤 初めて連絡する 会計書類を11/6までに提出します "
                                       "学務課の担当です。期限を教えてください。", False)])
        self.assertIn("-# model: sonnet", itx.sent[0][0])

    def test_placeholders_are_listed_in_the_note(self):
        itx = run_mail(FakeProvider(text="件名：お礼\n\n【担当者名】様\n【氏名】\n"))
        self.assertIn("-# 要記入: 【担当者名】 【氏名】\n", itx.sent[0][0])

    def test_search_failure_still_drafts_and_says_so_first(self):
        provider = FakeProvider()
        itx = run_mail(provider, FakeKB(fail=True))
        note = itx.sent[0][0]
        self.assertEqual(note.splitlines()[1], D._SEARCH_SKIPPED_NOTE)
        self.assertNotIn("# 資料抜粋", provider.prompts[0])

    def test_without_sources_the_kb_is_not_searched(self):
        kb = FakeKB()
        run_mail(FakeProvider(), kb, 資料参照=False)
        self.assertEqual(kb.queries, [])

    def test_ai_failure_is_reported(self):
        itx = run_mail(FakeProvider(error=AIError("時間切れ")))
        self.assertEqual(len(itx.sent), 1)
        self.assertIn("起草に失敗しました(時間切れ)", itx.sent[0][0])

    def test_no_provider_answers_privately(self):
        itx = RecordingItx()
        docs = D.Documents(SimpleNamespace(), FakeKB(), None, None, 160.0)
        asyncio.run(docs.mail.callback(docs, itx, "先方", "お礼", None, None, None, True, None))
        self.assertEqual(itx.sent, [("⚠️ AIプロバイダが無効のため /mail は使えません(config の [ai] を確認)。",
                                     {"ephemeral": True})])

    def test_long_draft_is_split_for_discord(self):
        long_body = "件名：長い\n\n" + ("あ" * 90 + "\n") * 30
        itx = run_mail(FakeProvider(text=long_body))
        self.assertGreater(len(itx.sent), 2)
        self.assertTrue(all(len(content) <= 2000 for content, _ in itx.sent))


class DocCommandTests(unittest.TestCase):
    """/doc の「メール文面」もメールの指示を使う。ほかの種類は従来どおり draft を通る。"""

    def test_doc_mail_type_uses_the_mail_prompt_and_keeps_file_only(self):
        provider = FakeProvider()
        itx = RecordingItx()
        docs = D.Documents(SimpleNamespace(), FakeKB(), provider, None, 160.0)
        kind = discord.app_commands.Choice(name="メール文面", value=M.MAIL_KIND_VALUE)
        asyncio.run(docs.doc.callback(docs, itx, kind, "ご担当者様に会計書類の提出を連絡", None, True, None))
        self.assertEqual(len(itx.sent), 1)   # /doc はファイルだけ(本文の投稿はしない)
        self.assertTrue(itx.sent[0][1]["file"].filename.endswith(".docx"))
        self.assertIn("(メールの草案)", itx.sent[0][0])
        self.assertIn("# 依頼\nご担当者様に会計書類の提出を連絡", provider.prompts[0])

    def test_other_doc_types_still_use_draft(self):
        class DraftProvider(FakeProvider):
            async def draft(self, doc_type, instruction, context="", model=None):
                self.prompts.append((doc_type, instruction))
                return AIResult(text="# 見積依頼\n\n本文", model=model, usage={})

        provider = DraftProvider()
        itx = RecordingItx()
        docs = D.Documents(SimpleNamespace(), FakeKB(), provider, None, 160.0)
        kind = discord.app_commands.Choice(name="依頼文(対外)", value="依頼文(学外の企業・団体宛)")
        asyncio.run(docs.doc.callback(docs, itx, kind, "発電機の見積依頼", None, False, None))
        self.assertEqual(provider.prompts, [("依頼文(学外の企業・団体宛)", "発電機の見積依頼")])
        self.assertTrue(itx.sent[0][0].startswith("📄 **見積依頼**(たたき台・依頼文(対外))\n"))
        self.assertIn("-# 【◯◯】は要記入のプレースホルダ。", itx.sent[0][0])


if __name__ == "__main__":
    unittest.main()
