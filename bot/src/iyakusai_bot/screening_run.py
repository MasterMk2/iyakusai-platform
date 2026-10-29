# -*- coding: utf-8 -*-
"""定期タスクスクリーニングの実行(systemd タイマーから 1 回ずつ起動する)。

    python -m iyakusai_bot.screening_run --config ~/.iyakusai/task-screening/config.json
    python -m iyakusai_bot.screening_run --config ... --dry-run            # 書き込み・カーソル更新なし
    python -m iyakusai_bot.screening_run --config ... --dry-run --lookback-hours 12
    python -m iyakusai_bot.screening_run --config ... --followup           # 差し戻しの修正と判定記録だけ

Bot 本体・Discord Gateway は起動しない。Discord への投稿と起票は Bot の TaskScreening Cog が
候補台帳を見て行う。ここでは「読む → AI で候補を拾う → 検証・重複判定 → 台帳と日次レポートに書く」と、
差し戻された候補の修正版づくり・判定記録(判定記録.tsv)の書き出しを行う。
"""

from __future__ import annotations

import argparse
import fcntl
import json
import logging
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path

from .screening_logic import (
    JST, Candidate, KnownTask, Limits, Message, NameBook, ReturnItem, Route, SourceRules, advance_cursor,
    build_prompt, build_revision_prompt, chunk_inventory, decide, extract_json, extract_json_object,
    parse_revisions, parse_ts,
    read_discord, read_inventory, read_mail, select_batch, strip_source_tail, tags_label, validate,
)
from .screening_store import ScreeningStore

log = logging.getLogger("iyakusai.screening")

# 純テキスト生成なのでツールは全部止める(ai_provider._ONESHOT_DENIED_TOOLS と同じ考え方)。
DENIED_TOOLS = ("Bash,Edit,MultiEdit,Write,NotebookEdit,Read,Glob,Grep,WebFetch,WebSearch,Task,"
                "TodoWrite,BashOutput,KillShell,SlashCommand,ExitPlanMode")
STATUS_LABELS = {"todo": "未着手", "in_progress": "進行中", "blocked": "保留", "done": "完了"}
STATE_LABELS = {"new": "未投稿", "publishing": "投稿中", "posted": "承認待ち", "creating": "起票中",
                "created": "起票済み", "rejected": "不要", "returned": "差し戻し", "revised": "修正版あり",
                "undoing": "取消中", "undone": "誤起票", "failed": "失敗"}
ACTION_LABELS = {"auto": "自動起票", "ok": "起票", "ng": "不要", "return": "差し戻し",
                 "undo": "誤起票として閉じた", "revised": "修正版を投稿"}
DECISIONS_FILE = "判定記録.tsv"
SOURCE_TEXT_MAX = 400


def load_config(path: Path) -> dict:
    cfg = json.loads(path.read_text(encoding="utf-8"))
    for key in ("guild_id", "discord_raw_dir", "task_db", "store_path", "routes"):
        if key not in cfg:
            raise SystemExit(f"設定に {key} がありません")
    return cfg


def routes_from(cfg: dict) -> list[Route]:
    routes = [Route(key=r["key"], label=r["label"], channel_id=int(r["channel_id"]), scope=r.get("scope", ""))
              for r in cfg["routes"]]
    if not routes or len({r.key for r in routes}) != len(routes):
        raise SystemExit("routes の key が空か重複しています")
    return routes


def existing_tasks(db: Path, guild_id: int, routes: list[Route]) -> list[KnownTask]:
    """/todo の SQLite を読み取り専用で開き、既存タスクを返す(書き込みは一切しない)。"""
    if not db.is_file():
        return []
    con = sqlite3.connect(f"{db.resolve().as_uri()}?mode=ro", uri=True, timeout=5)
    try:
        # 形式 2(2026-10-14〜): 部局タグ。ラベルは部局名
        rows = con.execute("SELECT t.title, t.status, t.deadline, group_concat(g.tag) FROM tasks t "
                           "LEFT JOIN task_tags g ON g.task_id = t.id WHERE t.guild_id=? GROUP BY t.id",
                           (guild_id,)).fetchall()
    finally:
        con.close()
    return [KnownTask(tags_label([t for t in (tags or "").split(",") if t]) or "部局なし", title,
                      STATUS_LABELS.get(st, st), dl, "task") for title, st, dl, tags in rows]


