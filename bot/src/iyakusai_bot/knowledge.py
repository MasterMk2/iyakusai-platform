# -*- coding: utf-8 -*-
"""F1 ナレッジ検索・質問応答(Discord Cog)。

/ask <質問> → _目録 検索 → AIProvider で出典付き回答。
AI 失敗時は検索抜粋の直返しにフォールバック(Bot は止めない)。
"""

from __future__ import annotations

import asyncio
import io
import logging
import re
import time
from pathlib import Path

import discord
from discord import app_commands
from discord.ext import commands

from . import contact
from . import docgen
from .ai_provider import (
    AIError,
    DEFER_BUDGET_SEC,
    MIN_AGENT_RUN_SEC,
    MIN_ONESHOT_RUN_SEC,
    agent_stage_deadline,
    elapsed_note,
    is_about_bot,
    route_model,
    run_budget_sec,
)
from .coverage import build_coverage_note
from .knowledge_search import KnowledgeBase, is_line_source, render_context
from .query_fields import is_inventory_scope, is_personal_scope
# 意味検索シードの本文マスク用(2026-08-12)。ミラーの文書原文と**同じ関数**を通す。
# ここで別のマスクを書くと、片方だけ直されてまた非対称が生まれる(レビュー総評の型)。
from .mirror import _transform_doc_text
from .neta import load_lines
from .persona import ondo_wants_neta, resolve_ondo
from .progress import ProgressReporter

log = logging.getLogger("iyakusai.knowledge")

FOOTER = "-# 出典は _目録 の資料(要約・原文)。金額・氏名は原本確認を推奨。"
DISCORD_LIMIT = 2000
# grep 直返し(AI失敗時のフォールバック)の本文予算。
# 1,500 字だった頃は **メール抜粋1件(本文 MAX_MAIL_BODY_CHARS=2,500字 + ヘッダ +
# 出典ラベル)が予算に収まらず、上位3件が全部スキップされて body が空**になっていた。
# 「出典だけ並んで本文が無い」回答の直接の原因(レビュー#2)。メール1件+αが確実に載る値に引き上げる。
# Discord の2,000字制限は _chunks が分割して送るので、この値で送信は壊れない。
_FALLBACK_BUDGET_CHARS = 4000

# AIが使えず検索フォールバックへ落ちたときに添える一言(状況別)。
_AI_OFF_NOTE = "🔌 いまはAI要約をオフ設定にしているので、資料の検索結果だけお届けします。"
_AI_LIMIT_NOTE = (
    "🕊️ ただいまClaudeの利用枠を使い切ってしまい、AIの要約はひと休み中です。"
    "かわりに、関連しそうな資料の抜粋をそのままお届けします(枠が戻れば自動で復活します)。"
)
def _ai_error_note() -> str:
    # 連絡先は config.toml の [help] contact(contact.py)
    return ("⚠️ いまAIの要約がうまく使えないので、資料の検索結果だけお出しします"
            + contact.ask_note("一時的な不調かもしれません。"))
# 応答期限(defer から15分)が近く、AI を呼ぶと届かなくなる場合。呼ばずに確実に届ける。
_AI_NOTIME_NOTE = (
    "⏳ 応答期限が近いため、AIの要約は省略して資料の検索結果だけお届けします。"
)
# エラーメッセージが「利用枠切れ(レート/使用量上限)」を示唆するかの手がかり。
# 「out of extra usage」「resets …」は 2026-08-01 に実機で観測した新パターン
# (exit 0・subtype=success・is_error=true で返るため文言でしか判別できない)。
# ai_provider._LIMIT_TEXT_RE と対で更新すること。
_AI_LIMIT_HINT_RE = re.compile(
    r"usage limit|limit reached|rate.?limit|quota|credit|exceeded|too many requests"
    r"|out of extra usage|\bresets\b"
    r"|上限|利用制限|利用枠|残枠|429",
    re.IGNORECASE,
)
# エージェント検索(既定経路)が落ちて簡易検索に転落したことを利用者に見せる1行。
# 2026-07-29 と 2026-08-01 の2度、劣化した回答が「権威ある回答」に見えたまま出た
# (どちらも max-turns 到達 → 無言で one-shot 転落)。フィールド条件行と同じ思想で、
# 沈黙して劣化させない(_目録/AI作業方針.md §3-4)。
_AGENT_FAILED_NOTE = (
    "-# ⚠ エージェント検索に失敗したため簡易検索の結果です"
    "(時間をおいて再実行すると復活することがあります)"
)
# 混雑(同時実行の順番待ちで予算を使い切った)で省略した場合。失敗とは原因も対処も
# 違う(こちらは時間をおけば確実に直る)ので文面を分ける。
_AGENT_BUSY_NOTE = (
    "-# ⏳ 混雑のためエージェント検索を省略しました(簡易検索の結果です)"
)
# _try_agentic の結果。「試して失敗した」と「そもそも試していない」を区別する
# (config agentic=off・ミラー未構築のときに⚠を出すと誤報になる)。
AGENT_DONE = "done"        # エージェントが応答済み(呼び出し側は return)
AGENT_SKIPPED = "skipped"  # 未試行(provider無し/agentic off/ミラー未構築)
AGENT_FAILED = "failed"    # 試したが例外で落ちた=劣化転落
AGENT_BUSY = "busy"        # 混雑・時間予算切れで実行を諦めた


def agent_degraded(outcome: str) -> bool:
    """エージェント検索を「試して失敗した」か(未試行・混雑と区別する)。"""
    return outcome == AGENT_FAILED


def _line_note(snapshot: str) -> str:
    """LINE 出典を含むときにフッターへ足す鮮度注記。

    LINE には Bot も API も無く、収集は委員長の手動エクスポート=スナップショット。
    「最新の状況」と読まれると三キャン間の合意が古いまま引用される事故になるので、
    どの時点までの記録かを必ず添える(_目録/INDEX.md の警告と同じ趣旨)。
    """
    if not snapshot:
        return ""
    return f"\n-# LINE は手動エクスポートのスナップショット(最終取込: {snapshot})"


