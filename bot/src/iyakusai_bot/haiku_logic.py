# -*- coding: utf-8 -*-
r"""F5: 偶然の俳句(川柳)検出 — 判定ロジック(Discord 非依存・AI呼び出し0円)。

Discord への出し方は haiku.py(Cog)。ここは「文字列 → 俳句かどうか」だけを持つ。

■ 何をもって「高性能」とするか
  素朴な 5-7-5 カウンタは偽陽性だらけになる(拗音を数える/単語の途中で切る/助詞から
  句が始まる)。本実装は次の4点で精度を出す:
    1. **読みは形態素解析で取る**(SudachiPy)。漢字を読めないと検出はほぼ無意味。
    2. **モーラ規則**: 拗音(ャュョァィゥェォヮ)は前拍に吸収、促音ッ・撥音ン・長音ーは1拍。
    3. **句の切れ目が形態素境界に一致するものだけ採用**(「たべも/のがおい」を弾く)。
       さらに各句の先頭が助詞・助動詞・接尾辞・非自立語のものを弾く。ここで偽陽性の
       大半が消える。
    4. **候補は「文」または「読点で区切った節の連続」**に限る(=必ず文頭か読点直後で
       始まり、読点直前か文末で終わる)。文の任意の位置から17拍を切り出す実装にはしない。

■ 実測(2026-07-22・discord/raw 4,278メッセージ = 約2.5か月分で検証)
    - 17拍ちょうどの文は135件。うち **境界NG100件・句頭NG30件を弾いて残り5件**。
      弾いた側は「ここに他/の情報はは/要りますか」のような明らかな偽陽性で、
      3.のガードが効いていることを確認した。
    - 候補を「節の連続」まで広げると 5件 → **10件**(増えた5件も尻切れなし)。
    - 参考: 文中の任意位置からの部分一致も試したが 233件に膨れ、大半が
      「医薬祭/実行委員/会が持っ」のような尻切れだった。**部分一致は採用しない**。

■ 依存
  SudachiPy + SudachiDict-small(RPi=ARM64 にも wheel あり)。**無ければ機能ごと自動OFF**
  (knowledge の vector 検索が Ollama 無しでスキップするのと同じ流儀)。
      pip install sudachipy sudachidict-small

■ 動作確認・しきい値のチューニング(Bot を止めずに単体で実行できる)
      py -m iyakusai_bot.haiku_logic --test "その企画は予算が足りない"
      py -m iyakusai_bot.haiku_logic --scan <discord/raw のパス> --min-score 0
"""

from __future__ import annotations

import logging
import re
import unicodedata
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger("iyakusai.haiku")

MORA_PATTERN = (5, 7, 5)
TOTAL_MORA = sum(MORA_PATTERN)
TEIKEI = "定型"

# 破調(どれか1句だけ ±1拍)。定型より1段下の扱い(点を引く)だが、実ログでは
# 字余り・字足らずの佳句がこちら側に多く出る。
HACHOU_PATTERNS: dict[tuple[int, int, int], str] = {}
for _i in range(3):
    for _d in (1, -1):
        _p = list(MORA_PATTERN)
        _p[_i] += _d
        HACHOU_PATTERNS[tuple(_p)] = f"{'字余り' if _d > 0 else '字足らず'}({'上中下'[_i]})"
HACHOU_PENALTY = 5

# 拗音・小書き(前のモーラに吸収されるので数えない)。ッ・ン・ー は1拍として数える。
SMALL_KANA = set("ャュョァィゥェォヮ")
KATAKANA_RE = re.compile(r"^[ァ-ヴー]+$")

# 記号は読みが「キゴウ」等になり拍数を水増しする(Sudachi は ':' に3拍のキゴウを返す)。
# _clean で落とし切れなかったものが残っていたら、その候補ごと捨てる。
SYMBOL_POS1 = {"補助記号", "記号", "空白"}
# 句頭に来ると不自然な品詞(大分類)
BAD_HEAD_POS1 = {"助詞", "助動詞", "接尾辞"} | SYMBOL_POS1
# 句頭に来ると不自然な品詞(中分類)。「〜している」の「いる」「こと」「もの」など
BAD_HEAD_POS2 = {"非自立可能"}
# 内容語(スコアの分子)
CONTENT_POS1 = {"名詞", "動詞", "形容詞", "形状詞", "副詞", "感動詞"}
# 文がここで終わると「途中で切れた」感じになる助詞(減点)
DANGLING_TAIL = {"て", "で", "が", "けど", "けれど", "ので", "から", "し", "と", "に"}

