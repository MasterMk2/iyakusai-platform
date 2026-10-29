# -*- coding: utf-8 -*-
"""質問文から検索の WHERE 句(発言者・日付レンジ)を決定的に抽出する純ロジック。

出発点は次の誤答。「7/20から今日までで委員Aがかかわったこと」に対し
one-shot 検索が質問を語の袋 ['今日','20','委員A'] に潰したため、
  ①期間がフィルタとして効かない ②発言者(author)が採点されない ③新しさが効かない
の3つが同時に起きて、半年前のメールと委員Aの名前入りの催促スレッドの digest が上位を占めた。

ここでは **LLM に判断させず**、正規表現と _authors.json の照合だけで条件を作る。
LLM に切り出させると「同じ質問でも日によって条件が変わる」=再現しない誤答になり、
検証もできない。決定的にしておけば smoke test で挙動を固定できる。

安全側の倒し方: **迷ったら条件を立てない**。日付表現・人名が読めなければ None / 空集合
を返して従来どおりの全期間・全員検索に戻す。誤って絞り込むほうが「資料が無い」という
沈黙の誤答になり、誤って絞らないのは単にノイズが混じるだけで人間が気づけるため。

Discord/numpy 非依存(標準ライブラリのみ)。knowledge_search から使う。
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone

# raw の ts は UTC(...Z)、質問文の日付は JST の暦日。zoneinfo は Windows で tzdata が
# 無いと ZoneInfoNotFoundError になるうえ、JST は夏時間が無く固定オフセットで厳密に等価。
JST = timezone(timedelta(hours=9))

# 「M/D」の解釈が now より この日数 先になったら前年と見なす。年始に「12月の話」を
# 聞くケース(1/5 に「12/20」→ 前年12/20)を救うため。14日の猶予は「来週の12/25の準備」
# のような近未来の予定への言及を今年のままにするための遊び。
_FUTURE_TOLERANCE_DAYS = 14


def _normalize(s: str) -> str:
    """NFKC + 小文字化。全角の数字・スラッシュ・括弧を半角に寄せてから照合するため。
    knowledge_search.normalize と同義だが、循環 import を避けてここに持つ。"""
    return unicodedata.normalize("NFKC", s).lower()


@dataclass
class QueryFields:
    """質問文から機械抽出した検索条件。空/None は「条件なし=従来挙動」を意味する。"""

    authors: set[str] = field(default_factory=set)     # 発言者の実名(表示名)。空=条件なし
    date_from: datetime | None = None                  # aware UTC(JST 00:00 を変換)
    date_to: datetime | None = None                    # aware UTC(JST 23:59:59 を変換・inclusive)
    note: str = ""                                     # 人間可読の要約。条件なしなら ""
    # 条件として解釈できた日付表現を潰した質問文(正規化済み)。日付は「語」ではなく
    # 「条件」なので、採点語からは外したい(「7/20」の残骸「20」が digest の
    # 「2026」「20分」に当たって順位を汚す)。解釈できなかった日付様の文字列は
    # 潰さずに残す——条件にならなかった語まで消すと検索の穴になるため。
    cleaned_question: str = ""

    def has_conditions(self) -> bool:
        return bool(self.authors or self.date_from or self.date_to)


# ---------- 人名 ----------

_PAREN_RE = re.compile(r"[(（][^)）]*[)）]")
_KANJI_RE = re.compile(r"[一-龥々]")
# 「若葉さん」「相生くん」等。照合は部分一致なので敬称は基本タダで拾えるが、
# あいまいな短い別名(下記 weak)を敬称付きのときだけ通すために使う。
_HONORIFIC = r"(?:さん|君|くん|ちゃん|氏|先輩)"
# 派生姓の直後に来ても複合語ではなく「姓+役職」である固定の接尾辞(委員会の3部6課に対応)。
# 長いものを先に並べる(「副委員長」を「委員長」で切り出さないため。lookahead なので
# 実害は無いが、読んだときの意図が揺れないように)。
_ROLE_SUFFIX = (r"(?:副委員長|委員長|副部長|部長|副課長|課長|委員|担当|係|先生|会長)")

# Bot 自身は _authors.json に載るが「発言者」条件にしてはいけない。raw 検索は Bot の
# 発言を除外するので、「IyakusaiBotの使い方」を発言者=IyakusaiBot と読むと raw が
# 必ず0件になり、Bot への言及を拾う既存の動きが壊れる(2026-08-01)。
_NOT_AUTHOR_NICKS = {"iyakusaibot"}


def _derive_name_keys(nick: str) -> list[tuple[str, bool]]:
    """実名(nick)から (照合キー, 派生姓か) の一覧を作る。

    _authors.json には「若葉」のような **姓だけのキーが存在しない**(names は
    Discord ハンドル = ExampleUser 等)。実測: aliases に '若葉' を含むキーは0件。
    そのため nick から姓を機械的に作らないと、事故の元になった「若葉がやったこと」が
    そもそも1件も当たらない。

    姓の切り出しは表記の型で変える:
      - 空白入り(「椿野 里奈」)は空白の前が姓 → 「椿野」
      - 空白なしの漢字始まり(「若葉花子」)は先頭2文字を姓と見なす → 「若葉」
    空白なしのかな/ラテン名(「さくらはなこ」「sample blue」)から先頭2文字を取ると
    「くり」「sh」のような無意味な断片になり、あらゆる質問に誤爆するので作らない。

    第2要素(派生姓か)は誤爆ガードの適用範囲を決めるために返す。機械生成した2文字の
    姓だけが地名・一般語(飛騨高山・相生町)と衝突するのであって、フルネームは衝突しない。
    """
    keys: list[tuple[str, bool]] = []
    base = nick.strip()
    if not base:
        return keys
    keys.append((base, False))
    plain = _PAREN_RE.sub("", base).strip()          # 「桐生太郎(きりゅうたろう)」→「桐生太郎」
    if plain and plain != base:
        keys.append((plain, False))
    for v, _ in list(keys):
        if " " in v:
            keys.append((v.replace(" ", ""), False))  # 「桟敷 あおば」→「桟敷あおば」
    src = plain or base
    if " " in src:
        head = src.split(" ")[0]
        if len(head) >= 2:                           # 「辻 美咲」の「辻」は1文字なので姓にしない
            keys.append((head, True))
    elif len(src) >= 3 and _KANJI_RE.match(src[0]) and _KANJI_RE.match(src[1]):
        keys.append((src[:2], True))
    return keys


def _is_weak_key(key: str) -> bool:
    """短くて日本語の地の文に埋もれやすいキーか(敬称付きのときだけ通す)。

    実データの別名には「はる」「のあ」があり、素で部分一致させると「〜のあります」
    「〜はるか」で誤爆する。漢字を含むか3文字以上なら地の文との衝突は実用上無視できる。
    """
    return len(key) <= 2 and not _KANJI_RE.search(key)


@dataclass(frozen=True)
class _NameKey:
    nicks: tuple[str, ...]
    # aliases(ハンドル/あだ名)にしか出てこないキーか。実名や派生姓と違い、あだ名は
    # 委員が普通名詞から付ける(実データ: 「胡瓜」=高山一郎、「やかん」=さくらはなこ)
    # ため、地の文との衝突率が段違いに高い。
    alias_only: bool
    # nick から機械生成した2文字姓にしか出てこないキーか。フルネーム・ハンドルとしても
    # 出てくるキーは False(そちらは衝突しないのでガードを掛けない)。
    surname_only: bool


def build_name_keys(authors_map: dict) -> dict[str, _NameKey]:
    """{照合キー(正規化済み): _NameKey} を作る。

    実名(people の nick)と別名(aliases のハンドル)の両方をキーにし、値は実名に正規化する。
    姓が衝突する場合(梅園晃一 / 梅園優子)はどちらか一方に決め打たず、両方を持たせて
    呼び出し側で OR に展開する。絞りすぎ(1人に決め打ち)より絞らないほうが安全側のため。
    """
    keys: dict[str, list] = {}   # key -> [nicks(list), alias_only(bool), surname_only(bool)]
    nicks = set(str(v) for v in (authors_map.get("by_id") or {}).values() if v)
    nicks |= set(str(v) for v in (authors_map.get("by_name") or {}).values() if v)

    def add(key: str, nick: str, from_alias: bool, is_surname: bool):
        if _normalize(nick) in _NOT_AUTHOR_NICKS:
            return
        k = _normalize(key)
        if len(k) < 2:            # 1文字キー(実データの別名「あ」)は地の文と区別できない
            return
        cur = keys.setdefault(k, [[], True, True])
        if nick not in cur[0]:
            cur[0].append(nick)
        if not from_alias:        # 実名/派生姓としても出てくるキーは alias_only ではない
            cur[1] = False
        if not is_surname:        # フルネーム/ハンドルとしても出てくるキーは姓限定ではない
            cur[2] = False

    for nick in nicks:
        for k, is_surname in _derive_name_keys(nick):
            add(k, nick, from_alias=False, is_surname=is_surname)
    for handle, nick in (authors_map.get("by_name") or {}).items():
        add(str(handle), str(nick), from_alias=True, is_surname=False)
    return {k: _NameKey(tuple(v[0]), v[1], v[2]) for k, v in keys.items()}


def _needs_honorific(key: str, entry: _NameKey) -> bool:
    """そのキーを「敬称付きのときだけ人名と認める」べきか。

    alias 由来の非ASCIIキー(=日本語のあだ名)は普通名詞と見分けがつかない。実測で
    「胡瓜の仕入れ」→高山一郎、「やかんのレンタル費用」→さくらはなこ と誤爆した。
    委員会の会話ではあだ名で人を指すときほぼ必ず敬称が付く(「胡瓜さん」)ので、
    敬称をゲートにすれば辞書も常識判定も要らずに機械的に切れる。
    ASCII ハンドル(exampleuser 等)は日本語の地の文と衝突しないので素のまま通す。
    """
    if _is_weak_key(key):
        return True
    return entry.alias_only and not key.isascii()


def _key_regex(key: str, entry: _NameKey) -> re.Pattern:
    """キーを人名として認める出現条件の正規表現。

    漢字隣接ガードは **機械生成した2文字姓(surname_only)にだけ** 掛ける。
    フルネーム(若葉花子)を内部に含む日本語の複合語は存在しないので、フルネームに
    ガードを掛けても衝突は1件も防げず、「若葉花子委員長の決定」のような曖昧性ゼロの
    指定を落とすだけ(2026-08-01 実測)。地名・一般語と衝突するのは姓の側だけ。

    姓の **後続** ガードは、直後が委員会の役職接尾辞のときだけ解除する。「若葉委員長」
    「相生担当」は委員の呼び方として最も普通なのに、後続漢字ガードが機械的に殺していた。
    許可リストは委員会の役職体系(3部6課)に合わせた **固定の正規表現** であり、辞書引きや
    語義判定ではない(_目録/AI作業方針.md §3-4 の「常識で判断しない」に反しない)。
    **前置ガードは無条件で維持**する——「飛騨高山」は前が漢字なので死んだまま。
    「相生町」「桟敷席」は 町/席 が役職ではないので死んだまま。
    「若葉関連」も救わない(関連は役職ではない)。この場合は条件が立たない=従来どおりの
    全期間・全員検索に落ちるだけで、フッターに条件行が出ないことで利用者が気づける。
    """
    pat = re.escape(key)
    if entry.surname_only and _KANJI_RE.search(key):
        pat = (r"(?<![一-龥々])" + pat
               + r"(?:(?![一-龥々])|(?=" + _ROLE_SUFFIX + r"))")
    if _needs_honorific(key, entry):
        pat += _HONORIFIC
    return re.compile(pat)


def _match_authors(text: str, name_keys: dict[str, _NameKey]) -> set[str]:
    """質問文に出てくる人名を実名の集合にする。

    残す割り切り: 「岡山の業者」「長野から来る団体」は姓と地名が完全に同形で、
    前後の文字だけでは人間にも判別できない。ここで無理に切ると「岡山さんの担当は?」
    のような正当な質問まで落ちるので、誤爆したままフッターの条件表示に気づかせる
    (沈黙させないほうが安全側・_目録/AI作業方針.md §3-4)。
    """
    out: set[str] = set()
    for key, entry in name_keys.items():
        if key in text and _key_regex(key, entry).search(text):
            out.update(entry.nicks)
    return out


# ---------- 日付 ----------

# 位置つきで拾いたいので1本の正規表現にまとめる(前の選択肢が優先されるため、
# 長い表記=年つき・月日つき を先に並べる)。
# 「M-D」は「3-4人」のような範囲表現と区別できないので「/」だけを認める。
_DATE_TOKEN_RE = re.compile(
    r"(?P<ymd>(?<![\d/])(?P<y>\d{4})[/年](?P<ym>\d{1,2})[/月](?P<yd>\d{1,2})日?)"
    r"|(?P<kmd>(?<!\d)(?P<km>\d{1,2})月(?P<kd>\d{1,2})日)"
    r"|(?P<md>(?<![\d/])(?P<m>\d{1,2})/(?P<d>\d{1,2})(?![\d/]))"
    r"|(?P<recent_n>(?:ここ|この|直近)(?P<rn>\d{1,3})日(?:間)?)"
    r"|(?P<recent_week>(?:ここ|この|直近)(?:1|一)?(?:週間|週))"
    r"|(?P<ndays_ago>(?<!\d)(?P<nd>\d{1,3})日前)"
    r"|(?P<dby>一昨日|おととい|おとつい)"
    r"|(?P<today>今日|本日)"
    r"|(?P<yesterday>昨日|きのう)"
    r"|(?P<this_week>今週)"
    r"|(?P<last_week>先週)"
    r"|(?P<this_month>今月)"
    r"|(?P<last_month>先月)"
)

# 単独の日付表現に付く「〜以降」「〜まで」。片側だけ開いた条件を作るために見る。
_OPEN_FROM_RE = re.compile(r"^\s*(?:以降|以後|以来|から)")
_OPEN_TO_RE = re.compile(r"^\s*(?:以前|まで|より前)")


def _safe_date(y: int, m: int, d: int) -> date | None:
    try:
        return date(y, m, d)
    except ValueError:      # 2/30・うるう年でない 2/29 等
        return None


def _infer_year(m: int, d: int, today: date) -> date | None:
    """年の明示が無い M/D を暦日にする。既定は今年。ただし now+14日より未来に
    なる場合は前年と解釈する(年始に前年12月の話を聞くケース)。"""
    cand = _safe_date(today.year, m, d)
    if cand is None:
        return None
    if cand > today + timedelta(days=_FUTURE_TOLERANCE_DAYS):
        return _safe_date(today.year - 1, m, d) or cand
    return cand


def _month_span(y: int, m: int) -> tuple[date, date]:
    first = date(y, m, 1)
    last = date(y + (m == 12), (m % 12) + 1, 1) - timedelta(days=1)
    return first, last


def _resolve_anchor(mo: re.Match, today: date) -> tuple[date, date] | None:
    """マッチ1つを JST の暦日レンジ(from, to)にする。読めなければ None。"""
    if mo.group("ymd"):
        d0 = _safe_date(int(mo.group("y")), int(mo.group("ym")), int(mo.group("yd")))
        return (d0, d0) if d0 else None
    if mo.group("kmd"):
        d0 = _infer_year(int(mo.group("km")), int(mo.group("kd")), today)
        return (d0, d0) if d0 else None
    if mo.group("md"):
        m, d = int(mo.group("m")), int(mo.group("d"))
        if not (1 <= m <= 12 and 1 <= d <= 31):
            return None
        d0 = _infer_year(m, d, today)
        return (d0, d0) if d0 else None
    if mo.group("recent_n"):
        n = int(mo.group("rn"))
        return (today - timedelta(days=n), today)   # 端は広めに(絞りすぎない側へ)
    if mo.group("recent_week"):
        return (today - timedelta(days=7), today)
    if mo.group("ndays_ago"):
        d0 = today - timedelta(days=int(mo.group("nd")))
        return (d0, d0)
    if mo.group("dby"):
        d0 = today - timedelta(days=2)
        return (d0, d0)
    if mo.group("today"):
        return (today, today)
    if mo.group("yesterday"):
        d0 = today - timedelta(days=1)
        return (d0, d0)
    if mo.group("this_week"):
        mon = today - timedelta(days=today.weekday())
        return (mon, mon + timedelta(days=6))
    if mo.group("last_week"):
        mon = today - timedelta(days=today.weekday() + 7)
        return (mon, mon + timedelta(days=6))
    if mo.group("this_month"):
        return _month_span(today.year, today.month)
    if mo.group("last_month"):
        y, m = (today.year - 1, 12) if today.month == 1 else (today.year, today.month - 1)
        return _month_span(y, m)
    return None


def _jst_start(d: date) -> datetime:
    return datetime(d.year, d.month, d.day, 0, 0, 0, tzinfo=JST).astimezone(timezone.utc)


def _jst_end(d: date) -> datetime:
    return datetime(d.year, d.month, d.day, 23, 59, 59, tzinfo=JST).astimezone(timezone.utc)


def _parse_dates(text: str, today: date):
    """(date_from, date_to, 解釈に使ったマッチ範囲) を返す。

    範囲を返すのは、条件として解釈できた日付表現を採点語から外すため。
    解釈に失敗したマッチ(存在しない日付など)の範囲は返さない=語として残す。
    """
    anchors: list[tuple[re.Match, date, date]] = []
    for mo in _DATE_TOKEN_RE.finditer(text):
        span = _resolve_anchor(mo, today)
        if span:
            anchors.append((mo, span[0], span[1]))
    if not anchors:
        return (None, None, [])
    spans = [(a[0].start(), a[0].end()) for a in anchors]
    tail = text[anchors[-1][0].end():]
    if len(anchors) == 1:
        if _OPEN_FROM_RE.match(tail):          # 「7/20以降」= 終端を開ける
            return (anchors[0][1], None, spans)
        if _OPEN_TO_RE.match(tail):            # 「7/20まで」= 始端を開ける
            return (None, anchors[0][2], spans)
        return (anchors[0][1], anchors[0][2], spans)
    # 複数あるときは全体を包む範囲にする(「AからBまで」も、連結詞の無い併記も同じ扱い)。
    # 連結詞の種類で分岐すると「7/20〜」「7/20、7/25の件」等で解釈が割れるので、
    # 常に外側=広い側に倒す(絞りすぎない方針)。
    lo = min(a[1] for a in anchors)
    hi = max(a[2] for a in anchors)
    if _OPEN_FROM_RE.match(tail):              # 「…7/20以降」= 最後が開いている
        return (lo, None, spans)
    return (lo, hi, spans)


def _blank_spans(text: str, spans: list[tuple[int, int]]) -> str:
    """指定範囲を空白に置換する(長さを保つので他の範囲がずれない)。"""
    if not spans:
        return text
    out = list(text)
    for s, e in spans:
        for i in range(s, e):
            out[i] = " "
    return "".join(out)


# ---------- 入口 ----------

def _strip_channel_labels(text: str, channel_labels: set[str] | None) -> str:
    """チャンネル/スレッド名を質問文から取り除いたコピーを返す(人名照合の誤爆ガード)。

    例えば「運営プロジェクト > 【催促用】委員Aのタスク」というスレッドがあると、
    「#委員Aのタスクのまとめ」という質問を発言者=委員A で絞り、本人の発言しか
    出ないという逆転が起きる。長いラベルから順に消す(部分ラベルが先に消えて
    長いラベルが消し損ねるのを防ぐ)。
    """
    if not channel_labels:
        return text
    for label in sorted(channel_labels, key=len, reverse=True):
        n = _normalize(label)
        if len(n) >= 2 and n in text:
            text = text.replace(n, " ")
    return text


def _format_note(authors: set[str], d_from: date | None, d_to: date | None) -> str:
    parts = []
    if authors:
        parts.append("発言者=" + "・".join(sorted(authors)))
    if d_from and d_to:
        parts.append(f"期間={d_from:%m/%d}〜{d_to:%m/%d}")
    elif d_from:
        parts.append(f"期間={d_from:%m/%d}以降")
    elif d_to:
        parts.append(f"期間={d_to:%m/%d}まで")
    return " / ".join(parts)


def parse_fields(question: str, authors_map: dict,
                 channel_labels: set[str] | None = None,
                 now: datetime | None = None) -> QueryFields:
    """質問文から発言者・日付レンジを抽出する。条件が読めなければ空の QueryFields。

    now は注入可能(テストのため)。相対表現(今日・先週)は毎回 now から計算し、
    キャッシュしない——Bot は常駐プロセスなので、日付を焼き込むと日付が変わった
    翌日以降ずっと古い範囲で検索し続ける。
    """
    if now is None:
        now = datetime.now(timezone.utc)
    elif now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    today = now.astimezone(JST).date()

    qn = _normalize(question or "")
    d_from, d_to, spans = _parse_dates(qn, today)
    authors = _match_authors(_strip_channel_labels(qn, channel_labels),
                             build_name_keys(authors_map or {}))
    return QueryFields(
        authors=authors,
        date_from=_jst_start(d_from) if d_from else None,
        date_to=_jst_end(d_to) if d_to else None,
        note=_format_note(authors, d_from, d_to),
        cleaned_question=_blank_spans(qn, spans),
    )


# ---------- 主語(誰の話か)の欠落検知 ----------

# 「やること・タスク」の類は **必ず誰かの** やることなので、人名が書かれていなければ
# 主語が欠けている。この形の質問だけにガードを掛ける(「保険の書類はどこ?」のような
# 人に紐づかない質問にまでガード文を足すと、プロンプトが無駄に長くなるだけ)。
#
# 誤答の例: 主語の無い「やらないといけないことを列挙して」に対し、
# Bot が個人名入りの催促スレッドの digest から **別の委員の課題一覧**を
# 二人称(「あんた、今やるべきことが…」)で返し、質問者の分ではない答えになった。
# 原因は2つ重なっている:
#   ① 検索側 — 委員会の資料で「個人のTODO一覧」の形をしているのは実質その催促スレッド
#      だけなので、主語なしのタスク質問は構造的にそこへ落ちる
#   ② 出力側 — 誰の分の資料かを書かせる決まりが無く、質問者本人の話として書けてしまう
# ①は資料の偏りなので消せない。**②を機械的に塞ぐ**のがこの検知の役割。
#
# ここでも「迷ったら条件を立てない」の方針は同じだが、**倒す向きが逆**である点に注意:
# 発言者条件は誤って絞ると沈黙の誤答になるので緩め、こちらは誤って発火しても
# 「誰の分か明示せよ」という無害な指示が増えるだけなので拾い漏らさない側に倒す。
_PERSONAL_SCOPE_RE = re.compile(
    r"やること|やるべき|やらないと|やらなきゃ|やり残|積み残|残タスク"
    r"|タスク|to-?do|宿題|マター|抱えて",
    re.IGNORECASE,
)


def is_personal_scope(question: str) -> bool:
    """「誰かのやること」を尋ねる形の質問か(人名の有無は見ない)。

    呼び出し側は **これが True かつ QueryFields.authors が空** のときだけ
    主語欠落ガードを立てる。片方だけでは足りない:
      - 人名があれば主語は明示されているのでガードは不要(「相生のタスク」)
      - タスク形でなければ、そもそも個人一覧に化ける危険が無い
    """
    return bool(_PERSONAL_SCOPE_RE.search(_normalize(question or "")))


# ---------- 棚卸し(洗い出し)質問の検知 ----------

# 誤答の例。「各部署でやるべきことを教えて。」に対し、エージェントが
# 持ち時間の一部だけで打ち切り、規程や研修資料から **職掌(役割分担)** を返した。役員会 digest も6課の digest も
# `discord/actions_recent.md` も、全部ミラーに在ったのに1本も開いていない。
#
# この検知が立つと2つが同時に差さる(どちらか片方では足りない):
#   ① coverage.build_coverage_note — 3部6課+役員会の「宿題・未完了タスク」節をホストが
#      先に読んで載せる。**読む面をエージェントの裁量から外す**のが主目的
#   ② ai_provider.INVENTORY_GUARD  — 「職掌ではなく未了で答える」「案件/期限/担当/
#      最終言及日の形で出す」「床で打ち切らない」を出力側で固定する
#
# 発火条件は「タスク・期限の形」×「全体を出せの形」の**両方**。片方だけでは広すぎる:
#   - タスク形だけ  → 「相生さんのタスク教えて」(個人1名の話)にまで床を差すことになる
#   - 列挙形だけ    → 「協賛企業の一覧」のような、未了と無関係な質問に当たる
# 「教えて」は列挙形に**入れない**(ほぼ全ての質問に付くため、事実上の常時発火になる)。
#
# 倒す向きは SUBJECT_GUARD と同じで「拾い漏らさない側」。誤発火のコストは
# プロンプトが 2〜3万字伸びるだけ(入力トークンは Q2 実測 133.6k に対し十分収まる)で、
# 拾い漏らすと 8/17 と同じ「職掌を返して終わり」に戻る。
_INVENTORY_TASK_RE = re.compile(
    r"やること|やるべき|やらないと|やらなきゃ|やり残|積み残|残タスク"
    r"|タスク|to-?do|宿題|マター|抱えて"
    r"|未完了|未了|未対応|残ってる|残っている|進捗|課題|懸案|案件"
    r"|期限|締切|締め切り|〆切",
    re.IGNORECASE,
)
_INVENTORY_ENUM_RE = re.compile(
    r"列挙|洗い出|一覧|棚卸|リスト|まとめて|整理して"
    r"|全部|全て|すべて|全体|ぜんぶ"
    r"|各部|各課|部署|部局|部門|それぞれ|みんな|全員",
    re.IGNORECASE,
)


def is_inventory_scope(question: str) -> bool:
    """「未了のものを全部出せ」型の棚卸し質問か。

    8/17 の2問はどちらも True になる:
      - 「やらないといけないことを列挙して」 = やらないと × 列挙
      - 「各部署でやるべきことを教えて。」     = やるべき   × 各部
    """
    q = _normalize(question or "")
    return bool(_INVENTORY_TASK_RE.search(q) and _INVENTORY_ENUM_RE.search(q))


def strip_author_terms(terms: list[str], authors: set[str], authors_map: dict) -> list[str]:
    """採点語から発言者の名前(実名・姓・ハンドル)を除く。

    本人の投稿に本人の名前は書かれないため、author で絞った後に名前を採点軸に残すと
    「本人が自分の名前を書いた投稿」だけが上位に来る。digest 等の他ティアでは名前は
    第三者の言及を拾う有効な軸なので、この除去は raw の author 絞り時に限る。
    """
    if not authors:
        return terms
    drop: set[str] = set()
    for key, entry in build_name_keys(authors_map or {}).items():
        if any(n in authors for n in entry.nicks):
            drop.add(key)
    return [t for t in terms if t not in drop]
