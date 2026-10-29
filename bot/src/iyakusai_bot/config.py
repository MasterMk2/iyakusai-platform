# -*- coding: utf-8 -*-
"""設定と秘密情報の読み込み。

config.toml はホストごとにローカル(既定: ~/.iyakusai/config.toml)に置く。
共有ドライブには置かない(RPi と Windows で内容が異なるため)。
トークンは環境変数 DISCORD_TOKEN、または DISCORD_TOKEN_FILE が指すファイルから読む。
"""

from __future__ import annotations

import os
import platform
import sys
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

from .contact import DEFAULT as CONTACT_DEFAULT
from .org import valid_domain

DEFAULT_CONFIG_PATH = Path.home() / ".iyakusai" / "config.toml"


@dataclass
class AssistantSettings:
    """統合アプリの「Bot」タブ([assistant]・2026-10-14)。enabled=false なら Cog を読まない。"""
    enabled: bool = False
    store_path: Path | None = None        # ジョブ表(SQLite)。絶対パス・共有データの外
    files_dir: Path | None = None         # 生成物の置き場。絶対パス・共有データの外
    share_channel_id: int | None = None   # アプリ発の ask/doc を投稿する #bottest
    reminder_channel_ids: list[int] = field(default_factory=list)   # 先頭が既定
    poll_sec: int = 2
    max_active_per_user: int = 3
    # アプリの「画像」(2026-10-14 再開)。true でも [image] が有効で /image が使える構成のときだけ受ける
    image_enabled: bool = False


@dataclass
class ImageSettings:
    """/image(Claude が SVG を書き、Pi で PNG にする・2026-10-14)。enabled=false なら Cog を読まない。"""
    enabled: bool = False
    model: str = "opus"                   # claude CLI の --model(opus / sonnet)
    effort: str = "low"                   # claude CLI の --effort。"" = [ai] effort(未設定なら CLI の既定。遅い)
    font_dir: Path | None = None          # 書体の置き場。絶対パス・共有データの外
    work_dir: Path | None = None          # 変換の作業場所(空の resources_dir を作る)。絶対パス・共有データの外
    render_python: str = ""               # resvg_py を入れた python。空 = Bot と同じ python
    render_timeout_sec: int = 60
    daily_limit_per_user: int = 20        # 1 人 1 日(日本時間)の枚数。Discord とアプリの合計
    max_concurrent: int = 1               # 同時に作る枚数(AI の枠と Pi のメモリを /ask と分け合う)


