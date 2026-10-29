"""Handwritten loan sheet (A4 portrait) for when the rental system cannot be used.

Items are printed per planned group with the short number from the label (IY-100123 -> 123), so a
person at the desk writes only times and initials, circles the condition at return (the same three
choices as the rental page) and notes any damage or missing parts. Blank rows at the end of each group
take items lent outside the plan (write the No. and the item name). Input: the items of an .issuance.json.
"""
from __future__ import annotations

import argparse
import io
import json
from datetime import datetime
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfgen import canvas

try:
    from labels import generate_labels as gl
except ImportError:  # run as a script from this folder
    import generate_labels as gl

MARGIN = 12 * mm
ROW = 8 * mm
HEAD_ROW = 9 * mm
BLANK_ROWS = 6
NO_GROUP = "予定団体なし"
# (heading, width in mm); the widths add up to the printable width (210 - 2 x 12 mm).
COLUMNS = [("No.", 13), ("物品名", 50), ("貸出 時刻", 14), ("貸出 担当", 16), ("返却 時刻", 14), ("返却 担当", 16),
           ("返却時の状態（○）", 31), ("傷・不足など", 32)]
CONDITION = 6
# The rental page's return conditions (異常なし / 要清掃・整備 / 破損・不足), shortened to fit.
CHOICES = "異常なし ・ 整備 ・ 破損"
GUIDE = ("No. はラベルに大きく印字した番号（IY-100123 なら 123）。時刻と担当（名字）を書き、返却時の状態を○で囲む。",
         "傷・不足は場所と内容を書く（貸出時からある傷も）。予定外の物品は空欄の行に No. と物品名を書く。")


def groups(items):
    """Planned groups in the order they first appear (the label printing order)."""
    order = {}
    for item in items:
        order.setdefault(item.get("borrower_name") or NO_GROUP, []).append(item)
    return list(order.items())


def _shrink(text, font, size, width, smallest):
    while size > smallest and pdfmetrics.stringWidth(text, font, size) > width:
        size -= 0.5
    return size


def _name_lines(name, width):
    size = _shrink(name, "LabelJP", 8, width, 6.5)
    if pdfmetrics.stringWidth(name, "LabelJP", size) <= width:
        return [name], size
    lines = gl._wrap(name, "LabelJP", 6.5, width)
    if len(lines) > 2:
        lines = [lines[0], lines[1][:-1] + "…"]
    return lines, 6.5


def _header(c, group, sheet, printed, source):
    width, height = A4
    y = height - MARGIN
    c.setFillColor(colors.black)
    c.setFont("LabelJP", 8)
    c.drawString(MARGIN, y - 3 * mm, "医薬祭 物品 手書き貸出表（システムが使えないとき用）")
    c.drawRightString(width - MARGIN, y - 3 * mm, f"印刷 {printed}")
    title = f"予定団体：{group}" + ("（続き）" if sheet > 1 else "")
    size = _shrink(title, "LabelJPBold", 15, width - 2 * MARGIN, 9)
    c.setFont("LabelJPBold", size)
    c.drawString(MARGIN, y - 11 * mm, title)
    c.setFont("LabelJP", 6.8)
    guide = [line for sentence in GUIDE for line in gl._wrap(sentence, "LabelJP", 6.8, width - 2 * MARGIN)]
    for n, line in enumerate(guide):
        c.drawString(MARGIN, y - 15.5 * mm - n * 3.4 * mm, line)
    c.setFont("LabelJP", 6)
    c.setFillColor(colors.HexColor("#555555"))
    c.drawString(MARGIN, MARGIN - 5 * mm, f"元データ: {source}" if source else "")
    c.drawRightString(width - MARGIN, MARGIN - 5 * mm, f"{group} {sheet}枚目")
    c.setFillColor(colors.black)
    return y - 18.5 * mm - (len(guide) - 1) * 3.4 * mm


def _table(c, top, rows):
    x0 = MARGIN
    total = sum(w for _, w in COLUMNS) * mm
    c.setFillColor(colors.HexColor("#e8e8e8"))
    c.rect(x0, top - HEAD_ROW, total, HEAD_ROW, stroke=0, fill=1)
    c.setFillColor(colors.black)
    c.setFont("LabelJPBold", 7.5)
    x = x0
    for heading, w in COLUMNS:
        c.drawCentredString(x + w * mm / 2, top - HEAD_ROW + 3.2 * mm, heading)
        x += w * mm
    y = top - HEAD_ROW
    choices_x = x0 + sum(w for _, w in COLUMNS[:CONDITION]) * mm + COLUMNS[CONDITION][1] * mm / 2
    for number, name in rows:
        c.setFillColor(colors.HexColor("#444444"))
        c.setFont("LabelJP", 7)
        c.drawCentredString(choices_x, y - ROW + 2.8 * mm, CHOICES)
        c.setFillColor(colors.black)
        if number:
            c.setFont("LabelJPBold", _shrink(number, "LabelJPBold", 12, (COLUMNS[0][1] - 2) * mm, 7))
            c.drawCentredString(x0 + COLUMNS[0][1] * mm / 2, y - ROW + 2.5 * mm, number)
        if name:
            lines, size = _name_lines(name, (COLUMNS[1][1] - 3) * mm)
            c.setFont("LabelJP", size)
            first = y - ROW / 2 - size * 0.35 + (size * 0.6 if len(lines) == 2 else 0)
            for n, line in enumerate(lines):
                c.drawString(x0 + (COLUMNS[0][1] + 1.5) * mm, first - n * (size + 1), line)
        y -= ROW
    c.setStrokeColor(colors.HexColor("#777777"))
    c.setLineWidth(0.2 * mm)
    bottom = y
    line_y = top
    c.line(x0, line_y, x0 + total, line_y)
    line_y -= HEAD_ROW
    while line_y >= bottom - 0.01:
        c.line(x0, line_y, x0 + total, line_y)
        line_y -= ROW
    x = x0
    for _, w in COLUMNS + [("", 0)]:
        c.line(x, top, x, bottom)
        x += w * mm


def build_sheet(items, source="", printed=None) -> bytes:
    """Return the PDF. Each group starts on a new page and continues on further pages when long."""
    items = gl.normalize_items(items)
    with gl.FONT_LOCK:
        gl._fonts()
    printed = printed or datetime.now().strftime("%Y-%m-%d %H:%M")
    buffer = io.BytesIO()
    c = canvas.Canvas(buffer, pagesize=A4, pageCompression=1)
    c.setTitle("医薬祭 物品 手書き貸出表")
    c.setAuthor("医薬祭 物品貸出システム")
    for group, members in groups(items):
        rows = [(gl.short_number(i["code"]) or i["code"], i["name"]) for i in members] + [("", "")] * BLANK_ROWS
        sheet = 0
        while rows:
            sheet += 1
            top = _header(c, group, sheet, printed, source)
            capacity = int((top - HEAD_ROW - MARGIN) // ROW)
            chunk, rows = rows[:capacity], rows[capacity:]
            _table(c, top, chunk)
            c.showPage()
    c.save()
    return buffer.getvalue()


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("input", type=Path, help="発行時の .issuance.json")
    ap.add_argument("output", type=Path, help="新規PDFの保存先（既存は上書きしない）")
    args = ap.parse_args()
    data = json.loads(args.input.read_text(encoding="utf-8-sig"))
    payload = build_sheet(data["items"] if isinstance(data, dict) else data, source=args.input.name)
    with args.output.open("xb") as f:
        f.write(payload)


if __name__ == "__main__":
    main()