def ask_claude(prompt: str, conf: dict) -> str:
    exe = shutil.which(conf.get("command", "claude"))
    if not exe:
        raise RuntimeError("Claude Code CLI が見つかりません")
    args = [exe, "-p", "--model", conf.get("model", "opus"), "--output-format", "json",
            "--disallowedTools", DENIED_TOOLS]
    if conf.get("effort"):
        args += ["--effort", conf["effort"]]
    # 空の作業ディレクトリで動かす(CLAUDE.md 等を読み込ませない)
    with tempfile.TemporaryDirectory(prefix="iyk-screen-") as cwd:
        proc = subprocess.run(args, input=prompt.encode("utf-8"), capture_output=True, cwd=cwd,
                              timeout=int(conf.get("timeout_sec", 900)))
    raw = proc.stdout.decode("utf-8", "replace").strip()
    if proc.returncode != 0:
        raise RuntimeError(f"CLI 異常終了 (code={proc.returncode}): {raw[:300] or proc.stderr[:300]!r}")
    try:
        outer = json.loads(raw)
    except ValueError as e:
        raise RuntimeError(f"CLI の出力が JSON ではありません: {raw[:200]!r}") from e
    if outer.get("is_error") or outer.get("subtype") not in (None, "success"):
        raise RuntimeError(f"CLI がエラーを返しました: {str(outer.get('result'))[:300]}")
    return str(outer.get("result") or "")


def source_json(c: Candidate) -> str:
    # 本文の抜粋も残す(差し戻しの修正版を作るとき、AI に根拠を見せるため)
    return json.dumps([{"kind": m.kind, "source": m.source, "ts": m.ts.isoformat(), "author": m.author,
                        "link": m.link, "text": m.text[:SOURCE_TEXT_MAX]} for m in c.refs], ensure_ascii=False)


def store_row(c: Candidate, revision_of: int | None = None) -> dict:
    from .screening_logic import task_description
    return {
        "fingerprint": c.fp, "route_key": c.route.key, "route_label": c.route.label,
        "channel_id": c.route.channel_id, "title": c.title, "description": task_description(c),
        "purpose": c.purpose, "deliverable": c.deliverable, "completion_criteria": c.completion_criteria,
        "open_questions": c.open_questions, "assignee_name": c.assignee_name,
        "assignee_id": int(c.assignee_id) if c.assignee_id else None, "deadline": c.deadline,
        "confidence": c.confidence, "decision": c.decision, "decision_note": c.decision_note,
        "reason": c.reason, "sources": source_json(c), "revision_of": revision_of,
        "tags": json.dumps(list(c.tags or (c.route.key,))),
    }


# ---------------------------------------------------------------- 差し戻し・判定記録