@dataclass
class Config:
    host_name: str            # ロック識別用(例: "windows-ws", "rpi4b")
    mode: str                 # "direct"(ドライブ直接) | "mirror"(ローカルミラー)
    data_dir: Path            # 可変データ(JSON)の置き場 = ドライブの bot/data(またはそのミラー)
    knowledge_dir: Path | None = None  # _目録 参照用(M3 で使用)
    heartbeat_sec: int = 300
    takeover_after_sec: int = 900
    reminder_check_sec: int = 60
    admin_role_names: list[str] = field(default_factory=lambda: ["役員", "システム課"])
    # AI(要件定義 §5)
    ai_provider: str = "claude-cli"   # claude-cli | none
    ai_model: str = "sonnet"          # 既定モデル
    ai_heavy_model: str = "opus"      # 複雑タスク用モデル
    ai_auto_route: bool = True        # 複雑さに応じた自動振り分け
    ai_timeout_sec: int = 180
    ai_usd_jpy: float = 160.0         # API換算額の円表示用レート
    # エージェント検索(無害化ミラー上の claude -p に自律検索させる)
    ai_agentic: str = "all"            # all=全質問 / heavy=統合系のみ(枠節約) / off=従来one-shotのみ
    ai_agent_model: str = "sonnet"     # エージェントの既定モデル(ターン数が多い分 sonnet 推奨)
    ai_agent_max_turns: int = 15       # エージェントのターン上限(暴走・トークン浪費の頭打ち)
    ai_agent_timeout_sec: int = 300
    # 推論の努力量(claude CLI の --effort: low/medium/high/xhigh/max)。
    # **空文字なら --effort を渡さない**(= CLI の既定に任せる従来動作)。2026-08-31
    ai_effort: str = ""                # one-shot / 文書生成side
    ai_agent_effort: str = ""          # エージェント検索side
    # /ask の進捗表示(2026-10-09)。false で表示をやめ、エージェントの CLI 出力も従来の
    # json に戻す(ストリーム解析ごと切り戻せるキルスイッチ)。間隔は Discord の編集レート
    # 制限を踏まないよう 3 秒未満にはしない。
    ai_progress: bool = True
    ai_progress_interval_sec: int = 7
    mirror_dir: Path | None = None     # 無害化ミラー(既定: ~/.iyakusai/mirror。ドライブ外に置く)
    neta_dir: Path | None = None       # ネタ帳(既定: ~/.iyakusai/neta。個人の投稿=ドライブ外に置く)
    contact: str = CONTACT_DEFAULT     # 不具合・要望の連絡先([help] contact。名前はコードに書かない)
    mail_address: str = ""             # メール草案の署名の住所の行([mail] address。所在地はコードに書かない)
    # 委員会名・キャンパス・残すメールドメイン([org]。学校名はコードに書かない。空なら org の既定値)
    org_name: str = ""
    org_campus: str = ""
    org_other_campuses: str = ""
    org_keep_mail_domains: tuple[str, ...] = ()
    # ナレッジ検索(要件定義 §6 F1)
    kn_digest_roots: list[str] | None = None   # None = knowledge_search の既定
    kn_blocklist: list[str] | None = None       # 完全遮断(digest/raw/perdoc)
    kn_raw_blocklist: list[str] | None = None   # raw だけ遮断(制限CHだが digest は安全)
    kn_discord_raw: bool = True                # /ask で discord/raw の最新分も検索するか
    kn_discord_raw_days: int = 45              # 直近この日数だけを raw 検索対象に
    kn_vector: bool = True                     # 意味検索(bge-m3)で文書を補完(Ollama必要・無ければ自動スキップ)
    kn_vector_min_score: float = 0.5           # このcosine未満は採用しない
    kn_vector_topk: int = 4                    # 意味検索から拾う文書数
    # F3 ログ収集の常駐化(要件定義 §6 F3)
    collect_enabled: bool = True               # Bot 内で Discord 収集を定期実行するか
    collect_interval_min: int = 30             # 収集間隔(分)
    # 独立した低優先度のネタ動画worker。省略時OFF、AI APIを使用しない。
    neta_video: dict = field(default_factory=lambda: {"enabled": False})
    # /todo 委員会タスク(task_store.TaskSettings で検証)。省略時OFF。
    tasks: dict = field(default_factory=lambda: {"enabled": False})
    # 定期タスクスクリーニングの候補の投稿・起票(screening_cog で検証)。省略時OFF。
    task_screening: dict = field(default_factory=lambda: {"enabled": False})
    # 統合アプリの「Bot」タブ(2026-10-14)。省略時は OFF。
    assistant: AssistantSettings = field(default_factory=AssistantSettings)
    # /image(Claude が描く図・ポスター風の画像・2026-10-14)。省略時は OFF。
    image: ImageSettings = field(default_factory=ImageSettings)
    # 基盤システム(統合アプリ)の写しをミラーの kiban/ に置く(kiban.KibanSettings で検証)。省略時OFF。2026-10-14
    kiban: dict = field(default_factory=lambda: {"enabled": False})
    # digest 本文の鮮度リマインド(収集後に「digest が raw に遅れていないか」を通知)
    collect_staleness_threshold: int = 30      # 未反映がこの件数以上で digest 再生成を促す
    collect_staleness_channel_id: int | None = None  # 通知先チャンネルID(未設定ならログのみ)
    # F8: 編集・削除を Gateway イベントで _edits.jsonl に記録するか。
    # 差分収集(collect_discord_v2)では「収集後の編集」「収集前に投稿→削除」を拾えないための補完。
    edit_watch_enabled: bool = True
    # F5 偶然の俳句検出(haiku.py)
    haiku_enabled: bool = False                # 既定OFF(出し方を決めてから有効化)
    haiku_mode: str = "react"                  # react=🎋を付けるだけ / reply=その場に返信 / digest=専用CHへ転記 / both
    haiku_channel_id: int | None = None        # digest・both の転記先
    haiku_min_score: int = 60                  # この点未満は出さない
    haiku_daily_limit: int = 5                 # 1日の上限(連投抑制)
    haiku_allow_hachou: bool = True            # 破調(1句だけ±1拍)も拾う。false=定型5-7-5のみ
    haiku_public_only: bool = True             # 転記時に @everyone が読めるCHだけを対象にする
    haiku_blocklist: list[str] | None = None   # 機微CH(既定は knowledge の blocklist 相当)


