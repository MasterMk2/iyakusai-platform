# -*- coding: utf-8 -*-
"""F1 ナレッジ検索の純ロジック(Discord/AI 非依存)。

検索資産(_目録)の使い方は INDEX.md の検索動線に準拠:
  1. aliases.tsv     … 同義語・略語の展開(代表語 \t grep-Eパターン)
  2. keyword_index.tsv … 語 \t 種別 \t 元パス → perdoc 要約(summaries/perdoc/<元パス>.md)
  3. digest 群       … discord/digest, mail/digest, line/digest, プレイブック,
                       カタログ/Google文書目録_*.md をセクション単位で grep
                       (Google文書目録=gdoc/gsheet 等の唯一の検索源 / line=三キャン間の唯一の検索源)
  4. mail raw        … mail/raw/mail_*.jsonl のメール原文(from/件名/本文をgrep)
  5. discord raw     … discord/raw/*.jsonl の直近メッセージ(digest 未反映の最新動向を補完)
  6. vector(意味検索)… fulltext/vector/ を bge-m3 で意味検索(keyword_index が拾えない
                       表記ゆれ・言い換えの文書を補完。Ollama/numpy が無ければ自動スキップ)

機微ガード(要件定義 §3): blocklist に一致するファイルは検索対象から除外する。
メール・Discord の原文はパスワード等らしき行をマスキングして返す。
"""

from __future__ import annotations

import json
import logging
import re
import unicodedata
import urllib.request
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import NamedTuple

from . import org
from .query_fields import JST, QueryFields, parse_fields, strip_author_terms

log = logging.getLogger("iyakusai.knowledge_search")

# 意味検索(ローカル埋め込み)。Ollama/bge-m3 と numpy が無い環境では自動でスキップ。
VECTOR_EMBED_URL = "http://localhost:11434/api/embed"
VECTOR_MODEL = "bge-m3"

# ファイル読み込み(read_text / open)で握りつぶす例外。**UnicodeDecodeError は
# ValueError 系であって OSError には含まれない**ため、従来の `except OSError` だけでは
# 非UTF-8のファイルを1つ踏んだ時点で例外が呼び出し元まで飛び、その語を含む質問が
# 恒常的に無応答になっていた(2026-08-12 レビュー#11。_目録は約6,000ファイルあり、
# 1つ混じれば再現し続ける)。読めないファイルは「無かったこと」にして検索を続ける
# ——1ファイル読めないことより /ask が黙ることの方が重い(_目録/AI作業方針.md §3-4)。
_READ_ERRORS = (OSError, UnicodeDecodeError)


def load_author_aliases(root: Path) -> dict[str, dict[str, str]]:
    """著者→サーバーニックネームの対応表を {"by_id":…, "by_name":…} で返す。
    discord/raw/_authors.json(build_author_aliases.py が生成)を読む。無ければ空。
    改名に強くするため **不変の user_id(by_id)** を優先し、過去ログ(id 未保存)は
    global_name(by_name)でフォールバックする。v1(平坦 {name:nick})も後方互換で読む。
    one-shot(KnowledgeBase)と mirror(エージェント検索の世界)の両方がこれを使う
    =実名統制の単一ソース(2026-07-18、ミラー経由のハンドル漏れの再発防止)。"""
    out: dict[str, dict[str, str]] = {"by_id": {}, "by_name": {}}
    p = root / "discord" / "raw" / "_authors.json"
    if p.exists():
        try:
            data = json.loads(p.read_text(encoding="utf-8-sig"))
        except (json.JSONDecodeError, *_READ_ERRORS):
            data = None
        if isinstance(data, dict) and "people" in data:  # v2
            out["by_id"] = {
                str(uid): str(e.get("nick", ""))
                for uid, e in (data.get("people") or {}).items() if e.get("nick")
            }
            out["by_name"] = {str(k): str(v) for k, v in (data.get("aliases") or {}).items()}
        elif isinstance(data, dict):  # v1 平坦 {name: nick}
            out["by_name"] = {str(k): str(v) for k, v in data.items()}
    return out


def load_role_names(root: Path) -> dict[str, str]:
    """ロールID → ロール名。discord/raw/_roles.json(build_author_aliases.py が生成)。

    本文中の `<@&ID>`(役職メンション。例「@役員」)を名前に戻すために使う。無ければ空。
    """
    p = root / "discord" / "raw" / "_roles.json"
    if not p.exists():
        return {}
    try:
        data = json.loads(p.read_text(encoding="utf-8-sig"))
    except (json.JSONDecodeError, *_READ_ERRORS):
        return {}
    roles = data.get("roles") if isinstance(data, dict) else None
    return {str(k): str(v) for k, v in (roles or {}).items()} if roles else {}


# 本文中のメンション。raw には `<@123…>`(ユーザー)・`<@&123…>`(ロール)が **数値のまま** 残る。
# 解決しないと LLM には「誰に向けた発言か」が見えない(2026-08-09、依頼の向きの取り違えで実害)。
_MENTION_USER_RE = re.compile(r"<@!?(\d+)>")
_MENTION_ROLE_RE = re.compile(r"<@&(\d+)>")


# クエリから拾う語: 漢字連続 / カタカナ連続 / 英数連続(2文字以上)
_TOKEN_RE = re.compile(r"[一-龥々]{2,}|[ァ-ヴー]{2,}|[A-Za-z0-9][A-Za-z0-9_.-]{1,}")
_HEADING_RE = re.compile(r"^#{1,4}\s")

# line/raw のうち、**手動エクスポートではなく自動取り込みで増える**もの(公式LINE は
# Webhook → Cloudflare Worker → Pi が1日4回 pull。2026-09-01 構築)。
# 鮮度注記「LINE は手動エクスポートのスナップショット(最終取込: …)」の根拠から外す:
#   - `line_snapshot_date()` が混ぜて拾うと、公式LINE が毎日更新されるせいで
#     **三キャン LINE の回答に「最終取込: 今日」と出る**=同型の嘘になる。
#   - `is_line_source()` が拾うと、自動で入っている公式LINE の回答に
#     「手動エクスポート」の但し書きが付く。
AUTO_LINE_STEMS = {"公式LINE"}

DEFAULT_DIGEST_ROOTS = [
    "discord/digest",
    "mail/digest",
    # 三キャンパス間の一次連絡は LINE で行われており、見積書の共有・
    # 企画の方針転換・支援課からの指示の伝達は Discord/メール/ドライブに原文が無い。
    # 収集は手動エクスポート(LINE に Bot/API が無い)= スナップショットである点に注意。
    "line/digest",
    "過去アーカイブ運営プレイブック.md",
    # Google ドキュメント(gdoc/gsheet/gform/gslides)は drive 上に実体が無い(214byteの
    # ポインタ)。その中身は Google文書目録_*.md の要約だけが唯一の検索源なので必ず含める。
    # 例: 役職の就任日のような事実は、議事録などの Google文書にしか無いことがある。
    "カタログ/Google文書目録_*.md",
    # 議事録・面談(31件)は Sonnet 要約に集約され、7b の perdoc/keyword_index からは
    # 除外(--exclude 議事録,面談)されている。粒度の細かい決定・論点・担当・TODO は
    # このファイルが唯一の検索源(例: 3キャン制作費の負担・議事録記入者)。
    "fulltext/summaries/議事録_Sonnet.md",
]
# 完全遮断(digest/raw/perdoc すべて検索対象外)= 秘密そのものを扱う源。パスやチャンネル名に含まれる語で判定する。
# 既定は一般的な語だけ。実際のファイル名・チャンネル名は設定([knowledge] blocklist)に書く。
DEFAULT_BLOCKLIST = ["パスワード", "password", "ログイン", "認証情報", "credential", "秘密", "secret", ".env"]
# raw だけ遮断(=生ログは機微を含むが、人手で機微を除いた digest は検索可)な制限チャンネル。
# 既定は一般的な語だけ。実際の非公開チャンネルは設定([knowledge] raw_blocklist)に書く。
DEFAULT_RAW_BLOCKLIST = ["非公開", "private"]

# 「何を知りたいか」ではなく「どう答えてほしいか」を指示する語。raw / mail の原文
# ティアではこれらを採点から外す。
#
# 誤答の例: 「7月20日から今日までにあったことを全部まとめて」で『全部』が
# 採点語になり、`期間あり かつ 採点語なし` で立つはずの keep_zero が False に倒れて
# **約千件の窓から数件しか拾えなかった**。ほぼ同義の「…委員Aがかかわったこと…」は
# 発言者名が除去されて採点語が空になるため全件になり、言い換えで結果が
# 大きく割れていた。
#
# 「一覧」「確認」のように話題語にもなり得る語も入れているが実害は無い: raw/mail の
# 採点から外すだけで、digest・keyword_index・意味検索の各ティアは**変更していない**
# ので、「協賛の確認方法」のような質問はそちらが従来どおり拾う。
INSTRUCTION_STOPWORDS = frozenset({
    "全部", "すべて", "全て", "まとめて", "まとめ", "漏れなく", "もれなく",
    "教えて", "おしえて", "詳しく", "くわしく", "一覧", "整理", "リストアップ",
    "把握", "確認",
})

MAX_EXCERPT_CHARS = 1200
# 2026-08-04: 800 → 1200。名簿・体制表を残すために足した【一覧】欄が、**表示の時点で**
# 切られていた(実測: perdoc 3,227件のうち169件=5.2%が800字超で、その末尾は /ask に出ない)。
# 他ティア(digest 抜粋・原文チャンク)と同じ1,200に揃える。総量は DEFAULT_CONTEXT_BUDGET
# (11,000字)と render_context の貪欲スキップが引き続き抑える。
MAX_PERDOC_CHARS = 1200
# 原文チャンクの抜粋上限(チャンク自体は約1,100字。要約より情報密度が高いので少し広く取る)
MAX_RAW_CHUNK_CHARS = 1200
MAX_MAIL_BODY_CHARS = 2500   # メール原文はやや長めに(「全文ください」対応)
MAX_MAILS = 4
MAX_DISCORD_MSGS = 5             # raw から拾う最新メッセージ数
# 発言者/期間で絞り込めているときだけ枠を広げる。「Aさんが7/20以降にやったこと」は
# 網羅性が答えそのもの(5件では漏れる)だが、条件なしで15件出すと raw が他ティアを
# 押しのけるだけなので、既定の5は据え置く(2026-08-01)。
FILTERED_DISCORD_MSGS = 15
# 条件で絞った Discord raw に、抜粋枠のうち何件を予約するか(search 内で使用)
RESERVED_FILTERED_SLOTS = 5
# 条件該当の本文合計がこれ以下なら、選抜せず全件をモデルに渡す(_search_discord_raw
# の docstring 参照)。実測で「本人×2週間」= 約15,000字なので、3倍弱の余裕を見た値。
# ★不変条件: fulldump_budget + ブロック見出し分 + FULLDUMP_CONTEXT_EXTRA
#   <= MAX_CONTEXT_BUDGET。これを破ると search() の min() で予算が頭打ちになり、
#   全件ブロックが黙って context から落ちる(R8-B1 の再来)。閾値を上げるときは
#   MAX_CONTEXT_BUDGET も一緒に上げること。fulldump_budget はテスト用に
#   インスタンス属性で上書きできる点に注意。
FULLDUMP_BUDGET_CHARS = 45_000
# 全件ブロック1つあたりの上限。1つの巨大 Excerpt にすると render_context の
# 予算判定が「全部載るか全部落ちるか」の二択になるため、日境界で分割する。
FULLDUMP_BLOCK_CHARS = 18_000
# AI に渡すコンテキストの既定予算(従来値)と、全件モード時の上限。
DEFAULT_CONTEXT_BUDGET = 11_000
FULLDUMP_CONTEXT_EXTRA = 6_000    # digest/mail を載せるための上乗せ
MAX_CONTEXT_BUDGET = 60_000
# render_context が1抜粋あたり足す固定文字数(`[出典N: ` + `]` + 改行2つ)の見積り。
# 予算計算でこれを無視すると、ぎりぎりの全件ブロックが最後だけ落ちる。
_RENDER_OVERHEAD_CHARS = 16
MAX_DISCORD_CONTENT_CHARS = 600  # 1メッセージあたり
MAX_REPLY_QUOTE_CHARS = 60       # 返信元の引用(「何に対する発言か」を示すのに足りる長さ)
DEFAULT_DISCORD_RAW_DAYS = 45    # 直近この日数だけを検索対象に(digest 未反映分の補完)

