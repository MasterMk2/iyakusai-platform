# -*- coding: utf-8 -*-
"""著者表示名(サーバーニックネーム)対応表の生成/更新。

raw の各メッセージは author に Discord の global_name(アカウント表示名。例:「ExampleUser」)を
保存している。委員会内で見慣れた名前(サーバーニックネーム。例:「山田花子」)で表示するため、
    author_id(不変) / global_name(可変) -> サーバーニックネーム
の対応表を ../raw/_authors.json に書き出す。knowledge_search がこれを読み、/ask の
Discord 抜粋・回答の著者名を置換する(raw 本文は書き換えない=非破壊)。

★改名に強い設計:
  Discord の global_name(表示名)は本人が変更できる。変わらないのは user_id と
  サーバーニックネーム(本名)。そこで本ツールは **user_id を軸(people)** に対応表を持ち、
  実行のたびに **過去に見た global_name を蓄積(マージ)** する。改名しても
  「旧名・新名の両方 → 同じニックネーム」に解決できる。knowledge_search は
  新規メッセージを **不変の author_id** で引く(=改名の影響を受けない)。過去ログ
  (author_id 未保存)は global_name で引く=蓄積済みの名前履歴でカバーする。

出力 _authors.json のスキーマ(v2):
  {
    "version": 2,
    "generated": "YYYY-MM-DD",
    "people": { "<user_id>": {"nick": "山田花子", "names": ["ExampleUser", "exampleuser", ...]} , ... },
    "aliases": { "ExampleUser": "山田花子", "exampleuser": "山田花子", ... }
                # people から導出した名前→ニックの平坦表(過去ログ・digest置換・人間閲覧用)。
                # names/aliases には global_name に加え username(ハンドル)も蓄積する
                # (bot/data/ai_usage.jsonl はハンドル記帳のため。2026-07-21 拡張)
  }

仕組み:
  - メッセージ payload には per-server の nick が入らない(アカウント名しか無い)ため、
    全チャンネル/スレッドの直近メッセージから著者の user_id を集め、
    GET /guilds/{gid}/members/{uid}(特権インテント不要)で nick を解決する。
  - 離脱者は 404。既存 people に登録済みなら残す(過去ログの名前は引き続き解決可)。
  - nick が無い/global_name と同じ人は aliases に載せない(そのまま表示で問題ない)。

読み取り専用: Discord へは GET しか行わない(collect_discord_v2.py と同じ姿勢)。
使い方:
    $env:PYTHONIOENCODING = "utf-8"
    py build_author_aliases.py
トークンは collect_discord_v2.py と同じ経路(環境変数 DISCORD_TOKEN / DISCORD_TOKEN_FILE / ホームの中のファイル)。
委員がニックネームや表示名を変えたら再実行すれば追従する(既存表にマージ)。
"""

import json
import os
import sys
import time
import urllib.request
import urllib.error
from datetime import date
from pathlib import Path

_CANDIDATES = [
    os.environ.get("DISCORD_TOKEN_FILE", ""),
    str(Path.home() / ".iyakusai" / "discord-token.env"),
    str(Path.home() / ".discord_bot_token.txt"),
]
TOKEN_FILE = next((p for p in _CANDIDATES if p and Path(p).exists()), _CANDIDATES[1])

API = "https://discord.com/api/v10"
RAW_DIR = Path(__file__).resolve().parent.parent / "raw"
OUT = RAW_DIR / "_authors.json"
ROLES_OUT = RAW_DIR / "_roles.json"   # ロールID -> ロール名(本文の <@&ID> 解決用)
PAGES_PER_CHANNEL = 3  # 100件 x N ページ。取りこぼしを減らすなら増やす。


def load_token() -> str:
    env_tok = os.environ.get("DISCORD_TOKEN")
    if env_tok and env_tok.strip():
        return env_tok.strip()
    p = Path(TOKEN_FILE)
    if not p.exists():
        sys.exit(f"トークンファイルが見つかりません: {p}")
    text = p.read_text(encoding="utf-8-sig").strip()
    if "=" in text:
        for line in text.splitlines():
            if "TOKEN" in line.upper() and "=" in line:
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return text


def api_get(path: str, token: str):
    """GET のみ。429/一過性切断は待って再試行。403/404 は数値コードを返す。"""
    for _ in range(8):
        req = urllib.request.Request(API + path, headers={
            "Authorization": f"Bot {token}",
            "User-Agent": "iyakusai-archive-bot (private, 1.0)",
        })
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                data = json.loads(r.read().decode("utf-8"))
                if r.headers.get("X-RateLimit-Remaining") == "0":
                    time.sleep(float(r.headers.get("X-RateLimit-Reset-After", "1")) + 0.1)
                return data
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(float(json.loads(e.read().decode("utf-8")).get("retry_after", 2)) + 0.5)
                continue
            if e.code in (403, 404):
                return e.code
            raise
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            time.sleep(1.5)
            continue
    return None


def list_threads(gid: str, text_channels: list, token: str) -> list:
    threads = {}
    active = api_get(f"/guilds/{gid}/threads/active", token)
    if isinstance(active, dict):
        for t in active.get("threads", []):
            threads[t["id"]] = t
    for ch in text_channels:
        before = None
        while True:
            q = f"/channels/{ch['id']}/threads/archived/public?limit=100" + (
                f"&before={before}" if before else "")
            page = api_get(q, token)
            if not isinstance(page, dict):
                break
            ths = page.get("threads", [])
            for t in ths:
                threads[t["id"]] = t
            if not page.get("has_more") or not ths:
                break
            before = ths[-1].get("thread_metadata", {}).get("archive_timestamp")
    return list(threads.values())


