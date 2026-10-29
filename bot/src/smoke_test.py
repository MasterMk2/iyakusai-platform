# -*- coding: utf-8 -*-
"""オフライン・スモークテスト(Discord 接続なしで純ロジックを検証する)。

    python smoke_test.py

対象: remind_logic(期限パース・繰り返し・通知判定) / storage / lockfile / mirror(アクション索引)
"""

import json
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from iyakusai_bot import mirror as mi
from iyakusai_bot import remind_logic as rl
from iyakusai_bot.lockfile import InstanceLock, LockBusy
from iyakusai_bot.storage import ReminderStore

JST = rl.JST
NOW = datetime(2026, 7, 12, 15, 0, tzinfo=JST)
ok = 0


def check(name, cond):
    global ok
    assert cond, f"NG: {name}"
    ok += 1
    print(f"  ok: {name}")


print("[parse_due]")
check("YYYY-MM-DD HH:MM", rl.parse_due("2026-07-20 18:00", NOW) == datetime(2026, 7, 20, 18, 0, tzinfo=JST))
check("YYYY/MM/DD 時刻省略→9:00", rl.parse_due("2026/08/01", NOW) == datetime(2026, 8, 1, 9, 0, tzinfo=JST))
check("M/D 未来", rl.parse_due("7/20", NOW) == datetime(2026, 7, 20, 9, 0, tzinfo=JST))
check("M/D 過去→翌年", rl.parse_due("7/1", NOW) == datetime(2027, 7, 1, 9, 0, tzinfo=JST))
check("明日", rl.parse_due("明日", NOW) == datetime(2026, 7, 13, 9, 0, tzinfo=JST))
check("明日 18:00", rl.parse_due("明日 18:00", NOW) == datetime(2026, 7, 13, 18, 0, tzinfo=JST))
check("HH:MM 未来=今日", rl.parse_due("18:00", NOW) == datetime(2026, 7, 12, 18, 0, tzinfo=JST))
check("HH:MM 過去=明日", rl.parse_due("9:00", NOW) == datetime(2026, 7, 13, 9, 0, tzinfo=JST))
check("+3d", rl.parse_due("+3d", NOW) == NOW + timedelta(days=3))
check("+12h", rl.parse_due("+12h", NOW) == NOW + timedelta(hours=12))
for bad in ("", "あさって?", "13/45", "25:00"):
    try:
        rl.parse_due(bad, NOW)
        raise AssertionError(f"NG: 不正入力が通った: {bad!r}")
    except rl.ParseError:
        ok += 1
print(f"  ok: 不正入力4種を拒否")

print("[next_occurrence]")
d = datetime(2026, 1, 31, 9, 0, tzinfo=JST)
check("daily", rl.next_occurrence(d, "daily") == datetime(2026, 2, 1, 9, 0, tzinfo=JST))
check("weekly", rl.next_occurrence(d, "weekly") == datetime(2026, 2, 7, 9, 0, tzinfo=JST))
check("monthly 月末クランプ", rl.next_occurrence(d, "monthly") == datetime(2026, 2, 28, 9, 0, tzinfo=JST))

print("[pending_actions]")
def rem(due, created, flags=None, last_ping=None, repeat="none", done=False):
    return {"id": 1, "due": due.isoformat(), "created_at": created.isoformat(),
            "flags": flags or {}, "last_ping": last_ping and last_ping.isoformat(),
            "repeat": repeat, "done": done}

due = NOW + timedelta(hours=20)
check("前日通知が出る", rl.pending_actions(rem(due, NOW - timedelta(days=2)), NOW) == ["day_before"])
check("登録直後は前日通知なし(期限24h未満)", rl.pending_actions(rem(due, NOW), NOW) == [])
check("期限到来", rl.pending_actions(rem(NOW - timedelta(minutes=1), NOW - timedelta(days=2), flags={"day_before": True}), NOW) == ["due"])
check("超過24hで再催促", rl.pending_actions(
    rem(NOW - timedelta(days=2), NOW - timedelta(days=5), flags={"day_before": True, "due": True},
        last_ping=NOW - timedelta(hours=25)), NOW) == ["overdue"])