def _source_text(cfg: dict, src: dict) -> str:
    """根拠の本文。台帳に抜粋があればそれ、無ければ(初期の候補)raw から探す。見つからなければ空。"""
    if src.get("text"):
        return str(src["text"])
    link = str(src.get("link", ""))
    try:
        if src.get("kind") == "discord":
            m = re.search(r"/channels/\d+/(\d+)/(\d+)$", link)
            if m:
                for path in Path(cfg["discord_raw_dir"]).glob(f"*__{m.group(1)}.jsonl"):
                    with path.open(encoding="utf-8") as fh:
                        for line in fh:
                            if f'"{m.group(2)}"' in line:
                                return str(json.loads(line).get("content") or "")[:SOURCE_TEXT_MAX]
        elif src.get("kind") == "inventory" and cfg.get("initial_inventory"):
            inv = cfg["initial_inventory"]
            for it in read_inventory(Path(inv["path"]), inv["rel"], datetime.fromisoformat(inv["as_of"]),
                                     tuple(inv.get("sections", INVENTORY_SECTIONS))):
                if it.link == link:
                    return it.text[:SOURCE_TEXT_MAX]
        elif src.get("kind") == "mail" and cfg.get("mail_raw_dir"):
            mid = link.removeprefix("mail:")
            for path in sorted(Path(cfg["mail_raw_dir"]).glob("mail_*.jsonl"), reverse=True)[:3]:
                with path.open(encoding="utf-8") as fh:
                    for line in fh:
                        if f'"{mid}"' in line:
                            rec = json.loads(line)
                            return f"件名: {rec.get('subject', '')} {str(rec.get('body') or '')[:300]}"
    except (OSError, ValueError):
        pass
    return ""


def return_items(cfg: dict, store: ScreeningStore, routes: list[Route], book: NameBook) -> list[ReturnItem]:
    by_key = {r.key: r for r in routes}
    items: list[ReturnItem] = []
    n = 0
    for c in store.returned():
        refs = []
        for s in c.source_list[:4]:
            n += 1
            refs.append(Message(ref=f"R{n}", kind=str(s.get("kind", "")), source=str(s.get("source", "")),
                                trusted=False, ts=parse_ts(s.get("ts", "")) or datetime.now(timezone.utc),
                                author=str(s.get("author", "")), text=_source_text(cfg, s),
                                link=str(s.get("link", "")), file_key=""))
        route = by_key.get(c.route_key) or Route(c.route_key, c.route_label, c.channel_id, "")
        items.append(ReturnItem(
            cid=c.id, route=route, tags=tuple(c.tag_list), title=c.title, deadline=c.deadline, assignee_name=c.assignee_name,
            description=strip_source_tail(c.description), purpose=c.purpose, deliverable=c.deliverable,
            completion_criteria=c.completion_criteria, open_questions=c.open_questions,
            comment=c.comment or "", commenter=book.display(str(c.decided_by or ""), "委員"), refs=refs))
    return items


def revise_returned(cfg: dict, store: ScreeningStore, routes: list[Route], book: NameBook,
                    now: datetime) -> tuple[int, int]:
    """差し戻された候補の修正版を AI に作らせ、承認待ちとして台帳に入れる。戻り値: (直した件数, 新しい候補数)。"""
    items = return_items(cfg, store, routes, book)
    if not items:
        return 0, 0
    run_id = store.start_run()
    try:
        data = extract_json_revisions(ask_claude(build_revision_prompt(items, routes, now, cfg.get("calendar_note", "")),
                                                 cfg.get("claude", {})))
        result = parse_revisions(data, items, routes, book, now)
    except Exception as e:  # noqa: BLE001  直せなかった候補は差し戻しのまま残し、次回やり直す
        log.error("差し戻しの修正版づくりに失敗: %s", e)
        store.finish_run(run_id, "error", messages=len(items), note=f"差し戻し: {str(e)[:400]}")
        return 0, 0
    revised = created = 0
    for cid, (cands, note) in result.items():
        new_ids = [i for i in (store.add(run_id, store_row(c, revision_of=cid)) for c in cands) if i]
        if new_ids and store.mark_revised(cid, new_ids, note):
            revised += 1
            created += len(new_ids)
    store.finish_run(run_id, "ok", messages=len(items), candidates=created, review=created,
                     note=f"差し戻し {revised}/{len(items)} 件を修正")
    log.info("差し戻し %d 件を修正し、修正版 %d 件を出しました(未処理 %d 件)", revised, created, len(items) - revised)
    return revised, created


def extract_json_revisions(text: str) -> dict:
    return extract_json_object(text, "revisions")


def _cell(value) -> str:
    return "" if value is None else re.sub(r"[\t\r\n]+", " ", str(value)).strip()


