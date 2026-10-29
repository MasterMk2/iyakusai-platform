# -*- coding: utf-8 -*-
"""/todo — 部局タグ付きの委員会タスク(返答はすべて本人にだけ見える ephemeral)。

タスクはチャンネルではなく部局(役員会・3部・6課)に属し、複数の部局に
付けてよい。番号はサーバー全体の通し番号。委員(サーバーのメンバー)なら全員が全部局を見て編集できる。
- 使える場所: 許可 guild の通常テキストチャンネル(どのチャンネルからでも全タスクを扱える)
- 部局の既定: チャンネル名から推す(「内務部todo」→内務部)。推せなければ指定が必要(一覧は全部局)
- 担当者: 同じ guild のメンバー(Bot は不可)。主担当 1 人と副担当(2026-10-28。主担当がいるときだけ)
自動通知・定期処理・公開投稿は行わない(候補の投稿は screening_cog が行う)。
"""

from __future__ import annotations

import asyncio
import io
import logging
from dataclasses import dataclass

import discord
from discord import app_commands
from discord.ext import commands

from .task_domain import (
    DEPARTMENTS, FIELD_LABELS, REQUIREMENT_FIELDS, REQUIREMENT_LABELS, STATUS_LABELS, Actor, HistoryEntry,
    Scope, TaskError, TaskView, department_from_name, format_date_only, format_tags, format_timestamp,
    parse_helpers,
)
from .task_store import ANY, Budget, TaskSettings, TaskStore

log = logging.getLogger("iyakusai.tasks")

MESSAGE_LIMIT = 1900          # Discord の 2000 文字上限に余裕を持たせる
LIST_PAGE_SIZE = 10
HISTORY_PAGE_SIZE = 5
STORE_TIMEOUT_SEC = 10.0
BUDGET_RATIO = 0.7            # store 側の期限(既定7秒)は待ち時間より短くし、自分で ROLLBACK させる
_ID = app_commands.Range[int, 1, 1_000_000_000]
_VERSION = app_commands.Range[int, 1, 2_147_483_647]
_PAGE = app_commands.Range[int, 1, 1000]

STATUS_CHOICES = [app_commands.Choice(name=label, value=value) for value, label in STATUS_LABELS.items()]
FIELD_CHOICES = ([app_commands.Choice(name=REQUIREMENT_LABELS[f], value=f) for f in REQUIREMENT_FIELDS]
                 + [app_commands.Choice(name="説明", value="description")])
DEPARTMENT_CHOICES = [app_commands.Choice(name=label, value=key) for key, (label, _) in DEPARTMENTS.items()]
LIST_DEPARTMENT_CHOICES = DEPARTMENT_CHOICES + [app_commands.Choice(name="すべての部局", value="all")]

HELP_TEXT = "\n".join([
    "**/todo の使い方**(タスクは部局ごと。複数の部局に付けられ、番号は全体の通し番号。返答は自分にだけ見えます)",
    "`/todo create タイトル: 部局:` 作成(部局は 3 つまで指定可。省略するとチャンネル名の部局。未割当・未着手で作成)",
    "`/todo list 部局:` 一覧(部はその部の課も含む。省略するとチャンネル名の部局、推せなければ全部局)",
    "`/todo tag id: 版: 追加:/外す:` 部局の付け外し(最後の 1 つは外せない)",
    "`/todo show id:` 詳細(版・部局・未入力の整理項目を表示)",
    "`/todo assign id: 版: 担当者:` 主担当の割当 / `解除:True` で外す",
    "`/todo helper id: 版: 追加:/外す:` 副担当の付け外し(主担当がいるタスクだけ。副担当の人を主担当にすると副担当から外れる)",
    "`/todo deadline id: 版: 期限:YYYY-MM-DD` 期限 / `解除:True` で期限なし",
    "`/todo status id: 版: 状態:` 状態変更(完了は `確認:True` が必要)",
    "`/todo reopen id: 版: 確認:True` 完了したタスクを未着手に戻す",
    "`/todo require id: 版: 項目: 内容:` 目的・成果物・完了条件・不明点・説明の整理 / `空にする:True`",
    "`/todo history id:` 変更履歴(新しい順)",
    "変更には一覧・詳細に出る **版** を指定します。先に他の人が更新していたら反映せず最新の版を示します。",
    "委員なら全員が全部局のタスクを見て変更できます(誰が変えたかは履歴に残ります)。",
])


