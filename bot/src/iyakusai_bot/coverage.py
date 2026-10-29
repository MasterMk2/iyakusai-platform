# -*- coding: utf-8 -*-
"""棚卸し質問で「読む面」をホスト側が決定的に埋める(カバレッジの床)。

出発点は次の誤答。「各部署でやるべきことを教えて。」に対し、エージェントは
**持ち時間の2〜4割で打ち切って** 規程や研修資料を読み、**職掌(役割分担)の説明**を返した。
このとき開かなかったものは全部ミラーの中に在った:

  - `discord/digest/役員会.md`
  - 6課の digest(会計課/システム課/会場課/企画課/渉外課/広報課)
  - `discord/actions_recent.md`

しかも digest の **38/43 本には `## 宿題・未完了タスク` セクションがある**。質問の答えは
ミラー内に節見出し付きで置いてあったのに、1本も開かれなかった。

**掟を足すのでは直らない**、と判断した根拠: 直前の「やらないといけないことを
列挙して」では `discord/actions_recent.md` を**1手目で Read している**。同じ掟・同じミラー・
同じ起動設定で、守られた回と守られなかった回がある。つまり律速は「指示が無いこと」ではない。
mirror.py 冒頭の方針(**境界はプロンプトではなく構造で保証する**)と、SUBJECT_GUARD の
コメント(「常設文は長い掟の中の1行にすぎず**実測では効かなかった**」)に合わせ、
**読むかどうかをエージェントの裁量から外す**。

やり方は fields_note(発言者・期間)/ seed_note(意味検索の種)と同じ、ホスト側の前処理。
全文は載せない——10本で 276KB あり、Q2 の入力 133.6k tok を軽く超えて本体が動かなくなる。
`## 宿題・未完了タスク` の節だけを抜くと **合計 21,800 字**(2026-08-23 実測)に収まる。

★これは**床であって天井ではない**。ここに載せた節は digest の要約であり、
  ①節に入っていない新しい依頼(直近72hは actions_recent が拾う)②完了済みなのに節に
  残っている行、の両方があり得る。プロンプト側(ai_provider.INVENTORY_GUARD)で
  「これで打ち切るな・最終言及日を確かめろ」を必ず併せて差すこと。
"""

from __future__ import annotations

import logging
import re
from pathlib import Path

log = logging.getLogger("iyakusai.coverage")

# 3部6課 + 役員会。**スレッド digest(スレッド_*.md)は入れない**: 個人TODO一覧の形を
# しているのは実質個人名入りの催促スレッドだけで、床に混ぜると主語なしの質問がまたそこへ寄る
# (別の委員の課題一覧を質問者の分として返す誤答と同型)。個人の分はエージェントが必要に応じて
# 自分で読めばよく、誰の分かの明示は SUBJECT_GUARD が担当する。
ORG_DIGESTS: tuple[str, ...] = (
    "役員会",
    "総務部", "内務部", "外務部",
    "会計課", "システム課", "会場課", "企画課", "渉外課", "広報課",
)

# digest の節見出し。build_digest 側の書式が変わったら 0 件になるので、
# そのときは黙って床が消えないよう WARNING を出す(下の build_coverage_note 参照)。
SECTION_TITLE = "宿題・未完了タスク"

# mirror.build_actions_index が書き出す機械抽出の一覧(ミラー内でのみ生成)。
ACTIONS_REL = "discord/actions_recent.md"

# 1本あたり / 全体の上限。digest が異常に膨らんでもプロンプトを壊さないための頭打ち。
# 2026-08-23 実測の実値は 役員会 4,590 / 渉外課 4,112 / 総務部 406 字、合計 21,800 字。
PER_FILE_CHARS = 6000
TOTAL_CHARS = 32000
ACTIONS_CHARS = 8000

_TRUNC = "\n…(以下省略。全文は該当ファイルを Read すること)"


def _extract_section(text: str, title: str) -> str:
    """`## <title>` から次の `## ` 直前までを返す。見つからなければ ""。

    見出しは `## 宿題・未完了タスク` 固定だが、将来 `(8/19時点)` のような注記が
    付いても拾えるよう行末までを許す。`##` より深い見出し(`###`)は節の中身として残す。
    """
    m = re.search(r"^## " + re.escape(title) + r"[^\n]*\n(.*?)(?=^## |\Z)",
                  text, re.M | re.S)
    return (m.group(1).strip() if m else "")