check("超過でも24h未満なら沈黙", rl.pending_actions(
    rem(NOW - timedelta(days=2), NOW - timedelta(days=5), flags={"day_before": True, "due": True},
        last_ping=NOW - timedelta(hours=1)), NOW) == [])
check("done は常に空", rl.pending_actions(rem(NOW - timedelta(days=1), NOW - timedelta(days=5), done=True), NOW) == [])
check("repeat は超過催促しない", rl.pending_actions(
    rem(NOW - timedelta(days=2), NOW - timedelta(days=5), flags={"due": True},
        last_ping=NOW - timedelta(hours=48), repeat="weekly"), NOW) == [])

with tempfile.TemporaryDirectory() as td:
    print("[storage]")
    store = ReminderStore(Path(td))
    r1 = store.add({"text": "テスト", "due": NOW.isoformat(), "done": False})
    r2 = store.add({"text": "テスト2", "due": NOW.isoformat(), "done": False})
    check("連番ID", (r1["id"], r2["id"]) == (1, 2))
    check("active 2件", len(store.active()) == 2)
    store.update(1, done=True)
    check("done 後 active 1件", len(store.active()) == 1 and store.get(1)["done"])
    check("delete", store.delete(2) and store.get(2) is None)
    check("存在しないID", store.update(99, done=True) is None and not store.delete(99))

    print("[lockfile]")
    a = InstanceLock(Path(td), "host-A", takeover_after_sec=900)
    b = InstanceLock(Path(td), "host-B", takeover_after_sec=900)
    a.acquire()
    try:
        b.acquire()
        raise AssertionError("NG: 二重取得できてしまった")
    except LockBusy:
        ok += 1
        print("  ok: 生きたロックは取得拒否")
    b.acquire(force=True)
    check("force で乗っ取り可", True)
    try:
        a.heartbeat()
        raise AssertionError("NG: 乗っ取られたのにハートビートが通った")
    except LockBusy:
        ok += 1
        print("  ok: 乗っ取られた側のハートビートは失敗する")
    b.release()
    check("解放後は再取得可", (a.acquire() or True))
    a.release()

