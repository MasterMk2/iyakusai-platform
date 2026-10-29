"""A4, 10-up 91 x 55 mm rental labels. QR and card writing share exact URLs."""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import math
import os
import re
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit
from threading import RLock

from reportlab.graphics import renderPDF
from reportlab.graphics.barcode.qr import QrCodeWidget
from reportlab.graphics.shapes import Drawing
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

WIDTH_MM, HEIGHT_MM = 91, 55
COLUMNS, ROWS = 2, 5
LEFT_MM, TOP_MM = 14, 11
CODE = re.compile(r"IY-[A-Z0-9][A-Z0-9-]{2,39}\Z")
SHORT = re.compile(r"IY-1(\d{5})\Z")
FONT_LOCK = RLock()


def validate_item_url(code, url):
    parts = urlsplit(url)
    query = parse_qs(parts.query, keep_blank_values=True)
    references = query.get("item", []) + query.get("iy", [])
    match = re.fullmatch(r"/i/([^/]+)/?", parts.path)
    if match:
        references.append(unquote(match.group(1)))
    if not references or any(ref != code for ref in references):
        raise ValueError(f"URLの物品コードがラベルと一致しません: {code}")


def normalize_items(items):
    if not isinstance(items, list) or not items or len(items) > 10000:
        raise ValueError("itemsは1〜10000件の配列にしてください")
    result, seen = [], set()
    for item in items:
        if not isinstance(item, dict):
            raise ValueError("各物品にはcode/name/urlが必要です")
        code = str(item.get("code", "")).strip()
        name = str(item.get("name", "")).strip()
        url = str(item.get("url", "")).strip()
        if not CODE.fullmatch(code):
            raise ValueError(f"識別コードが不正です: {code[:40]}")
        if code in seen:
            raise ValueError(f"識別コードが重複しています: {code}")
        if not name or len(name) > 160 or any(ord(c) < 32 for c in name):
            raise ValueError(f"物品名は改行なしの1〜160文字にしてください: {code}")
        try:
            parts = urlsplit(url)
            valid = parts.scheme == "https" or (parts.scheme == "http" and parts.hostname in ("localhost", "127.0.0.1", "::1"))
            if not valid or not parts.hostname or parts.username or parts.password or len(url.encode("utf-8")) > 180 or any(ord(c) <= 32 or ord(c) > 126 for c in url):
                raise ValueError()
        except (ValueError, UnicodeError):
            raise ValueError(f"URLはHTTPS、またはlocalhostのHTTPで指定してください: {code}") from None
        validate_item_url(code, url)
        seen.add(code)
        normalized = {"code": code, "name": name, "url": url}
        kind = item.get("card_kind", "regular")
        if kind not in ("regular", "irregular"):
            raise ValueError("カードの種類を確認してください。")
        if kind == "irregular":
            if not re.fullmatch(r"IY-IR-[0-9]{6}", code):
                raise ValueError("イレギュラーカードの番号を確認してください。")
            normalized["card_kind"] = kind
        elif code.startswith("IY-IR-"):
            raise ValueError("イレギュラーカードの種類が失われています。サーバーから読み直してください。")
        if "borrower_name" in item:
            borrower = item["borrower_name"]
            if not isinstance(borrower, str) or not borrower.strip() or len(borrower.strip()) > 120 or any(ord(c) < 32 or ord(c) == 127 for c in borrower):
                raise ValueError(f"予定団体名は改行なしの1〜120文字にしてください: {code}")
            normalized["borrower_name"] = borrower.strip()
        if "borrower_id" in item:
            borrower_id = item["borrower_id"]
            if not isinstance(borrower_id, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,79}", borrower_id):
                raise ValueError(f"予定団体IDが不正です: {code}")
            normalized["borrower_id"] = borrower_id
        if "item_owner" in item:
            owner = item["item_owner"]
            if not isinstance(owner, str) or not owner.strip() or len(owner.strip()) > 120 or any(ord(c) < 32 or ord(c) == 127 for c in owner):
                raise ValueError("借用元は改行なしの1〜120文字にしてください。")
            normalized["item_owner"] = owner.strip()
        if "item_scope" in item:
            scope = item["item_scope"]
            if scope not in ("学内", "学外", "委員会", "区分未確認"):
                raise ValueError(f"物品区分は学内・学外・委員会・区分未確認のいずれかにしてください: {code}")
            normalized["item_scope"] = scope
        result.append(normalized)
    return result


def short_number(code):
    """The number written by hand: the part after IY-1 without leading zeros (IY-100123 -> "123")."""
    match = SHORT.match(code)
    if not match or not int(match.group(1)):
        return None
    return str(int(match.group(1)))