# メール/Discord 本文中の認証情報らしき行はマスクする(平文共有事故の再発防止)
_CREDENTIAL_LINE_RE = re.compile(
    r"(パスワード|password|passwd|初期pw|\bpw\b|ログインid|login\s*id|暗証)\s*[::=に→]",
    re.IGNORECASE,
)

# 認証情報・ワンタイムコードの兆候語。raw の丸ごと不採用(_SENSITIVE_DROP_RES の1本目)と、
# メール原文の本文差し止め(_mail_body_for_answer)の両方から参照する=判定の単一ソース。
# 2026-08-12 に定数へ切り出しただけで、パターン自体は変えていない。
_AUTH_WORD_RE = re.compile(
    r"パスワード|password|passwd|\bpw\b|暗証|初期pw|ログイン(情報|id)"
    r"|ユーザー ?名|アカウント名|ワンタイム|認証コード", re.IGNORECASE)

# Discord raw は人手の機微フィルタ(digest)を迂回するため、"秘密の兆候" がある
# メッセージは行マスクではなく丸ごと不採用にする(区切り無し/キーワード無しの取りこぼし対策)。
# raw は補完層であり、機微を含む案件は digest 側で拾えるので実害は小さい。
_SENSITIVE_DROP_RES = [
    _AUTH_WORD_RE,
    re.compile(r"\d{7,}"),                                  # 口座番号/長いID/区切り無し電話
    re.compile(r"0\d{1,3}[-()\s]\d{2,4}[-()\s]\d{3,4}"),   # 電話(区切りあり)
    re.compile(r"〒?\s?\d{3}-\d{4}"),                       # 郵便番号(=住所)
    re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+"),               # メールアドレス
    # 金融の**文脈語**(口座|振込先|振込|銀行)は機微から外した(設計判断)。
    # 理由: 受取口座は請求書などで外部にも渡している情報であり、委員会アーカイブの
    # 本体はむしろ「金の流れの議論」そのもの。LINE の見積/振込系の2割強が
    # この1行で丸ごと落ちており、見積の共有(他ソースに原文が無い)が
    # 構造的に検索できなくなっていた。
    # 守りは3層で維持する: ①下の \d{7,}(生の口座番号・電話・学籍番号は従来どおり drop)
    # ②_mask_credentials による認証行マスク ③SYSTEM_INSTRUCTIONS の「口座番号は書かない」。
]


# Discord 記法トークン(メンション/カスタム絵文字/タイムスタンプ/メッセージリンク)は
# 17〜19桁の snowflake ID を含み、機微判定の \d{7,} に誤爆する(2026-07-19 実測:
# ロールメンション付きの物品発注依頼がミラーから丸ごと落ち、/ask の進捗まとめから
# 消えた。ロール宛の依頼=アクション指示の典型が構造的に消える穴)。判定前に除去する。
# 除去は判定用のコピーに対してのみで、保存・表示する本文はそのまま。
_DISCORD_TOKEN_RE = re.compile(
    r"<a?:\w+:\d+>"                  # カスタム絵文字 <:name:123> / <a:name:123>
    r"|<[@#][!&]?\d+>"               # ユーザー/ロール/チャンネルのメンション
    r"|<t:\d+(?::[A-Za-z])?>"        # タイムスタンプ <t:123:R>
    r"|https?://(?:\w+\.)?discord(?:app)?\.com/channels/\S+"  # メッセージリンク
)


def _looks_sensitive(text: str) -> bool:
    """機微の兆候(認証情報・口座/電話/住所/メール等)を含むか。含めば raw からは丸ごと落とす。
    Discord 記法トークンは snowflake ID の誤爆を防ぐため判定前に除去する。"""
    t = _DISCORD_TOKEN_RE.sub("", text)
    return any(r.search(t) for r in _SENSITIVE_DROP_RES)


# ---- メール原文(mail/raw)の機微ガード(2026-08-12 追加・レビュー#10)----
# それまで mail raw だけ _mask_credentials(認証行マスク)しか通っておらず、
# Discord/LINE raw が _looks_sensitive で丸ごと不採用にしているのと非対称だった。
#
# **丸ごと不採用は採らない**(選択の理由を残す):
#   ①メールは業務連絡の本体で、署名にほぼ必ずメールアドレスと電話が入る。
#     _looks_sensitive はその両方を drop 条件に持つので、当てると mail ティアが
#     ほぼ全滅する。すると「出典は並ぶのに本文が無い」という壊れ方を、今度は機微ガード側から再生産してしまう。
#   ②エージェント経路のミラー(mirror.py の _transform_mail_line)は既にメールを
#     「認証/OTP の兆候があれば本文ごと除外 + 認証行マスク」で扱っている。one-shot を
#     そこに揃えるのが、経路間で露出を揃えるという既存方針に沿う(同関数のコメントが
#     「one-shot とミラーの露出を揃える」と明記している)。
# → 認証の兆候だけ本文差し止め、それ以外は要件定義§3 が名指しする
#   住所/電話/口座番号を部分マスクで落とす。金額・氏名・企業名は残す
#   (消すと索引としての価値が失われる。mirror.py の _PLAIN_SCRUB と同じ判断)。
# ⚠ パターンは mirror.py の _PLAIN_SCRUB と揃えること(片方だけ強化しない)。
_MAIL_SCRUB = [
    (re.compile(r"\b0\d{1,4}[-‐–−ー]\d{1,4}[-‐–−ー]\d{3,4}\b"), "【電話番号マスク】"),
    # ハイフン無しの直書き(09012345678 / 0764451234)。0始まり10〜11桁に限るので
    # 金額とも学籍番号(12始まり8桁)とも衝突しない。
    (re.compile(r"(?<!\d)0\d{9,10}(?!\d)"), "【電話番号マスク】"),
    (re.compile(r"〒\s*\d{3}[-‐]?\d{4}[^\n【]{0,30}"), "〒【住所マスク】"),
    (re.compile(r"(口座番号|口座|普通預金|当座)([  ::・]*)\d{4,10}"), r"\1\2【口座番号マスク】"),
    (re.compile(r"\b12\d{6}\b"), "【学籍番号マスク】"),
    # ミラーの _OTP_RE 相当(「コード: 123456」)。**ミラーはこれでメールを丸ごと除外する**が、
    # ここは数字だけ伏せる。「商品コード」「発注コード」に当たるので丸ごと除外だと
    # 業務メールの巻き添えが大きく、one-shot は最後の砦=本文を残す側に倒す。
    (re.compile(r"(コード|code|pin|暗証番号)([\s　]*[::]?[\s　]*)\d{4,8}\b", re.IGNORECASE),
     r"\1\2【コードマスク】"),
]
_MAIL_AUTH_HIDDEN = "(認証情報の兆候があるため本文は伏せています。原本はメールで確認してください)"
_MAIL_SUBJECT_HIDDEN = "(認証情報の兆候があるため件名は伏せています)"


def _mail_subject_for_answer(subject: str, body: str) -> str:
    """回答に出す件名。**本文と同じガードを件名にも通す。**

    2026-08-12(第2ラウンド): _mail_body_for_answer は subject を「検知」にしか使わず、
    呼び出し側は `件名: …` と出典ラベル `(メール) 日付 件名` に **原文のまま** 載せていた。
    one-shot は grep 直返し(モデルを介さず Discord に投稿されうる)経路なので、
    件名「【重要】認証コード: 483920」/ 本文「上記コードを入力してください」では
    本文が伏せ字になっても **ワンタイムコードが件名として素通り** していた(実測で再現)。
    ミラー(mirror.py の _transform_mail_line)は同じ条件でメールを丸ごと除外スタブに
    するため、「経路間で露出を揃える」というレビュー#10 の目的が件名だけ破れていた。
    → 認証の兆候があれば件名も伏せる(ミラーと最も揃う)。それ以外は本文と同じ
      _MAIL_SCRUB(住所/電話/口座/学籍/コード)を当てる。**本文ヘッダと出典ラベルの
      両方でこの関数を使うこと**(片方だけだと漏れる)。
    """
    if _AUTH_WORD_RE.search(f"{subject}\n{body}"):
        return _MAIL_SUBJECT_HIDDEN
    out = _mask_credentials(subject)
    for pat, rep in _MAIL_SCRUB:
        out = pat.sub(rep, out)
    return out


def _mail_body_for_answer(subject: str, body: str) -> str:
    """メール原文の本文を回答に載せられる形にする(方針は _MAIL_SCRUB のコメント参照)。"""
    if _AUTH_WORD_RE.search(f"{subject}\n{body}"):
        # 認証情報が本文のどこにどう書かれるか(区切り記号の有無)は当てにできないので、
        # 兆候があれば本文ごと出さない。日付・件名は出典として残す=黙って消さない
        # (_目録/AI作業方針.md §3-4: 切り捨てたことは見えるようにする)。
        # ⚠ この差し止め文が grep 直返しの本文になることはありうる(render_context の
        #   ensure_one が強制採用する最上位1件がこのメールだった場合)。それは承知のうえで
        #   許容する: 空文字ではなく **なぜ出せないか・どこを見ればよいかが読める1行** なので、
        #   レビュー#2 の「本文ゼロを返す経路を無くす」とは両立する(#3 で出典も付く)。
        return _MAIL_AUTH_HIDDEN
    out = _mask_credentials(body)
    for pat, rep in _MAIL_SCRUB:
        out = pat.sub(rep, out)
    return out


# ---- 文書ティア(意味検索の原文チャンク / perdoc 要約)の機微ガード ----
# 2026-08-12(第2ラウンド)追加。**このティアだけマスクを1つも通っていなかった**:
# _search_vectors は fulltext/text/<rel>.txt のチャンクを、_search_keyword_index は
# perdoc 要約を、そのまま Excerpt(text=…) にしていた。one-shot は grep 直返し
# (モデルを介さず Discord に投稿されうる)経路なので、実在の携帯番号が無加工で
# 投稿されうる状態だった(実測: 索引対象 3,753 文書のうち 電話913 / 〒住所404 /
# 外部メール370 / 学籍番号形217 件が該当)。
# 今回作った穴ではないが、①予算1,500→4,000字と ensure_one=True で露出が確実に広がり
# ②隣接するメールティアと意味検索シードにはマスクを入れたため、**同一プロンプト・
# 同一投稿の中でこのティアだけ無防備**という非対称が残っていた(要件定義§3 が名指しする
# 住所・電話がそのまま Discord に出る)。
# ⚠ パターンは mirror.py の _PLAIN_SCRUB / _transform_doc_text と揃えること。
#   **mirror を import してはいけない**(mirror が knowledge_search を import している=循環)。
# 金額・氏名・企業名は残す(消すと索引としての価値が失われる。第1ラウンドの判断を踏襲)。
# 残すメールドメイン(委員会の公開連絡先・大学事務)は mirror と同じ org.mail_mask_re()(設定で決まるので使うときに引く)。
_DOC_SCRUB = [
    (re.compile(r"\b0\d{1,4}[-‐–−ー]\d{1,4}[-‐–−ー]\d{3,4}\b"), "【電話番号マスク】"),
    # 括弧・空白区切り(`TEL(076)000-0001` / `076 000 0001`)。上のハイフン系だけでは
    # 素通りしていた(2026-08-12 実測: 文書ティアの実出力に大学職員の直通 (076)000-0001 と
    # 企業担当者の (076)000-0002 が残存。実データで異なり40番号・700箇所)。
    # これは mirror.py の _PHONE_SUB_RE と同一式で、上の「揃えること」の不変条件を満たす。
    # ※上のハイフン系は Unicode ダッシュ(‐–−ー)も拾うのでこちらでは代替できない=両方要る。
    (re.compile(r"0\d{1,3}[-()\s]\d{2,4}[-()\s]\d{3,4}"), "【電話番号マスク】"),
    (re.compile(r"(?<!\d)0\d{9,10}(?!\d)"), "【電話番号マスク】"),
    (org.mail_mask_re, "【メールマスク】"),
    (re.compile(r"〒\s*\d{3}[-‐]?\d{4}[^\n【]{0,30}"), "〒【住所マスク】"),
    (re.compile(r"(口座番号|口座|普通預金|当座)([  ::・]*)\d{4,10}"), r"\1\2【口座番号マスク】"),
    (re.compile(r"\b12\d{6}\b"), "【学籍番号マスク】"),
]