def agent_note(outcome: str) -> str:
    """転落の事情を利用者に見せる1行(未試行なら空)。"""
    if outcome == AGENT_FAILED:
        return _AGENT_FAILED_NOTE
    if outcome == AGENT_BUSY:
        return _AGENT_BUSY_NOTE
    return ""


# ---- 意味検索シード(2026-08-12 追加・レビュー追補「案2」) ----
# エージェントに許したツールは Read(./**)/Glob/Grep だけ(_AGENT_ALLOWED_TOOLS)= **字句
# 一致でしか探せない**。質問者の言葉と文書の言葉が違うと永遠に引けない(発見性の問題)。
# 一方 bge-m3 の索引(20,093チャンク)は one-shot 経路にしか実装が無く、実測では 8/1 以降の
# /ask 21件中20件がエージェント経路 = **索引は本番でほぼ一度も使われていなかった**。
# そこでホスト側で意味検索を1回だけ回し、その抜粋を「種」としてプロンプトに置く。
# 種は根拠ではなく入口(本文はエージェントが自分で確認する)。fields_note と同型の作り。
#
# 種の取得に使ってよい秒数。実測は cold 5.0秒 / warm 0.17秒だが、cold は索引 npy(82MB)の
# ロードと Ollama の初回モデルロードが重なるため余裕を持たせる。/ask 全体の予算 780秒に
# 対して 2〜3%。**超えたら種なしで続行**する(種のために本体を失わない)。
_SEED_BUDGET_SEC = 20
# 種に載せる件数。vector_topk は既定4だが、エージェントは候補1件を裏取りするのに
# 1〜2ターン使う(Read → 必要なら Grep)。max-turns は既定15なので、4件全部を追わせると
# 種の検証だけでターン予算が尽きて本来の探索ができなくなる。入口として3件に絞る。
_SEED_MAX_HITS = 3
# 1件あたりの文字数。意味検索が返す原文チャンクは最大 MAX_RAW_CHUNK_CHARS=1,200字で、
# 3件そのまま載せると 3,600字。エージェントのプロンプトはミラーの CLAUDE.md(数KB)と
# 合流するので、初回入力が膨らんだ分だけ探索に回せる予算が減る。700字あればチャンクの
# 主題と固有名詞は残り、「言い換えの橋渡し」という目的には足りる。
_SEED_MAX_CHARS = 700
# 全体の上限(件数×文字数の掛け算が効きすぎないよう二重に締める)。
# ★不変条件: _SEED_MAX_HITS × _SEED_MAX_CHARS 以上にしておくこと。
#   下回ると「件数上限より前に合計上限で break する」ため、**長いチャンクのときだけ
#   黙って3件目が落ちる**(3×700=2,100 に対して 2,000 にしていた初版が実際にそうで、
#   実測でも2件しか載っていなかった)。件数を絞りたいなら _SEED_MAX_HITS を下げること。
_SEED_TOTAL_CHARS = 2200

# 種の出典ラベルから落とす接頭辞。`Excerpt.source` は `(文書) 2026医薬祭/…` という
# **表示用ラベル**だが、ai_provider の種ブロックは「パスは _目録 からの相対で、実体は
# `fulltext/text/<パス>.txt`」と案内している。そのまま見出しに出すと、エージェントが
# `fulltext/text/(文書) 2026医薬祭/….txt` を組み立てて必ず空振りする(2026-08-12)。
# ★ `Excerpt.source` 自体は変えない——/ask の出典行など他の表示経路が使っている。
_SEED_SRC_PREFIX = "(文書) "

# ---- 過去アーカイブ(委員会再編前ファイル)の扱い ----
# mirror.py の DOC_GLOBS は現行年度+委員会運営だけをミラーに載せ、過去年度アーカイブを
# **意図的に締め出している**(「one-shot で2023年の旧部門構成が現行体制の質問に混入した」
# という実測事故がその理由としてコメントに残っている)。ところが意味検索の種はミラーを
# 経由せず共有ドライブの原文から直接来るため、締め出したはずの本文が同じプロンプトへ
# 戻ってくる。実測では上位3件×6問=18件のうち12件が `委員会再編前ファイル/` だった。
# 歯止めが ai_provider のプロンプト文だけなのは mirror.py 冒頭の設計原則
# 「境界はプロンプトではなく構造で保証する」に反するので、ここで機械的な線を引く。
# 判定は `e.source` の文字列一致で行う(モデルに判断させない)。2026-08-12
_SEED_ARCHIVE_MARKERS = ("委員会再編前ファイル",)
# ★ 既定は「除外しないが機械的に注記を付ける」。True にすると種から**除外**に切り替わる。
#   どちらが望ましいかは運用の判断: 注記方式は過去の経緯(旧体制の決定・前例)を
#   入口として拾えるが現行体制の質問に旧情報が混じる余地を残す。除外方式は混入を構造で
#   断てるが、過去年度しか記録の無い事柄が意味検索から一切引けなくなる。
# 既定は注記方式。実測で種の6割が過去アーカイブ由来で、上位3件すべてがアーカイブの
#   質問もある = 除外方式にすると種が空になる質問が実在する。混入の歯止めは この注記 + ミラーの
#   CLAUDE.md(年度ガード)の二段で持つ。
_SEED_DROP_ARCHIVE = False
_SEED_ARCHIVE_TAG = "※過去アーカイブ(現行体制の根拠にはならない)"


def _is_archive_source(source: str) -> bool:
    """出典ラベルが過去アーカイブ(委員会再編前ファイル)由来か。**機械判定のみ。**

    区切り文字は索引の作られ方で `/` にも `\\` にもなりうるので正規化してから見る。
    2026-08-12
    """
    return any(m in str(source or "").replace("\\", "/") for m in _SEED_ARCHIVE_MARKERS)