def _fonts():
    if "LabelJP" in pdfmetrics.getRegisteredFontNames():
        return
    regular = os.environ.get("RENTAL_LABEL_FONT", r"C:\Windows\Fonts\meiryo.ttc")
    bold = os.environ.get("RENTAL_LABEL_BOLD_FONT", r"C:\Windows\Fonts\meiryob.ttc")
    if not Path(regular).is_file() or not Path(bold).is_file():
        raise RuntimeError("日本語フォントをRENTAL_LABEL_FONT/RENTAL_LABEL_BOLD_FONTで指定してください")
    pdfmetrics.registerFont(TTFont("LabelJP", regular, subfontIndex=0))
    pdfmetrics.registerFont(TTFont("LabelJPBold", bold, subfontIndex=0))


def _wrap(text, font, size, width):
    lines, current = [], ""
    for char in text:
        if current and pdfmetrics.stringWidth(current + char, font, size) > width:
            lines.append(current)
            current = char
        else:
            current += char
    if current:
        lines.append(current)
    return lines


def _irregular_label(c, item, x, y):
    c.saveState()
    c.translate(x, y)
    c.setFillColor(colors.black)
    c.setFont("LabelJPBold", 13)
    c.drawString(4 * mm, 48 * mm, "イレギュラーカード")
    qr = QrCodeWidget(item["url"], barLevel="M", barBorder=4)
    bounds = qr.getBounds()
    edge = 26 * mm
    d = Drawing(edge, edge, transform=[edge / (bounds[2] - bounds[0]), 0, 0, edge / (bounds[3] - bounds[1]), 0, 0])
    d.add(qr)
    renderPDF.draw(d, c, 3 * mm, 19 * mm)
    for title, height in (("品名", 39), ("数量・単位", 30), ("貸出先", 21), ("借用元・区分", 12)):
        c.setFont("LabelJP", 6)
        c.drawString(32 * mm, (height + 4) * mm, title)
        c.setStrokeColor(colors.HexColor("#666666"))
        c.setLineWidth(0.15 * mm)
        c.line(32 * mm, height * mm, 87 * mm, height * mm)
    c.setFont("LabelJPBold", 11)
    c.drawString(4 * mm, 12 * mm, item["code"].removeprefix("IY-"))
    c.setFont("LabelJP", 5.7)
    c.drawString(4 * mm, 6 * mm, "貸出時に入力・券面と照合 ／ 全数返却後に書き直して再利用")
    c.restoreState()


def _label(c, item, x, y):
    if item.get("card_kind") == "irregular":
        return _irregular_label(c, item, x, y)
    c.saveState()
    c.translate(x, y)
    c.setFillColor(colors.black)
    c.setFont("LabelJP", 6)
    c.drawString(5 * mm, 51 * mm, "医薬祭　貸出物品")
    # Left of the planned group, above the QR. Text and border also distinguish it in monochrome.
    scope = item.get("item_scope", "区分未確認")
    scope_label = {"学内": "学内物品", "学外": "学外物品", "委員会": "委員会物品"}.get(scope, "区分未確認")
    if scope == "学外":
        c.setFillColor(colors.black)
        c.rect(4 * mm, 46 * mm, 27 * mm, 4 * mm, fill=1, stroke=0)
        c.setFillColor(colors.white)
    else:
        c.setFillColor(colors.white)
        c.rect(4 * mm, 46 * mm, 27 * mm, 4 * mm, fill=1, stroke=1)
        c.setFillColor(colors.black)
    c.setFont("LabelJPBold", 8)
    c.drawCentredString(17.5 * mm, 47 * mm, scope_label)
    c.setFillColor(colors.black)
    # Four-module quiet zone is part of the vector barcode, not adjacent text.
    qr = QrCodeWidget(item["url"], barLevel="M", barBorder=4)
    bounds = qr.getBounds()
    edge = 27 * mm
    d = Drawing(edge, edge, transform=[edge / (bounds[2] - bounds[0]), 0, 0, edge / (bounds[3] - bounds[1]), 0, 0])
    d.add(qr)
    renderPDF.draw(d, c, 4 * mm, 18 * mm)

    name_top = 39 * mm
    if item.get("borrower_name"):
        borrower_size = 8
        borrower_lines = _wrap(f"予定団体：{item['borrower_name']}", "LabelJP", borrower_size, 53 * mm)
        while len(borrower_lines) > 5 and borrower_size > 5.5:
            borrower_size -= 0.5
            borrower_lines = _wrap(f"予定団体：{item['borrower_name']}", "LabelJP", borrower_size, 53 * mm)
        if len(borrower_lines) > 5:
            raise ValueError(f"予定団体名がラベルに収まりません: {item['code']}")
        c.setFont("LabelJP", borrower_size)
        for n, line in enumerate(borrower_lines):
            c.drawString(33 * mm, 47 * mm - n * (borrower_size + 2), line)
        name_top = min(name_top, 47 * mm - (len(borrower_lines) - 1) * (borrower_size + 2) - 4 * mm)
    size = 11
    # Set composition starts on its own line while remaining in the exact persisted name.
    parts = item["name"].split("｜", 1) if item["name"].startswith(("横幕セット（", "テントの足 ")) else [item["name"]]
    lines = [line for part in parts for line in _wrap(part, "LabelJPBold", size, 53 * mm)]
    while len(lines) > 3 and size > 5.5:
        size -= 0.5
        lines = [line for part in parts for line in _wrap(part, "LabelJPBold", size, 53 * mm)]
    if len(lines) > 3:
        raise ValueError(f"物品名がラベルに収まりません: {item['code']}")
    c.setFont("LabelJPBold", size)
    for n, line in enumerate(lines):
        c.drawString(33 * mm, name_top - n * (size + 3), line)
    c.setFont("LabelJP", 6.3)
    hint_y = min(21 * mm, name_top - (len(lines) - 1) * (size + 3) - 4 * mm)
    c.drawString(33 * mm, hint_y, "スマホでNFC・QRを読み取り")
    short = short_number(item["code"])
    if short:
        # Handwritten records use only this number; the full code stays beside it, smaller.
        big = f"No.{short}"
        c.setFont("LabelJPBold", 18)
        c.drawString(5 * mm, 10.5 * mm, big)
        c.setFont("LabelJP", 8)
        c.drawString(5 * mm + pdfmetrics.stringWidth(big, "LabelJPBold", 18) + 3 * mm, 10.5 * mm, item["code"])
    else:
        size = min(14, 81 * mm / max(pdfmetrics.stringWidth(item["code"], "LabelJPBold", 1), 1))
        c.setFont("LabelJPBold", size)
        c.drawString(5 * mm, 11 * mm, item["code"])
    c.setFont("LabelJP", 4.8)
    # Long URLs remain exact in the QR/manifest; text shows the host as a fallback.
    visible = item["url"]
    if pdfmetrics.stringWidth(visible, "LabelJP", 4.8) > 81 * mm:
        visible = urlsplit(visible).hostname or ""
    c.drawString(5 * mm, 5.5 * mm, visible)
    c.restoreState()


