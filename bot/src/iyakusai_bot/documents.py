# -*- coding: utf-8 -*-
"""F4 文書ドラフト生成(/doc)とメールの草案(/mail)。AI が起草 → docx/md/txt 添付で返す。

/mail(2026-10-25 追加)は相手・要件などを mail_draft.compose_request で 1 つの依頼にまとめ、
/doc の「メール文面」と同じ起草処理に渡す。違いは返し方だけで、/mail は草案を本文としても投稿する
(貼り付けて使うため)。統合アプリの「メール」は /doc(docType=mail)として来るので、この経路を通る。
"""

from __future__ import annotations

import asyncio
import io
import logging
import time

import discord
from discord import app_commands
from discord.ext import commands

from . import docgen, mail_draft
from .ai_provider import AIError, elapsed_note
from .knowledge import _chunks, safe_send
from .knowledge_search import KnowledgeBase, render_context

log = logging.getLogger("iyakusai.documents")

DOC_TYPES = [
    app_commands.Choice(name="依頼文(対外)", value="依頼文(学外の企業・団体宛)"),
    app_commands.Choice(name="お知らせ(学内・委員向け)", value="お知らせ・周知文(学内または委員会内向け)"),
    app_commands.Choice(name="報告書", value="報告書"),
    app_commands.Choice(name="議事録たたき台", value="議事録のたたき台(日時・出席者・議題・決定事項の枠組み)"),
    app_commands.Choice(name="メール文面", value="メール文面(件名+本文)"),
    app_commands.Choice(name="自由(内容の指示に従う)", value="自由形式"),
]
FMT_CHOICES = [app_commands.Choice(name=f, value=f) for f in docgen.FORMATS]
MODEL_CHOICES = [
    app_commands.Choice(name="自動(対外文書・報告書はopusへ)", value="auto"),
    app_commands.Choice(name="sonnet(標準・速い)", value="sonnet"),
    app_commands.Choice(name="opus(高性能・遅め)", value="opus"),
]
RELATION_CHOICES = [
    app_commands.Choice(name="初めて連絡する", value="first"),
    app_commands.Choice(name="以前からやりとりがある", value="ongoing"),
]

# 資料参照(kb.search)に使ってよい秒数。**無制限に待たない**のは /ask と同じ理由:
# 共有ドライブ(Google Drive FS)は数分単位でストールすることがあり、待ち切ると
# followup 送信可能時間(defer から15分)を検索だけで使い切って**完全沈黙**になる
# (/doc 側だけこのガードが無かった・2026-08-12)。120秒 + 起草の ai_timeout 既定180秒で
# 15分にはまだ大きく余裕がある。
# ★打ち切ったら**資料参照なしで起草を続行する**。/doc の主目的は起草であって資料提示では
#  なく、参考資料が無くても下書きは返せる——「たたき台が届かない」より「たたき台は届くが
#  資料は参照できなかった」ほうが利用者の利益になる。**黙って落とさず注記で見せる**
#  (_目録/AI作業方針.md §3-4: 沈黙して劣化させない)。
_SEARCH_BUDGET_SEC = 120
_SEARCH_SKIPPED_NOTE = "-# ⚠ 共有ドライブの応答が遅く、資料を参照せずに起草しました(事実関係は要確認)。"
_MAIL_CHECK_NOTE = "-# 宛先・日時・金額などの事実は、送る前に必ず確かめてください。送信は各自の委員会のメールアドレスから。"
_CURRENT_YEAR_DOCS = 2   # メールの草案で、今年度のフォルダから先頭に足す文書の数


def _current_year_first(kb, query: str, excerpts: list) -> list:
    """メールの草案用: 今年度のフォルダ(例: 2026医薬祭/)の文書を意味検索で別に拾い、資料の先頭に置く。
    全体の検索では過去年度の似た文書が上位を占め、今年度の協賛の料金表が 17 位で入らなかった(2026-10-25 実測)。
    render_context は予算を先頭から使うので、先頭に置いたものが確実に AI に渡る。同じ文書は 1 回だけ。"""
    pick = getattr(kb, "search_docs_under", None)
    if pick is None:
        return excerpts
    try:
        current = pick(query, (f"{mail_draft.fiscal_year()}医薬祭/",), _CURRENT_YEAR_DOCS)
    except Exception as e:  # noqa: BLE001  足せなくても通常の資料で起草は続ける
        log.warning("今年度の資料の追加検索に失敗(通常の資料だけで起草): %s", type(e).__name__)
        return excerpts
    seen = {e.source for e in current}
    return list(current) + [e for e in excerpts if e.source not in seen]