print("[mirror actions]")
with tempfile.TemporaryDirectory() as td:
    m = Path(td)
    raw = m / "discord" / "raw"
    raw.mkdir(parents=True)
    recent = datetime.now(timezone.utc).isoformat()
    old = (datetime.now(timezone.utc) - timedelta(hours=100)).isoformat()
    msgs = [
        # 発注依頼の連投は両方拾う(以前は片方を落とした)
        {"ts": recent, "author": "若葉花子", "bot": False,
         "content": "物品発注願います\nトナー&インク一式\nA4コピー用紙いっぱい"},
        {"ts": recent, "author": "若葉花子", "bot": False, "content": "カードリーダー(なる早)"},
        {"ts": recent, "author": "相生次郎", "bot": False, "content": "よろしくお願いいたします！"},  # 定型挨拶
        {"ts": old, "author": "相生次郎", "bot": False, "content": "封筒を発注しました"},           # 窓外
        {"ts": recent, "author": "IyakusaiBot", "bot": True, "content": "発注についてまとめます"},   # Bot発言
    ]
    (raw / "総務部__1.jsonl").write_text(
        "\n".join(json.dumps(x, ensure_ascii=False) for x in msgs), encoding="utf-8")
    n = mi.build_actions_index(m)
    out = (m / mi.ACTIONS_REL).read_text(encoding="utf-8")
    check("連投2件を別々に抽出", n == 2)
    check("発注願いを含む", "物品発注願います" in out)
    check("なる早の件を含む", "カードリーダー" in out)
    check("定型挨拶は拾わない", "よろしくお願いいたします" not in out)
    check("72h窓外は拾わない", "封筒を発注しました" not in out)
    check("Bot発言は拾わない", "発注についてまとめます" not in out)
    check("空ミラーでも落ちない", mi.build_actions_index(m / "empty") == 0)

    # 以前の不具合: ロールメンションの snowflake ID(19桁)が機微判定
    # \d{7,} に誤爆し、依頼メッセージがミラーから丸ごと消えていた
    kept, dropped = mi._transform_msg_line(json.dumps(
        {"ts": recent, "author": "若葉花子", "bot": False,
         "content": "<@&1000000000000000101>\\n物品発注願います\nトナー一式"}, ensure_ascii=False))
    check("ロールメンション付き依頼は落ちない", kept is not None and not dropped and "物品発注" in kept)
    # v5: 会計文脈は丸dropせず行マスクで残す(「振込」の語だけで相談が丸ごと消える
    # 過剰遮断の解消・2026-07-24)。
    # v9(設計判断): Discord/LINE/メール本文の**振込行マスクは撤去**した
    # (受取口座は請求書などで外部にも渡している情報で、委員会アーカイブの本体は
    # 金の流れの議論そのもの。LINE の見積/振込系の2割強が丸ごと落ちていた)。
    # → 本テストは v5 当時の「マスクされる」を検査したままで **2026-08-01 から失敗して
    #   おり、以降のチェックが1つも走っていなかった**(2026-08-04 に発見して更新)。
    #   現行の期待は「メッセージも番号もそのまま残る」。守りは①7桁以上の数字列 drop
    #   ②認証行マスク ③モデル指示 の3層(mirror.py の _FMT_VERSION v9 コメント参照)。
    kept, dropped = mi._transform_msg_line(json.dumps(
        {"ts": recent, "author": "x", "bot": False,
         "content": "振込先は 1234567 の口座です"}, ensure_ascii=False))
    check("振込メッセージは丸dropせず残る", kept is not None and not dropped)
    check("v9: 口座番号の行マスクは撤去済み(金融の文脈語は機微ではない)",
          "1234567" in kept and "振込先" in kept)
    kept, dropped = mi._transform_msg_line(json.dumps(
        {"ts": recent, "author": "x", "bot": False,
         "content": "連絡です パスワード: hunter2"}, ensure_ascii=False))
    check("認証情報は引き続き丸ごと落ちる", kept is None and dropped)
    kept, dropped = mi._transform_msg_line(json.dumps(
        {"ts": recent, "author": "x", "bot": False,
         "content": "<:iyakusai_fukurou:1503012345678901234> 了解です"}, ensure_ascii=False))
    check("カスタム絵文字も誤爆しない", kept is not None and not dropped)

    # v10(2026-08-03 実測のバグ): ミラーは Discord raw(ts=UTC)とメール raw(date=UTC)を
    # 素通しでコピーし、LINE raw だけ JST(+09:00) だった。案内文にもTZの記載が無く、
    # エージェントが **UTC の数字にそのまま「JST」ラベルを付けて回答**していた
    # (夕方の会議を「午前中に開催」と答える誤り)。
    check("tz: UTC → JST(+9h)", mi._to_jst("2026-08-03T09:57:00.000000+00:00") == "2026-08-03 18:57")
    check("tz: Z 表記も読める", mi._to_jst("2026-08-03T05:54:46.000Z") == "2026-08-03 14:54")
    check("tz: 既に JST(+09:00) なら値は変わらない",
          mi._to_jst("2026-07-30T16:15+09:00") == "2026-07-30 16:15")
    check("tz: naive は UTC とみなす", mi._to_jst("2026-08-03T09:57:00") == "2026-08-03 18:57")
    check("tz: 壊れた値・空は None(落ちない)",
          mi._to_jst("not-a-date") is None and mi._to_jst("") is None)
    kept, _ = mi._transform_msg_line(json.dumps(
        {"ts": "2026-08-03T09:57:00.000000+00:00", "author": "x", "bot": False,
         "content": "議事録のリンクです"}, ensure_ascii=False))
    obj = json.loads(kept)
    check("tz: メッセージに ts_jst が付く", obj.get("ts_jst") == "2026-08-03 18:57")
    check("tz: ts は UTC のまま(build_actions_index が読む)",
          obj.get("ts") == "2026-08-03T09:57:00.000000+00:00")
    blk, _ = mi._transform_mail_line(json.dumps(
        {"date": "2026-08-03T05:54:46.000Z", "from": "a@b.jp", "to": "c@d.jp",
         "subject": "件名", "body": "本文", "attachments": []}, ensure_ascii=False))
    check("tz: メールの === 行が JST 表記になる", blk.startswith("=== 2026-08-03 14:54 JST |"))
    check("tz: エージェント案内文が ts_jst を指示している",
          "ts_jst" in mi.CLAUDE_MD and "UTC" in mi.CLAUDE_MD)