def build_seed_note(excerpts) -> str:
    """意味検索の抜粋を「種」の本文に整形する。**マスクは必ずここを通す。**

    エージェントが読むミラーは sync_mirror が `_transform_doc_text` を通してから
    書いているが、**この種はミラーを経由せず共有ドライブの原文から直接来る**
    (`_search_vectors` は `fulltext/text/` の生テキストを読む)。同じ関数をここで
    自分で通さないと、電話番号・〒住所・メアド・認証情報が素のままプロンプトに載る。

    ★順序は「マスク → 切り詰め」。逆にすると、住所行(mirror の `_POSTAL_LINE_RE` は
    行単位で丸ごと落とす)が切り詰めで途中から始まってパターンに当たらず素通りする。
    mask_fin は既定(True)のまま = ミラーの文書原文(DOC_GLOBS)と同じ扱い。
    2026-08-12
    """
    blocks: list[str] = []
    total = 0
    # 除外モードのときだけ先に落とす(件数上限より**前**に間引かないと、除外した分だけ
    # 種が減って上限に届かなくなる)。既定の注記モードでは何も落ちない。
    seeds = [e for e in (excerpts or [])
             if not (_SEED_DROP_ARCHIVE and _is_archive_source(e.source))]
    for e in seeds[:_SEED_MAX_HITS]:
        body = _transform_doc_text(e.text or "").strip()
        if not body:
            continue
        body = body[:_SEED_MAX_CHARS]
        if total + len(body) > _SEED_TOTAL_CHARS:
            break
        total += len(body)
        # 見出しは「実体を組み立てられるパス」+「機械的に付けた注記」。注記はモデルに
        # パスを読ませて判断させるのではなく、こちら側で断定して書く。
        label = str(e.source)
        if label.startswith(_SEED_SRC_PREFIX):
            label = label[len(_SEED_SRC_PREFIX):]
        tag = f" {_SEED_ARCHIVE_TAG}" if _is_archive_source(e.source) else ""
        blocks.append(f"- {label}(類似度 {float(e.score):.2f}){tag}\n{body}")
    return "\n\n".join(blocks)


FMT_CHOICES = [app_commands.Choice(name=f, value=f) for f in docgen.FORMATS]
MODEL_CHOICES = [
    app_commands.Choice(name="自動(複雑な質問はopusへ)", value="auto"),
    app_commands.Choice(name="sonnet(標準・速い)", value="sonnet"),
    app_commands.Choice(name="opus(高性能・遅め)", value="opus"),
]
# 「考える深さ」(claude CLI の --effort)。2026-10-09 追加。
# max は入れない: 公式に「収穫逓減・考えすぎになりやすい」とされ、Opus 5.5 では /ask の
# 持ち時間(780秒)と利用枠を食い潰しかねないため。
EFFORT_CHOICES = [
    app_commands.Choice(name="自動(設定どおり)", value="auto"),
    app_commands.Choice(name="low(浅い・いちばん速い)", value="low"),
    app_commands.Choice(name="medium(やや浅い・速め)", value="medium"),
    app_commands.Choice(name="high(深め)", value="high"),
    app_commands.Choice(name="xhigh(かなり深い・とても遅い・枠を多く使う)", value="xhigh"),
]

# /ask の進捗表示(interaction id → ProgressReporter)。safe_send が「回答の1通目を、
# 進捗を出していた元の応答に書く」ために参照する。/doc は登録しないので従来どおり。
_ACTIVE_PROGRESS: dict = {}


def _effort_label(res) -> str:
    """回答に使った深さ(フッター・ログ用)。空 = --effort を渡していない = CLI/モデルの既定。"""
    return getattr(res, "effort", "") or "既定"


def _edit_kwargs(content, kw: dict) -> dict:
    """followup.send の引数を edit_original_response 用に読み替える(file → attachments)。"""
    out = {"content": content}
    files = list(kw.get("files") or [])
    if kw.get("file") is not None:
        files.insert(0, kw["file"])
    if files:
        out["attachments"] = files
    for k in ("embed", "embeds", "allowed_mentions", "view"):
        if k in kw:
            out[k] = kw[k]
    return out


def _rewind_files(kw: dict) -> None:
    """編集に失敗した添付を followup で送り直せるよう読み出し位置を戻す。"""
    files = ([kw["file"]] if kw.get("file") is not None else []) + list(kw.get("files") or [])
    for f in files:
        try:
            f.reset()
        except Exception:  # noqa: BLE001
            pass


async def safe_send(itx, content=None, **kw):
    """followup.send の薄いラッパ。送信失敗を握って ERROR ログに落とす。

    defer から15分を過ぎた interaction への送信は NotFound(HTTPException の
    サブクラス)になる。そこで例外が上がるとコマンド全体が落ち、利用者にも
    ログにも何も残らない=沈黙。届かないのは変えられないが、記録には残す。
    /ask と /doc の両方で使うためモジュール関数にしてある。

    進捗表示(2026-10-09): 進捗で元の応答を書き換えていた場合は、**回答の1通目を元の応答に
    書く**。Discord は「考え中」のままの応答なら最初の followup で置き換えるが、書き換え済みの
    応答は置き換えないため(放っておくと進捗表示が残り、回答が別メッセージになる)。
    編集に失敗したら followup に落とす(回答を落とさないことが最優先)。
    """
    rep = _ACTIVE_PROGRESS.get(getattr(itx, "id", None))
    if rep is not None:
        try:
            use_original = await rep.claim_for_answer()
        except Exception:  # noqa: BLE001
            log.exception("進捗表示の停止に失敗(followup で送る)")
            use_original = False
        if use_original:
            try:
                await itx.edit_original_response(**_edit_kwargs(content, kw))
                return
            except Exception as e:  # noqa: BLE001  HTTPException・期限切れなど
                log.warning("進捗メッセージへの回答書き込みに失敗 → followup で送る: %s", e)
                _rewind_files(kw)
    try:
        await itx.followup.send(content, **kw)
    except discord.HTTPException as e:
        log.error("Discord への送信に失敗(応答期限切れ等・内容は届いていない): %s", e)
    except Exception:  # noqa: BLE001
        log.exception("Discord への送信で想定外の例外")