@dataclass(frozen=True)
class Access:
    scope: Scope
    actor: Actor
    guild: discord.Guild
    channel: discord.TextChannel

    @property
    def default_tag(self) -> str | None:
        """このチャンネルの名前から推した部局(推せなければ None)。"""
        return department_from_name(self.channel.name)


def _deny(message: str) -> TaskError:
    return TaskError("FORBIDDEN", message)


def _clip(text: str, limit: int) -> str:
    text = text.replace("\r", " ").replace("\n", " ⏎ ")
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _esc(text: str) -> str:
    return discord.utils.escape_markdown(text)


def _person(user_id: int | None) -> str:
    # 表示名は保存しない。メンションは AllowedMentions.none() で通知しない。
    return "未割当" if user_id is None else f"<@{user_id}>"


def _people(user_ids) -> str:
    return "、".join(_person(u) for u in user_ids)


def summary_line(view: TaskView) -> str:
    t = view.task
    overdue = "・期限超過" if view.overdue else ""
    missing = f"／未整理 {len(view.missing)}" if view.missing else ""
    helpers = f"（副 {_people(t.helpers)}）" if t.helpers else ""
    return (f"#{t.number} [{STATUS_LABELS[t.status]}]〔{format_tags(t.tags)}〕{_esc(t.title)}"
            f"（担当: {_person(t.assignee_id)}{helpers}／期限: {format_date_only(t.deadline)}{overdue}"
            f"／版 {t.version}{missing}）")


def detail_text(view: TaskView, children: list[TaskView] | None = None) -> str:
    t = view.task
    lines = [summary_line(view), f"版: {t.version}", f"部局: {format_tags(t.tags)}"]
    if t.helpers:
        lines.append(f"副担当: {_people(t.helpers)}")
    # 親子(2026-10-25)。付け外しは統合アプリのタスク画面から。
    if t.parent is not None:
        lines.append(f"親タスク: #{t.parent}")
    if children:
        done = sum(c.task.status == "done" for c in children)
        lines.append(f"子タスク（{done}/{len(children)} 完了）: "
                     + "、".join(f"#{c.task.number} [{STATUS_LABELS[c.task.status]}]" for c in children))
    lines.append(f"説明: {t.description or '（未入力）'}")
    for f in REQUIREMENT_FIELDS:
        value = t.requirements[f]
        lines.append(f"{REQUIREMENT_LABELS[f]}: {value if value else '（未入力）'}")
    lines.append(f"作成: {format_timestamp(t.created_at)} {_person(t.created_by)}"
                 f" ／ 更新: {format_timestamp(t.updated_at)} {_person(t.updated_by)}")
    return "\n".join(lines)


def _change_value(field: str, value: str | None) -> str:
    if value is None or value == "":
        return "（なし）"
    if field == "assignee_id":
        return _person(int(value))
    if field == "helpers":
        return _people(parse_helpers(value)) or "（なし）"
    if field == "status":
        return STATUS_LABELS.get(value, value)
    if field == "deadline":
        return format_date_only(value)
    if field == "tags":
        return format_tags(value.split(","))
    if field == "parent":
        return f"#{value}"
    return _clip(value, 60)


_ACTIONS = {"created": "作成", "updated": "更新", "reopened": "再開"}