print("[haiku 前処理・モーラ]")
from iyakusai_bot import haiku_logic as hk

check("拗音は数えない", hk.count_mora("キャク") == 2)
check("促音・撥音・長音は1拍", hk.count_mora("ガッコー") == 4 and hk.count_mora("ホン") == 2)
check("カタカナ以外の読みは判定不能", hk.count_mora("A") == -1 and hk.count_mora("") == -1)
check("URL・メンション・コードは落とす",
      hk.sentences("見て <@123> https://a.example/b `code` これ") == ["見て これ"])
check("文末記号で分割", hk.sentences("あれは何。これは何？") == ["あれは何", "これは何"])
check("候補は節の連続(文の途中からは切り出さない)",
      sorted(hk.candidates("会場の下見に行き、写真を撮ってきました"))
      == sorted(["会場の下見に行き", "写真を撮ってきました", "会場の下見に行き写真を撮ってきました"]))
check("短すぎ・長すぎは候補にしない", hk.candidates("了解です") == [])


def _tok(spec):
    """(表記, 読み, 品詞大, 品詞中) から Token 列を作る(Sudachi 無しで境界判定を試す)。"""
    return [hk.Token(s, r, p1, p2, hk.count_mora(r)) for s, r, p1, p2 in spec]


ku = _tok([("古池", "フルイケ", "名詞", "普通名詞"), ("や", "ヤ", "助詞", "係助詞"),
           ("蛙", "カワズ", "名詞", "普通名詞"), ("飛び込む", "トビコム", "動詞", "一般"),
           ("水", "ミズ", "名詞", "普通名詞"), ("の", "ノ", "助詞", "格助詞"),
           ("音", "オト", "名詞", "普通名詞")])
check("5/7/5 が形態素境界に一致すれば3句に割れる",
      [len(k) for k in hk._split_at_boundaries(ku)] == [2, 2, 3])
straddle = _tok([("食べ物", "タベモノ", "名詞", "普通名詞"), ("が", "ガ", "助詞", "格助詞"),
                 ("多い", "オオイ", "形容詞", "一般"), ("会場", "カイジョウ", "名詞", "普通名詞"),
                 ("だ", "ダ", "助動詞", "*")])
check("語の途中で境界をまたぐものは不採用", hk._split_at_boundaries(straddle) is None)
check("句頭の助詞・助動詞・非自立は弾く",
      hk._bad_head(ku[1]) and not hk._bad_head(ku[0]))
check("破調は6型(上中下 × 字余り/字足らず)",
      len(hk.HACHOU_PATTERNS) == 6 and hk.HACHOU_PATTERNS[(5, 8, 5)] == "字余り(中)")
check("18拍に当たる型は3つ、17拍なら定型のみ",
      len(hk._patterns_for(18, True)) == 3 and hk._patterns_for(17, True) == [((5, 7, 5), "定型")])
check("破調を許さなければ17拍以外は候補なし", hk._patterns_for(18, False) == [])

names = {"by_id": {"111": "若葉花子"}, "by_name": {"SampleHandle": "椿野 里奈"}}
check("実名: user_id を最優先(改名に強い)",
      hk.real_name({"author_id": "111", "author": "ExampleUser"}, names) == "若葉花子")
check("実名: id が無ければ名前で引く",
      hk.real_name({"author": "SampleHandle"}, names) == "椿野 里奈")
check("実名: 対応表に無ければ元の名前のまま",
      hk.real_name({"author": "誰か"}, names) == "誰か"
      and hk.real_name({}, {"by_id": {}, "by_name": {}}) == "?")