_EFFORT_LEVELS = ("low", "medium", "high", "xhigh", "max")


def _as_effort(value, where: str) -> str:
    """claude CLI の `--effort` に渡す努力量。未設定/空なら "" を返す(=フラグを渡さない)。

    綴り間違い(`"XHigh"` `"extra-high"` 等)を**起動時に弾く**。ここで通してしまうと
    CLI 側が引数エラーで異常終了し、`/ask` が「理由の分からない失敗」として one-shot に
    無言転落する——2026-08-01 の max-turns 転落と同じ壊れ方になるため。2026-08-31
    """
    if value is None:
        return ""
    s = str(value).strip().lower()
    if not s:
        return ""
    if s not in _EFFORT_LEVELS:
        sys.exit(f"config: {where} は {'/'.join(_EFFORT_LEVELS)} のいずれかです(現在: {value})")
    return s


def _as_int(value, where: str, default: int) -> int:
    """toml の数値項目を int にする。失敗は他の設定エラーと同じ体裁で sys.exit する。

    従来は素の `int(...)` だったため、値に文字列などが書かれていると生の ValueError で
    落ちていた。data_dir や host.mode は個別チェックで親切なメッセージを出しているのに
    数値だけ非対称で、委員が「どの項目が悪いのか」をトレースバックから読む羽目になる
    (2026-08-12)。
    ★既定値の挙動は変えない: 未設定なら default、`"300"` のような**引用符つきの数値も
    従来どおり通す**(int() に投げる中身は同じ)。型で弾くと、今まで起動できていた
    config.toml が新たに拒否されてしまう。
    """
    if value is None:
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        sys.exit(f"config: {where} は整数で指定してください(現在: {value!r})")


def _as_float(value, where: str, default: float) -> float:
    """_as_int の float 版(同じ方針・同じ体裁)。"""
    if value is None:
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        sys.exit(f"config: {where} は数値で指定してください(現在: {value!r})")


# ---- 統合アプリの「Bot」タブ(2026-10-14 追加)----

_ASSISTANT_KEYS = {"enabled", "store_path", "files_dir", "share_channel_id", "reminder_channel_ids",
                   "poll_sec", "image_enabled", "max_active_per_user"}


def _as_bool(value, where: str, default: bool) -> bool:
    if value is None:
        return default
    if type(value) is not bool:
        sys.exit(f"config: {where} は true / false で指定してください(現在: {value!r})")
    return value


def _bounded_int(value, where: str, low: int, high: int, default: int) -> int:
    if value is None:
        return default
    if type(value) is not int or not low <= value <= high:
        sys.exit(f"config: {where} は {low}〜{high} の整数で指定してください(現在: {value!r})")
    return value


def _snowflake(value, where: str) -> int:
    if type(value) is not int or not 1 <= value < 2**63:
        sys.exit(f"config: {where} は Discord の ID(整数)で指定してください")
    return value