def history_text(number: int, entries: list[HistoryEntry], total: int, page: int) -> str:
    if not entries:
        return f"#{number} の履歴はこのページにはありません（全 {total} 件）。"
    lines = [f"#{number} の変更履歴（新しい順・全 {total} 件・{page} ページ目）"]
    for e in entries:
        op = f"・操作 {e.operation_id}" if e.operation_id else ""
        lines.append(f"**版 {e.version}** {format_timestamp(e.at)} {_person(e.actor_id)} "
                     f"{_ACTIONS.get(e.action, e.action)}（{e.source}{op}）")
        for c in e.changes:
            lines.append(f"・{FIELD_LABELS.get(c.field, c.field)}: "
                         f"{_change_value(c.field, c.before)} → {_change_value(c.field, c.after)}")
    if page * HISTORY_PAGE_SIZE < total:
        lines.append(f"続きは `ページ:{page + 1}`")
    return "\n".join(lines)


def package(text: str, filename: str) -> tuple[str, discord.File | None]:
    """長文は切り詰めたことを明示し、全文を本人だけに見える添付ファイルで返す。"""
    if len(text) <= MESSAGE_LIMIT:
        return text, None
    note = "\n…（長文のため途中までを表示。全文は添付ファイルを見てください）"
    head = text[: MESSAGE_LIMIT - len(note)]
    return head + note, discord.File(io.BytesIO(text.encode("utf-8")), filename=filename)


def error_text(error: TaskError) -> str:
    text = f"⚠ {error.message}"
    if error.details:
        text += "\n" + "\n".join(f"・{d}" for d in error.details)
    if error.current is not None and error.code != "CONFIRM_REQUIRED":
        text += "\n現在: " + summary_line(error.current)
    elif error.current is not None:
        text += "\n" + summary_line(error.current)
    return text


def _mutation_text(action: str, result) -> str:
    head = ("（この操作はすでに処理済みのため、再実行していません）" if result.replayed
            else f"✅ {action}。")
    return f"{head}\n{summary_line(result.view)}"