def load_existing() -> tuple[dict, dict]:
    """既存 _authors.json を (people, aliases) で返す。v1(平坦 {name:nick})も読める。"""
    if not OUT.exists():
        return {}, {}
    try:
        data = json.loads(OUT.read_text(encoding="utf-8-sig"))
    except (json.JSONDecodeError, OSError):
        return {}, {}
    if isinstance(data, dict) and "people" in data:  # v2
        people = {str(k): v for k, v in data.get("people", {}).items()}
        aliases = {str(k): str(v) for k, v in data.get("aliases", {}).items()}
        return people, aliases
    if isinstance(data, dict):  # v1 平坦 {name: nick}。名前履歴として温存(id は不明)。
        aliases = {str(k): str(v) for k, v in data.items()}
        return {}, aliases
    return {}, {}


def main():
    token = load_token()
    guilds = api_get("/users/@me/guilds", token)
    if not isinstance(guilds, list) or not guilds:
        sys.exit("Bot が参加しているサーバーがありません。")

    people, aliases = load_existing()  # 既存を土台にマージ(改名時に旧名を失わない)

    # 1) 全チャンネル/スレッドの直近から author_id -> 見かけた名前(global_name と
    #    username の両方)を収集。username(ハンドル)も names に蓄積することで、
    #    bot/data/ai_usage.jsonl(str(itx.user)=ハンドルで記帳)からも実名を引ける
    #    (例: handle1234 -> 山田花子)。
    id2names: dict[str, set[str]] = {}
    for g in guilds:
        gid = g["id"]
        channels = api_get(f"/guilds/{gid}/channels", token)
        channels = channels if isinstance(channels, list) else []
        text_channels = [c for c in channels if c.get("type") in (0, 5)]
        targets = [c["id"] for c in text_channels]
        targets += [th["id"] for th in list_threads(gid, text_channels, token)]
        print(f"サーバー: {g['name']} — {len(targets)} チャンネル/スレッドを走査")
        for cid in targets:
            before = None
            for _ in range(PAGES_PER_CHANNEL):
                q = f"/channels/{cid}/messages?limit=100" + (f"&before={before}" if before else "")
                msgs = api_get(q, token)
                if not isinstance(msgs, list) or not msgs:
                    break
                for m in msgs:
                    a = m["author"]
                    seen = id2names.setdefault(a["id"], set())
                    for nm in (a.get("global_name"), a.get("username")):
                        if nm:
                            seen.add(nm)
                before = msgs[-1]["id"]
                if len(msgs) < 100:
                    break
        print(f"  著者(distinct user id): {len(id2names)}")

        # 2) user_id -> nick を解決し people にマージ(名前は蓄積・nick は最新で更新)
        for uid, seen in id2names.items():
            mem = api_get(f"/guilds/{gid}/members/{uid}", token)
            if mem == 404:      # 離脱者。既存 people はそのまま残す。
                continue
            if not isinstance(mem, dict):
                continue
            u = mem.get("user") or {}
            for nm in (u.get("global_name"), u.get("username")):
                if nm:
                    seen.add(nm)
            # nick 未設定なら表示名(無ければハンドル)をそのまま採用
            nick = mem.get("nick") or u.get("global_name") or u.get("username") \
                or sorted(seen)[0]
            entry = people.get(uid, {"nick": nick, "names": []})
            entry["nick"] = nick
            names = set(entry.get("names", []))
            names.update(seen)
            entry["names"] = sorted(names)
            people[uid] = entry

    # 3) people から平坦 aliases を導出(既存 aliases に上書きマージ=離脱者の旧名も温存)
    for uid, entry in people.items():
        nick = entry["nick"]
        for nm in entry.get("names", []):
            if nm and nm != nick:
                aliases[nm] = nick
    # nick と同名になった別名は除去(表示上ノイズなだけ)
    aliases = {k: v for k, v in aliases.items() if k != v}

    out = {
        "version": 2,
        "generated": date.today().isoformat(),
        "people": dict(sorted(people.items())),
        "aliases": dict(sorted(aliases.items())),
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")

    # ロール名(本文の `<@&ID>` を「@役員会」等に戻すため)。2026-08-09 追加。
    # raw には数値のまま残り、解決しないと「誰に向けた発言か」が消える(実測112回)。
    try:
        roles = api_get(f"/guilds/{gid}/roles", token) or []
        rmap = {str(r["id"]): str(r.get("name", "")) for r in roles
                if r.get("name") and r.get("name") != "@everyone"}
        ROLES_OUT.write_text(
            json.dumps({"version": 1, "generated": date.today().isoformat(),
                        "roles": dict(sorted(rmap.items()))},
                       ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"書き出し: roles {len(rmap)}件 -> {ROLES_OUT}")
    except Exception as e:                      # ロールが取れなくても本体は成功扱い
        print(f"⚠ ロール取得に失敗(既存の _roles.json は据え置き): {e}")

    print(f"\n書き出し: people {len(people)}人 / aliases {len(aliases)}件 -> {OUT}")
    for nm, nick in sorted(aliases.items()):
        print(f"  {nm!r} -> {nick!r}")


if __name__ == "__main__":
    main()