# 前処理で落とすもの
CODE_BLOCK_RE = re.compile(r"```.*?```", re.S)
INLINE_CODE_RE = re.compile(r"`[^`]*`")
URL_RE = re.compile(r"https?://\S+")
DISCORD_TAG_RE = re.compile(r"<a?:\w+:\d+>|<@[!&]?\d+>|<#\d+>|<t:\d+(?::\w)?>")
QUOTE_LINE_RE = re.compile(r"^\s*>.*$", re.M)
EMOJI_RE = re.compile(
    "[\U0001F000-\U0001FAFF☀-➿️←-⇿⬀-⯿]"
)
# 0拍の記号(中黒・括弧・コロンなど)。拍は増やさないので落とす(読点は節の区切りとして先に使う)
DROP_CHARS_RE = re.compile(r"[・…‥「」『』（）\(\)\[\]【】〈〉《》”“\"'’‘~〜\-—_/|*#+=^%$@:;：；※→←↑↓♪♡★☆\s]")
SENTENCE_SPLIT_RE = re.compile(r"[。.!?！？\n]+")
CLAUSE_SPLIT_RE = re.compile(r"[、,]+")
ASCII_ALNUM_RE = re.compile(r"[0-9A-Za-z]")
MAX_CLAUSES = 6            # 節が多い文は組み合わせ爆発を避けて「単節」と「文全体」だけ見る

# 事前フィルタ(形態素解析にかける前の足切り)。17拍の文はおおむね 9〜40 文字に収まる
MIN_CHARS, MAX_CHARS = 8, 44


@dataclass
class Token:
    surface: str
    reading: str
    pos1: str
    pos2: str
    mora: int


@dataclass
class Haiku:
    """検出結果。ku = 上/中/下の句(表記)、reading_ku = その読み。"""
    text: str                 # 判定対象になった文(前処理後)
    ku: tuple[str, str, str]
    reading_ku: tuple[str, str, str]
    score: int
    pattern: str = TEIKEI     # "定型" または「字余り(中)」等

    @property
    def label(self) -> str:
        """定型のときは何も出さない(注記が付くのは破調のときだけ)。"""
        return "" if self.pattern == TEIKEI else self.pattern

    @property
    def formatted(self) -> str:
        return "　".join(self.ku)

    @property
    def reading(self) -> str:
        return "　".join(self.reading_ku)


# ---------- モーラ ----------

def count_mora(reading: str) -> int:
    """カタカナの読み → モーラ数。カタカナ以外を含む読みは -1(判定不能)。"""
    if not reading or not KATAKANA_RE.match(reading):
        return -1
    return sum(1 for ch in reading if ch not in SMALL_KANA)


# ---------- 形態素解析 ----------

class Analyzer:
    """SudachiPy のラッパ。辞書ロードは重い(1〜2秒)ので遅延+使い回し。

    SudachiPy が無い/辞書が無い環境では available=False になり、呼び出し側は
    機能ごと黙って無効化する(Bot は止めない)。
    """

    def __init__(self, split_mode: str = "C"):
        self._tokenizer = None
        self._mode = None
        self._split_mode = split_mode
        self._failed = False

    @property
    def available(self) -> bool:
        if self._failed:
            return False
        if self._tokenizer is None:
            self._load()
        return not self._failed

    def _load(self) -> None:
        try:
            from sudachipy import dictionary, tokenizer as sudachi_tokenizer
        except ImportError:
            log.info("SudachiPy 未導入のため俳句検出は無効(pip install sudachipy sudachidict-small)")
            self._failed = True
            return
        d = None
        for kwargs in ({"dict": "small"}, {"dict": "core"}, {}):
            try:
                d = dictionary.Dictionary(**kwargs)
                break
            except Exception:                      # 辞書未導入・引数名の版差(dict/dict_type)
                continue
        if d is None:
            try:                                   # 0.6.7 以前は dict_type
                d = dictionary.Dictionary(dict_type="small")
            except Exception:
                log.warning("Sudachi 辞書を読めないため俳句検出は無効(pip install sudachidict-small)")
                self._failed = True
                return
        self._tokenizer = d.create()
        # C=複合語をまとめる(語の途中で句を切りにくい=厳しめ)。A は細かすぎて誤検出が増える
        self._mode = getattr(sudachi_tokenizer.Tokenizer.SplitMode, self._split_mode)

    def tokenize(self, text: str) -> list[Token] | None:
        """読みが全てカタカナで取れた場合のみトークン列を返す。1つでも読めなければ None。"""
        if not self.available:
            return None
        out = []
        for m in self._tokenizer.tokenize(text, self._mode):
            pos = m.part_of_speech()
            if pos[0] in SYMBOL_POS1:              # 記号は読み(キゴウ等)が拍数を狂わせる
                return None
            reading = m.reading_form() or ""
            mora = count_mora(reading)
            if mora <= 0:                          # 英字・数字・読み無し = 判定不能
                return None
            out.append(Token(m.surface(), reading, pos[0], pos[1], mora))
        return out or None


# ---------- 前処理 ----------