def _scrub_doc(text: str) -> str:
    """文書原文・要約を回答に載せられる形にする(方針は _DOC_SCRUB のコメント参照)。"""
    out = _mask_credentials(text)
    for pat, rep in _DOC_SCRUB:
        out = (pat() if callable(pat) else pat).sub(rep, out)
    return out


def normalize(s: str) -> str:
    return unicodedata.normalize("NFKC", s).lower()


class RawHit(NamedTuple):
    """discord/raw と line/raw を同じティアで扱うための正規化済みメッセージ。

    ts を index 1 に置いているのは _sample_by_day が h[1] を日付キーに使うため。
    """

    score: int
    ts: str
    kind: str     # "discord" | "line"
    chan: str     # チャンネル/スレッド名、または LINE グループ名
    author: str   # 実名(委員会での表示名)に正規化済み
    body: str     # マスク済み・長さ制限済みの本文
    when: datetime | None = None   # ts をパースした aware datetime(並べ替えの正)
    truncated: bool = False        # 本文が MAX_DISCORD_CONTENT_CHARS で切られたか
    reply: str = ""                # 返信元の要約「→ 誰々「…」への返信」(2026-08-09 追加)


_TS_MIN = datetime(1970, 1, 1, tzinfo=timezone.utc)


def _ts_key(h) -> datetime:
    """並べ替え用の時刻キー。**文字列ではなく datetime で比べる。**

    Discord の ts は UTC(`...Z`)、LINE は JST(`+09:00`)。文字列のまま比べると
    同じ日内で「09:00+09:00 < 10:00Z(=19:00 JST)」のような巻き戻りが起きる
    (2026-08-01 の検証で実測)。読めない ts は素の文字列比較に頼らず最古扱いにする。
    """
    w = getattr(h, "when", None)
    return w or _parse_ts(h[1]) or _TS_MIN


@dataclass
class Excerpt:
    source: str   # 表示用の相対パス(出典)
    text: str
    score: int


@dataclass
class SearchResult:
    terms: list[str]
    excerpts: list[Excerpt] = field(default_factory=list)
    # 質問文から機械抽出した検索条件(発言者・期間)。呼び出し側が利用者に見せる。
    fields: QueryFields = field(default_factory=QueryFields)
    # raw ティアの網羅状況(全件添付か日別間引きか)。空=条件なしの従来経路。
    coverage: str = ""
    # AI に渡すコンテキストの予算。全件モードのときだけ広げる。
    context_budget: int = DEFAULT_CONTEXT_BUDGET
    # LINE 出典を含むときの最終取込日(手動エクスポートのスナップショットである注記用)
    line_snapshot: str = ""