if hk.Analyzer().available:
    az = hk.Analyzer()
    h = hk.detect("古池や蛙飛び込む水の音", az, 0)
    check("実解析: 5-7-5 を検出",
          h is not None and h.ku == ("古池や", "蛙飛び込む", "水の音") and h.pattern == hk.TEIKEI)
    check("実解析: 5-7-5 でない文は None", hk.detect("その企画は予算が足りない", az, 0) is None)
    check("実解析: 数字を含む文は対象外", hk.detect("7月20日に集合してください", az, 0) is None)
    # Sudachi は ':' に「キゴウ」(3拍)を返す。記号が残ると拍数が水増しされる
    check("実解析: 記号は拍数を水増ししない",
          az.tokenize("イベント情報:店舗名") is None
          and sum(t.mora for t in az.tokenize(hk._clean("イベント情報:店舗名"))) == 13)
    hh = hk.detect("福島に負ける美しい県香川", az, 0)
    check("実解析: 破調(字余り)を拾う", hh is not None and hh.pattern == "字余り(中)")
    check("実解析: 破調を許さなければ拾わない",
          hk.detect("福島に負ける美しい県香川", az, 0, allow_hachou=False) is None)
else:
    print("  skip: SudachiPy 未導入のため実解析テストは省略")

print("[haiku react(Cog の出し分け)]")
# Discord には繋がず、message/bot をスタブにして on_message をそのまま通す。
# 「reply を出さずに🎋だけ付ける」「付けられなかったら記録もしない(=次も再挑戦できる)」
# といった react モード固有の分岐は haiku_logic 側のテストでは拾えないため、ここで見る。
import asyncio
import types

import discord
from iyakusai_bot.haiku import REACT_EMOJI, Haiku, HaikuStore


class _Ch:
    def __init__(self, name="雑談", cid=1):
        self.name, self.id, self.parent = name, cid, None

    def permissions_for(self, role):
        return types.SimpleNamespace(read_messages=True)


class _Au:
    def __init__(self, uid=111, name="委員 太郎", is_bot=False):
        self.id, self.bot = uid, is_bot
        self.display_name = self.name = name


class _Msg:
    def __init__(self, content, channel=None, author=None):
        self.content, self.channel, self.author = content, channel or _Ch(), author or _Au()
        self.guild = types.SimpleNamespace(default_role=object())
        self.id, self.jump_url = 999, "https://discord.com/x"
        self.reactions, self.replies = [], []

    async def add_reaction(self, emoji):
        self.reactions.append(emoji)

    async def reply(self, *a, **k):
        self.replies.append(a)


def _cog(store, **over):
    base = dict(haiku_enabled=True, haiku_mode="react", haiku_channel_id=None,
                haiku_min_score=60, haiku_daily_limit=15, haiku_allow_hachou=True,
                haiku_public_only=True, haiku_blocklist=["機微な連絡"], knowledge_dir=None)
    c = Haiku.__new__(Haiku)          # Cog のメタクラス初期化を避けて __init__ 相当だけ行う
    Haiku.__init__(c, types.SimpleNamespace(get_channel=lambda cid: None),
                   store, types.SimpleNamespace(**{**base, **over}))
    return c


if hk.Analyzer().available:
    _store = HaikuStore(Path(tempfile.mkdtemp()))
    _c = _cog(_store)

    async def _react_cases():
        m = _Msg("柿食えば鐘が鳴るなり法隆寺")
        await _c.on_message(m)
        check("react: 🎋 を1つ付ける", m.reactions == [REACT_EMOJI])
        check("react: テキスト返信はしない", m.replies == [])
        check("react: 検出を store に記録する", len(_store.all()) == 1)

        m = _Msg("柿食えば鐘が鳴るなり法隆寺")
        await _c.on_message(m)
        check("react: 同じ句には二度反応しない", m.reactions == [])

        m = _Msg("今日の会議は18時からです、資料お願いします")
        await _c.on_message(m)
        check("react: 5-7-5 でなければ無反応", m.reactions == [])

        m = _Msg("柿食えば鐘が鳴るなり法隆寺", author=_Au(222, "IyakusaiBot", is_bot=True))
        await _c.on_message(m)
        check("react: Bot自身の発言は対象外", m.reactions == [])

        m = _Msg("柿食えば鐘が鳴るなり法隆寺", channel=_Ch("機微な連絡", 2))
        await _c.on_message(m)
        check("react: 機微CH(blocklist)は対象外", m.reactions == [])

        _store.set_optout(333, True)
        m = _Msg("柿食えば鐘が鳴るなり法隆寺", author=_Au(333, "抜けたい人"))
        await _c.on_message(m)
        check("react: optout ユーザーは対象外", m.reactions == [])

        # ADD_REACTIONS が無いCHでも受信処理を壊さず、記録も残さない
        before = len(_store.all())
        m = _Msg("春の海ひねもすのたりのたりかな")

        async def _forbidden(_):
            raise discord.Forbidden(types.SimpleNamespace(status=403, reason=""), "no perm")

        m.add_reaction = _forbidden
        await _c.on_message(m)
        check("react: 権限が無くても例外を投げない", True)
        check("react: 付けられなければ記録しない", len(_store.all()) == before)

        c2 = _cog(_store, haiku_daily_limit=1)
        m = _Msg("春の海ひねもすのたりのたりかな")
        await c2.on_message(m)
        check("react: 日次上限に達したら無反応", m.reactions == [])

        # digest/both は転記先が解決できないとき何もしない(react の早期returnと混ざらないこと)
        c3 = _cog(_store, haiku_mode="digest")
        m = _Msg("春の海ひねもすのたりのたりかな")
        await c3.on_message(m)
        check("digest: 転記先が無ければ何もしない", m.reactions == [] and m.replies == [])

    asyncio.run(_react_cases())