def sentences(text: str) -> list[str]:
    """メッセージ本文 → 判定対象の文のリスト(URL・コード・メンション・絵文字は除去)。"""
    t = CODE_BLOCK_RE.sub(" ", text)
    t = INLINE_CODE_RE.sub(" ", t)
    t = QUOTE_LINE_RE.sub(" ", t)
    t = URL_RE.sub(" ", t)
    t = DISCORD_TAG_RE.sub(" ", t)
    t = EMOJI_RE.sub(" ", t)
    t = unicodedata.normalize("NFKC", t)
    out = []
    for part in SENTENCE_SPLIT_RE.split(t):
        s = " ".join(part.split())        # 除去跡の空白をまとめる(拍には影響しない)
        if s:
            out.append(s)
    return out


def _clean(sentence: str) -> str:
    return DROP_CHARS_RE.sub("", sentence)


def candidates(text: str) -> list[str]:
    """判定にかける文字列の候補。

    「文」と「読点で区切った節の連続」= 必ず文頭か読点直後で始まり、読点直前か文末で
    終わる単位だけを候補にする(文の途中から17拍を切り出さない)。長さで足切り済み。
    """
    out: list[str] = []
    for sent in sentences(text):
        clauses = [c for c in (_clean(c) for c in CLAUSE_SPLIT_RE.split(sent)) if c]
        n = len(clauses)
        if n == 0:
            continue
        if n > MAX_CLAUSES:
            spans = [(i, i) for i in range(n)] + [(0, n - 1)]
        else:
            spans = [(i, j) for i in range(n) for j in range(i, n)]
        for i, j in spans:
            s = "".join(clauses[i:j + 1])
            if MIN_CHARS <= len(s) <= MAX_CHARS and s not in out:
                out.append(s)
    return out


# ---------- 判定 ----------

def _bad_head(tok: Token) -> bool:
    return tok.pos1 in BAD_HEAD_POS1 or tok.pos2 in BAD_HEAD_POS2


def _split_at_boundaries(tokens: list[Token],
                         pattern: tuple[int, int, int] = MORA_PATTERN) -> list[list[Token]] | None:
    """句の切れ目が形態素境界に一致するなら3句に分ける。しなければ None。"""
    ku, cur, cur_mora, target = [], [], 0, 0
    for tok in tokens:
        cur.append(tok)
        cur_mora += tok.mora
        want = pattern[target]
        if cur_mora == want:
            ku.append(cur)
            cur, cur_mora, target = [], 0, target + 1
            if target == len(pattern):
                return ku if not cur else None
        elif cur_mora > want:
            return None                            # 単語の途中で境界をまたいだ
    return None


def _score(tokens: list[Token], ku: list[list[Token]]) -> int:
    n = len(tokens)
    content = sum(1 for t in tokens if t.pos1 in CONTENT_POS1)
    score = 45 + int(45 * content / n)
    if 4 <= n <= 12:                               # 1〜3語だけ = ただの長い固有名詞
        score += 10
    elif n <= 3:
        score -= 20
    if any(t.pos2 == "固有名詞" for t in tokens):    # 委員会の固有名詞が入ると味が出る
        score += 5
    last = tokens[-1]
    if last.pos1 == "助詞" and last.surface in DANGLING_TAIL:
        score -= 15                                # 「〜が」「〜ので」で終わる=文の途中
    if last.pos1 in {"接続詞", "接頭辞"}:
        score -= 15
    if all(t.pos1 == "名詞" for t in tokens):       # 名詞の羅列(箇条書きの見出し等)
        score -= 15
    return max(0, min(100, score))


def _patterns_for(total: int, allow_hachou: bool) -> list[tuple[tuple[int, int, int], str]]:
    if total == TOTAL_MORA:
        return [(MORA_PATTERN, TEIKEI)]
    if not allow_hachou:
        return []
    return [(p, label) for p, label in HACHOU_PATTERNS.items() if sum(p) == total]


def detect(text: str, analyzer: Analyzer, min_score: int = 60,
           allow_hachou: bool = True) -> Haiku | None:
    """メッセージ本文から俳句を1つ返す(無ければ None)。最も点の高い候補を返す。

    allow_hachou=True なら破調(どれか1句だけ ±1拍)も拾う。破調は
    HACHOU_PENALTY 点を引くので、同じ文なら定型が優先される。
    """
    if not analyzer.available:
        return None
    best: Haiku | None = None
    for s in candidates(text):
        if ASCII_ALNUM_RE.search(s):
            continue                               # 数字・英字は読みが不定(20日=はつか等)
        tokens = analyzer.tokenize(s)
        if not tokens:
            continue
        total = sum(t.mora for t in tokens)
        for pattern, label in _patterns_for(total, allow_hachou):
            ku = _split_at_boundaries(tokens, pattern)
            if ku is None or any(_bad_head(k[0]) for k in ku):
                continue
            score = _score(tokens, ku) - (0 if label == TEIKEI else HACHOU_PENALTY)
            if score >= min_score and (best is None or score > best.score):
                best = Haiku(
                    text=s,
                    ku=tuple("".join(t.surface for t in k) for k in ku),
                    reading_ku=tuple("".join(t.reading for t in k) for k in ku),
                    score=score,
                    pattern=label,
                )
    return best