def export_decisions(store: ScreeningStore, book: NameBook, report_dir: Path | None) -> Path | None:
    """判定の記録を共有ドライブの判定記録.tsv に書き出す(毎回すべて書き直す。元は候補台帳)。"""
    if report_dir is None:
        return None
    cands = store.candidates_by_id()
    lines = ["日時\t候補番号\t部署\tタイトル\t判定\t判定者\tコメント\tタスク番号\t関連候補"]
    for d in store.decisions():
        c = cands.get(d.candidate_id)
        if d.action == "auto":
            who = "IyakusaiBot（自動）"
        elif d.action == "revised":
            who = "AI（修正版）"
        else:
            who = book.display(str(d.actor_id or ""), str(d.actor_id or "不明"))
        at = parse_ts(d.at)
        lines.append("\t".join(_cell(v) for v in (
            at.astimezone(JST).strftime("%Y-%m-%d %H:%M") if at else d.at, d.candidate_id,
            c.route_label if c else "", c.title if c else "", ACTION_LABELS.get(d.action, d.action), who,
            d.comment, d.task_number, d.related)))
    report_dir.mkdir(parents=True, exist_ok=True)
    path = report_dir / DECISIONS_FILE
    tmp = report_dir / f".{DECISIONS_FILE}.tmp"
    tmp.write_text("\n".join(lines) + "\n", encoding="utf-8")
    os.replace(tmp, path)
    return path


def followup(cfg: dict, store: ScreeningStore, routes: list[Route], book: NameBook, now: datetime) -> None:
    revise_returned(cfg, store, routes, book, now)
    try:
        export_decisions(store, book, Path(cfg["report_dir"]) if cfg.get("report_dir") else None)
    except OSError as e:
        log.warning("判定記録を書けませんでした: %s", type(e).__name__)


def write_report(report_dir: Path | None, now: datetime, batch: list[Message], cands: list[Candidate],
                 notes: list[str], dry_run: bool, added: dict[str, int | None], title: str = "") -> Path | None:
    if report_dir is None:
        return None
    local = now.astimezone(JST)
    report_dir.mkdir(parents=True, exist_ok=True)
    path = report_dir / f"{local:%Y-%m-%d}.md"
    new_count = sum(1 for m in batch if not m.context)
    sources = sorted({m.source for m in batch if not m.context})
    lines = [f"\n## {local:%H:%M} {title or 'の実行'}{'(試運転・台帳には書いていない)' if dry_run else ''}\n",
             f"- 読んだ{'行' if title else '新着'}: {new_count} 件（{len(sources)} か所: {'、'.join(sources[:12])}{' ほか' if len(sources) > 12 else ''}）"]
    groups = {"auto": "自動起票", "review": "部署の承認待ち", "drop": "見送り"}
    for key, title in groups.items():
        items = [c for c in cands if c.decision == key]
        lines.append(f"- {title}: {len(items)} 件")
    for key, title in groups.items():
        items = [c for c in cands if c.decision == key]
        if not items:
            continue
        lines.append(f"\n### {title}\n")
        for c in items:
            dl = f"／期限 {c.deadline}" if c.deadline else ""
            who = f"／担当候補 {c.assignee_name}" if c.assignee_name else ""
            mark = ""
            if not dry_run and key != "drop":
                mark = "（台帳に追加）" if added.get(c.fp) else "（同じ候補が台帳に既にあるため追加せず）"
            lines.append(f"- **[{tags_label(c.tags) or c.route.label}] {c.title}**{dl}{who}{mark}")
            lines.append(f"  - 判定: {c.decision_note}（確度 {c.confidence}・明示 {'あり' if c.explicit else 'なし'}"
                         f"・抜粋一致 {'○' if c.quote_verified else '×'}）")
            if c.duplicate_of:
                lines.append(f"  - 重複先: {c.duplicate_of}")
            refs = "、".join(f"{m.source} {m.ts.astimezone(JST):%m/%d %H:%M} {m.author}" for m in c.refs[:3])
            lines.append(f"  - 出典: {refs}")
            if c.quote:
                lines.append(f"  - 抜粋: 「{c.quote}」")
    if notes:
        lines.append("\n### AI 出力のうち検証で落としたもの\n")
        lines += [f"- {n}" for n in notes]
    header = "" if path.exists() else (f"# タスク候補 {local:%Y-%m-%d}\n\n"
                                       "定期タスクスクリーニングの実行記録(機械生成)。候補は AI の抽出で、"
                                       "自動起票・承認待ちの判定規則は `tools/タスク自動起票_20261013/README.md`。\n")
    with path.open("a", encoding="utf-8") as fh:
        fh.write(header + "\n".join(lines) + "\n")
    return path