def _outside_shared(path: Path, roots, where: str) -> Path:
    """ジョブ表・生成物を共有データ・検索対象の**内側**に置かない(契約 §2)。

    連携口とジョブ表は Bot と同じホストのローカルディスクに置く前提。ドライブの同期中に
    ジョブが読めなくなる・検索対象に生成物が混ざる、の両方を構造で防ぐ。
    """
    if not path.is_absolute():
        sys.exit(f"config: {where} は絶対パスで指定してください")
    resolved = path.resolve()
    for root in roots:
        if root is None:
            continue
        base = Path(root).resolve()
        if resolved == base or base in resolved.parents:
            sys.exit(f"config: {where} は共有データ・検索対象の外に置いてください")
    return resolved


def _assistant_settings(raw: dict, roots) -> AssistantSettings:
    section = raw.get("assistant", {})
    if not isinstance(section, dict):
        sys.exit("config: [assistant] の形式が正しくありません")
    unknown = set(section) - _ASSISTANT_KEYS
    if unknown:
        sys.exit(f"config: [assistant] に未知の項目があります: {', '.join(sorted(unknown))}")
    if not _as_bool(section.get("enabled"), "assistant.enabled", False):
        return AssistantSettings()
    paths = {}
    for key in ("store_path", "files_dir"):
        value = section.get(key)
        if not isinstance(value, str) or not value.strip():
            sys.exit(f"config: assistant.{key} を絶対パスの文字列で指定してください")
        paths[key] = _outside_shared(Path(value.strip()).expanduser(), roots, f"assistant.{key}")
    channels = section.get("reminder_channel_ids")
    if not isinstance(channels, list) or not channels:
        sys.exit("config: assistant.reminder_channel_ids は ID の配列(1件以上・先頭が既定)で指定してください")
    # 画像は 2026-10-14 夜に Claude の SVG 方式で再開(Gemini は使わない)。[image] が無効なら
    # true でも画像の依頼は受けてすぐ「使えない」で返す(assistant_cog が Images の有無を見る)。
    return AssistantSettings(
        enabled=True,
        store_path=paths["store_path"],
        files_dir=paths["files_dir"],
        share_channel_id=_snowflake(section.get("share_channel_id"), "assistant.share_channel_id"),
        reminder_channel_ids=[_snowflake(v, "assistant.reminder_channel_ids") for v in channels],
        poll_sec=_bounded_int(section.get("poll_sec"), "assistant.poll_sec", 1, 60, 2),
        max_active_per_user=_bounded_int(section.get("max_active_per_user"),
                                         "assistant.max_active_per_user", 1, 10, 3),
        image_enabled=_as_bool(section.get("image_enabled"), "assistant.image_enabled", False),
    )


_ORG_KEYS = {"name", "campus", "other_campuses", "keep_mail_domains"}


def _org_section(raw: dict) -> dict:
    section = raw.get("org", {})
    if not isinstance(section, dict):
        sys.exit("config: [org] は表で指定してください")
    unknown = set(section) - _ORG_KEYS
    if unknown:
        sys.exit(f"config: [org] に未知の項目があります: {', '.join(sorted(unknown))}")
    for key in ("name", "campus", "other_campuses"):
        if not isinstance(section.get(key, ""), str):
            sys.exit(f"config: org.{key} は文字列で指定してください")
    domains = section.get("keep_mail_domains", [])
    if not isinstance(domains, list) or not all(isinstance(d, str) and valid_domain(d) for d in domains):
        sys.exit("config: org.keep_mail_domains は小文字のドメイン名の配列で指定してください")
    return section


# ---- /image(2026-10-14 追加)----

_IMAGE_KEYS = {"enabled", "model", "effort", "font_dir", "work_dir", "render_python",
               "render_timeout_sec", "daily_limit_per_user", "max_concurrent"}
_IMAGE_MODELS = ("opus", "sonnet")