class KnowledgeBase:
    def __init__(
        self,
        knowledge_dir: Path,
        digest_roots: list[str] | None = None,
        blocklist: list[str] | None = None,
        raw_blocklist: list[str] | None = None,
        discord_raw: bool = True,
        discord_raw_days: int = DEFAULT_DISCORD_RAW_DAYS,
        vector: bool = True,
        vector_min_score: float = 0.5,
        vector_topk: int = 4,
        vector_timeout: int = 30,
    ):
        self.root = Path(knowledge_dir)
        self.digest_roots = digest_roots or DEFAULT_DIGEST_ROOTS
        self.blocklist = [normalize(b) for b in (blocklist or DEFAULT_BLOCKLIST)]
        self.raw_blocklist = [normalize(b) for b in (raw_blocklist or DEFAULT_RAW_BLOCKLIST)]
        self.discord_raw = discord_raw
        self.discord_raw_days = discord_raw_days
        self.vector = vector
        self.vector_min_score = vector_min_score
        self.vector_topk = vector_topk
        self.vector_timeout = vector_timeout
        self._aliases: list[list[str]] | None = None
        self._author_aliases: dict[str, str] | None = None  # global_name -> サーバーnick(表示名)
        self._role_names: dict[str, str] | None = None      # ロールID -> ロール名(<@&ID> 解決用)
        self._channel_label_cache: set[str] | None = None
        self._line_members: dict[str, str] | None = None
        # 全件モードの閾値(本文合計の上限)。属性にしてあるのはテストが
        # 「予算超過で間引く側」を 45,000 字のダミーを作らずに検証できるようにするため。
        self.fulldump_budget = FULLDUMP_BUDGET_CHARS
        self._vec_cache = None            # (numpy, matrix, rows, kind)
        self._vec_path = None             # 索引ファイル(再構築の検知用)
        self._vec_mtime = 0.0
        self._vec_snippet_warned = False  # 復元不整合の警告は1回だけ
        self._vec_failed = False          # 一度失敗したら以後スキップ(Ollama/numpy 不在等)
        self._digvec_cache = None         # (numpy, matrix, [section dict...])
        self._digvec_failed = False
        self._digest_stale_logged = False

    # ---------- 読み込み ----------

    def _load_aliases(self) -> list[list[str]]:
        if self._aliases is None:
            self._aliases = []
            p = self.root / "fulltext" / "summaries" / "aliases.tsv"
            if p.exists():
                # 例外ガードが皆無だった(2026-08-12 レビュー#11)。同義語展開は検索を
                # 良くするための補助にすぎないのに、ここで落ちると search() 全体が飛んで
                # /ask が無応答になる。読めなければ展開なしで続行する(結果は劣化するが届く)。
                try:
                    lines = p.read_text(encoding="utf-8-sig").splitlines()
                except _READ_ERRORS as e:
                    log.warning("aliases.tsv を読めません(同義語展開なしで続行): %s", e)
                    lines = []
                for line in lines:
                    if not line.strip() or line.startswith("#"):
                        continue
                    parts = line.split("\t")
                    if len(parts) >= 2:
                        self._aliases.append([normalize(a) for a in parts[1].split("|") if a])
        return self._aliases

    def _load_author_aliases(self) -> dict[str, dict[str, str]]:
        """著者→サーバーニックネームの対応表(モジュール関数 load_author_aliases 参照)。"""
        if self._author_aliases is None:
            self._author_aliases = load_author_aliases(self.root)
        return self._author_aliases

    def _author_display(self, name, author_id=None) -> str:
        """著者を委員会での表示名(サーバーニックネーム)に置換。未登録はそのまま。
        不変の author_id があれば最優先(改名に強い)、無ければ global_name で引く。"""
        a = self._load_author_aliases()
        if author_id and str(author_id) in a["by_id"]:
            return a["by_id"][str(author_id)]
        if not name:
            return "?"
        return a["by_name"].get(name, name)

    def _load_role_names(self) -> dict[str, str]:
        if self._role_names is None:
            self._role_names = load_role_names(self.root)
        return self._role_names

    def _resolve_mentions(self, text: str) -> str:
        """本文中の `<@ID>` / `<@&ID>` を実名・ロール名に戻す。

        raw は数値のまま保存しているため、解決しないと LLM には「誰に向けた発言か」が
        見えない。メンションは「@Xさんこれお願い」という**依頼・割り当て**の文で使われる
        ので、タスク追跡では最も価値の高い行がちょうど宛先不明で渡ることになる
        (解決しないと依頼の向きを取り違える)。
        引けなかったIDはそのまま残す(嘘の名前を作らない)。
        """
        if not text:
            return text
        a = self._load_author_aliases()
        roles = self._load_role_names()
        def _sub(table):
            def f(m):
                nick = table.get(m.group(1))
                return f"@{nick}" if nick else m.group(0)   # 引けなければ原文のまま
            return f

        text = _MENTION_USER_RE.sub(_sub(a["by_id"]), text)
        text = _MENTION_ROLE_RE.sub(_sub(roles), text)
        return text

    def _channel_labels(self) -> set[str]:
        """raw のファイル名から作ったチャンネル/スレッド名ラベル集合(人名誤爆ガード用)。"""
        if self._channel_label_cache is None:
            labels: set[str] = set()
            raw_dir = self.root / "discord" / "raw"
            if raw_dir.is_dir():
                for f in raw_dir.glob("*.jsonl"):
                    if not f.name.startswith("_"):
                        labels |= discord_channel_label_variants(f.name)
            self._channel_label_cache = labels
        return self._channel_label_cache

    def parse_fields(self, query: str, now=None) -> QueryFields:
        """質問文から検索条件(発言者・期間)を機械抽出する。search を回さずに使える薄い入口。
        エージェント経路(Cog)がプロンプトに条件を載せるために単独で呼ぶ。"""
        return parse_fields(query, self._load_author_aliases(), self._channel_labels(), now=now)

    def _blocked(self, path_like: str) -> bool:
        n = normalize(str(path_like))
        return any(b in n for b in self.blocklist)

    def _raw_blocked(self, path_like: str) -> bool:
        """raw 専用の遮断(digest は許可される制限チャンネルの生ログ)。"""
        n = normalize(str(path_like))
        return any(b in n for b in self.raw_blocklist)

    # ---------- クエリ処理 ----------

    def extract_terms(self, query: str) -> list[str]:
        qn = normalize(query)
        terms = {t for t in _TOKEN_RE.findall(qn)}
        for group in self._load_aliases():
            if any(a in qn for a in group):
                terms.update(group)
        # 長い語を優先(短い語のノイズを抑える)。同じ長さの語は辞書順で決める——
        # set の反復順は PYTHONHASHSEED 依存なので、長さだけで並べると同じ質問でも
        # 実行ごとに terms の順序が変わり、before/after 比較が再現しない(2026-08-01)。
        return sorted(terms, key=lambda t: (len(t), t), reverse=True)[:24]

    # ---------- 検索 ----------

    def search(self, query: str, max_excerpts: int = 10,
               use_fields: bool = True) -> SearchResult:
        """資料を検索する。

        use_fields=False は「質問文からの条件抽出(発言者・期間)を使わない」。
        回答フッターで機械解釈を利用者に見せられない経路(/doc の起草)向け。見せられない
        ところで黙って絞ると、誤爆に誰も気づけない沈黙の劣化になる(_目録/AI作業方針.md §3-4)。
        """
        fields = self.parse_fields(query) if use_fields else QueryFields()
        # 日付が条件として解釈できたなら、その表現は「語」ではなく「条件」なので採点から外す。
        # 「7/20」は _TOKEN_RE に「20」だけ残り、digest の「2026」「20分」に当たって
        # 順位を汚していた(「期間が効かない」不具合の残り火)。
        term_src = (fields.cleaned_question
                    if (fields.date_from or fields.date_to) else query)
        terms = self.extract_terms(term_src)
        result = SearchResult(terms=terms, fields=fields)
        # 条件(発言者・期間)が立っていれば語が無くても検索する意味がある
        # (「委員Aが7/20以降にやったこと」は語ではなく WHERE 句が本体)。
        if not terms and not fields.has_conditions():
            return result
        mail_query = bool(re.search(r"メール|mail", normalize(query)))
        digests = self._search_digests(terms)
        kw = self._search_keyword_index(terms)
        mail = self._search_mail_raw(terms, fields, boost=3 if mail_query else 1)
        # digest 未反映の最新動向(Discord raw + 三キャン LINE raw)
        recent, result.coverage, _n_raw, is_fulldump = self._search_discord_raw(terms, fields)
        # 意味検索(keyword が拾えない文書 + digest を言い換え/表記ゆれで補完)。
        # ★ 2026-08-04: **文書と digest を別ティアに分けた**。以前は「どちらも cosine だから」と
        #   1ティアに統合していたが、文書側が原文チャンク索引(vector_raw)になって尺度が変わり、
        #   digest セクションが常に上位を占めて**原文が1件も出ない**状態になった(実測:
        #   「2025年末会計マスターの特別損失」で出典4件が全部カタログ/プレイブックの要約)。
        #   RRF は「ティアごとに順位で融合」する仕組みなので、分けるとそれぞれに枠が回る。
        # ★ 2026-08-04: 原文チャンク索引では **keyword で出た文書を除外しない**。
        #   除外は「意味検索も perdoc 要約を返す」時代の重複対策だったが、いまは
        #   keyword=要約 / 意味検索=原文の一節 と**中身が別物**で、除外すると
        #   「keyword に当たった文書ほど原文が見られない」という逆転が起きる
        #   (実測: 「レンタル物品の発電機の費用」で原文スコア0.718の会計マスターが
        #   出典に1件も出なかった)。字面が同じ抜粋は _dedup_excerpts が畳む。
        vec_docs = self._search_vectors(query, exclude=None if self._raw_mode() else
                                        {e.source for e in kw})
        vec_digest = self._search_digest_vectors(query)
        vec = vec_docs + vec_digest      # メール質問経路(下)は従来どおり合算で扱う
        digests = [e for e in digests if not self._blocked(e.source)]
        kw = [e for e in kw if not self._blocked(e.source)]
        mail = [e for e in mail if not self._blocked(e.source)]
        recent = [e for e in recent if not self._blocked(e.source)]
        vec = [e for e in vec if not self._blocked(e.source)]
        vec_docs = [e for e in vec_docs if not self._blocked(e.source)]
        vec_digest = [e for e in vec_digest if not self._blocked(e.source)]
        # recent は含めない。_search_discord_raw が自前で並べ終えており(通常は
        # score→ts 降順、期間指定時は日別 round-robin)、ここで score で並べ直すと
        # 「山の上位5日の代表」という並びが壊れる。通常経路では既に score 降順なので
        # 除外しても結果は変わらない(安定ソート=恒等変換だった)。
        for lst in (digests, kw, mail, vec, vec_docs, vec_digest):
            lst.sort(key=lambda e: e.score, reverse=True)
        # 条件で絞り込めた Discord raw に枠を予約する。順位融合は「どのティアも同格」の
        # 前提で効くが、WHERE 句で絞ったティアだけは前提が違う——15件すべてが「本人の
        # 期間内の投稿」=答えそのものであり、順位で digest と競わせると digest 1位の
        # 1/21 に必ず負けて3件しか残らない(2026-08-01 実測)。
        # 2026-07-15 のクォータバグ(head が枠を埋め切って mail が常に切られた)の
        # 再発ではない: あれは条件に関係なく固定順で連結していたのが原因。ここでは
        # **条件が立ったときだけ**、**条件が立った1ティアにだけ** 予約を与え、
        # 残枠は従来どおり順位融合に委ねる。条件が無いときは reserved が空=完全に従来経路。
        # 全件モードのブロックは「絞り込みの成果物」そのもの=この経路の存在理由なので、
        # **分岐にかかわらず excerpts の先頭に固定**する。R7 実測(2026-08-01):
        # mail 分岐では reserved が lead+rest の後ろに置かれていたため render_context の
        # 貪欲スキップで丸ごと落ち、「三キャンのやりとり」の回答に LINE が1行も無く
        # 広告メール4通だけが届いた(3/3 再現)。順位融合に委ねてよいのは「候補」であって
        # 「答えそのもの」ではない。
        lead_blocks = recent if is_fulldump else []
        reserved = ([] if is_fulldump
                    else recent[:RESERVED_FILTERED_SLOTS] if fields.has_conditions() else [])
        if mail_query:
            # 「メールを教えて」にメール原文が1件も出ないことがあった(2026-08-01 リプレイ)。
            # digest のセクションスコアは boost 済みメールスコアより高く出るのが普通で、
            # 同一ティアで score 順に並べると head がまるごと digest で埋まるため。
            # メール質問のときはメール原文に保証枠を与える(利用者が明示的に求めた種類の
            # 資料が0件になるのは、順位付けの巧拙以前に答えとして成立していない)。
            lead = mail[:MAX_MAILS]
            head = sorted(digests + kw + mail, key=lambda e: e.score, reverse=True)
            if lead or reserved or lead_blocks:
                rest = [e for e in head if e not in lead]
                room = max(0, max_excerpts - len(lead_blocks) - len(lead) - len(reserved))
                # 全件ブロック → メール保証枠 → digest 残り → 予約枠 の順。
                excerpts = lead_blocks + lead + rest[:room] + reserved + vec + recent
            else:
                excerpts = head + vec + recent
        else:
            # ティア間でスコアの尺度が違う(digest/mail/recent は別基準)ため、順位だけで
            # 融合する(重みなしRRF)。旧実装のティア別クォータ+末尾連結は、head が枠を
            # 埋め切ると mail が常に件数上限で切られるバグだった(2026-07-15 実測)。
            # digest と keyword は旧来どおり同一ティア(同尺度)で混ぜる——keyword を独立
            # ティアにすると候補2件の score=1 が「ティア2位」に化けて上位を食う(実測)。
            non_mail = sorted(digests + kw, key=lambda e: e.score, reverse=True)
            # 文書の原文(vec_docs)と digest 要約(vec_digest)は別ティア。前者を落とすと
            # 「原文にしか書いていない事実」に永久に届かない(2026-08-04)。
            excerpts = lead_blocks + reserved + _rrf_merge(
                [non_mail, vec_docs, vec_digest, recent, mail])
        # 同一セクションが keyword と意味検索で二重に出るのを畳む(本文先頭で判定)。
        # 予約分は先頭にあるので、融合側に出た同じ抜粋はここで自然に落ちる。
        result.excerpts = _dedup_excerpts(excerpts)[:max_excerpts]
        # 全件モードのときだけコンテキスト予算を広げる。**全ブロックが必ず載ること**を
        # 構造的に保証する: 予算 = 全ブロックの実描画サイズ + digest/mail 用の上乗せ。
        # 実描画サイズには render_context が足す「[出典N: <source>]」の見出しと改行も
        # 含める(これを落としていたため、複数ブロック時に最後のブロック=最新側だけが
        # 尾切れした・2026-08-01 の検証で 643件ケースの直近9日が消滅)。
        # 上限 MAX_CONTEXT_BUDGET が効いてブロックが落ちることは無い:
        #   need <= fulldump_budget(45,000) + 見出し分(ブロックは高々4個×約150字)
        #        + FULLDUMP_CONTEXT_EXTRA(6,000) < 60,000
        if is_fulldump and lead_blocks:
            need = sum(len(e.text) + len(e.source) + _RENDER_OVERHEAD_CHARS
                       for e in lead_blocks)
            result.context_budget = min(MAX_CONTEXT_BUDGET,
                                        max(DEFAULT_CONTEXT_BUDGET,
                                            need + FULLDUMP_CONTEXT_EXTRA))
        # LINE は Bot/API が無く手動エクスポートのスナップショット。鮮度を隠さない。
        # **ここでは日付を用意するだけ**で、注記を出すか否かは呼び出し側が
        # 「render_context の実出力に LINE 抜粋が載ったか」で決める。抜粋リストに
        # 在るだけで注記を立てると、予算超過で LINE が落ちた回答にも鮮度注記が付く
        # =同型の嘘になる(2026-08-01 の検証で実測)。
        result.line_snapshot = self.line_snapshot_date()
        return result

    def _search_digests(self, terms: list[str]) -> list[Excerpt]:
        """digest 群を節単位で検索する。

        ⚠ **このティアは意図的に `_scrub_doc` を通していない**(設計判断)。
        塞ぐこと自体は :691 を `text=_scrub_doc(sec_text)` にするだけで足りるが、
        digest には業者・銀行・大学窓口の連絡先が載っており、マスクすると
        「誰に連絡すればよいか」に答えられなくなる。2026-08-01 に金融の文脈語
        (口座/振込/銀行)を機微から外したのと**同じ判断**。
        実測(2026-08-12・digest 66ファイル): 電話1(FAX)/ 外部メール11ファイル /
        学籍番号形1(様式の記入例)/ 〒住所0 / 口座番号0。
        `_search_digest_vectors`(:995)も素材が同一なので同じ扱い。
        変えるなら運用の側で改めて判断すること。
        """
        out: list[Excerpt] = []
        for root in self.digest_roots:
            if any(ch in root for ch in "*?["):        # glob パターン(例: Google文書目録_*.md)
                files = sorted(self.root.glob(root))
            else:
                p = self.root / root
                files = [p] if p.is_file() else sorted(p.glob("*.md")) if p.is_dir() else []
            for f in files:
                if self._blocked(str(f)):
                    continue
                try:
                    text = f.read_text(encoding="utf-8-sig")
                except _READ_ERRORS:
                    continue
                for sec_text, score in self._score_sections(text, terms):
                    rel = f.relative_to(self.root)
                    out.append(Excerpt(source=str(rel), text=sec_text, score=score))
        return out

    def _score_sections(self, text: str, terms: list[str]) -> list[tuple[str, int]]:
        """md を見出しでセクション分割し、語のヒット数で採点。上位のみ返す。"""
        sections: list[list[str]] = [[]]
        for line in text.splitlines():
            if _HEADING_RE.match(line):
                sections.append([line])
            else:
                sections[-1].append(line)
        scored = []
        for lines in sections:
            body = "\n".join(lines).strip()
            if not body:
                continue
            bn = normalize(body)
            score = sum(bn.count(t) for t in terms)
            if score > 0:
                scored.append((body[:MAX_EXCERPT_CHARS], score))
        scored.sort(key=lambda x: x[1], reverse=True)
        return scored[:3]

    def _search_keyword_index(self, terms: list[str]) -> list[Excerpt]:
        idx = self.root / "fulltext" / "summaries" / "keyword_index.tsv"
        if not idx.exists():
            return []
        hits: dict[str, int] = {}
        # read_text と同じ理由で例外を握る(2026-08-12 レビュー#11)。ここは唯一
        # ガードが無い読み込みで、索引が壊れた・非UTF-8になった瞬間に /ask 全体が
        # 無応答化する。途中まで読めた分は活かす(部分結果 > 沈黙)。
        try:
            with open(idx, encoding="utf-8-sig") as f:
                next(f, None)  # ヘッダ
                for line in f:
                    parts = line.rstrip("\n").split("\t")
                    if len(parts) < 3:
                        continue
                    kw = normalize(parts[0])
                    src = parts[2]
                    if any((t in kw) or (len(kw) >= 2 and kw in t) for t in terms):
                        hits[src] = hits.get(src, 0) + 1
        except _READ_ERRORS as e:
            log.warning("keyword_index.tsv の読み込みに失敗(読めた分で続行): %s", e)
        out: list[Excerpt] = []
        # ヒット数上位の文書の perdoc 要約を添付
        for src, n in sorted(hits.items(), key=lambda x: x[1], reverse=True)[:8]:
            if self._blocked(src):
                continue
            pd = self.root / "fulltext" / "summaries" / "perdoc" / (src + ".md")
            if pd.exists():
                try:
                    body = pd.read_text(encoding="utf-8-sig").strip()[:MAX_PERDOC_CHARS]
                except _READ_ERRORS:
                    continue
                # 文書ティアの機微ガード(2026-08-12・第2ラウンド。_DOC_SCRUB 参照)。
                # perdoc は生成側 summarize_local.py の scrub でも落としているが、
                # perdoc を書くのがそのスクリプトだけとは限らないので出口にも網を張る。
                out.append(Excerpt(source=f"(文書) {src}", text=_scrub_doc(body), score=n))
        return out


    # ---------- 意味検索(ローカル埋め込み) ----------

    def _load_vectors(self):
        """(numpy, 行列, rows, kind) を遅延ロード。numpy/索引が無ければ None(以後スキップ)。

        kind="raw"  … `fulltext/vector_raw/`(**原文チャンク**。2026-08-04 新設・優先)
                      rows = [(元パス, chunk_idx, snippet), …]
        kind="perdoc" … 従来の `fulltext/vector/`(要約)。raw が無い環境へのフォールバック。

        なぜ raw を優先するか: 要約索引は「LLMが書いたもの」しか引けず、要約が落とした細部と
        **12,000字を超える文書の後半(要約の入力上限の外)** が構造的に検索不能だった
        (実測: 12,000字超58件のうち索引に載っていたのは全体の5%)。
        """
        from .semantic_index import pointer_signature, read_generation
        try:
            signature = pointer_signature(self.root, "raw")
            if signature is not None:
                if signature != getattr(self, "_raw_generation_signature", None):
                    np, mat, records, manifest = read_generation(self.root, "raw")
                    self._vec_cache = (np, mat, [(r["src"], r["chunk_idx"], r.get("snippet", "")) for r in records], "raw")
                    self._raw_generation_signature = signature
                    self._raw_generation_manifest = manifest
                    self._vec_failed = False
                return self._vec_cache
            if getattr(self, "_raw_generation_signature", None) is not None:
                self._raw_generation_signature = None
                self._raw_generation_manifest = None
                self._vec_cache = None
                self._vec_failed = False
        except Exception:
            log.warning("意味索引の世代読込みに失敗。次の検索で再試行", exc_info=True)
            return None
        if self._vec_failed:
            return None
        if self._vec_cache is not None:
            # ★ 索引ファイルの mtime を見て、再構築されていれば読み直す。
            #   以前は一度読んだら**プロセスが死ぬまで古い行列を使い続けた**ので、
            #   索引を作り直しても Bot を再起動するまで反映されなかった(黙って古い結果を出す)。
            try:
                if (self._vec_path is not None
                        and self._vec_path.stat().st_mtime > self._vec_mtime):
                    log.info("意味検索: 索引が更新されたので読み直します")
                    self._vec_cache = None
                else:
                    return self._vec_cache
            except OSError:
                return self._vec_cache
        try:
            import csv
            import numpy as np
            raw_dir = self.root / "fulltext" / "vector_raw"
            if (raw_dir / "vectors.npy").exists() and (raw_dir / "meta.tsv").exists():
                mat = np.load(raw_dir / "vectors.npy")
                rows: list[tuple[str, int, str]] = []
                with open(raw_dir / "meta.tsv", encoding="utf-8") as f:
                    for m in csv.DictReader(f, delimiter="\t"):
                        rows.append((m["rel_path"], int(m["chunk_idx"]), m.get("snippet", "")))
                if mat.shape[0] != len(rows):
                    raise ValueError(f"vector_raw/meta 件数不一致: {mat.shape[0]} vs {len(rows)}")
                log.info("意味検索: 原文チャンク索引を使用(%s チャンク)", len(rows))
                self._vec_path = raw_dir / "vectors.npy"
                self._vec_mtime = self._vec_path.stat().st_mtime
                self._vec_cache = (np, mat, rows, "raw")
                return self._vec_cache
            vdir = self.root / "fulltext" / "vector"
            mat = np.load(vdir / "vectors.npy")
            rels: list[str] = []
            with open(vdir / "meta.tsv", encoding="utf-8") as f:
                for m in csv.DictReader(f, delimiter="\t"):
                    rels.append(m["元パス"])
            if mat.shape[0] != len(rels):
                raise ValueError(f"vector/meta 件数不一致: {mat.shape[0]} vs {len(rels)}")
            log.info("意味検索: 要約索引を使用(%s 件・vector_raw 未生成)", len(rels))
            self._vec_path = vdir / "vectors.npy"
            self._vec_mtime = self._vec_path.stat().st_mtime
            self._vec_cache = (np, mat, rels, "perdoc")
            return self._vec_cache
        except Exception as e:  # noqa: BLE001  numpy不在/索引欠落/破損はすべて無効化
            log.warning("意味検索を無効化(索引ロード失敗): %s", e)
            self._vec_failed = True
            return None

    def _embed(self, text: str):
        """クエリを bge-m3 で埋め込み、L2 正規化して返す。失敗時 None(fallback)。"""
        try:
            import numpy as np
            payload = json.dumps({"model": VECTOR_MODEL, "input": [text]}).encode("utf-8")
            req = urllib.request.Request(
                VECTOR_EMBED_URL, data=payload, headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=self.vector_timeout) as r:
                v = np.asarray(json.loads(r.read())["embeddings"][0], dtype=np.float32)
            n = np.linalg.norm(v)
            return v / n if n else v
        except Exception as e:  # noqa: BLE001  Ollama 未起動/タイムアウト等
            log.warning("意味検索の埋め込み失敗(fallback): %s", e)
            return None

    def _raw_mode(self) -> bool:
        """意味検索が原文チャンク索引で動いているか(= perdoc 要約ではないか)。"""
        loaded = self._load_vectors()
        return bool(loaded) and loaded[3] == "raw"

    def search_docs_under(self, query: str, prefixes: tuple[str, ...], k: int = 2) -> list[Excerpt]:
        """意味検索(文書)を、指定したフォルダ(rel_path の先頭)の文書だけに絞って k 件返す(2026-10-25 追加)。
        /mail が今年度のフォルダ(例: 2026医薬祭/)の資料を優先するために使う。全体の検索では、
        過去年度の似た文書(価格表の重複コピー等)が上位を占め、今年度の料金表が 17 位に沈んでいた(実測)。
        /ask の検索(search)は変えない。機微の処理(_scrub_doc)・ブロックリストは通常の意味検索と同じ。"""
        if not prefixes:
            return []
        out = self._search_vectors(query, only_prefixes=tuple(prefixes), limit=k)
        return [e for e in out if not self._blocked(e.source)]

    def _search_vectors(self, query: str, exclude: set[str] | None = None,
                        only_prefixes: tuple[str, ...] | None = None, limit: int | None = None) -> list[Excerpt]:
        """意味検索。raw 索引なら**原文チャンクそのもの**を、旧索引なら perdoc 要約を返す。
        keyword_index で既出の文書(exclude)は重複回避のため除く。
        only_prefixes を渡すと、その先頭の文書だけを(閾値以上で)全体から探し、limit 件まで返す。"""
        if not self.vector:
            return []
        loaded = self._load_vectors()
        if loaded is None:
            return []
        np, mat, rows, kind = loaded
        manifest = getattr(self, "_raw_generation_manifest", None) if kind == "raw" else None
        eligible = None
        if manifest is not None:
            from .semantic_index import raw_relations
            try:
                eligible = set(raw_relations(self.root, blocked=manifest["blocked"], expected_ledgers=manifest.get("ledgers", {})))
            except Exception:
                log.warning("原文索引の台帳確認に失敗。今回の意味検索を見送ります", exc_info=True)
                return []
        q = self._embed(query)
        if q is None:
            return []
        sims = mat @ q
        exclude = exclude or set()
        out: list[Excerpt] = []
        seen_rel: set[str] = set()
        want = limit if limit is not None else self.vector_topk
        # 絞り込むときは対象の文書が下位にいるので、閾値までは全体を見る(行列積は済んでいるので安い)
        order = np.argsort(-sims) if only_prefixes else np.argsort(-sims)[: self.vector_topk * 12]
        # raw はチャンク単位なので、同じ文書が上位を占めうる。**1文書1件**に畳んでから返す
        # (畳まないと大きい文書1本で枠が埋まる。vsearch.py と同じ考え方)。
        for i in order:
            score = float(sims[i])
            if score < self.vector_min_score:
                break                       # スコア降順なので以降は全て閾値未満
            if kind == "raw":
                rel, chunk_idx, snippet = rows[int(i)]
            else:
                rel, chunk_idx, snippet = rows[int(i)], -1, ""
            if only_prefixes and not rel.startswith(only_prefixes):
                continue
            if rel in seen_rel:
                continue
            src = f"(文書) {rel}"
            if src in exclude or self._blocked(rel):
                continue
            body = ""
            if kind == "raw":
                body = self._raw_chunk_text(rel, chunk_idx, eligible)
                if manifest is not None and not body:
                    continue
                # ★ 復元は「索引と同じ刻み方で切り直す」方式なので、刻み幅が片方だけ変わると
                #   **黙って別の場所を出典として出す**。索引に持っている先頭80字と突き合わせ、
                #   食い違ったら本文を使わず snippet に退避する(誤った引用より短い引用)。
                head = re.sub(r"[\t\n]", " ", (body or "")[:80]).strip()
                if body and snippet and head != snippet.strip():
                    if not self._vec_snippet_warned:
                        log.warning("原文チャンクの復元が索引と不一致(刻み幅の不整合?): %s #%s",
                                    rel, chunk_idx)
                        self._vec_snippet_warned = True
                    body = snippet
                elif not body:
                    body = snippet
            else:
                pd = self.root / "fulltext" / "summaries" / "perdoc" / (rel + ".md")
                if pd.exists():
                    try:
                        body = pd.read_text(encoding="utf-8-sig").strip()[:MAX_PERDOC_CHARS]
                    except _READ_ERRORS:
                        body = ""
            if not body:
                continue
            # 文書ティアの機微ガード(2026-08-12・第2ラウンド。_DOC_SCRUB 参照)。
            # **snippet 突き合わせより後**でマスクすること: 索引の snippet は原文の
            # 先頭80字なので、先にマスクすると毎回「復元不一致」に倒れて本文が
            # snippet(=原文の先頭80字・無加工)に退避してしまい、逆に悪化する。
            body = _scrub_doc(body)
            seen_rel.add(rel)
            out.append(Excerpt(source=src, text=body, score=score))
            if len(out) >= want:
                break
        return out

    # 原文チャンクの復元。索引に本文を持たせず、**同じ刻み方で切り直して**該当チャンクを取る。
    # ★ 刻み幅は tools/fulltext/build_raw_vector.py と一致させること(ずれると別の場所が出る)。
    _RAW_CHUNK = 1100
    _RAW_OVERLAP = 150

    def _raw_chunk_text(self, rel: str, chunk_idx: int, eligible=None) -> str:
        p = self.root / "fulltext" / "text" / (rel + ".txt")
        try:
            # errors="replace" なので復号では落ちない想定だが、将来その指定を外した
            # ときに黙って /ask を無応答化させないため捕捉幅は他と揃える(#11)。
            manifest = getattr(self, "_raw_generation_manifest", None)
            if manifest is not None:
                from .semantic_index import raw_current_text
                txt = raw_current_text(self.root, rel, manifest, eligible)
                if txt is None:
                    return ""
            else:
                txt = p.read_text(encoding="utf-8", errors="replace")
        except _READ_ERRORS:
            return ""
        lines = txt.split("\n")
        i = 0
        while i < len(lines) and (lines[i].startswith("# ") or not lines[i].strip()):
            i += 1
        body = "\n".join(lines[i:]).strip()
        size, overlap = self._RAW_CHUNK, self._RAW_OVERLAP
        start, n, idx = 0, len(body), 0
        while start < n:
            end = min(start + size, n)
            if end < n:
                nl = body.rfind("\n", start + int(size * 0.5), end)
                if nl > 0:
                    end = nl
            chunk = body[start:end].strip()
            if chunk:
                if idx == chunk_idx:
                    return chunk[:MAX_RAW_CHUNK_CHARS]
                idx += 1
            if end >= n:
                break
            start = max(end - overlap, start + 1)
        return ""

    # ---------- 意味検索(digest セクション) ----------

    def _digest_index_fresh(self) -> bool:
        """digest ベクトル索引が最新か(索引が digest 群より古ければ False=陳腐化)。
        古い索引で「古いセクションを出典として出す」事故を防ぐためのフェイルセーフ。"""
        return not digest_index_stale(self.root, self.digest_roots)

    def _load_digest_vectors(self):
        from .semantic_index import pointer_signature, read_generation
        try:
            signature = pointer_signature(self.root, "digest")
            if signature is not None:
                if signature != getattr(self, "_digest_generation_signature", None):
                    np, mat, sections, _ = read_generation(self.root, "digest")
                    self._digvec_cache = (np, mat, sections)
                    self._digest_generation_signature = signature
                    self._digvec_failed = False
                return self._digvec_cache
            if getattr(self, "_digest_generation_signature", None) is not None:
                self._digest_generation_signature = None
                self._digvec_cache = None
                self._digvec_failed = False
            vdir = self.root / "fulltext" / "vector"
            signature = tuple((vdir / name).stat().st_mtime_ns for name in ["digest_vectors.npy", "digest_sections.jsonl"])
            if signature != getattr(self, "_legacy_digest_signature", None):
                import numpy as np
                mat = np.load(vdir / "digest_vectors.npy", allow_pickle=False)
                sections = [json.loads(line) for line in (vdir / "digest_sections.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
                if mat.shape[0] != len(sections):
                    raise ValueError("digest vector/section count mismatch")
                self._digvec_cache = (np, mat, sections)
                self._legacy_digest_signature = signature
                self._digvec_failed = False
            return self._digvec_cache
        except Exception:
            log.warning("digest意味索引の読込みに失敗。次の検索で再試行", exc_info=True)
            return None

    def _search_digest_vectors(self, query: str) -> list[Excerpt]:
        """digest セクションを意味検索。索引が古ければ keyword にフォールバック(空返し)。"""
        if not self.vector:
            return []
        if not self._digest_index_fresh():
            if not self._digest_stale_logged:
                log.info("digest意味検索を一時停止(索引が古い/未生成 → keyword検索に委ねる)")
                self._digest_stale_logged = True
            return []
        self._digest_stale_logged = False
        loaded = self._load_digest_vectors()
        if loaded is None:
            return []
        np, mat, sections = loaded
        q = self._embed(query)
        if q is None:
            return []
        sims = mat @ q
        out: list[Excerpt] = []
        for i in np.argsort(-sims)[: self.vector_topk * 4]:
            score = float(sims[i])
            if score < self.vector_min_score:
                break
            row = sections[int(i)]
            src = row.get("src", "")
            if self._blocked(src):        # A の遮断方針を query 時にも尊重
                continue
            out.append(Excerpt(source=src, text=row.get("text", "")[:MAX_EXCERPT_CHARS], score=score))
            if len(out) >= self.vector_topk:
                break
        return out

    def _search_mail_raw(self, terms: list[str], fields: QueryFields | None = None,
                         boost: int = 1) -> list[Excerpt]:
        """mail/raw/mail_*.jsonl のメール原文を検索する。

        検索語のスコアリングでは「メール」「全文」のような依頼語を除外し、
        差出人・件名でのヒットを本文ヒットより重く扱う(「◯◯さんからのメール」対応)。

        期間条件があるときは date でフィルタする(フィルタが無いと「7/20以降」の
        質問に半年前のメールが上位で出る)。発言者条件はメールには効かせない——from は
        企業・大学の担当者名義であり _authors.json の実名照合が成立しないため。
        """
        raw_dir = self.root / "mail" / "raw"
        if not raw_dir.is_dir():
            return []
        score_terms = [t for t in terms
                       if t not in ("メール", "mail", "全文", "原文", "内容")
                       and t not in INSTRUCTION_STOPWORDS]
        if not score_terms:
            return []
        fields = fields or QueryFields()
        hits: list[tuple[int, dict]] = []
        for f in sorted(raw_dir.glob("mail_*.jsonl"), reverse=True):  # 新しい月から
            try:
                lines = f.read_text(encoding="utf-8-sig").splitlines()
            except _READ_ERRORS:
                continue
            for line in lines:
                if not line.strip():
                    continue
                try:
                    m = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not _in_range(_parse_ts(m.get("date")), fields):
                    continue
                head = normalize(f"{m.get('from', '')} {m.get('to', '')} {m.get('subject', '')}")
                body = normalize(m.get("body", "") or "")
                score = sum(3 * head.count(t) + min(body.count(t), 5) for t in score_terms)
                if score > 0:
                    hits.append((score, m))
        hits.sort(key=lambda x: x[0], reverse=True)
        out: list[Excerpt] = []
        for score, m in hits[:MAX_MAILS]:
            # 機微ガードは _mail_body_for_answer に集約(認証の兆候は本文差し止め、
            # 住所/電話/口座番号は部分マスク。2026-08-12 レビュー#10)。
            # ⚠ **メールアドレスは意図的にマスクしない**(設計判断)。
            #   ミラー側の `_transform_mail_line` も差出人・宛先・本文中のアドレスを
            #   素通しにしており、**片側だけ強化すると経路間の露出が非対称になる**
            #   (この非対称は繰り返し不具合の元になった)。
            #   直すなら one-shot とミラーを**同時に**変えること。
            raw_subject = str(m.get("subject") or "")
            raw_body = m.get("body", "") or ""
            body = _mail_body_for_answer(raw_subject, raw_body)
            # 件名も同じガードを通す(2026-08-12・第2ラウンド。_mail_subject_for_answer 参照)。
            # **本文ヘッダと出典ラベルの両方に使う**——片方でも原文を載せると
            # 件名に書かれたワンタイムコードが grep 直返しでそのまま Discord に出る。
            subject = _mail_subject_for_answer(raw_subject, raw_body)
            truncated = "\n…(以下省略)" if len(body) > MAX_MAIL_BODY_CHARS else ""
            date = _display_day(m.get("date"))   # 表示は JST に統一(_display_day 参照)
            text = (
                f"日付: {date} / 差出人: {m.get('from', '?')} / 宛先: {m.get('to', '?')}\n"
                f"件名: {subject or '(件名なし)'}\n"
                f"本文:\n{body[:MAX_MAIL_BODY_CHARS]}{truncated}"
            )
            out.append(Excerpt(source=f"(メール) {date} {subject[:30]}",
                               text=text, score=score * boost))
        return out


    def _collect_discord_hits(self, score_terms, fields, keep_zero, window):
        """discord/raw/*.jsonl から条件を満たす投稿を集める(選抜はしない)。

        戻り値は (ヒット, 機微ガードで落とした件数)。落とした件数を返すのは、
        黙って捨てると「その期間には何も無かった」と読まれるため(§3-4)。

        安全策: 機微チャンネルは blocklist で丸ごと除外、本文は認証情報行をマスク、
        Bot 自身の発言は除外(自己参照ノイズ防止)。
        """
        raw_dir = self.root / "discord" / "raw"
        if not raw_dir.is_dir():
            return [], 0
        hits: list[RawHit] = []
        dropped = 0
        for f in raw_dir.glob("*.jsonl"):
            if f.name.startswith("_"):            # _state.json 等
                continue
            if self._blocked(f.name) or self._raw_blocked(f.name):  # 機微/制限チャンネルの生ログは除外
                continue
            chan = _discord_channel_label(f.name)
            try:
                lines = f.read_text(encoding="utf-8-sig").splitlines()
            except _READ_ERRORS:
                continue
            # 返信元(reply_to)を引くための索引。返信はほぼ同じチャンネル/スレッド内に
            # 収まるのでファイル単位で足りる。raw の 13% が返信で、宛先が分からないと
            # 「何に対する発言か」が消える(2026-08-09 追加)。
            parsed: list[dict] = []
            by_msg_id: dict[str, dict] = {}
            for line in lines:
                if not line.strip():
                    continue
                try:
                    m = json.loads(line)
                except json.JSONDecodeError:
                    continue
                parsed.append(m)
                if m.get("id"):
                    by_msg_id[str(m["id"])] = m
            for m in parsed:
                if m.get("bot"):                  # Bot の発言は対象外
                    continue
                content_full = self._resolve_mentions(m.get("content", "") or "")
                ts = m.get("ts") or ""
                if not _in_range(_parse_ts(ts), window):
                    continue
                author = self._author_display(m.get("author"), m.get("author_id"))
                if fields.authors and author not in fields.authors:
                    continue
                score = sum(normalize(content_full).count(t) for t in score_terms)
                if score <= 0 and not keep_zero:
                    continue
                # 機微判定は **条件を満たした行にだけ** 適用する。窓に入っただけの行を
                # 数えると「あなたの条件に当たったのに伏せた件数」より大きくなり、
                # coverage の「N件除外」が実態より重く見える(ある委員についての
                # 質問で、他人の機微まで数えていた)。
                if _looks_sensitive(content_full):  # 機微の兆候があれば丸ごと不採用
                    dropped += 1                    # 落とした事実は coverage で見せる
                    continue
                masked = _mask_credentials(content_full)
                body = masked[:MAX_DISCORD_CONTENT_CHARS]
                reply = ""
                parent = by_msg_id.get(str(m.get("reply_to") or ""))
                if parent:
                    p_author = self._author_display(parent.get("author"),
                                                    parent.get("author_id"))
                    p_body = self._resolve_mentions(
                        _mask_credentials(parent.get("content", "") or ""))
                    p_body = " ".join(p_body.split())[:MAX_REPLY_QUOTE_CHARS]
                    reply = f"→ {p_author}「{p_body}」への返信"
                hits.append(RawHit(score, ts, "discord", chan, author, body,
                                   _parse_ts(ts), len(masked) > len(body), reply))
        return hits, dropped

    def _load_line_members(self) -> dict[str, str]:
        """LINE の表示名 → 実名(nick)の対応表。line/raw/_members.json から作る。

        raw の行にも nick フィールドがあるが、実測で 三キャン委員長=127/268、
        高キャン制作部=90/90 が null。_members.json は変換スクリプトが送信者を
        切り出すための正典なので、そちらを補助に使う。
        """
        if self._line_members is None:
            out: dict[str, str] = {}
            p = self.root / "line" / "raw" / "_members.json"
            try:
                data = json.loads(p.read_text(encoding="utf-8-sig"))
            except (json.JSONDecodeError, *_READ_ERRORS):
                data = {}
            for g in (data.get("groups") or {}).values():
                for disp, info in (g.get("members") or {}).items():
                    nick = (info or {}).get("nick")
                    if nick:
                        out[str(disp)] = str(nick)
            self._line_members = out
        return self._line_members

    def _collect_line_hits(self, score_terms, fields, keep_zero, window):
        """line/raw/*.jsonl(三キャンパス間のLINE)から条件を満たす投稿を集める。

        ほかの 2 キャンパスとのやり取りは Discord にもメールにも
        原文が無く、見積書の共有・企画の方針転換・支援課からの指示はここにしか残らない
        (INDEX.md の検索動線どおり)。one-shot でも digest だけでなく原文を見に行く。

        - `kind == "system"`(招待・参加・アナウンス操作)は活動ではないので除外する。
          残すと「参加しました」だけで日別代表の枠が埋まる。
        - 発言者の正規形は `nick or _members.json の対応 or author`。表示名は
          「若葉花子(はなこ)」のように実名+読みなので、条件の実名とは **部分一致** で
          突き合わせる(完全一致だと本人の発言が1件も当たらない)。
        - 機微ガードは discord raw と同一(_looks_sensitive で丸ごと落とし、本文はマスク)。
        """
        raw_dir = self.root / "line" / "raw"
        if not raw_dir.is_dir():
            return [], 0
        members = self._load_line_members()
        hits: list[RawHit] = []
        dropped = 0
        for f in raw_dir.glob("*.jsonl"):
            if f.name.startswith("_"):            # _members.json 等
                continue
            if self._blocked(f.name) or self._raw_blocked(f.name):
                continue
            group = f.name[:-6] if f.name.endswith(".jsonl") else f.name
            try:
                lines = f.read_text(encoding="utf-8-sig").splitlines()
            except _READ_ERRORS:
                continue
            for line in lines:
                if not line.strip():
                    continue
                try:
                    m = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if str(m.get("kind") or "") == "system":
                    continue
                content_full = m.get("content", "") or ""
                ts = m.get("ts") or ""
                if not _in_range(_parse_ts(ts), window):
                    continue
                raw_author = str(m.get("author") or "")
                author = str(m.get("nick") or members.get(raw_author) or raw_author or "?")
                if fields.authors and not any(
                        a and (a in author or a in raw_author) for a in fields.authors):
                    continue
                score = sum(normalize(content_full).count(t) for t in score_terms)
                if score <= 0 and not keep_zero:
                    continue
                # 機微判定は条件を満たした行にだけ(discord 側と同じ理由)
                if _looks_sensitive(content_full):
                    dropped += 1
                    continue
                masked = _mask_credentials(content_full)
                body = masked[:MAX_DISCORD_CONTENT_CHARS]
                hits.append(RawHit(score, ts, "line", group, author, body,
                                   _parse_ts(ts), len(masked) > len(body)))
        return hits, dropped

    def line_snapshot_date(self) -> str:
        """line/raw の最終取込日(**手動エクスポート分だけ**のスナップショット時点)。

        自動取り込み(AUTO_LINE_STEMS = 公式LINE)は除く。混ぜると、Pi が毎日 pull する
        公式LINE の mtime で「最終取込: 今日」になり、実際には数週間前で止まっている
        三キャン LINE の引用に新鮮さの嘘が付く。
        """
        raw_dir = self.root / "line" / "raw"
        latest = 0.0
        if raw_dir.is_dir():
            for f in raw_dir.glob("*.jsonl"):
                if f.stem in AUTO_LINE_STEMS:
                    continue
                try:
                    latest = max(latest, f.stat().st_mtime)
                except OSError:
                    pass
        if not latest:
            return "不明"
        return datetime.fromtimestamp(latest, timezone.utc).astimezone(JST).date().isoformat()

    def _search_discord_raw(self, terms: list[str], fields: QueryFields | None = None):
        """discord/raw と line/raw を横断して直近メッセージを検索する。

        戻り値は (抜粋, 網羅状況の表示文字列, 条件該当の総件数, 全件モードか)。
        LINE の走査は discord_raw フラグに相乗りしている(raw ティア全体の on/off
        スイッチとして扱う。独立スイッチは需要が無いので作らない)。

        質問から抽出した条件(fields)がある場合はここが WHERE 句として効く:
        - 発言者指定があるときは **語ヒット0でも候補に残す**。「Aさんが期間中にやったこと」
          への答えは本人の投稿そのものであり、語で採点しても本人投稿は自分の名前も
          テーマ語も含まないことが多く、score>0 を要求すると全滅する。
        - 期間指定があるときは既定の45日窓ではなく指定レンジの両端で絞る。片側(45日)の
          ままだと「5月の話」が黙って0件になるため、明示指定は既定窓を置き換える。
          **「〜まで」(date_to だけ)でも既定窓は外す**——外さないと「5月までの話」が
          「直近45日 かつ 5月まで」=空集合になり、宣言と裏腹に必ず0件になる。

        **15件の選抜は「採点が曖昧で全体から拾う」時代の遺物**である。フィールド条件で
        正確に絞れる今、絞った結果セットは丸ごと渡せる大きさになった(実測で、
        委員1人の2週間分の投稿は約200件・本文合計 1万5千字程度)。「漏れなくまとめて」に
        対する正しい答えは全件を読んで書くことなので、予算に収まるなら全件を渡す。
        収まらないときだけ間引き、**間引いた事実を必ず表示する**(§3-4: 黙った切り捨ての禁止)。
        """
        if not self.discord_raw:
            return [], "", 0, False
        fields = fields or QueryFields()
        score_terms = [t for t in terms
                       if t not in ("discord", "ディスコード", "チャンネル", "line", "ライン")
                       and t not in INSTRUCTION_STOPWORDS]
        # 本人の投稿に本人の名前は出ない。author で絞るなら名前は採点軸として無意味
        # (残すと「自分の名前を書いた投稿」だけが上位に来る)。他ティアでは残す。
        score_terms = strip_author_terms(score_terms, fields.authors,
                                         self._load_author_aliases())
        if not score_terms and not fields.has_conditions():
            return [], "", 0, False
        has_range = bool(fields.date_from or fields.date_to)
        # 語ヒット0の投稿を候補に入れてよい条件。
        #  - 発言者指定あり: 「Aさんがやったこと」は本人の投稿そのものが答え。
        #  - 期間指定あり かつ 採点語なし: 「先週あったことをまとめて」は語が1つも無く、
        #    score>0 を要求すると構造的に必ず0件になる(2026-08-01 のリプレイで実証)。
        # 逆に「6/1〜7/31の発電機」のように語が効く期間質問では score=0 を入れない
        # ——関連度の低い投稿が日別代表として上位を占めてしまうため。
        keep_zero = bool(fields.authors) or (has_range and not score_terms)
        # 期間の明示があればそちらを使う(45日窓は「最近」を補完するための既定にすぎない)
        window = (QueryFields(date_from=fields.date_from, date_to=fields.date_to)
                  if has_range else QueryFields(
                      date_from=datetime.now(timezone.utc)
                      - timedelta(days=self.discord_raw_days)))
        d_hits, d_drop = self._collect_discord_hits(score_terms, fields, keep_zero, window)
        l_hits, l_drop = self._collect_line_hits(score_terms, fields, keep_zero, window)
        hits = d_hits + l_hits
        # 機微ガードで落ちた件数。黙って捨てると「その期間には何も無かった」と読まれる
        # ので、条件が立っているときは coverage に出す(§3-4)。drop の基準自体は変えない。
        guard = f"(機微ガードで{d_drop + l_drop}件除外)" if (d_drop + l_drop) else ""
        total = len(hits)
        if not hits:
            return [], (f"対象: 条件該当 0件{guard}" if fields.has_conditions() and guard
                        else ""), 0, False

        # ---- 全件モード(条件が立っていて、予算に収まるとき) ----
        # 予算は **組み立て後の実サイズ** で測る。本文の合計だけで判定すると、1件あたり
        # 約50字ある行頭(時刻・チャンネル・発言者)が勘定に入らず、実測で936件のとき
        # 本文45,000字以内でも出力は55,852字になり、digest/mail の枠を食い潰した
        # (2026-08-01 リプレイ)。組み立ては安いので、作ってから測って捨てる。
        volume = 0
        if fields.has_conditions():
            blocks = _build_fulldump(hits, fields)
            volume = sum(len(b.text) for b in blocks)
            if volume <= self.fulldump_budget:
                return blocks, f"対象: 条件該当 {total}件を全件添付{guard}", total, True

        # ---- 従来の選抜(予算超過 or 条件なし) ----
        limit = FILTERED_DISCORD_MSGS if fields.has_conditions() else MAX_DISCORD_MSGS
        # 2部構成の選抜。①語が当たった投稿は関連度(score→ts)で先に取る=質問に
        # 答えている投稿を落とさない。②語ヒット0は「期間の要約」の材料なので、
        # 期間指定があるときだけ日別 round-robin で残枠を埋める。
        # 単純に全件を日別 round-robin にすると、語が効く期間質問(「6/1〜7/31の発電機」)で
        # 関連度の高い投稿が日別代表に押しのけられる(2026-08-01 のレビュー指摘)。
        scored = [h for h in hits if h[0] > 0]
        zeros = [h for h in hits if h[0] <= 0]
        scored.sort(key=lambda x: (x[0], _ts_key(x)), reverse=True)
        picked = scored[:limit]
        if len(picked) < limit and zeros:
            room = limit - len(picked)
            if has_range:
                # 期間を明示された質問は「その期間の要約」が欲しいのであって「期間の末尾」が
                # 欲しいのではない。新しい順に15件だと、**窓が静かな末尾に張り付いて
                # 期間の前半にある投稿の山を丸ごと落とす**。日別に散らして山の代表を必ず拾う。
                picked += _sample_by_day(zeros, room)
            else:
                zeros.sort(key=_ts_key, reverse=True)          # 従来どおり新しい順
                picked += zeros[:room]
        picked = picked[:limit]
        coverage = ""
        if fields.has_conditions():
            # 「N件添付した」と読める書き方は誇張になる——選抜した15件のうち、実際に
            # 文脈へ載るのは順位融合を抜けた分だけ(予約枠5件+残枠)。候補選抜と
            # 文脈搭載を言い分ける(2026-08-01 の検証指摘)。
            coverage = (f"対象: 条件該当 {total}件中 最大{len(picked)}件を候補選抜"
                        f"(全件は{volume:,}字で予算超過のため日別間引き"
                        f"/文脈搭載は融合結果による){guard}"
                        if len(picked) < total
                        else f"対象: 条件該当 {total}件を全件添付{guard}")
        return [_raw_excerpt(h) for h in picked], coverage, total, False


def _discord_channel_label(fname: str) -> str:
    """raw ファイル名 → 表示用のチャンネル/スレッド名。
    <channel>__<id>.jsonl / <parent>__スレッド_<name>__<id>.jsonl の両形式に対応。"""
    stem = fname[:-6] if fname.endswith(".jsonl") else fname
    parts = stem.split("__")
    label = parts[0]
    for p in parts[1:]:
        if p.startswith("スレッド_"):
            label = f"{parts[0]} > {p[len('スレッド_'):]}"
    return label


_BRACKET_PREFIX_RE = re.compile(r"^[【\[(（][^】\])）]*[】\])）]")


def discord_channel_label_variants(fname: str) -> set[str]:
    """raw ファイル名 → 人名照合の誤爆ガードに使うラベル候補の集合。

    表示用ラベル(親 > スレッド)だけでは足りない。例えば
    「運営プロジェクト__スレッド_【催促用】委員Aのタスク」があると、質問「#委員Aのタスクのまとめ」
    から消したいのは結合ラベルではなく **スレッド名の部品**(「【催促用】委員Aのタスク」と、
    先頭の【】を落とした「委員Aのタスク」)だから。親名・部品も含めて返す。
    """
    stem = fname[:-6] if fname.endswith(".jsonl") else fname
    parts = stem.split("__")
    out = {parts[0], _discord_channel_label(fname)}
    for p in parts[1:]:
        if p.startswith("スレッド_"):
            name = p[len("スレッド_"):]
            out.add(name)
            out.add(_BRACKET_PREFIX_RE.sub("", name).strip())
    return {v for v in out if v}


def is_line_source(source: str) -> bool:
    """その出典が三キャンパス LINE 由来か(raw の抜粋・全件ブロック・line/digest)。

    鮮度注記(手動エクスポートのスナップショット)を出すかの判定に使う。
    digest だけが出典のときも LINE の鮮度は同じ制約を受けるので含める。

    **自動取り込み(AUTO_LINE_STEMS = 公式LINE)は False。** あれは Pi が1日4回
    pull していて「手動で書き出すまで止まる」制約を受けないので、
    手動スナップショットの但し書きを付けると逆に誤解させる。
    ただし "Discord+LINE" の全件ブロックは中身が混ざり得るので従来どおり True。
    """
    s = str(source).replace("\\", "/")
    if not (s.startswith("(LINE ") or "Discord+LINE" in s
            or s.startswith("line/") or "/line/" in s):
        return False
    return not any(f"(LINE {stem})" in s or f"/{stem}." in s for stem in AUTO_LINE_STEMS)


def _raw_excerpt(h: RawHit) -> Excerpt:
    """選抜された1件を表示用の Excerpt にする。Discord の書式は従来のまま。"""
    day = _display_day(h.ts)
    if h.kind == "line":
        return Excerpt(source=f"(LINE {h.chan}) {day}",
                       text=f"LINE {h.chan} / {day} / {h.author}:\n{h.body}",
                       score=h.score)
    head = f"#{h.chan} / {day} / {h.author}"
    if h.reply:                       # 「何に対する発言か」(2026-08-09 追加)
        head += f" {h.reply}"
    return Excerpt(source=f"(Discord #{h.chan}) {day}",
                   text=f"{head}:\n{h.body}", score=h.score)


def _jst_time(ts) -> str:
    dt = _parse_ts(ts)
    return dt.astimezone(JST).strftime("%H:%M") if dt else "--:--"


def _build_fulldump(hits: list[RawHit], fields: QueryFields) -> list[Excerpt]:
    """条件該当の全件を、時系列(ts 昇順)・日付見出し付きのブロックにまとめる。

    個別 Excerpt にすると出典リストが数百行になって回答が読めなくなるので、
    **1つ(必要ならサイズで数個)の論理 Excerpt** にし、出典は集約ラベルで示す。
    日付見出し(`## 2026-07-24 (61件)`)を入れるのは、モデルが「どの日を書き漏らしたか」
    に自分で気づけるようにするため——日付が地の文に埋もれていると漏れても分からない。
    """
    # 並べ替えは **datetime** で行う。Discord(UTC)と LINE(+09:00)が混ざると
    # 文字列比較では同じ日の中で時刻が巻き戻る(_ts_key 参照)。ts が読めない行は
    # 時系列に置きようがないので末尾へ回す。
    rows = sorted(hits, key=lambda h: (h.when is None, _ts_key(h), h.chan))
    groups: dict[str, list[RawHit]] = {}
    for h in rows:
        d = _jst_day(h.ts)
        groups.setdefault(d.isoformat() if d else "日付不明", []).append(h)

    srcs = {h.kind for h in hits}
    src_label = "+".join(n for k, n in (("discord", "Discord"), ("line", "LINE")) if k in srcs)
    nch = len({(h.kind, h.chan) for h in hits})
    days = sorted(groups)
    who = ("・".join(sorted(fields.authors)) + "の投稿") if fields.authors else "全員の投稿"
    # span は「日付が読めた日」だけで作る。不明日を混ぜると sorted で末尾に来て
    # 「07-20〜」のような尻切れラベルになる(2026-08-01 の検証指摘)。
    dated = [d for d in days if d != "日付不明"]
    span = f"{dated[0][5:]}〜{dated[-1][5:]}" if dated else "日付不明"
    unknown = len(groups.get("日付不明", []))
    if unknown:
        span += f"(ほか日付不明 {unknown}件)"
    # 600字で切った長文があるなら黙らない——「件数は全件・内容も無傷」と読まれる。
    cut = sum(1 for h in hits if h.truncated)
    cut_note = f"・うち長文{cut}件は{MAX_DISCORD_CONTENT_CHARS}字で省略" if cut else ""

    blocks: list[list[str]] = [[]]
    size = 0
    for d in days:
        chunk = [f"## {d} ({len(groups[d])}件)"]
        for h in groups[d]:
            where = f"#{h.chan}" if h.kind == "discord" else f"LINE {h.chan}"
            rep = f" {h.reply}" if h.reply else ""
            chunk.append(f"- {_jst_time(h.ts)} {where} {h.author}{rep}: {h.body}")
        text = "\n".join(chunk)
        if size and size + len(text) > FULLDUMP_BLOCK_CHARS:
            blocks.append([])
            size = 0
        blocks[-1].append(text)
        size += len(text)

    out: list[Excerpt] = []
    filled = [b for b in blocks if b]
    n = len(filled)
    for i, b in enumerate(filled, 1):
        part = f" {i}/{n}" if n > 1 else ""
        head = (f"# 条件該当の全件 {len(hits)}件{cut_note}\n" if i == 1 and cut_note else "")
        out.append(Excerpt(
            source=f"({src_label} {nch}ch / {span} / {who} {len(hits)}件・全件{cut_note}{part})",
            text=head + "\n".join(b),
            # 全件ブロックは「絞り込みの成果物」であって語スコアの比較対象ではない。
            # 融合では先頭に固定されるため、ここでのスコアは順位に効かない。
            score=0))
    return out


def _jst_day(ts) -> date | None:
    """ISO8601 の ts を JST の暦日にする。読めなければ None(独立バケットに落ちる)。"""
    dt = _parse_ts(ts)
    return dt.astimezone(JST).date() if dt else None


def _display_day(ts) -> str:
    """出典ラベル・本文に出す日付(JST の暦日)。読めなければ元の先頭10文字。

    raw の ts は UTC なので、素の `ts[:10]` は 15:00Z 以降の投稿で1日前にずれる
    (2026-08-01 の実測で Discord 抜粋の 17.8% がずれ、AI が誤った日付を回答に書いた)。
    委員の感覚も質問文の日付も JST なので、表示は JST に統一する。
    """
    d = _jst_day(ts)
    return d.isoformat() if d else str(ts or "")[:10]


def _sample_by_day(hits: list, limit: int) -> list:
    """日別バケットの round-robin で選ぶ(期間を明示された質問の選抜)。

    日の順序は **投稿数の多い日から**(同数なら新しい日から)。「働いた山から1日1件ずつ
    拾う」ことで、融合の予約枠(先頭5件)が「上位5日の代表1件ずつ」になり、期間の要約
    として読めるようになる。単純な新しい順だと静かな末尾の数日で枠を使い切る。

    日の中の優先度は score 降順 → ts 降順(語ヒットのある投稿はその日の代表になる)。
    ts が読めない行(fail-open で残した行)は None バケットにまとめ、同数なら最後に回す。
    """
    buckets: dict[date | None, list] = {}
    for h in hits:
        buckets.setdefault(_jst_day(h[1]), []).append(h)
    for rows in buckets.values():
        rows.sort(key=lambda x: (x[0], _ts_key(x)), reverse=True)
    order = sorted(buckets, key=lambda d: (len(buckets[d]), d or date.min), reverse=True)
    out: list = []
    i = 0
    while len(out) < limit:
        added = False
        for d in order:
            if i < len(buckets[d]):
                out.append(buckets[d][i])
                added = True
                if len(out) >= limit:
                    break
        if not added:              # 全バケットを配り切った
            break
        i += 1
    return out


def _parse_ts(value) -> datetime | None:
    """ISO8601(...Z / +00:00 / 小数秒つき)を aware UTC にする。読めなければ None。
    Discord raw の ts と mail raw の date(実測 "2026-07-09T08:39:21.000Z")の両方に使う。"""
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value).strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _in_range(ts: datetime | None, fields: QueryFields) -> bool:
    """期間条件を満たすか。**ts が読めない行(None)は通す**(fail-open)。
    日付が壊れている・欠けている行を落とすと、期間指定のたびに静かに資料が消える。"""
    if ts is None:
        return True
    if fields.date_from and ts < fields.date_from:
        return False
    if fields.date_to and ts > fields.date_to:
        return False
    return True


def digest_index_stale(root: Path, digest_roots: list[str]) -> bool:
    """digest ベクトル索引(digest_vectors.npy)が digest 群より古い/未生成なら True。
    knowledge_search(query側フェイルセーフ)と collector(自動再構築の判定)で共用。"""
    from .semantic_index import digest_current
    if (root / "fulltext" / "vector" / "current.json").is_file():
        return not digest_current(root, digest_roots)
    npy = root / "fulltext" / "vector" / "digest_vectors.npy"
    if not npy.exists():
        return True
    try:
        idx_mtime = npy.stat().st_mtime
    except OSError:
        return True
    latest = 0.0
    for r in digest_roots:
        if any(ch in r for ch in "*?["):
            files = root.glob(r)
        else:
            p = root / r
            files = [p] if p.is_file() else (p.glob("*.md") if p.is_dir() else [])
        for f in files:
            try:
                latest = max(latest, f.stat().st_mtime)
            except OSError:
                pass
    return idx_mtime < latest


def _dedup_key(text: str) -> str:
    """重複判定のキー。**先頭100字 + 末尾100字** で見る。

    先頭だけだと、書式の決まったヘッダを持つ抜粋が別内容でも同一と判定される。
    実測(2026-08-01): メール抜粋の 39.7% は「日付/差出人/宛先/件名」だけで100字を
    超えており、同じ相手との別件メールが1件に潰れていた。
    """
    n = normalize(text.strip())
    return f"{n[:100]}|{n[-100:]}"


def _rrf_merge(tiers: list[list[Excerpt]], k: int = 20) -> list[Excerpt]:
    """複数ティアを順位だけで融合する(重みなし Reciprocal Rank Fusion)。

    - ティア内の重複(月次digestに同文が2回等)は順位を進めずスキップする。
      これを怠ると重複の多い文書が「複数ティア一致」と同じゲタを履く(2026-07-15 実測)。
    - 複数ティアに同じ抜粋が出た場合は加点=多ソース一致は上がる(RRFの狙い通り)。
    - k は小さいほど各ティアの上位が強くなるが、候補の少ないティアの下位が
      過大評価される(k=60 で「候補2件のティアの2位」が本命を抜く実測)。k=20 は妥協点。
    """
    fused: dict[str, list] = {}
    for tier in tiers:
        seen: set[str] = set()
        rank = 0
        for e in tier:
            key = _dedup_key(e.text)
            if key in seen:
                continue
            seen.add(key)
            rank += 1
            item = fused.setdefault(key, [0.0, e])
            item[0] += 1.0 / (k + rank)
    return [it[1] for it in sorted(fused.values(), key=lambda x: x[0], reverse=True)]


def _dedup_excerpts(excerpts: list[Excerpt]) -> list[Excerpt]:
    """本文先頭が同じ抜粋を1つに畳む(keyword digest と digest意味検索の重複対策)。"""
    seen: set[str] = set()
    out: list[Excerpt] = []
    for e in excerpts:
        key = _dedup_key(e.text)
        if key in seen:
            continue
        seen.add(key)
        out.append(e)
    return out


def _mask_credentials(text: str) -> str:
    return "\n".join(
        "【認証情報らしき行のため省略】" if _CREDENTIAL_LINE_RE.search(ln) else ln
        for ln in text.splitlines()
    )


_RENDER_TRUNC_MARK = "\n…(長いため以下省略。原本は出典を参照)"


def render_context(excerpts: list[Excerpt], budget_chars: int = 11000,
                   ensure_one: bool = False) -> str:
    """AI に渡す(またはgrep直返しする)コンテキスト文字列を組み立てる。

    予算に収まらない抜粋はスキップして次を試す(break だと長いメール原文1件で
    以降が全滅する)。出典番号は excerpts の並び順のまま=飛び番になり得るが、
    呼び出し側の出典表示は「context に出た番号」で突き合わせるので問題ない。

    ensure_one=True のときだけ、**1件も載らなかった場合に最上位1件を予算を無視して
    (末尾を切り詰めて)必ず載せる**。既定(False)の挙動は従来どおりで、AI に渡す
    本経路は予算を厳守する(予算は claude CLI の入力サイズを守るためのもの)。
    2026-08-12 追加(レビュー#2): grep 直返しは劣化ラダーの最後の砦であり、ここが
    空文字を返すと利用者には **出典だけ並んで本文が無い回答** が届く。2026-08-04 に
    会計課が「物品費用」で受け取ったのがこれで、当時の予算1,500字に対しメール抜粋は
    本文2,500字(MAX_MAIL_BODY_CHARS)+ヘッダのため1件も収まらず全スキップだった。
    **利用者に本文ゼロを返す経路を無くす**のがこのフラグの目的。
    """
    parts, used = [], 0
    for i, e in enumerate(excerpts, 1):
        block = f"[出典{i}: {e.source}]\n{e.text}\n"
        if used + len(block) > budget_chars:
            continue
        parts.append(block)
        used += len(block)
    if ensure_one and not parts and excerpts:
        e = excerpts[0]
        head = f"[出典1: {e.source}]\n"
        # 見出しだけで予算を食い切る異常系(source が異様に長い)でも本文が残るよう下限を置く。
        room = max(budget_chars - len(head) - len(_RENDER_TRUNC_MARK), 200)
        text = e.text if len(e.text) <= room else e.text[:room] + _RENDER_TRUNC_MARK
        parts.append(f"{head}{text}\n")
    return "\n".join(parts)