class Documents(commands.Cog):
    def __init__(self, bot: commands.Bot, kb: KnowledgeBase | None, provider, usage_log=None, usd_jpy=160.0):
        self.bot = bot
        self.kb = kb
        self.provider = provider
        self.usage_log = usage_log
        self.usd_jpy = usd_jpy

    @app_commands.command(name="doc", description="文書のたたき台をAIが起草してファイルで返す")
    @app_commands.describe(
        種類="文書の種類",
        内容="何の文書か・盛り込む内容(例: サンプルレンタル宛に発電機3台の見積依頼)",
        形式="出力ファイル形式(既定: docx)",
        資料参照="_目録から関連資料を検索して事実関係の参考にする(既定: する)",
        モデル="AIモデルの指定(省略時は自動振り分け)",
    )
    @app_commands.choices(種類=DOC_TYPES, 形式=FMT_CHOICES, モデル=MODEL_CHOICES)
    async def doc(
        self,
        itx: discord.Interaction,
        種類: app_commands.Choice[str],
        内容: str,
        形式: app_commands.Choice[str] | None = None,
        資料参照: bool = True,
        モデル: app_commands.Choice[str] | None = None,
    ):
        await self._draft_and_send(itx, "/doc", 種類.name, 種類.value, 内容, 形式.value if 形式 else "docx",
                                   資料参照, モデル.value if モデル else None)

    @app_commands.command(name="mail", description="相手と要件から、メールの草案(件名+本文)をAIが作る")
    @app_commands.describe(
        相手="宛先(例: サンプルレンタル ご担当者様、学務課 ご担当者様)",
        要件="伝えたいこと・お願いしたいこと(例: 会計書類を11/6までに提出する旨と、提出先の確認)",
        届いたメール="返信するとき: 届いたメールの本文を貼る(任意)",
        差出人="名乗りと署名に入れる所属・氏名(例: 渉外課 山田。任意)",
        やりとり="相手とのこれまでのやりとり(省略時は資料から判断)",
        資料参照="_目録から関連資料を検索して事実関係の参考にする(既定: する)",
        モデル="AIモデルの指定(省略時は自動振り分け)",
    )
    @app_commands.choices(やりとり=RELATION_CHOICES, モデル=MODEL_CHOICES)
    async def mail(
        self,
        itx: discord.Interaction,
        相手: app_commands.Range[str, 1, mail_draft.MAX_TO],
        要件: app_commands.Range[str, 1, mail_draft.MAX_PURPOSE],
        届いたメール: app_commands.Range[str, 1, mail_draft.MAX_RECEIVED] | None = None,
        差出人: app_commands.Range[str, 1, mail_draft.MAX_SENDER] | None = None,
        やりとり: app_commands.Choice[str] | None = None,
        資料参照: bool = True,
        モデル: app_commands.Choice[str] | None = None,
    ):
        request = mail_draft.compose_request(相手, 要件, sender=差出人,
                                             relation=やりとり.value if やりとり else None, received=届いたメール)
        await self._draft_and_send(itx, "/mail", "メール", mail_draft.MAIL_KIND_VALUE, request, "txt",
                                   資料参照, モデル.value if モデル else None, inline=True)

    async def _draft_and_send(self, itx: discord.Interaction, command: str, kind_name: str, kind_value: str,
                              内容: str, fmt: str, 資料参照: bool, model_override: str | None,
                              *, inline: bool = False):
        """/doc と /mail の本体。種類がメール文面なら mail_draft の指示で起草し、件名の行をそろえる。
        inline=True(/mail)は草案を本文としても投稿する。"""
        if self.provider is None:
            await itx.response.send_message(
                f"⚠️ AIプロバイダが無効のため {command} は使えません(config の [ai] を確認)。",
                ephemeral=True,
            )
            return
        await itx.response.defer(thinking=True)
        t0 = time.time()   # 経過表示は「受付→応答」の体感時間(検索・変換込み)
        is_mail = mail_draft.is_mail_kind(kind_value)
        query = mail_draft.search_text(内容) if is_mail else 内容

        context = ""
        search_note = ""
        if 資料参照 and self.kb is not None:
            # use_fields=False: /ask と違い /doc は回答フッターを描画しないので、質問文から
            # 機械抽出した条件(発言者・期間)を利用者に見せる場所が無い。起草指示に委員名が
            # 入っただけで Discord 資料が黙って著者で絞られる=沈黙の劣化になるため、
            # この経路では条件抽出を切る(効かせたくなったら可視化とセットで)。
            # 締切は _SEARCH_BUDGET_SEC(上の定数コメント参照)。**wait_for で打ち切っても
            # スレッドは止まらない**が、読み取り専用なので放置してよい(/ask と同じ扱い)。
            def search():
                excerpts = list(self.kb.search(query, 6, use_fields=False).excerpts)
                if is_mail:
                    excerpts = _current_year_first(self.kb, query, excerpts)
                return excerpts

            try:
                excerpts = await asyncio.wait_for(asyncio.to_thread(search), timeout=_SEARCH_BUDGET_SEC)
                context = render_context(excerpts, budget_chars=6000)
            except asyncio.TimeoutError:
                log.error("%s 資料検索が %d 秒で終わらず打ち切り(共有ドライブのストール?)"
                          " → 資料参照なしで起草: %.40s", command, _SEARCH_BUDGET_SEC, query)
                search_note = _SEARCH_SKIPPED_NOTE
            except Exception as e:  # noqa: BLE001  索引破損・非UTF-8ファイル・実装バグなど
                # 起草そのものは資料が無くても成立する。ここで抜けると defer 済みのまま
                # 応答が返らず完全な無応答になるので、必ず起草まで進める。
                log.exception("%s 資料検索が想定外の例外で失敗 → 資料参照なしで起草: %s", command, e)
                search_note = _SEARCH_SKIPPED_NOTE

        model = self.provider.choose_model(内容, kind=kind_value, override=model_override)
        try:
            if is_mail:
                res = await self.provider.complete(mail_draft.build_prompt(内容, context), model)
            else:
                res = await self.provider.draft(kind_value, 内容, context, model=model)
        except AIError as e:
            log.warning("%s AI失敗: %s", command, e)
            await safe_send(itx, f"⚠️ 起草に失敗しました({e})。時間をおいて再試行してください。")
            return
        body_md = mail_draft.normalize(res.text) if is_mail else res.text
        # 記帳は共有ドライブへの同期書き込み。ここで OSError が出ると、起草に成功した
        # 文書が丸ごと捨てられて完全沈黙になる(/ask で実証された同型の穴)。
        # 記帳は落ちてよい・回答は落ちてはいけない(_目録/AI作業方針.md §3-4)。
        if self.usage_log:
            try:
                await asyncio.to_thread(self.usage_log.record, command, str(itx.user), res)
            except Exception as e:  # noqa: BLE001
                log.warning("使用量の記帳に失敗(送信を優先・記帳のみ欠落): %s", e)

        if is_mail:
            # 件名をそのまま題にする(アプリは本文の 1 行目「件名：」で件名と本文を分ける)
            title = mail_draft.split(body_md)[0] or kind_name
            todo = mail_draft.placeholders(body_md)
            head = (f"✉️ **{title}**(メールの草案)\n"
                    + (f"{search_note}\n" if search_note else "")
                    + (f"-# 要記入: {' '.join(todo)}\n" if todo else "")
                    + f"{_MAIL_CHECK_NOTE}\n")
        else:
            title = body_md.splitlines()[0].lstrip("# ").strip() if body_md.splitlines() else kind_name
            head = (f"📄 **{title}**(たたき台・{kind_name})\n"
                    # 資料参照を落としたことは**先に**見せる(モデル情報より上)。後ろに置くと
                    # 読み飛ばされ、資料裏取り済みの下書きに見えてしまう(/ask の注意書きと同じ思想)。
                    + (f"{search_note}\n" if search_note else "")
                    + "-# 【◯◯】は要記入のプレースホルダ。送付前に必ず内容を確認してください。\n")
        log.info("%s 完了: 種類=%s fmt=%s model=%s %.1f秒 by %s", command, kind_name, fmt, model,
                 time.time() - t0, itx.user)
        note = head + f"-# model: {model} / {res.tokens_note()} / {res.cost_note(self.usd_jpy)} / {elapsed_note(t0)}"
        # ファイル変換に失敗しても本文は届ける(欲しいのは中身であって形式ではない)。
        try:
            fname, data = docgen.to_file(fmt, title, body_md)
        except Exception as e:  # noqa: BLE001  変換ライブラリ/一時ファイルの失敗
            log.warning("%s のファイル生成に失敗 → 本文をテキストで送信に縮退: %s", command, e)
            for chunk in _chunks(f"{note}\n\n{body_md}"):
                await safe_send(itx, chunk)
            return
        await safe_send(itx, note, file=discord.File(io.BytesIO(data), filename=fname))
        if inline:
            # 草案そのものを続けて投稿する(長押し・選択でそのまま写せるように)。草案の中の @ で
            # 誰かに通知が飛ばないよう、メンションはすべて無効にする。
            for chunk in _chunks(body_md.strip()):
                await safe_send(itx, chunk, allowed_mentions=discord.AllowedMentions.none())
