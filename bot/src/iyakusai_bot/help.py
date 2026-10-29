# -*- coding: utf-8 -*-
"""/help — Bot の使い方(本人にだけ見える ephemeral 応答)。"""

from __future__ import annotations

import discord
from discord import app_commands
from discord.ext import commands

from . import contact
from . import __version__


def _haiku_how(mode: str) -> str:
    """俳句がどう出るかは `[haiku] mode` 次第なので、設定に合わせて説明を変える。"""
    if mode == "react":
        return "発言がたまたま 5-7-5 になっていると、Botがその発言に 🎋 を付けます(AI不使用)。\n"
    if mode == "reply":
        return "発言がたまたま 5-7-5 になっているとBotが詠み上げます(AI不使用)。\n"
    return "発言がたまたま 5-7-5 になっていると専用チャンネルに詠み上げます(AI不使用)。\n"


def build_help_embed(ai_enabled: bool, haiku_enabled: bool = False,
                     haiku_mode: str = "react", video_enabled: bool = False,
                     tasks_enabled: bool = False, assistant_enabled: bool = False,
                     image_enabled: bool = False) -> discord.Embed:
    e = discord.Embed(
        title="IyakusaiBot の使い方",
        description=(
            "医薬祭実行委員会の資料検索・リマインド・文書起草を手伝うBotです。\n"
            "資料の出どころは共有ドライブの `_目録`(digest・要約)。"
        ),
        color=0x2E8B57,
    )
    e.add_field(
        name="🔍 /ask — 資料から探して答える",
        value=(
            "「あの決定どこ?」に出典付きで答えます。\n"
            "例: `/ask 質問: 会計ソフトは何に決まった?`\n"
            "`形式:` を付けると回答をファイル(docx/md/txt)で受け取れます。\n"
            "`モデル:` でAIを指定可(省略時は設定どおり)。\n"
            "`考える深さ:` で low〜xhigh を選べます(深いほど遅く、利用枠を多く使う)。\n"
            "調べている間は「何回調べたか・いま何をしているか」が表示されます。\n"
            "-# 応答まで数十秒〜数分。金額・氏名は原本確認を推奨"
        ),
        inline=False,
    )
    e.add_field(
        name="📄 /doc — 文書のたたき台を起草",
        value=(
            "依頼文・お知らせ・報告書・議事録・メール文面のドラフトをファイルで返します。\n"
            "例: `/doc 種類:依頼文(対外) 内容:◯◯宛に発電機の見積依頼`\n"
            "`形式:`(docx/md/txt)と `モデル:` も指定できます。\n"
            "-# 不明な固有情報は【◯◯】で残します。**送付前に必ず内容確認**"
        ),
        inline=False,
    )
    e.add_field(
        name="✉️ /mail — メールの草案",
        value=(
            "相手と要件を書くと、件名と本文の草案を返します(本文をそのまま投稿・txt も添付)。\n"
            "例: `/mail 相手:学務課 ご担当者様 要件:会計書類を11/6までに提出します。提出先を確認したい`\n"
            "返信なら `届いたメール:` に本文を貼り、`差出人:` に所属・氏名を入れると名乗りと署名に入ります。\n"
            "-# 送信はしません。【◯◯】を埋め、事実を確かめてから各自のアドレスで送ってください"
        ),
        inline=False,
    )
    if image_enabled:
        e.add_field(
            name="🎨 /image — 図・ポスター風の画像",
            value=(
                "Claude が説明に合わせて、ポスター・案内図・看板・値段表・図解などを描きます(PNG と編集用 SVG)。\n"
                "例: `/image 説明:模擬店の値段表。焼きそば300円・フランク200円。赤と黄色で元気に 縦横比:縦長(9:16)`\n"
                "日本語の文字はきれいに入りますが、写真風・写実的な絵は作れません。\n"
                "-# 1 人 1 日の枚数に上限あり。文字・数字・日付は使う前に必ず確認"
            ),
            inline=False,
        )
    e.add_field(
        name="⏰ /remind — リマインド・催促",
        value=(
            "`/remind add 期限: 内容:` で登録(`対象:` で他の人宛、`繰り返し:` で定期化)。\n"
            "通知は **前日 → 期限時刻 → 超過中は24時間ごと**。\n"
            "`/remind list`(一覧) `/remind done id:`(完了) `/remind delete id:`(削除)"
        ),
        inline=False,
    )
    e.add_field(
        name="🗓 期限の書き方",
        value="`7/20 18:00` `2026-08-01` `明日` `明後日 12:00` `18:00` `+3d` `+12h`(時刻省略時は9:00)",
        inline=False,
    )
    e.add_field(
        name="📊 /usage — AI使用量",
        value="BotのAI消費トークンを期間別・モデル別に表示(自分にだけ見えます)。",
        inline=False,
    )
    e.add_field(
        name="🎭 口調(キャラ)",
        value=(
            "`/ask` の `口調:` にその場で指定できます(例: `関西弁っぽく`)。\n"
            "恒久的な口調は `/persona set`(役員)、確認は `/persona show`。"
        ),
        inline=False,
    )
    if haiku_enabled:
        e.add_field(
            name="🎋 偶然の俳句",
            value=(
                _haiku_how(haiku_mode)
                + "字余り・字足らずが1拍だけの「破調」も拾います。\n"
                "句そのものは `/haiku list`(最近の句) `/haiku ranking`(詠み人)で読めます"
                "(どちらも自分にだけ見えます)。`/haiku check 文:` はその場判定。\n"
                "-# 対象外にしたい人は `/haiku optout`(過去の句も消えます)"
            ),
            inline=False,
        )
    if video_enabled:
        e.add_field(name="🎬 /ネタ動画", value="80文字・3行以内の文言をファンファーレ付き動画にします。本人だけに返却。\\nで改行。受付IDで `/ネタ動画キャンセル`。", inline=False)
    if tasks_enabled:
        e.add_field(name="✅ /todo — 委員会タスク",
                    value=("部局(役員会・各部・各課。複数可)ごとのタスクを作成・一覧・部局の付け外し・担当・期限・状態・"
                           "整理(目的/成果物/完了条件/不明点)・履歴で管理。番号は全体の通し番号。\n"
                           "返答は自分にだけ見えます。詳しくは `/todo help`。\n"
                           "-# 委員なら全員が全部局を見て変更できます。通知は送りません"),
                    inline=False)
    # 統合アプリの「Bot」タブは、[assistant] enabled の構成でだけ出す(2026-10-14)
    if assistant_enabled:
        e.add_field(
            name="🌐 統合アプリの「Bot」タブ",
            value=("同じ機能を https://app.iyakusai.com の「Bot」タブからも使えます。\n"
                   "-# アプリから出した質問・文書・画像は #bottest にも投稿されます"),
            inline=False,
        )
    if not ai_enabled:
        e.add_field(name="⚠️ 現在AI応答は無効", value="/ask は検索抜粋の直返し、/doc は使えません。", inline=False)
    # 連絡先は config.toml の [help] contact(contact.py)。保守担当が決まったら設定だけ直す。
    e.set_footer(text=f"IyakusaiBot v{__version__} ｜ 不具合・要望は当面 {contact.name()} まで")
    return e


class Help(commands.Cog):
    def __init__(self, bot: commands.Bot, ai_enabled: bool, haiku_enabled: bool = False,
                 haiku_mode: str = "react", video_enabled: bool = False, tasks_enabled: bool = False,
                 assistant_enabled: bool = False, image_enabled: bool = False):
        self.bot = bot
        self.ai_enabled = ai_enabled
        self.haiku_enabled = haiku_enabled
        self.haiku_mode = haiku_mode
        self.video_enabled = video_enabled
        self.tasks_enabled = tasks_enabled
        self.assistant_enabled = assistant_enabled
        self.image_enabled = image_enabled

    @app_commands.command(name="help", description="このBotの使い方を表示する")
    async def help_(self, itx: discord.Interaction):
        await itx.response.send_message(
            embed=build_help_embed(self.ai_enabled, self.haiku_enabled, self.haiku_mode, self.video_enabled,
                                   self.tasks_enabled, self.assistant_enabled, self.image_enabled),
            ephemeral=True)