def real_name(rec: dict, names: dict[str, dict[str, str]]) -> str:
    """raw の1行 → 委員会での表示名(実名)。改名に強い user_id を優先する。

    対応表は `discord/raw/_authors.json`(実名統制の単一ソース)。載っていなければ
    元の author をそのまま返す。
    """
    uid = str(rec.get("author_id") or "")
    author = rec.get("author") or "?"
    return names.get("by_id", {}).get(uid) or names.get("by_name", {}).get(author) or author


# ---------- CLI(単体確認・しきい値のチューニング) ----------

RAW_CHANNEL_ID_RE = re.compile(r"__([0-9]+)$")


def scan_raw(raw_dir: Path, analyzer: Analyzer, min_score: int,
             blocklist: list[str], allow_hachou: bool = True,
             names: dict[str, dict[str, str]] | None = None,
             allowed_channel_ids: set[int] | None = None,
             ) -> list[tuple[int, str, str, str]]:
    """discord/raw/*.jsonl を走査して過去ログの俳句を拾う(Bot 不要・オフライン)。

    raw の author は Discord のハンドル(SampleHandle 等)なので、names(_authors.json 由来の
    {"by_id":…, "by_name":…})を渡して**実名(サーバーニックネーム)**に読み替える。
    allowed_channel_ids を渡すと、ファイル名末尾(<CH名>__<ID>.jsonl)の ID がそこに
    含まれるファイルだけを開く(ID が読めないファイルは開かない)。
    """
    import json
    names = names or {"by_id": {}, "by_name": {}}
    found = []
    for path in sorted(Path(raw_dir).glob("*.jsonl")):
        if allowed_channel_ids is not None:
            m = RAW_CHANNEL_ID_RE.search(path.stem)
            if m is None or int(m[1]) not in allowed_channel_ids:
                continue
        if any(b in path.name for b in blocklist):
            continue
        with open(path, encoding="utf-8") as f:
            for line in f:
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if rec.get("bot") or not rec.get("content"):
                    continue
                h = detect(rec["content"], analyzer, min_score, allow_hachou)
                if h:
                    found.append((h.score, real_name(rec, names),
                                  (rec.get("ts") or "")[:10],
                                  h.formatted + (f"  ({h.label})" if h.label else "")))
    return sorted(found, key=lambda x: -x[0])


def main() -> None:
    import argparse
    import io
    import sys
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    ap = argparse.ArgumentParser(description="偶然の俳句検出(単体確認)")
    ap.add_argument("--test", metavar="TEXT", help="1件だけ判定して詳細を出す")
    ap.add_argument("--scan", metavar="RAW_DIR", help="discord/raw を走査して過去の俳句を出す")
    ap.add_argument("--min-score", type=int, default=60)
    ap.add_argument("--limit", type=int, default=40)
    ap.add_argument("--teikei-only", action="store_true", help="破調を拾わず定型5-7-5だけにする")
    args = ap.parse_args()
    hachou = not args.teikei_only

    az = Analyzer()
    if not az.available:
        print("SudachiPy/辞書がありません: pip install sudachipy sudachidict-small")
        return
    if args.test:
        for s in candidates(args.test):
            toks = az.tokenize(s)
            print(f"[文] {s}")
            if not toks:
                print("  読めないトークンあり(英数字・記号)→ 対象外")
                continue
            print("  " + " / ".join(f"{t.surface}({t.reading}:{t.mora})" for t in toks)
                  + f"  計{sum(t.mora for t in toks)}拍")
        h = detect(args.test, az, args.min_score, hachou)
        print(f"\n判定: {'俳句 ' + h.formatted + f'  [{h.score}点 {h.pattern}] ' + h.reading if h else '俳句ではない'}")
    if args.scan:
        # 実名の対応表は _目録 直下の discord/raw/_authors.json(= <raw>/../..)
        from .knowledge_search import DEFAULT_BLOCKLIST, load_author_aliases
        raw_dir = Path(args.scan)
        rows = scan_raw(raw_dir, az, args.min_score, DEFAULT_BLOCKLIST, hachou,
                        load_author_aliases(raw_dir.parent.parent))
        print(f"検出 {len(rows)} 句(上位 {min(args.limit, len(rows))} 件)")
        for score, author, day, text in rows[:args.limit]:
            print(f"  {score:3d}点 {day} {author}: {text}")


if __name__ == "__main__":
    main()