def _image_settings(raw: dict, roots) -> ImageSettings:
    section = raw.get("image", {})
    if not isinstance(section, dict):
        sys.exit("config: [image] の形式が正しくありません")
    unknown = set(section) - _IMAGE_KEYS
    if unknown:
        sys.exit(f"config: [image] に未知の項目があります: {', '.join(sorted(unknown))}")
    if not _as_bool(section.get("enabled"), "image.enabled", False):
        return ImageSettings()
    paths = {}
    for key in ("font_dir", "work_dir"):
        value = section.get(key)
        if not isinstance(value, str) or not value.strip():
            sys.exit(f"config: image.{key} を絶対パスの文字列で指定してください")
        paths[key] = _outside_shared(Path(value.strip()).expanduser(), roots, f"image.{key}")
    model = section.get("model", "opus")
    if model not in _IMAGE_MODELS:
        sys.exit(f"config: image.model は {' / '.join(_IMAGE_MODELS)} のどちらかです(現在: {model!r})")
    render_python = section.get("render_python", "")
    if not isinstance(render_python, str):
        sys.exit("config: image.render_python は python の絶対パスの文字列で指定してください")
    render_python = render_python.strip()
    if render_python and not Path(render_python).expanduser().is_absolute():
        sys.exit("config: image.render_python は絶対パスで指定してください")
    return ImageSettings(
        enabled=True,
        model=model,
        # 既定 low: Pi の実測で opus・low が 27〜31 秒、既定(medium)は 111 秒で 180 秒の上限に近い(2026-10-14)
        effort=_as_effort(section.get("effort", "low"), "image.effort"),
        font_dir=paths["font_dir"],
        work_dir=paths["work_dir"],
        render_python=str(Path(render_python).expanduser()) if render_python else "",
        render_timeout_sec=_bounded_int(section.get("render_timeout_sec"), "image.render_timeout_sec", 5, 300, 60),
        daily_limit_per_user=_bounded_int(section.get("daily_limit_per_user"),
                                          "image.daily_limit_per_user", 1, 200, 20),
        max_concurrent=_bounded_int(section.get("max_concurrent"), "image.max_concurrent", 1, 2, 1),
    )


