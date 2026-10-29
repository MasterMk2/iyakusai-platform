"""Builds tests/rental/fixtures/python-ledger/ with the Python rental server (reference/rental-python).

The TypeScript ledger must open this directory as it is (the switch from the Python server is a copy of
its data directory) and must compute the same fingerprints, so a loan queued on a phone before the switch
is replayed, not rejected, when it is resent afterwards. Run from the repository root:

    py -3 -I tests/rental/fixtures/make_python_ledger.py

Requires Python 3.12 with Pillow (the reference server's own dependency). Synthetic data only.
"""
import io
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "reference" / "rental-python" / "server"))
from PIL import Image  # noqa: E402
from store import Store, canonical  # noqa: E402

OUT = Path(__file__).resolve().parent / "python-ledger"


def jpeg(color):
    stream = io.BytesIO()
    Image.new("RGB", (100, 80), color).save(stream, "JPEG")
    return stream.getvalue()


def main():
    if OUT.exists():
        shutil.rmtree(OUT)
    store = Store(OUT / "folder", "demo", True)
    actor = {"id": "demo", "name": "試用スタッフ"}
    photos = {"red": jpeg("red"), "blue": jpeg("blue")}
    group = store.create_borrower("試用 事前団体")["borrower"]
    planned = store.preassign([{"code": "IY-PLAN-000001", "name": "事前割当 机", "url": "https://rental.example.jp/i/IY-PLAN-000001",
                                "borrower_id": group["id"], "borrower_name": group["name"]}], actor)
    borrow = {"operation_id": "6f1c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f", "item_code": "IY-000123", "item_version": 0,
              "action": "borrow", "borrower": "試用 模擬店A", "condition": "normal", "note": "付属品\tケーブル 2本",
              "client_at": "2026-10-12T12:00:00Z", "client_read_at": "2026-10-12T11:59:58+09:00"}
    borrow_receipt = store.submit(borrow, [photos["red"], photos["blue"]], actor)
    ret = {"operation_id": "0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d", "item_code": "IY-000123", "item_version": 1,
           "action": "return", "borrower": "", "condition": "damage", "note": "角に傷", "client_at": "", "client_read_at": ""}
    return_receipt = store.submit(ret, [photos["blue"]], actor)
    planned_borrow = {"operation_id": "1d2c3b4a-5f6e-4d7c-a8b9-c0d1e2f3a4b5", "item_code": "IY-PLAN-000001",
                      "item_version": planned["items"][0]["version"], "action": "borrow", "borrower": "試用 模擬店B",
                      "condition": "normal", "note": "", "client_at": "2026-10-17T09:00:00.123Z", "client_read_at": ""}
    planned_receipt = store.submit(planned_borrow, [photos["red"], photos["blue"]], actor)
    with store.connect() as db:
        fingerprints = {row["id"]: row["fingerprint"] for row in db.execute("SELECT id,fingerprint FROM operations")}
    (OUT / "photos").mkdir()
    for name, data in photos.items():
        (OUT / "photos" / f"{name}.jpg").write_bytes(data)
    expected = {
        "actor": actor,
        "operations": [
            {"meta": borrow, "photos": ["red", "blue"], "receipt": borrow_receipt},
            {"meta": ret, "photos": ["blue"], "receipt": return_receipt},
            {"meta": planned_borrow, "photos": ["red", "blue"], "receipt": planned_receipt},
        ],
        "fingerprints": fingerprints,
        "items": {code: store.item(code) for code in ("IY-000123", "IY-000124", "IY-PLAN-000001")},
        "groups": store.borrower_groups(),
        "canonical_sample": canonical({"b": [1, True, None], "a": "日本\n\"x\"\u0001", "é": 2, "Z": {"y": 0, "x": -5}}).decode("utf-8"),
    }
    (OUT / "expected.json").write_text(json.dumps(expected, ensure_ascii=False, indent=1, sort_keys=True), encoding="utf-8")
    print("wrote", OUT)


if __name__ == "__main__":
    main()