else:
    print("  skip: SudachiPy 未導入のため react テストは省略")

print("[elapsed_note]")
import time as _time
from iyakusai_bot.ai_provider import elapsed_note
check("10秒未満は小数1桁", elapsed_note(_time.time() - 3.24).startswith("⏱3.2"))
check("10秒以上は整数", elapsed_note(_time.time() - 42.6) in ("⏱42秒", "⏱43秒"))
check("負にならない(時計ずれ耐性)", elapsed_note(_time.time() + 5) == "⏱0.0秒")

print("[主語欠落ガード]")
# 誤答対策。主語の無い「やらないといけないことを列挙して」に対し、
# Bot が個人名入りの催促スレッドの digest から別の委員の課題一覧を二人称で返した。
# 発火条件は **機械判定**(is_personal_scope かつ人名条件なし)なのでここで固定する。
from iyakusai_bot.ai_provider import SUBJECT_GUARD, build_agent_prompt, build_prompt
from iyakusai_bot.query_fields import is_personal_scope

check("事故文そのもの: やらないといけないこと→タスク形", is_personal_scope("やらないといけないことを列挙して"))
check("タスク", is_personal_scope("今日のタスクは？"))
check("ToDo(大小・ハイフン)", is_personal_scope("ToDoある？") and is_personal_scope("to-do教えて"))
check("積み残し/やり残し", is_personal_scope("積み残しは？") and is_personal_scope("やり残しある？"))
check("マター", is_personal_scope("現状のマターをまとめて"))
check("非タスク質問では立たない: 書類の所在", not is_personal_scope("保険に関する書類はどこ？"))
check("非タスク質問では立たない: 議事まとめ", not is_personal_scope("8/5の議事まとめ"))

check("ガード本文に二人称の禁止がある", "二人称" in SUBJECT_GUARD)
check("ガード本文に誰の分か明示の指示がある", "誰の分" in SUBJECT_GUARD)
check("one-shot: True で差さる", SUBJECT_GUARD in build_prompt("q", "ctx", subject_guard=True))
check("one-shot: 既定では差さらない", SUBJECT_GUARD not in build_prompt("q", "ctx"))
check("agent: True で差さる", SUBJECT_GUARD in build_agent_prompt("q", subject_guard=True))
check("agent: 既定では差さらない", SUBJECT_GUARD not in build_agent_prompt("q"))
# 常設ルール(発火条件に関係なく常に載る側)も消えていないこと
from iyakusai_bot.ai_provider import SYSTEM_INSTRUCTIONS
from iyakusai_bot.mirror import CLAUDE_MD
check("SYSTEM_INSTRUCTIONS に常設ルールがある", "質問文に人名が無いとき" in SYSTEM_INSTRUCTIONS)
check("CLAUDE.md に常設ルールがある", "質問文に人名が無いとき" in CLAUDE_MD)

print(f"\n全 {ok} 項目 PASS")