def load_config(path: str | os.PathLike | None = None) -> Config:
    p = Path(path or os.environ.get("IYAKUSAI_CONFIG") or DEFAULT_CONFIG_PATH)
    if not p.exists():
        sys.exit(
            f"設定ファイルが見つかりません: {p}\n"
            f"src/config.example.toml を {DEFAULT_CONFIG_PATH} にコピーして編集してください。"
        )
    with open(p, "rb") as f:
        raw = tomllib.load(f)

    host = raw.get("host", {})
    paths = raw.get("paths", {})
    lock = raw.get("lock", {})
    reminders = raw.get("reminders", {})

    mode = host.get("mode", "direct")
    if mode not in ("direct", "mirror"):
        sys.exit(f"config: host.mode は direct か mirror です(現在: {mode})")

    data_dir = paths.get("data_dir")
    if not data_dir:
        sys.exit("config: paths.data_dir が未設定です")

    # ホスト名はロック(lock.json)の持ち主識別子。従来のフォールバック os.uname() は
    # POSIX 専用で、COMPUTERNAME が無い Windows(サービスアカウント起動等)では生の
    # AttributeError で落ちていた → platform.node()(クロスプラットフォーム)へ。
    # ただし platform.node() は取得できないとき **空文字を返す** 仕様なので、置き換え
    # だけだと「落ちる」が「黙って host_name='' で起動する」に化ける。空のホスト名は
    # ロックの比較(host != self.host)を無意味にするので、ここで親切に止める(2026-08-12)。
    host_name = host.get("name") or os.environ.get("COMPUTERNAME") or platform.node()
    if not host_name:
        sys.exit('config: host.name が未設定で、ホスト名も自動取得できませんでした。'
                 'config.toml の [host] name に識別名(例: "windows-ws")を書いてください')

    knowledge_dir = paths.get("knowledge_dir")
    ai = raw.get("ai", {})
    kn = raw.get("knowledge", {})
    org = _org_section(raw)
    collect = raw.get("collect", {})
    haiku = raw.get("haiku", {})
    haiku_mode = str(haiku.get("mode", "react"))
    if haiku_mode not in ("react", "reply", "digest", "both"):
        sys.exit(f"config: haiku.mode は react / reply / digest / both です(現在: {haiku_mode})")
    # 俳句の除外CHは、指定が無ければナレッジ検索の機微blocklistをそのまま流用する
    # (転記先は全員が見えるので、遮断範囲は検索と同じかそれより広くしておく)
    haiku_block = haiku.get("blocklist")
    if haiku_block is None:
        from .knowledge_search import DEFAULT_BLOCKLIST, DEFAULT_RAW_BLOCKLIST
        haiku_block = ((kn.get("blocklist") or DEFAULT_BLOCKLIST)
                       + (kn.get("raw_blocklist") or DEFAULT_RAW_BLOCKLIST))
    # 統合アプリ(2026-10-14): ジョブ表・生成物はこれら共有データの外に置く検査に使う
    data_dir_path = Path(data_dir)
    knowledge_path = Path(knowledge_dir) if knowledge_dir else None
    return Config(
        host_name=host_name,   # 上で決定・検証済み(os.uname() からの置き換え)
        mode=mode,
        data_dir=Path(data_dir),
        knowledge_dir=Path(knowledge_dir) if knowledge_dir else None,
        heartbeat_sec=_as_int(lock.get("heartbeat_sec"), "lock.heartbeat_sec", 300),
        takeover_after_sec=_as_int(lock.get("takeover_after_sec"),
                                   "lock.takeover_after_sec", 900),
        reminder_check_sec=_as_int(reminders.get("check_sec"), "reminders.check_sec", 60),
        admin_role_names=list(raw.get("permissions", {}).get("admin_roles", ["役員", "システム課"])),
        ai_provider=ai.get("provider", "claude-cli"),
        ai_model=ai.get("model", "sonnet"),
        ai_heavy_model=ai.get("heavy_model", "opus"),
        ai_auto_route=bool(ai.get("auto_route", True)),
        ai_timeout_sec=_as_int(ai.get("timeout_sec"), "ai.timeout_sec", 180),
        ai_usd_jpy=_as_float(ai.get("usd_jpy"), "ai.usd_jpy", 160.0),
        # bool でも書けるように(true→all / false→off)。それ以外は all/heavy/off の文字列
        ai_agentic=("all" if ai.get("agentic", "all") is True
                    else "off" if ai.get("agentic") is False
                    else str(ai.get("agentic", "all"))),
        ai_agent_model=ai.get("agent_model", "sonnet"),
        ai_agent_max_turns=_as_int(ai.get("agent_max_turns"), "ai.agent_max_turns", 15),
        ai_agent_timeout_sec=_as_int(ai.get("agent_timeout_sec"),
                                     "ai.agent_timeout_sec", 300),
        ai_effort=_as_effort(ai.get("effort"), "ai.effort"),
        ai_agent_effort=_as_effort(ai.get("agent_effort"), "ai.agent_effort"),
        ai_progress=bool(ai.get("progress", True)),
        ai_progress_interval_sec=max(3, _as_int(ai.get("progress_interval_sec"),
                                                "ai.progress_interval_sec", 7)),
        mirror_dir=Path(paths["mirror_dir"]).expanduser() if paths.get("mirror_dir")
                   else Path.home() / ".iyakusai" / "mirror",
        neta_dir=Path(paths["neta_dir"]).expanduser() if paths.get("neta_dir")
                 else Path.home() / ".iyakusai" / "neta",
        contact=str(raw.get("help", {}).get("contact") or CONTACT_DEFAULT),
        mail_address=str(raw.get("mail", {}).get("address") or ""),
        org_name=org.get("name", ""),
        org_campus=org.get("campus", ""),
        org_other_campuses=org.get("other_campuses", ""),
        org_keep_mail_domains=tuple(org.get("keep_mail_domains", [])),
        kn_digest_roots=kn.get("digest_roots"),
        kn_blocklist=kn.get("blocklist"),
        kn_raw_blocklist=kn.get("raw_blocklist"),
        kn_discord_raw=bool(kn.get("discord_raw", True)),
        kn_discord_raw_days=_as_int(kn.get("discord_raw_days"), "knowledge.discord_raw_days", 45),
        kn_vector=bool(kn.get("vector", True)),
        kn_vector_min_score=_as_float(kn.get("vector_min_score"),
                                      "knowledge.vector_min_score", 0.5),
        kn_vector_topk=_as_int(kn.get("vector_topk"), "knowledge.vector_topk", 4),
        collect_enabled=bool(collect.get("enabled", True)),
        collect_interval_min=_as_int(collect.get("interval_min"), "collect.interval_min", 30),
        neta_video=raw.get("neta_video", {"enabled": False}),
        tasks=raw.get("tasks", {"enabled": False}),
        task_screening=raw.get("task_screening", {"enabled": False}),
        assistant=_assistant_settings(raw, roots=(
            data_dir_path, knowledge_path,
            Path(paths["mirror_dir"]).expanduser() if paths.get("mirror_dir")
            else Path.home() / ".iyakusai" / "mirror")),
        image=_image_settings(raw, roots=(
            data_dir_path, knowledge_path,
            Path(paths["mirror_dir"]).expanduser() if paths.get("mirror_dir")
            else Path.home() / ".iyakusai" / "mirror")),
        kiban=raw.get("kiban", {"enabled": False}),
        collect_staleness_threshold=_as_int(collect.get("staleness_threshold"),
                                            "collect.staleness_threshold", 30),
        # チャンネルIDは「未設定・0・空文字なら None(通知しない)」の判定をそのまま残す
        # (ここを _as_int の default 経路に寄せると 0 が 0 のまま通り、挙動が変わる)
        collect_staleness_channel_id=(_as_int(collect["staleness_channel_id"],
                                              "collect.staleness_channel_id", 0)
                                      if collect.get("staleness_channel_id") else None),
        edit_watch_enabled=bool(collect.get("edit_watch", True)),
        haiku_enabled=bool(haiku.get("enabled", False)),
        haiku_mode=haiku_mode,
        haiku_channel_id=(_as_int(haiku["channel_id"], "haiku.channel_id", 0)
                          if haiku.get("channel_id") else None),
        haiku_min_score=_as_int(haiku.get("min_score"), "haiku.min_score", 60),
        haiku_daily_limit=_as_int(haiku.get("daily_limit"), "haiku.daily_limit", 5),
        haiku_allow_hachou=bool(haiku.get("allow_hachou", True)),
        haiku_public_only=bool(haiku.get("public_only", True)),
        haiku_blocklist=list(haiku_block),
    )


def load_token() -> str:
    """Discord Bot トークン。環境変数 DISCORD_TOKEN 優先、次に DISCORD_TOKEN_FILE。

    ファイルは素のトークンでも KEY=VALUE 形式(.env)でもよい
    (既存 collect_discord_v2.py と同じ流儀)。
    """
    tok = os.environ.get("DISCORD_TOKEN")
    if tok:
        return tok.strip()
    fpath = os.environ.get("DISCORD_TOKEN_FILE")
    if not fpath or not Path(fpath).exists():
        sys.exit(
            "Discord トークンがありません。環境変数 DISCORD_TOKEN を設定するか、\n"
            "DISCORD_TOKEN_FILE にトークンファイルのパスを設定してください。"
        )
    text = Path(fpath).read_text(encoding="utf-8-sig").strip()
    if "=" in text:
        for line in text.splitlines():
            if "TOKEN" in line.upper() and "=" in line:
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return text