class TaskCog(commands.Cog):
    todo = app_commands.Group(name="todo", description="このチャンネルの委員会タスク(返答は本人にだけ表示)",
                              guild_only=True)

    def __init__(self, bot: commands.Bot, settings: TaskSettings, store: TaskStore | None,
                 timeout: float = STORE_TIMEOUT_SEC):
        self.bot = bot
        self.settings = settings
        self.store = store
        self.timeout = timeout

    # ---- 権限 ----

    def authorize(self, itx: discord.Interaction, *, edit: bool) -> Access:
        guild = itx.guild
        if guild is None or itx.guild_id is None:
            raise _deny("サーバー内のテキストチャンネルで使ってください。")
        channel = itx.channel
        # Thread・ForumChannel・VoiceChannel・DM は TextChannel ではないので拒否される。
        if not isinstance(channel, discord.TextChannel) or channel.guild.id != guild.id:
            raise _deny("このコマンドは通常のテキストチャンネルでだけ使えます（スレッド・DM などは不可）。")
        if not self.settings.allows(guild.id, channel.id):
            raise _deny("この場所ではタスク機能を使えません。")
        member = itx.user
        if not isinstance(member, discord.Member) or member.guild.id != guild.id or member.bot:
            raise _deny("このサーバーのメンバーだけが使えます。")
        perms = channel.permissions_for(member)
        resolved = itx.permissions  # Discord がこの操作時点で解決した権限
        if not (perms.view_channel and resolved.view_channel):
            raise _deny("このチャンネルを閲覧する権限がありません。")
        me = guild.me
        if me is None or not channel.permissions_for(me).view_channel or not itx.app_permissions.view_channel:
            raise _deny("Bot がこのチャンネルを閲覧できないため使えません。")
        # 2026-10-14: 委員なら全員が全部局のタスクを変更できる(チャンネルの発言権限は問わない)。
        return Access(scope=Scope(guild.id, channel.id),
                      actor=Actor(user_id=member.id, operation_id=str(itx.id)),
                      guild=guild, channel=channel)

    @staticmethod
    def assignable(access: Access, user) -> int:
        """明示指定された担当者を検証する。権限は変えない。"""
        if not isinstance(user, discord.Member) or user.guild.id != access.guild.id:
            raise TaskError("VALIDATION", "担当者はこのサーバーのメンバーから選んでください。")
        if user.bot:
            raise TaskError("VALIDATION", "Bot アカウントには割り当てられません。")
        return user.id

    # ---- 実行の共通部 ----

    async def _send(self, itx: discord.Interaction, content: str, file: discord.File | None = None):
        kwargs = {"ephemeral": True, "allowed_mentions": discord.AllowedMentions.none()}
        if file is not None:
            kwargs["file"] = file
        content = content if len(content) <= 2000 else content[:1999] + "…"
        try:
            if itx.response.is_done():
                await itx.followup.send(content, **kwargs)
            else:
                await itx.response.send_message(content, **kwargs)
        except Exception as error:  # noqa: BLE001  返信失敗で例外を外に出すと公開の汎用エラーになる
            log.warning("/todo の返信に失敗: %s", type(error).__name__)
        finally:
            if file is not None:
                file.close()

    async def _call(self, fn, *args, **kwargs):
        """保存処理をスレッドで実行する。待つ間も event loop は止めない。

        スレッドは途中で止められないので、store には self.timeout より短い期限を渡し、
        期限切れは store 自身が ROLLBACK して TIMEOUT を返す。self.timeout を過ぎても
        スレッドの終了(取り消し済みか COMMIT 済みか)まで待ち、実際の結果を返す。
        """
        budget = Budget(self.timeout * BUDGET_RATIO)
        work = asyncio.ensure_future(asyncio.to_thread(fn, *args, budget=budget, **kwargs))
        work.add_done_callback(lambda f: f.cancelled() or f.exception())  # 未回収の例外警告を防ぐ
        try:
            try:
                return await asyncio.wait_for(asyncio.shield(work), timeout=self.timeout)
            except (asyncio.TimeoutError, TimeoutError):
                log.warning("/todo の保存処理が時間を超過。終了を待ちます")
                return await asyncio.shield(work)
        except asyncio.CancelledError:
            # 外から取り消されたときも、未 COMMIT ならスレッドに次の確認点で ROLLBACK させる。
            budget.cancel()
            raise

    async def _run(self, itx: discord.Interaction, *, edit: bool, work, name: str):
        """権限確認 → ephemeral defer → 処理 → ephemeral 返信。例外は外に出さない。"""
        try:
            access = self.authorize(itx, edit=edit)
            if self.store is None:
                raise TaskError("UNAVAILABLE", "タスク機能は現在停止中です（保存先を開けません）。管理者に連絡してください。")
        except TaskError as error:
            await self._send(itx, error_text(error))
            return
        except Exception as error:  # noqa: BLE001
            log.warning("/todo %s の権限確認に失敗: %s", name, type(error).__name__)
            await self._send(itx, "⚠ 権限を確認できませんでした。")
            return
        try:
            await itx.response.defer(ephemeral=True, thinking=True)
        except Exception as error:  # noqa: BLE001  期限切れの interaction には返せない
            log.warning("/todo %s の defer に失敗: %s", name, type(error).__name__)
            return
        file = None
        try:
            content, file = await work(access)
        except TaskError as error:
            content = error_text(error)
        except Exception as error:  # noqa: BLE001
            log.warning("/todo %s の処理に失敗: %s", name, type(error).__name__)
            content = "⚠ タスクの処理中に想定外のエラーが発生しました。変更は反映されていない可能性があります。"
        await self._send(itx, content, file)

    # ---- コマンド ----

    @todo.command(name="help", description="/todo の使い方")
    async def help_(self, itx: discord.Interaction):
        await self._send(itx, HELP_TEXT)

    @todo.command(name="create", description="タスクを作成する(部局は省略するとチャンネル名の部局・未割当/未着手)")
    @app_commands.describe(タイトル="120文字以内・改行不可", 部局="省略するとチャンネル名の部局",
                           部局2="ほかの部局(任意)", 部局3="ほかの部局(任意)", 期限="YYYY-MM-DD(任意)",
                           担当者="任意。サーバーのメンバー", 説明="任意。2000文字以内")
    @app_commands.choices(部局=DEPARTMENT_CHOICES, 部局2=DEPARTMENT_CHOICES, 部局3=DEPARTMENT_CHOICES)
    async def create(self, itx: discord.Interaction, タイトル: app_commands.Range[str, 1, 120],
                     部局: str | None = None, 部局2: str | None = None, 部局3: str | None = None,
                     期限: str | None = None, 担当者: discord.User | None = None,
                     説明: app_commands.Range[str, 1, 2000] | None = None):
        async def work(access: Access):
            tags = [t for t in (部局, 部局2, 部局3) if t] or ([access.default_tag] if access.default_tag else [])
            if not tags:
                raise TaskError("VALIDATION", "このチャンネルからは部局を決められないので、`部局:` を選んでください。")
            assignee = None if 担当者 is None else self.assignable(access, 担当者)
            result = await self._call(self.store.create, access.actor, access.scope, title=タイトル,
                                      description=説明 or "", assignee_id=assignee, deadline=期限, tags=tags)
            return _mutation_text("作成しました", result), None
        await self._run(itx, edit=True, work=work, name="create")

    @todo.command(name="tag", description="タスクの部局を付け外しする")
    @app_commands.describe(id="タスク番号", 版="一覧・詳細に出る版", 追加="付ける部局", 外す="外す部局")
    @app_commands.choices(追加=DEPARTMENT_CHOICES, 外す=DEPARTMENT_CHOICES)
    async def tag(self, itx: discord.Interaction, id: _ID, 版: _VERSION,
                  追加: str | None = None, 外す: str | None = None):
        async def work(access: Access):
            if (追加 is None) == (外す is None):
                raise TaskError("VALIDATION", "追加 か 外す のどちらか一方を指定してください。")
            view = await self._call(self.store.get_task, access.scope, int(id))
            tags = set(view.task.tags)
            if 追加:
                tags.add(追加)
            else:
                tags.discard(外す)
                if not tags:
                    raise TaskError("VALIDATION", "最後の部局は外せません。先にほかの部局を追加してください。")
            result = await self._call(self.store.update, access.actor, access.scope, int(id), 版,
                                      {"tags": sorted(tags)})
            return _mutation_text("部局を更新しました", result), None
        await self._run(itx, edit=True, work=work, name="tag")

    @todo.command(name="list", description="部局のタスク一覧(部はその部の課も含む)")
    @app_commands.describe(部局="省略するとチャンネル名の部局(推せなければ全部局)", 状態="状態で絞り込む",
                           担当="自分(副担当も含む) / 未割当", 担当者="この人の担当だけ(副担当も含む)",
                           期限="期限で絞り込む", ページ="10件ずつ")
    @app_commands.choices(部局=LIST_DEPARTMENT_CHOICES, 状態=STATUS_CHOICES,
                          担当=[app_commands.Choice(name="自分", value="me"),
                                app_commands.Choice(name="未割当", value="none")],
                          期限=[app_commands.Choice(name="期限超過", value="overdue"),
                                app_commands.Choice(name="期限あり", value="set"),
                                app_commands.Choice(name="期限なし", value="none")])
    async def list_(self, itx: discord.Interaction, 部局: str | None = None, 状態: str | None = None,
                    担当: str | None = None, 担当者: discord.User | None = None, 期限: str | None = None,
                    ページ: _PAGE = 1):
        async def work(access: Access):
            if 担当 is not None and 担当者 is not None:
                raise TaskError("VALIDATION", "担当と担当者はどちらか一方だけ指定してください。")
            if 担当 not in (None, "me", "none"):
                raise TaskError("VALIDATION", "担当は 自分 / 未割当 から選んでください。")
            assignee = ANY
            if 担当 == "me":
                assignee = access.actor.user_id
            elif 担当 == "none":
                assignee = None
            elif 担当者 is not None:
                assignee = 担当者.id
            tag = None if 部局 == "all" else (部局 or access.default_tag)
            where = DEPARTMENTS[tag][0] if tag else "すべての部局"
            views = await self._call(self.store.list_tasks, access.scope, status=状態,
                                     assignee=assignee, deadline=期限, tag=tag)
            if not views:
                return f"{where}に該当するタスクはありません。", None
            page = max(1, min(int(ページ), 1000))
            start = (page - 1) * LIST_PAGE_SIZE
            shown = views[start:start + LIST_PAGE_SIZE]
            if not shown:
                return f"このページにはタスクがありません（全 {len(views)} 件）。", None
            lines = [f"{where}のタスク（全 {len(views)} 件・{page} ページ目）"]
            lines += [summary_line(v) for v in shown]
            if start + LIST_PAGE_SIZE < len(views):
                lines.append(f"続きは `ページ:{page + 1}`")
            return package("\n".join(lines), "tasks.txt")
        await self._run(itx, edit=False, work=work, name="list")

    @todo.command(name="show", description="タスクの詳細(版・整理項目)")
    @app_commands.describe(id="タスク番号(#の後の数字)")
    async def show(self, itx: discord.Interaction, id: _ID):
        async def work(access: Access):
            view = await self._call(self.store.get_task, access.scope, int(id))
            children = [] if view.task.parent is not None else await self._call(self.store.children, access.scope, int(id))
            return package(detail_text(view, children), f"task-{view.task.number}.txt")
        await self._run(itx, edit=False, work=work, name="show")

    @todo.command(name="assign", description="主担当を割り当てる/外す(明示指定のみ)")
    @app_commands.describe(id="タスク番号", 版="一覧・詳細に出る版", 担当者="主担当にする人", 解除="True で主担当を外す")
    async def assign(self, itx: discord.Interaction, id: _ID, 版: _VERSION,
                     担当者: discord.User | None = None, 解除: bool = False):
        async def work(access: Access):
            if (担当者 is None) == (not 解除):
                raise TaskError("VALIDATION", "担当者を指定するか、解除:True のどちらか一方を指定してください。")
            assignee = None if 解除 else self.assignable(access, 担当者)
            result = await self._call(self.store.update, access.actor, access.scope, int(id), 版,
                                      {"assignee_id": assignee})
            return _mutation_text("主担当を更新しました", result), None
        await self._run(itx, edit=True, work=work, name="assign")

    @todo.command(name="helper", description="副担当を付け外しする(主担当がいるタスクだけ)")
    @app_commands.describe(id="タスク番号", 版="一覧・詳細に出る版", 追加="副担当にする人", 外す="副担当から外す人")
    async def helper(self, itx: discord.Interaction, id: _ID, 版: _VERSION,
                     追加: discord.User | None = None, 外す: discord.User | None = None):
        async def work(access: Access):
            if (追加 is None) == (外す is None):
                raise TaskError("VALIDATION", "追加 か 外す のどちらか一方を指定してください。")
            view = await self._call(self.store.get_task, access.scope, int(id))
            helpers = list(view.task.helpers)
            if 追加 is not None:
                user_id = self.assignable(access, 追加)
                if user_id in helpers:
                    raise TaskError("NO_CHANGE", "その人はすでに副担当です。")
                helpers.append(user_id)
            else:
                if 外す.id not in helpers:
                    raise TaskError("NO_CHANGE", "その人は副担当ではありません。")
                helpers.remove(外す.id)
            result = await self._call(self.store.update, access.actor, access.scope, int(id), 版,
                                      {"helpers": helpers})
            return _mutation_text("副担当を更新しました", result), None
        await self._run(itx, edit=True, work=work, name="helper")

    @todo.command(name="deadline", description="期限を設定/解除する")
    @app_commands.describe(id="タスク番号", 版="一覧・詳細に出る版", 期限="YYYY-MM-DD", 解除="True で期限なしに戻す")
    async def deadline(self, itx: discord.Interaction, id: _ID, 版: _VERSION,
                       期限: str | None = None, 解除: bool = False):
        async def work(access: Access):
            if (期限 is None) == (not 解除):
                raise TaskError("VALIDATION", "期限を指定するか、解除:True のどちらか一方を指定してください。")
            result = await self._call(self.store.update, access.actor, access.scope, int(id), 版,
                                      {"deadline": None if 解除 else 期限})
            return _mutation_text("期限を更新しました", result), None
        await self._run(itx, edit=True, work=work, name="deadline")

    @todo.command(name="status", description="状態を変える(完了は確認が必要)")
    @app_commands.describe(id="タスク番号", 版="一覧・詳細に出る版", 状態="変更先",
                           確認="完了にするときは True")
    @app_commands.choices(状態=STATUS_CHOICES)
    async def status(self, itx: discord.Interaction, id: _ID, 版: _VERSION, 状態: str, 確認: bool = False):
        async def work(access: Access):
            result = await self._call(self.store.update, access.actor, access.scope, int(id), 版,
                                      {"status": 状態}, confirmed=bool(確認))
            return _mutation_text("状態を更新しました", result), None
        await self._run(itx, edit=True, work=work, name="status")

    @todo.command(name="reopen", description="完了したタスクを未着手に戻す(確認が必要)")
    @app_commands.describe(id="タスク番号", 版="一覧・詳細に出る版", 確認="戻すときは True")
    async def reopen(self, itx: discord.Interaction, id: _ID, 版: _VERSION, 確認: bool = False):
        async def work(access: Access):
            result = await self._call(self.store.reopen, access.actor, access.scope, int(id), 版,
                                      confirmed=bool(確認))
            return _mutation_text("再開しました", result), None
        await self._run(itx, edit=True, work=work, name="reopen")

    @todo.command(name="require", description="目的・成果物・完了条件・不明点・説明を整理する")
    @app_commands.describe(id="タスク番号", 版="一覧・詳細に出る版", 項目="整理する項目",
                           内容="2000文字以内", 空にする="True で未入力に戻す")
    @app_commands.choices(項目=FIELD_CHOICES)
    async def require(self, itx: discord.Interaction, id: _ID, 版: _VERSION, 項目: str,
                      内容: app_commands.Range[str, 1, 2000] | None = None, 空にする: bool = False):
        async def work(access: Access):
            if 項目 not in REQUIREMENT_FIELDS and 項目 != "description":
                raise TaskError("VALIDATION", "項目は 目的・成果物・完了条件・不明点・説明 から選んでください。")
            if (内容 is None) == (not 空にする):
                raise TaskError("VALIDATION", "内容を指定するか、空にする:True のどちらか一方を指定してください。")
            result = await self._call(self.store.update, access.actor, access.scope, int(id), 版,
                                      {項目: "" if 空にする else 内容})
            return _mutation_text(f"{FIELD_LABELS[項目]}を更新しました", result), None
        await self._run(itx, edit=True, work=work, name="require")

    @todo.command(name="history", description="タスクの変更履歴(新しい順)")
    @app_commands.describe(id="タスク番号", ページ="5件ずつ")
    async def history(self, itx: discord.Interaction, id: _ID, ページ: _PAGE = 1):
        async def work(access: Access):
            page = max(1, min(int(ページ), 1000))
            entries, total = await self._call(self.store.history, access.scope, int(id),
                                              offset=(page - 1) * HISTORY_PAGE_SIZE, limit=HISTORY_PAGE_SIZE)
            return package(history_text(int(id), entries, total, page), f"task-{int(id)}-history.txt")
        await self._run(itx, edit=False, work=work, name="history")
