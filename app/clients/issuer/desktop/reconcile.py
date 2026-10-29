"""Prepare a reviewed update without renumbering existing labels or touching a server."""
from collections import defaultdict, deque
from workflow import WorkflowError, _normalize_rows, expand_rows
from labels.generate_labels import normalize_items


def reconcile_rows(rows, previous, origin, reserved_through=0):
    rows = _normalize_rows(rows)
    previous = normalize_items(previous)
    pools = defaultdict(deque)
    for item in sorted(previous, key=lambda value: value["code"]):
        if not item.get("borrower_name"):
            raise WorkflowError("既存の書込み用データに予定団体がありません。団体付きのデータを選んでください。")
        pools[(item["name"], item["borrower_name"])].append(item)
    numeric = [int(item["code"][3:]) for item in previous if item["code"].startswith("IY-") and item["code"][3:].isdigit()]
    if type(reserved_through) is not int or not 0 <= reserved_through <= 999999:
        raise WorkflowError('予約済み番号が不正です。')
    next_number = max([100000, reserved_through, *numeric]) + 1
    items, added, kept = [], [], []
    for row in rows:
        pool = pools[(row["name"], row["borrower_name"])]
        for _ in range(row["quantity"]):
            if pool:
                item = dict(pool.popleft())
                kept.append(item["code"])
                if row.get("item_scope") in ("学内", "委員会", "区分未確認") and "item_owner" not in row:
                    item.pop("item_owner", None)
                for field in ("item_scope", "item_owner"):
                    if field in row:
                        item[field] = row[field]
            else:
                item = expand_rows([{**row, "quantity": 1}], origin, next_number)[0]
                next_number += 1
                added.append(item["code"])
            items.append(item)
    removed = sorted([item for pool in pools.values() for item in pool], key=lambda value: value["code"])
    # Removed labels remain reserved. Never recycle their codes, guess a renamed group, or delete history.
    return {"items": items, "kept_codes": kept, "added_codes": added, "removed_candidates": removed, "reserved_through": next_number - 1,
            "note": "対象外候補のカード回収・予定解除は未実施です。物品名や団体名の変更は自動対応しません。"}