def build_pdf(items) -> bytes:
    """Return a PDF; input order is also the card issuance/cutting order."""
    items = normalize_items(items)
    with FONT_LOCK:
        _fonts()
    buffer = io.BytesIO()
    c = canvas.Canvas(buffer, pagesize=A4, pageCompression=1)
    c.setTitle("医薬祭 貸出物品ラベル 91 x 55 mm")
    c.setAuthor("医薬祭 物品貸出システム")
    pages = math.ceil(len(items) / 10)
    for page in range(pages):
        c.setFont("LabelJP", 6)
        c.setFillColor(colors.HexColor("#444444"))
        c.drawString(14 * mm, A4[1] - 6 * mm, "A4・倍率100%（実際のサイズ）で印刷 ／ 1枚 91×55mm ／ 枠線に沿って裁断")
        c.drawRightString(196 * mm, A4[1] - 6 * mm, f"{page + 1}/{pages}")
        for slot, item in enumerate(items[page * 10:(page + 1) * 10]):
            row, col = divmod(slot, COLUMNS)
            x = (LEFT_MM + col * WIDTH_MM) * mm
            y = A4[1] - (TOP_MM + (row + 1) * HEIGHT_MM) * mm
            _label(c, item, x, y)
        c.setStrokeColor(colors.HexColor("#aaaaaa"))
        c.setLineWidth(0.15 * mm)
        bottom = A4[1] - (TOP_MM + ROWS * HEIGHT_MM) * mm
        for col in range(COLUMNS + 1):
            x = (LEFT_MM + col * WIDTH_MM) * mm
            c.line(x, bottom, x, A4[1] - TOP_MM * mm)
        for row in range(ROWS + 1):
            y = A4[1] - (TOP_MM + row * HEIGHT_MM) * mm
            c.line(LEFT_MM * mm, y, (LEFT_MM + COLUMNS * WIDTH_MM) * mm, y)
        c.showPage()
    c.save()
    return buffer.getvalue()


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("input", type=Path, help="JSON配列、{items:[...]}、またはcode,name,urlのCSV")
    ap.add_argument("output", type=Path, help="新規PDFの保存先")
    args = ap.parse_args()
    if args.input.suffix.lower() == ".csv":
        with args.input.open(encoding="utf-8-sig", newline="") as f:
            items = list(csv.DictReader(f))
    else:
        obj = json.loads(args.input.read_text(encoding="utf-8-sig"))
        items = obj["items"] if isinstance(obj, dict) else obj
    items = normalize_items(items)
    payload = build_pdf(items)
    manifest = args.output.with_suffix(".issuance.json")
    if args.output.exists() or manifest.exists():
        raise SystemExit("保存先が存在します。別のファイル名を指定してください。")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("xb") as f:
        f.write(payload)
        f.flush()
        os.fsync(f.fileno())
    with manifest.open("x", encoding="utf-8") as f:
        f.write(json.dumps({"format": "rental-label-issuance-v1", "label_mm": [91, 55], "page": "A4", "items": items, "pdf_sha256": hashlib.sha256(payload).hexdigest()}, ensure_ascii=False, indent=2))
        f.flush()
        os.fsync(f.fileno())
    print(json.dumps({"pdf": str(args.output), "manifest": str(manifest), "labels": len(items), "pages": math.ceil(len(items) / 10)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