INVENTORY_SECTIONS = ("0.", "1.", "2.", "3.", "4.", "5.", "6.", "7.")


def run_inventory(cfg: dict, store: ScreeningStore, inv: dict, routes: list[Route], book: NameBook,
                  limits: Limits, now: datetime, dry_run: bool, guild_id: int) -> tuple[int, int, bool]:
    """初回の全タスク棚卸し: 棚卸し表の行を塊に分けて AI に渡し、候補を台帳に入れる。

    塊ごとに、前の塊までの候補を「すでにある候補」として渡す(重複を出させない)。
    戻り値: (自動件数, 承認待ち件数, 全部の塊が成功したか)
    """
    path = Path(inv["path"])
    doc_ts = datetime.fromisoformat(inv["as_of"])
    items = read_inventory(path, inv["rel"], doc_ts, tuple(inv.get("sections", INVENTORY_SECTIONS)))
    chunks = chunk_inventory(items)
    lim = replace(limits, max_candidates_per_run=int(inv.get("max_candidates_per_chunk", 40)))
    auto_left = int(inv.get("max_auto", 20))
    auto_total = review_total = 0
    ok = True
    known = existing_tasks(Path(cfg["task_db"]), guild_id, routes)
    known += [KnownTask(tags_label(c.tag_list), c.title, STATE_LABELS.get(c.state, c.state), c.deadline, "candidate")
              for c in store.recent(limits.recent_candidate_days)]
    report_dir = Path(cfg["dry_run_report_dir"] if dry_run else cfg["report_dir"]) if cfg.get("report_dir") else None
    for n, chunk in enumerate(chunks, 1):
        run_id = None if dry_run else store.start_run()
        prompt = build_prompt(chunk, routes, known, now, lim, cfg.get("calendar_note", ""), mode="inventory")
        try:
            data = extract_json(ask_claude(prompt, cfg.get("claude", {})))
        except Exception as e:  # noqa: BLE001  1 つの塊の失敗で全体を止めない(次回の棚卸しでやり直せる)
            log.error("棚卸し %d/%d の抽出に失敗: %s", n, len(chunks), e)
            ok = False
            if run_id is not None:
                store.finish_run(run_id, "error", messages=len(chunk), note=f"棚卸し {n}/{len(chunks)}: {str(e)[:400]}")
            continue
        cands, notes = validate(data, chunk, routes, book, now)
        cands = decide(cands, known, lim, now, bool(cfg.get("auto_enabled", False)), auto_budget=auto_left)
        added: dict[str, int | None] = {}
        for c in cands:
            if c.decision in ("auto", "review"):
                known.append(KnownTask(tags_label(c.tags) or c.route.label, c.title, "候補", c.deadline, "candidate"))
                if not dry_run:
                    added[c.fp] = store.add(run_id, store_row(c))
        auto = sum(1 for c in cands if c.decision == "auto")
        review = sum(1 for c in cands if c.decision == "review")
        auto_left -= auto
        auto_total += auto
        review_total += review
        try:
            write_report(report_dir, now, chunk, cands, notes, dry_run, added,
                         title=f"全タスク棚卸し {n}/{len(chunks)}（{inv['rel']}）")
        except OSError as e:
            log.warning("日次レポートを書けませんでした: %s", type(e).__name__)
        if run_id is not None:
            store.finish_run(run_id, "ok", messages=len(chunk), candidates=len(cands), auto=auto, review=review,
                             note=f"棚卸し {n}/{len(chunks)}; " + "; ".join(notes)[:400])
        print(json.dumps({"inventory_chunk": f"{n}/{len(chunks)}", "rows": len(chunk), "candidates": len(cands),
                          "auto": auto, "review": review}, ensure_ascii=False), flush=True)
        if dry_run:
            for c in cands:
                print(f"[{c.decision}] [{tags_label(c.tags) or c.route.label}] {c.title} — {c.decision_note}", flush=True)
    return auto_total, review_total, ok