def _clip(s: str, limit: int) -> str:
    return s if len(s) <= limit else s[:limit].rstrip() + _TRUNC


def _read(path: Path) -> str:
    """読めなければ ""。ミラーは共有ドライブから同期したローカルコピーだが、
    欠損・権限・破損のいずれでも /ask を落とさない(fields_note / seed_note と同じ扱い)。"""
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError as e:
        log.warning("カバレッジ床の読み取りに失敗(この1本は飛ばす): %s: %s", path, e)
        return ""


def build_coverage_note(mirror_dir: Path | str) -> str:
    """棚卸し質問のときプロンプトへ差す「読んだ面」ブロックを作る。

    失敗は全部握って "" を返す。床が空でもエージェントは従来どおり自分で探せる——
    ここで例外を上げると /ask 全体が one-shot へ落ちる(呼び出し側の設計は knowledge.py)。
    """
    try:
        mirror = Path(mirror_dir)
        digest_dir = mirror / "discord" / "digest"
        blocks: list[str] = []
        total = 0
        missing: list[str] = []
        no_section: list[str] = []

        for name in ORG_DIGESTS:
            path = digest_dir / f"{name}.md"
            if not path.is_file():
                missing.append(name)
                continue
            body = _extract_section(_read(path), SECTION_TITLE)
            if not body:
                no_section.append(name)
                continue
            body = _clip(body, PER_FILE_CHARS)
            if total + len(body) > TOTAL_CHARS:
                log.warning("カバレッジ床が全体上限(%d字)に達したため %s 以降を省略",
                            TOTAL_CHARS, name)
                break
            total += len(body)
            blocks.append(
                f"## discord/digest/{name}.md — 「{SECTION_TITLE}」節\n{body}\n"
            )

        actions = _clip(_read(mirror / ACTIONS_REL).strip(), ACTIONS_CHARS)

        if not blocks and not actions:
            log.warning("カバレッジ床が空(missing=%s / 節なし=%s) → 床なしで続行",
                        missing, no_section)
            return ""
        if no_section:
            # digest の書式が変わると床が静かに痩せる。気づけるように必ず残す。
            log.warning("「%s」節が見つからない digest: %s", SECTION_TITLE, no_section)
        if missing:
            log.warning("ミラーに存在しない digest: %s", missing)

        head = (
            "# 各部署の未完了タスク(ホスト側が決定的に抜き出したもの・**床であって天井ではない**)\n"
            "3部6課＋役員会の digest から `## " + SECTION_TITLE + "` 節を機械抽出した。"
            "エージェントが読むかどうかを判断する前に載せてある。\n"
            "- **ここに載っているものは、原則すべて回答の検討対象にすること。**"
            "落とすなら「完了済み」等の理由が要る。\n"
            "- **これで打ち切らないこと。** digest は要約なので、"
            "①節に入っていない新しい依頼 ②完了したのに節に残っている行 の両方があり得る。\n"
            "- **「未了です」と言い切らない。** 各件について "
            "`discord/raw/` を Grep して**最後に言及された日**を確かめ、"
            "完了の証跡が無いものは「◯/◯以降の言及なし」と書く。\n"
            "- 出典は**この節ではなく元の digest のパス**"
            "(`discord/digest/<名>.md`)で書く。\n"
        )
        body = "\n".join(blocks)
        tail = ""
        if actions:
            tail = (
                "\n## 直近72時間のアクション指示(機械抽出)\n"
                "※ `" + ACTIONS_REL + "` はミラー内でのみ生成される。"
                "**出典には挙げず**、元になった `discord/raw/` のファイルを挙げること。\n"
                f"{actions}\n"
            )
        return f"{head}\n{body}{tail}\n"
    except Exception as e:  # noqa: BLE001  想定外(実装バグ・パス異常)でも /ask を止めない
        log.warning("カバレッジ床の生成に失敗(床なしで続行): %s", e)
        return ""