def _chunks(text: str, size: int = 1900):
    """Discord の2000字制限に収まるよう分割。なるべく改行で切る(コードブロック・
    見出し・表の途中で機械分割されると読みにくいため)。改行が無い長文は size で分割。"""
    while text:
        if len(text) <= size:
            yield text
            return
        cut = text.rfind("\n", 1, size)
        if cut <= 0:
            cut = size
        yield text[:cut]
        text = text[cut:].lstrip("\n")


class Knowledge(commands.Cog):
    def __init__(self, bot: commands.Bot, kb: KnowledgeBase, provider, usage_log=None,
                 usd_jpy=160.0, persona=None, neta_dir=None):
        self.bot = bot
        self.kb = kb
        self.provider = provider  # None なら常に grep 直返し
        self.usage_log = usage_log
        self.usd_jpy = usd_jpy
        self.persona = persona  # PersonaStore(恒久口調)
        self.neta_dir = neta_dir  # ネタ帳の置き場(None=既定 ~/.iyakusai/neta。ドライブ外)
        self._agent_sem = asyncio.Semaphore(2)  # エージェント検索の同時実行上限

    @app_commands.command(name="ask", description="委員会資料から探して答える(「あの決定どこ?」)")
    @app_commands.describe(
        質問="知りたいこと(例: 発電機のレンタルはどうなってる?)",
        形式="回答をファイルで受け取る場合の形式(省略時は通常のメッセージ)",
        モデル="AIモデルの指定(省略時は自動振り分け)",
        口調="この回答だけの口調(プリセット名も可、自由文も可)。恒久は /persona",
        考える深さ="AIがどれだけ考えるか(省略時は設定どおり。深いほど遅く、利用枠を多く使う)",
    )
    @app_commands.choices(形式=FMT_CHOICES, モデル=MODEL_CHOICES, 考える深さ=EFFORT_CHOICES)
    async def ask(
        self,
        itx: discord.Interaction,
        質問: str,
        形式: app_commands.Choice[str] | None = None,
        モデル: app_commands.Choice[str] | None = None,
        口調: str | None = None,
        考える深さ: app_commands.Choice[str] | None = None,
    ):
        await itx.response.defer(thinking=True)
        t0 = time.time()
        # /ask 全体の締切。**起点は defer した瞬間**であって各段の開始ではない。
        # 段ごとに局所計測すると、セマフォ待ちが誰の予算にも入らず合計が15分を超える
        # (2026-08-01 の検証で「単独利用でも 300+300+300=960秒」を実証)。
        # 基準は monotonic(壁時計だとスリープ復帰・NTP 補正で予算が飛ぶ)。
        deadline = time.monotonic() + DEFER_BUDGET_SEC
        # 「考える深さ」の明示指定。auto/未指定は None = [ai] effort / agent_effort のとおり。
        effort = (考える深さ.value if 考える深さ and 考える深さ.value != "auto" else None)
        # 進捗表示(2026-10-09)。開始に失敗しても None で続行する(回答が本体)。
        reporter = self._start_progress(itx, モデル, effort)
        try:
            await self._ask_body(itx, 質問, 形式, モデル, 口調, effort, t0, deadline, reporter)
        finally:
            if reporter is not None:
                # 回答が1通も出ないまま終わった(想定外の例外)ときだけ、進捗表示を
                # 「問題が発生しました」に差し替える。回答済みなら何もしない。
                await reporter.close()
                _ACTIVE_PROGRESS.pop(getattr(itx, "id", None), None)

    def _start_progress(self, itx, モデル, effort):
        """進捗表示を始める。無効設定・AI無し・開始失敗なら None(=従来どおりの「考え中」)。

        `[ai] progress = false` のときは None を返し、エージェントにも on_progress を渡さない
        = CLI は従来の json 出力のまま動く(ストリーム解析ごと切り戻せるキルスイッチ)。
        """
        cfg = getattr(self.bot, "cfg", None)
        if self.provider is None or cfg is None or not getattr(cfg, "ai_progress", True):
            return None
        if not hasattr(itx, "edit_original_response"):
            return None   # 書き換え先が無い(テスト用の偽 Interaction など)
        try:
            model = (モデル.value if モデル and モデル.value != "auto"
                     else getattr(cfg, "ai_agent_model", "sonnet"))
            rep = ProgressReporter(
                itx.edit_original_response,
                interval=getattr(cfg, "ai_progress_interval_sec", 7),
                mirror_root=getattr(cfg, "mirror_dir", None),
                model=str(model),
                effort=effort or getattr(cfg, "ai_agent_effort", "") or "")
            _ACTIVE_PROGRESS[itx.id] = rep
            rep.start()
            return rep
        except Exception:  # noqa: BLE001
            log.exception("進捗表示の開始に失敗(進捗なしで続行)")
            _ACTIVE_PROGRESS.pop(getattr(itx, "id", None), None)
            return None

    async def _ask_body(self, itx, 質問, 形式, モデル, 口調, effort, t0, deadline, reporter):
        """/ask の本体。2026-10-09 に ask から分離(defer・締切・進捗表示の後始末は ask 側)。"""
        # その場指定(口調。プリセット名なら展開)> 恒久ペルソナ > なし
        persona_style = resolve_ondo(口調) if 口調 else (
            self.persona.active_style() if self.persona else None)
        # ネタ帳はネタ枠(既定オフ)を明示的に選んだときだけ載せる。口調と同じ優先順位で判定し、
        # ネタ帳が空/未作成なら何も載らない=通常の口調のまま(neta.load_lines が空を返す)。
        neta_lines = None
        if (ondo_wants_neta(口調) if 口調 else
                (self.persona.active_neta() if self.persona else False)):
            neta_lines = load_lines(self.neta_dir) or None

        # 既定は全質問をエージェント検索(無害化ミラー上で自分で grep→読む→絞り直す)へ。
        # 抜粋10件の one-shot は「統合が要るか」を検索前に予測できず、キーワードルーターも
        # 実ログで誤判定が多かった(例:「レンタルはどうなってる?」が default 落ち)ため、
        # ルーティング自体を廃止した。one-shot は agent 失敗時の転落先として残る(劣化ラダー:
        # agent → one-shot → grep直返し)。枠逼迫時は config agentic="heavy"/"off" で絞れる。
        outcome = await self._try_agentic(itx, 質問, 形式, モデル, persona_style, t0,
                                          neta_lines, deadline, effort=effort,
                                          reporter=reporter)
        if outcome == AGENT_DONE:
            return
        # 転落・混雑の事情は⚠/⏳で見せる(未試行=設定でオフのときは何も出さない)
        notice = agent_note(outcome)
        if reporter is not None:
            reporter.set_phase("fallback" if outcome in (AGENT_FAILED, AGENT_BUSY) else "lookup")

        # 検索も締切の内側に入れる。共有ドライブ(Google Drive FS)は数分単位で
        # ストールすることがあり、無制限に待つと defer 期限を検索だけで使い切って
        # 完全沈黙になる。**スレッドは止められない**(読み取り専用なので放置してよい)。
        search_budget = run_budget_sec(deadline - time.monotonic(),
                                       minimum=MIN_ONESHOT_RUN_SEC)
        try:
            if search_budget is None:
                raise asyncio.TimeoutError
            result = await asyncio.wait_for(
                asyncio.to_thread(self.kb.search, 質問), timeout=search_budget)
        except asyncio.TimeoutError:
            # 「見つかりませんでした」と混同させない——資料が無いのではなく調べられて
            # いない。利用者が再実行すべきだと分かる文面にする(§3-4)。
            log.error("/ask 検索が時間内に終わらず打ち切り(共有ドライブのストール?): %.40s", 質問)
            await self._safe_send(
                itx,
                (f"{notice}\n" if notice else "")
                + "⚠ 共有ドライブの応答が遅く、検索を完了できませんでした。"
                "少し待って再実行してください。"
            )
            return
        except Exception:  # noqa: BLE001  索引破損・非UTF-8ファイル・実装バグなど
            # 2026-08-12 追加(レビュー#9): ここは TimeoutError しか捕っていなかった。
            # 想定外の例外が飛ぶと **defer 済みのまま応答が返らない**=利用者から見て
            # 完全な無応答(最悪の結果)になる。原因はログに残し、必ず何かを返す
            # (_目録/AI作業方針.md §3-4: 沈黙して劣化させない)。
            log.exception("/ask 検索が想定外の例外で失敗 → 応答だけは返す: %.40s", 質問)
            await self._safe_send(
                itx,
                (f"{notice}\n" if notice else "")
                + "⚠ 資料の検索中にエラーが発生しました。少し待って再実行してください"
                + contact.ask_note()
            )
            return
        # Bot自身(機能・仕組み・使い方)への質問は、資料が検索対象外でも自己説明で答えたい。
        # → 検索0件でも早期リターンせず AI に渡す(SYSTEM_INSTRUCTIONS の「私について」が根拠)。
        about_bot = is_about_bot(質問)
        # 質問文から機械抽出した条件(発言者・期間)は必ず利用者に見せる。黙って絞ると
        # 誤爆(チャンネル名を人名と読む等)に誰も気づけず、沈黙の誤答になる
        # (この設計思想は _目録/AI作業方針.md §3-4)。0件のときこそ「絞りすぎたのでは」を
        # 疑えるように、見つからなかった旨のメッセージにも同じ1行を出す。
        cond = f"-# 条件: {result.fields.note}(質問文から機械抽出)" if result.fields.note else ""
        # 網羅状況(全件添付か日別間引きか)。**間引いたことは必ず見せる**——黙って
        # 切り捨てると「これで全部」と読まれる(§3-4)。条件行と同じ扱いで先頭に出す。
        cover = f"-# {result.coverage}" if result.coverage else ""
        # **注意書きは回答の先頭に置く**。フッターに置くと長い回答では2通目に押し出され、
        # 1通目だけ読んだ人には劣化が見えない=権威ある回答に見えてしまう(2026-08-01 検証)。
        notes = "\n".join(x for x in (notice, cond, cover) if x)
        title = f"**Q: {質問}**" + (f"\n{notes}" if notes else "")
        if not result.excerpts and not (about_bot and self.provider is not None):
            await self._safe_send(
                itx,
                (f"{notes}\n" if notes else "")
                + f"🔍 「{質問}」に該当する資料が見つかりませんでした。"
                f"言い換え(略語→正式名など)を試すか、`_目録/INDEX.md` の検索動線を参照してください。"
            )
            return

        # 予算は検索側が決める(全件モードのときだけ広がる)。
        context = render_context(result.excerpts, budget_chars=result.context_budget)
        # context に実際に載った出典だけを表示する(budget 超過でスキップされた抜粋を
        # 「or i<=3」で無条件表示すると、AIが見ていない資料が根拠に見える・2026-07-24)
        loaded = [e for i, e in enumerate(result.excerpts, 1) if f"出典{i}:" in context]
        sources = "\n".join(f"-# [{i}] {e.source}"
                            for i, e in enumerate(result.excerpts, 1)
                            if f"出典{i}:" in context)
        # LINE の鮮度注記は **実際に context に載ったとき** だけ。抜粋リストに在るだけで
        # 出すと、予算超過で LINE が落ちた回答にも注記が付く(2026-08-01 の検証で実測)。
        line_note = _line_note(result.line_snapshot
                               if any(is_line_source(e.source) for e in loaded) else "")

        ai_note = _AI_OFF_NOTE   # provider が None(AI無効設定)のときの既定
        # 残りが少なすぎるなら AI を呼ばない。呼んで期限を越えると回答は届かず、
        # 利用者から見れば「無応答」=最悪の結果になる(grep直返しなら必ず届く)。
        ai_budget = run_budget_sec(deadline - time.monotonic(), minimum=MIN_ONESHOT_RUN_SEC)
        if self.provider is not None and ai_budget is None:
            log.warning("/ask 残り時間が足りず AI 要約を省略 → grep直返し (%.0f秒経過)",
                        time.time() - t0)
            ai_note = _AI_NOTIME_NOTE
        elif self.provider is not None:
            model = self.provider.choose_model(質問, override=モデル.value if モデル else None)
            if reporter is not None:
                reporter.set_phase("oneshot")
                reporter.set_meta(model=model,
                                  effort=effort or getattr(self.provider, "effort", "") or "")
            try:
                res = await self.provider.answer(
                    質問, context, model=model,
                    persona_style=persona_style,
                    neta_lines=neta_lines,
                    # agent 経路と同じ判定(「やること」系 かつ 人名条件なし)。
                    # one-shot はここに result.fields がそのまま在るので直接見る。
                    subject_guard=(is_personal_scope(質問)
                                   and not result.fields.authors),
                    timeout=ai_budget, effort=effort)
                answer = res.text
                # 後処理はすべて「失敗しても回答は送る」側に倒す(agent 経路と同じ)。
                # 従来は usage_log.record の OSError が except AIError を素通りして
                # 回答ごと消えていた(2026-08-01 検証)。
                await self._record_usage("/ask", itx.user, res)
                log.info("/ask 完了: model=%s effort=%s %.1f秒 by %s : %.40s", model,
                         _effort_label(res), time.time() - t0, itx.user, 質問)
                # mode を明示する(agent 側の「mode: agent(ミラー横断検索)」と対称)。
                # ログ・スクショから経路が一目で分かる=障害調査の初手が要らなくなる。
                footer = (f"{FOOTER}{line_note}"
                          f"\n-# mode: one-shot(抜粋検索) / model: {model} / 深さ: {_effort_label(res)}"
                          f" / {res.tokens_note()} / {res.cost_note(self.usd_jpy)}"
                          f" / {elapsed_note(t0)}")
                src_plain = sources.replace("-# ", "- ")
                await self._deliver(
                    itx, 形式, 質問, title, footer,
                    doc_md=f"# Q: {質問}\n\n{answer}\n\n## 出典\n{src_plain}",
                    plain=f"{title}\n{answer}\n{sources}\n{footer}")
                return
            except AIError as e:
                log.warning("AI失敗→grep直返しにフォールバック: %s", e)
                ai_note = _AI_LIMIT_NOTE if _AI_LIMIT_HINT_RE.search(str(e)) else _ai_error_note()

        # フォールバック: 上位抜粋を直接返す(形式指定は無視してテキストで)。
        # AIが使えない理由(枠切れ/一時障害/オフ)を一言添える。
        if not result.excerpts:   # Bot自身への質問等で抜粋が無い場合
            await self._send(itx, f"{title}\n{ai_note}")
            return
        top = result.excerpts[:3]
        body = render_context(top, budget_chars=_FALLBACK_BUDGET_CHARS, ensure_one=True)
        # 出典は **body に実際に載った分だけ** で作り直す(2026-08-12 修正・レビュー#3)。
        # 上の sources は本予算(既定11,000字)の context を基準に作った変数で、
        # フォールバックでそのまま流用すると **本文に無い資料が根拠として並ぶ**。
        # 「出典は並ぶのに本文が無い」回答のもう半分の原因。
        grep_loaded = [e for i, e in enumerate(top, 1) if f"出典{i}:" in body]
        grep_sources = "\n".join(f"-# [{i}] {e.source}"
                                 for i, e in enumerate(top, 1)
                                 if f"出典{i}:" in body)
        # grep 直返しでも LINE を出すなら鮮度注記を添える(実際に載った分で判定)。
        # agent 経路はエージェントがどの資料を読んだかホスト側から分からないため見送る。
        grep_note = _line_note(result.line_snapshot if any(
            is_line_source(e.source) for e in grep_loaded) else "")
        await self._send(itx,
                         f"{title}\n{ai_note}\n{body}\n{grep_sources}\n{FOOTER}{grep_note}")

    async def _try_agentic(self, itx, 質問, 形式, モデル, persona_style, t0,
                           neta_lines=None, deadline: float | None = None,
                           effort: str | None = None, reporter=None) -> str:
        """質問をエージェント検索で処理する。AGENT_DONE/SKIPPED/FAILED/BUSY を返す。

        条件: provider あり / config agentic が all(全質問)か heavy(統合系のみ) /
        ミラー構築済み。失敗は AGENT_FAILED を返して呼び出し側の one-shot に流す。
        **未試行(SKIPPED)・混雑(BUSY)と区別する**のは、⚠を出すのが「試して失敗
        した」ときだけだから(設定でオフのときに⚠が出ると誤報になる)。
        """
        cfg = getattr(self.bot, "cfg", None)
        if (self.provider is None or cfg is None
                or not getattr(cfg, "mirror_dir", None)
                or not getattr(self.provider, "answer_agentic", None)):
            return AGENT_SKIPPED
        mode = str(getattr(cfg, "ai_agentic", "off"))
        if mode not in ("all", "heavy"):
            return AGENT_SKIPPED
        if mode == "heavy" and route_model(質問) != "heavy":
            return AGENT_SKIPPED
        # ミラー未構築は「設定が済んでいない」であって障害ではない。ここで弾かないと
        # answer_agentic が AIError を投げて AGENT_FAILED になり、⚠が誤報として出る。
        try:
            if not (Path(cfg.mirror_dir) / "CLAUDE.md").is_file():
                log.info("ミラー未構築のためエージェント検索をスキップ: %s", cfg.mirror_dir)
                return AGENT_SKIPPED
        except OSError as e:
            log.warning("ミラーの確認に失敗(スキップ): %s", e)
            return AGENT_SKIPPED
        # モデル明示指定はそれを尊重、無指定/autoならエージェント既定(sonnet)
        model = (モデル.value if モデル and モデル.value != "auto"
                 else getattr(cfg, "ai_agent_model", "sonnet"))
        # 発言者・期間は one-shot と同じ機械抽出をエージェントにも渡す。エージェントは
        # grep で ts / author を自分で絞れるので、条件を言葉で書いてやるだけで効く
        # (KnowledgeBase 側のキャッシュを使うため kb 経由。初回は raw のファイル一覧を
        # 舐めるので to_thread に逃がす=共有ドライブでのイベントループ停止を避ける)。
        # 例外は握りつぶして条件なしで続行する。共有ドライブは一時的に見えなくなることが
        # あり、この行は付加情報にすぎない——ここで落ちると agent→one-shot→grep の
        # 劣化ラダーごと吹き飛んで /ask が無応答になる(呼び出し側に try は無い)。
        # subject_guard: 「やること」系なのに人名が書かれていない質問(主語欠落)。
        # 立つと ai_provider.SUBJECT_GUARD がプロンプトに差さり、「誰の分の資料か明示せよ /
        # 二人称で他人の課題を指示するな」を守らせる(2026-08-16 の誤答対策)。
        # 抽出に失敗した側では authors が分からないので **ガードを立てる方に倒す**
        # (立てすぎても指示が1つ増えるだけで無害。立て損なうと個人一覧を誤って返す)。
        subject_guard = is_personal_scope(質問)
        try:
            _fields = await asyncio.to_thread(self.kb.parse_fields, 質問)
            fields_note = _fields.note
            subject_guard = subject_guard and not _fields.authors
        except Exception as e:  # noqa: BLE001  ドライブ不通・索引破損など
            log.warning("検索条件の機械抽出に失敗(条件なしで続行): %s", e)
            fields_note = ""
        # 棚卸し(「未了のものを全部出せ」型)の質問。立つと2つが同時に差さる:
        #   ① coverage_note        = 3部6課+役員会 digest の「宿題・未完了タスク」節
        #   ② INVENTORY_GUARD      = 職掌でなく未了で答えろ / 案件・期限・担当・最終言及日
        # ①が主役。2026-08-17 05:45「各部署でやるべきことを教えて。」は、掟に
        # 「進捗・まとめ系は actions_recent を必ず Read」と書いてあるのに読まずツール7回で
        # 打ち切り、職掌を返した(同日 05:41 は同じ掟の下で読んでいる)。**読む面を
        # エージェントの裁量から外す**のがこの床の目的で、文章の追加では直らないと判断した。
        # 床の生成はローカルのミラーを読むだけだが、共有ドライブがマウントされた環境も
        # あり得るので to_thread に逃がす(fields と同じ。失敗は "" で続行)。
        inventory_guard = is_inventory_scope(質問)
        coverage_note = ""
        if inventory_guard:
            try:
                coverage_note = await asyncio.to_thread(build_coverage_note, cfg.mirror_dir)
                if coverage_note:
                    log.info("棚卸し床: %d字をエージェントへ", len(coverage_note))
                else:
                    log.warning("棚卸し質問だが床が空 → 床なしで続行")
            except Exception as e:  # noqa: BLE001  実装バグ・OSError など想定外
                log.warning("棚卸し床の生成に失敗(床なしで続行): %s", e)
        # 意味検索の「種」(2026-08-12 追加・レビュー追補「案2」)。エージェントは字句一致
        # しかできないので、言い換えに強い bge-m3 の上位数件を入口として渡す。
        # **/ask 本体を絶対に失敗させない**のが最優先: 予算超過も例外も種なしで続行する
        # (fields_note と同じ扱い。種は付加情報であって回答の必要条件ではない)。
        # セマフォ取得の**手前**で回すのは、これがホスト側の前処理であってエージェント本体
        # ではないため(順番待ちの2枠を種の取得で塞がない)。
        seed_note = ""
        seed_budget = _SEED_BUDGET_SEC
        if deadline is not None:
            # エージェント本体の最低実行時間(MIN_AGENT_RUN_SEC)は必ず残す。種を取ったせいで
            # 本体が起動できず BUSY に落ちたら本末転倒。
            seed_budget = min(seed_budget,
                              int(agent_stage_deadline(deadline) - time.monotonic()
                                  - MIN_AGENT_RUN_SEC))
        # 意味検索が無い環境(numpy/索引/Ollama 不在)は _search_vectors 自身が [] を返して
        # 黙って無効化される。ここでは「メソッドごと存在しない」場合だけ先に降りる。
        vsearch = getattr(self.kb, "_search_vectors", None)
        if vsearch is not None and seed_budget >= 1:
            if reporter is not None:
                reporter.set_phase("seed")
            try:
                # 同期で呼ぶとイベントループが止まる(索引 npy のロード+Ollama への HTTP)。
                # **wait_for で打ち切ってもスレッドは止まらない**が、読み取り専用なので
                # 放置してよい(one-shot の kb.search と同じ扱い)。
                hits = await asyncio.wait_for(asyncio.to_thread(vsearch, 質問),
                                              timeout=seed_budget)
                seed_note = build_seed_note(hits)
                if seed_note:
                    # この INFO 行が本機能の唯一の可視化(回答の見た目は変わらない)。
                    # hits は bge-m3 が返した**候補**の件数(vector_topk)であって、
                    # 種に載った件数ではない——上限で切っているので「候補N件から」と書く。
                    log.info("意味検索シード: 候補%d件から %d字をエージェントへ",
                             len(hits), len(seed_note))
            except asyncio.TimeoutError:
                # Ollama の初回ロード・共有ドライブのストール。種なしで続行する。
                log.warning("意味検索シードが %d 秒で終わらず種なしで続行", seed_budget)
            except Exception as e:  # noqa: BLE001  索引破損・実装バグなど想定外
                log.warning("意味検索シードの取得に失敗(種なしで続行): %s", e)
        # 同時実行は2本まで(1本60〜180秒×claude CLI は1本数百MB。RPi 4GB と
        # 利用枠の保護)。**順番待ちも締切の内側**で行う: 待ちを無制限にすると
        # 3人目が待つ間に defer 期限を使い切り、agent も one-shot も間に合わない。
        stage_end = agent_stage_deadline(deadline) if deadline is not None else None
        if reporter is not None and self._agent_sem.locked():
            reporter.set_phase("queue")   # 2本とも埋まっている=順番待ちになる
        if stage_end is not None:
            wait = run_budget_sec(stage_end - time.monotonic(), minimum=1)
            if wait is None:
                log.warning("エージェント段の時間予算が無いためスキップ(混雑)")
                return AGENT_BUSY
            try:
                await asyncio.wait_for(self._agent_sem.acquire(), timeout=wait)
            except asyncio.TimeoutError:
                log.warning("エージェント検索の順番待ちが予算超過 → one-shot へ(混雑)")
                return AGENT_BUSY
        else:
            await self._agent_sem.acquire()
        if reporter is not None:
            reporter.set_phase("start")
        try:
            res = await self.provider.answer_agentic(
                質問, cfg.mirror_dir, model=model, persona_style=persona_style,
                neta_lines=neta_lines, fields_note=fields_note, seed_note=seed_note,
                subject_guard=subject_guard, inventory_guard=inventory_guard,
                coverage_note=coverage_note, deadline=deadline, effort=effort,
                # 進捗の受け口。None(=[ai] progress=false)なら CLI は従来の json 出力。
                on_progress=(reporter.feed if reporter is not None else None))
        except AIError as e:
            if getattr(e, "kind", "") == "busy":   # 実行前に予算切れ=失敗ではない
                log.warning("エージェント検索の時間予算切れ → one-shot へ(混雑): %s", e)
                return AGENT_BUSY
            log.warning("エージェント検索が失敗(kind=%s) → one-shot にフォールバック: %s",
                        getattr(e, "kind", "unknown"), e)
            return AGENT_FAILED
        except Exception:  # noqa: BLE001
            # AIError 以外(実装バグ・OSError 等)でも /ask を無応答にしない。
            # ここで抜けると呼び出し側に try が無く、利用者にもログにも何も残らない。
            log.exception("エージェント検索が想定外の例外で失敗 → one-shot にフォールバック")
            return AGENT_FAILED
        finally:
            self._agent_sem.release()
        # ここから先は「回答を得たあとの後処理」。記帳もファイル変換も、失敗しても
        # 回答の送信を止めない(いずれも _record_usage / _deliver が内部で握る)。
        await self._record_usage("/ask-agent", itx.user, res)
        log.info("/ask agent完了: model=%s effort=%s %.1f秒 by %s : %.40s",
                 model, _effort_label(res), time.time() - t0, itx.user, 質問)
        cond = f"-# 条件: {fields_note}(質問文から機械抽出)" if fields_note else ""
        title = f"**Q: {質問}**" + (f"\n{cond}" if cond else "")
        footer = (f"{FOOTER}\n-# mode: agent(ミラー横断検索) / model: {model} / 深さ: {_effort_label(res)}"
                  f" / {res.tokens_note()} / {res.cost_note(self.usd_jpy)} / {elapsed_note(t0)}")
        await self._deliver(itx, 形式, 質問, title, footer,
                            doc_md=f"# Q: {質問}\n\n{res.text}",
                            plain=f"{title}\n{res.text}\n{footer}")
        return AGENT_DONE

    async def _record_usage(self, cmd: str, user, res):
        """使用量を記帳する。**失敗しても回答の送信より優先しない。**

        usage_log は共有ドライブへの同期書き込みで、ドライブ不通時に OSError を投げる。
        従来これが送信前・try の外にあったため、**成功した回答が丸ごと捨てられて完全沈黙**
        になった(2026-08-01 の検証で例外注入により実証)。記帳は落ちてよい情報であり、
        回答は落ちてはいけない。沈黙させずログに残す(_目録/AI作業方針.md §3-4)。
        """
        if not self.usage_log:
            return
        try:
            await asyncio.to_thread(self.usage_log.record, cmd, str(user), res)
        except Exception as e:  # noqa: BLE001  ドライブ不通・破損など
            log.warning("使用量の記帳に失敗(回答送信を優先・記帳のみ欠落): %s", e)

    async def _deliver(self, itx, 形式, 質問, title, footer, doc_md, plain):
        """回答を届ける。**成功した回答は何があっても送る** が不変条件。

        形式指定(docx 等)のファイル生成に失敗したら、添付を諦めてテキストで送る。
        変換の失敗は回答そのものの喪失より軽い——利用者が欲しいのは中身であって
        ファイル形式ではない。
        """
        if 形式 is not None:
            try:
                fname, data = docgen.to_file(形式.value, 質問, doc_md)
                await self._safe_send(
                    itx, f"{title}(回答を {形式.value} で添付)\n{footer}",
                    file=discord.File(io.BytesIO(data), filename=fname),
                )
                return
            except Exception as e:  # noqa: BLE001  変換ライブラリ/一時ファイルの失敗
                log.warning("回答ファイルの生成に失敗 → テキスト送信に縮退: %s", e)
        await self._send(itx, plain)

    async def _safe_send(self, itx, content=None, **kw):
        """モジュール関数 safe_send への委譲(Cog からの呼び出し用)。"""
        await safe_send(itx, content, **kw)

    async def _send(self, itx: discord.Interaction, text: str):
        for chunk in _chunks(text):
            await self._safe_send(itx, chunk)