def run(cfg: dict, *, dry_run: bool, lookback_hours: int | None, print_prompt: bool,
        inventory: bool = False, followup_only: bool = False) -> int:
    now = datetime.now(timezone.utc)
    limits = Limits(**cfg.get("limits", {}))
    if lookback_hours is not None:
        limits = replace(limits, initial_lookback_hours=lookback_hours)
    rules = SourceRules(exclude=tuple(cfg.get("exclude_sources", [])),
                        untrusted=tuple(cfg.get("untrusted_sources", [])),
                        ignore_author_ids=tuple(str(x) for x in cfg.get("ignore_author_ids", [])))
    routes = routes_from(cfg)
    guild_id = int(cfg["guild_id"])
    store = ScreeningStore.open(Path(cfg["store_path"]))
    authors = Path(cfg.get("authors_file") or Path(cfg["discord_raw_dir"]) / "_authors.json")
    book = NameBook(json.loads(authors.read_text(encoding="utf-8")) if authors.is_file() else None)

    # 差し戻しの修正版づくりと判定記録の書き出しは、毎回の実行の最初に行う
    if not dry_run and not print_prompt:
        followup(cfg, store, routes, book, now)
    if followup_only:
        # 処理中に新しい判定が来ていたら(起動依頼のファイルが更新されていたら)もう一度だけ回す
        trigger = Path(cfg.get("trigger_path") or Path(cfg["store_path"]).parent / "followup.request")
        for _ in range(3):
            try:
                changed = trigger.stat().st_mtime > now.timestamp()
            except OSError:
                changed = False
            if not changed:
                break
            now = datetime.now(timezone.utc)
            followup(cfg, store, routes, book, now)
        return 0

    inv = cfg.get("initial_inventory")
    if inventory:
        if not inv:
            raise SystemExit("設定に initial_inventory がありません")
        if not dry_run and store.get_meta("inventory_done") == inv["path"]:
            log.info("この棚卸し表は取り込み済みのため、棚卸しは飛ばします")
        else:
            a, r, ok = run_inventory(cfg, store, inv, routes, book, limits, now, dry_run, guild_id)
            log.info("全タスク棚卸し: 自動 %d 件・承認待ち %d 件%s", a, r, "" if ok else "(失敗した塊あり)")
            if ok and not dry_run:
                store.set_meta("inventory_done", inv["path"])

    cursor = {} if (dry_run and lookback_hours is not None) else store.get_meta("cursor", {})
    messages = read_discord(Path(cfg["discord_raw_dir"]), cursor, rules, book, guild_id, now, limits)
    if cfg.get("mail_raw_dir"):
        messages += read_mail(Path(cfg["mail_raw_dir"]), cursor, rules, now, limits)
    batch = select_batch(messages, limits)
    fresh = [m for m in batch if not m.context]
    run_id = None if dry_run else store.start_run()
    if not fresh:
        log.info("新着なし")
        if run_id is not None:
            store.finish_run(run_id, "ok", note="新着なし")
        return 0

    known = existing_tasks(Path(cfg["task_db"]), guild_id, routes)
    known += [KnownTask(tags_label(c.tag_list), c.title, STATE_LABELS.get(c.state, c.state),
                        c.deadline, "candidate") for c in store.recent(limits.recent_candidate_days)]
    prompt = build_prompt(batch, routes, known, now, limits, cfg.get("calendar_note", ""))
    if print_prompt:
        print(prompt)
        return 0
    try:
        data = extract_json(ask_claude(prompt, cfg.get("claude", {})))
    except Exception as e:  # noqa: BLE001  失敗してもカーソルは進めない(次回やり直す)
        log.error("AI の候補抽出に失敗: %s", e)
        if run_id is not None:
            store.finish_run(run_id, "error", messages=len(fresh), note=str(e)[:500])
        return 2
    cands, notes = validate(data, batch, routes, book, now)
    cands = decide(cands, known, limits, now, bool(cfg.get("auto_enabled", False)))
    added: dict[str, int | None] = {}
    if not dry_run:
        for c in cands:
            if c.decision in ("auto", "review"):
                added[c.fp] = store.add(run_id, store_row(c))
        store.set_meta("cursor", advance_cursor(cursor, batch))
    report_dir = Path(cfg["report_dir"]) if cfg.get("report_dir") else None
    if dry_run and cfg.get("dry_run_report_dir"):
        report_dir = Path(cfg["dry_run_report_dir"])
    try:
        path = write_report(report_dir, now, batch, cands, notes, dry_run, added)
    except OSError as e:
        path = None
        log.warning("日次レポートを書けませんでした: %s", type(e).__name__)
    auto = sum(1 for c in cands if c.decision == "auto")
    review = sum(1 for c in cands if c.decision == "review")
    if run_id is not None:
        store.finish_run(run_id, "ok", messages=len(fresh), candidates=len(cands), auto=auto, review=review,
                         note="; ".join(notes)[:500])
    print(json.dumps({"dry_run": dry_run, "messages": len(fresh), "candidates": len(cands), "auto": auto,
                      "review": review, "dropped": len(cands) - auto - review,
                      "report": str(path) if path else None}, ensure_ascii=False))
    if dry_run:
        for c in cands:
            print(f"[{c.decision}] [{tags_label(c.tags) or c.route.label}] {c.title} — {c.decision_note}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="定期タスクスクリーニング")
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--dry-run", action="store_true", help="台帳・カーソル・本番レポートに書かない")
    parser.add_argument("--lookback-hours", type=int, help="(試運転用)カーソルを使わず直近 N 時間を読む")
    parser.add_argument("--print-prompt", action="store_true", help="AI に渡す指示文を表示して終わる")
    parser.add_argument("--inventory", action="store_true",
                        help="先に設定 initial_inventory の棚卸し表から全タスクを取り込む(初回用。取り込み済みなら飛ばす)")
    parser.add_argument("--followup", action="store_true",
                        help="差し戻しの修正版づくりと判定記録の書き出しだけを行う(Bot がボタン操作のあとに起動する)")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    if args.lookback_hours is not None and not args.dry_run:
        parser.error("--lookback-hours は --dry-run と一緒にだけ使えます")
    if args.followup and args.dry_run:
        parser.error("--followup は --dry-run と一緒には使えません")
    cfg = load_config(args.config.expanduser())
    lock_path = Path(cfg["store_path"]).with_suffix(".lock")
    lock_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with open(lock_path, "w") as lock:
        # 定期実行は前回が続いていれば見送る。差し戻しの処理は待ってから行う(取りこぼさないため)。
        deadline = time.monotonic() + (900 if args.followup else 0)
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if time.monotonic() >= deadline:
                    log.warning("前回の実行が続いているため今回は見送ります")
                    return 0
                time.sleep(10)
        return run(cfg, dry_run=args.dry_run, lookback_hours=args.lookback_hours, print_prompt=args.print_prompt,
                   inventory=args.inventory, followup_only=args.followup)


if __name__ == "__main__":
    sys.exit(main())
