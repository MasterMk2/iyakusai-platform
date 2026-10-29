# -*- coding: utf-8 -*-
"""/image の純ロジック(依頼文・SVG の取り出し・無害化)の試験。Discord・CLI・変換には触らない。"""

from __future__ import annotations

import sys
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC))

from iyakusai_bot import image_logic as IL  # noqa: E402

NS = {"s": IL.SVG_NS}


def wrap(body: str, head: str = 'xmlns="http://www.w3.org/2000/svg" width="400" height="300"') -> str:
    return f"<svg {head}>{body}</svg>"


def clean(body: str, **kw) -> IL.CleanSvg:
    return IL.sanitize_svg(wrap(body, **kw) if not body.lstrip().startswith("<svg") else body, 1080, 1080)


class ExtractTests(unittest.TestCase):
    def test_takes_the_svg_out_of_prose_and_code_fences(self):
        text = "はい、描きました。\n```svg\n<svg xmlns=\"http://www.w3.org/2000/svg\"><rect/></svg>\n```\n以上です。"
        self.assertEqual(IL.extract_svg(text), '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>')

    def test_missing_or_cut_svg_is_an_error_with_a_reason(self):
        with self.assertRaises(IL.SvgError) as missing:
            IL.extract_svg("ごめんなさい、描けません")
        self.assertIn("見つかりません", missing.exception.message)
        with self.assertRaises(IL.SvgError) as cut:
            IL.extract_svg('<svg xmlns="http://www.w3.org/2000/svg"><rect width="10"')
        self.assertIn("切れて", cut.exception.message)


class SanitizeTests(unittest.TestCase):
    def test_drops_everything_that_can_read_outside_the_svg(self):
        body = ('<rect width="10" height="10" fill="red"/>'
                '<image href="/home/user/.iyakusai/secret.png" width="10" height="10"/>'
                '<image href="../secret/red.png"/>'
                '<script>alert(1)</script>'
                '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>'
                '<filter id="f"><feImage href="file:///etc/passwd"/><feGaussianBlur stdDeviation="2"/></filter>'
                '<animate attributeName="x" to="10"/>'
                '<use href="other.svg#icon"/>'
                '<use href="#ok"/>')
        result = clean(body)
        root = ET.fromstring(result.svg)
        tags = [el.tag.split("}")[1] for el in root.iter()]
        for banned in ("image", "script", "foreignObject", "feImage", "animate"):
            self.assertNotIn(banned, tags)
        self.assertIn("feGaussianBlur", tags)
        uses = root.findall("s:use", NS)
        self.assertEqual([u.get("href") for u in uses], [None, "#ok"])   # 外を指す href は消える
        for word in ("secret", "passwd", "other.svg", "alert", "file:"):
            self.assertNotIn(word, result.svg)
        self.assertGreater(result.removed, 0)

    def test_xlink_href_inside_the_document_is_kept_as_plain_href(self):
        svg = ('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">'
               '<defs><path id="p" d="M0 0L10 10"/></defs><use xlink:href="#p"/><use xlink:href="http://x/y"/></svg>')
        root = ET.fromstring(IL.sanitize_svg(svg, 1080, 1080).svg)
        uses = root.findall("s:use", NS)
        self.assertEqual(uses[0].get("href"), "#p")
        self.assertIsNone(uses[1].get("href"))
        self.assertNotIn("xlink", IL.sanitize_svg(svg, 1080, 1080).svg)

    def test_event_handlers_foreign_attributes_and_outside_urls_are_removed(self):
        svg = ('<svg xmlns="http://www.w3.org/2000/svg" xmlns:sodipodi="http://sodipodi.sourceforge.net/x" '
               'onload="evil()"><rect onclick="evil()" sodipodi:nodetypes="cc" fill="url(#g)" '
               'stroke="url(http://evil/x.svg#a)" mask="url(\'file:///x\')" style="fill:url(data:image/png;base64,AA)"/>'
               '<rect style="fill:#f00;stroke:url(#g)"/><rect fill="url( #g )"/></svg>')
        result = IL.sanitize_svg(svg, 1080, 1080)
        root = ET.fromstring(result.svg)
        first, second, third = root.findall("s:rect", NS)
        self.assertIsNone(root.get("onload"))
        self.assertEqual(sorted(first.attrib), ["fill"])
        self.assertEqual(first.get("fill"), "url(#g)")
        self.assertEqual(second.get("style"), "fill:#f00;stroke:url(#g)")
        self.assertEqual(third.get("fill"), "url( #g )")
        self.assertNotIn("evil", result.svg)
        self.assertNotIn("data:", result.svg)

    def test_style_element_with_import_or_outside_url_is_removed_and_safe_style_kept(self):
        bad = clean('<style>@import url("http://evil/x.css"); rect{fill:red}</style><rect/>')
        self.assertNotIn("<style", bad.svg.replace("ns0:", ""))
        self.assertNotIn("evil", bad.svg)
        escaped = clean('<style>rect{fill:u\\72l(file:///x)}</style><rect/>')
        self.assertNotIn("file", escaped.svg)
        good = clean("<style>.t{font-family:Arial, sans-serif; font-size:40px}</style><text class='t'>医薬祭</text>")
        self.assertIn("font-family:'Noto Sans JP'", good.svg)
        self.assertIn("font-size:40px", good.svg)

    def test_font_family_is_bent_to_an_installed_face(self):
        cases = {
            "Arial": "Noto Sans JP",
            "serif": "Noto Serif JP",
            "'M PLUS Rounded 1c', sans-serif": "M PLUS Rounded 1c",
            "dela gothic one": "Dela Gothic One",
            "Hiragino Sans, cursive": "Klee One",
            "": "Noto Sans JP",
        }
        for value, expected in cases.items():
            self.assertEqual(IL.normalize_family(value), expected, value)
        result = clean('<text font-family="Meiryo, serif" style="font-family: \'Comic Sans\'">文字</text>')
        text = ET.fromstring(result.svg).find("s:text", NS)
        self.assertEqual(text.get("font-family"), "Noto Serif JP")
        self.assertEqual(text.get("style"), "font-family: 'Noto Sans JP'")

    def test_emoji_are_removed_from_text_but_japanese_and_bmp_symbols_stay(self):
        result = clean("<text>医薬祭🎉2026<tspan>★楽しもう😀️</tspan>👨‍👩‍👧</text>")
        text = "".join(ET.fromstring(result.svg).find("s:text", NS).itertext())
        self.assertEqual(text, "医薬祭2026★楽しもう")

    def test_size_is_forced_and_viewbox_kept_or_filled_in(self):
        kept = IL.sanitize_svg('<svg xmlns="http://www.w3.org/2000/svg" width="99999" height="5" '
                               'viewBox="0 0 800 450" x="5"><rect/></svg>', 1600, 900)
        root = ET.fromstring(kept.svg)
        self.assertEqual((root.get("width"), root.get("height"), root.get("viewBox")), ("1600", "900", "0 0 800 450"))
        self.assertIsNone(root.get("x"))
        filled = ET.fromstring(IL.sanitize_svg('<svg xmlns="http://www.w3.org/2000/svg" width="400px" height="300">'
                                               '<rect/></svg>', 1080, 1080).svg)
        self.assertEqual(filled.get("viewBox"), "0 0 400 300")
        bare = ET.fromstring(IL.sanitize_svg("<svg><rect/></svg>", 900, 1600).svg)
        self.assertEqual(bare.get("viewBox"), "0 0 900 1600")

    def test_missing_namespace_declarations_are_filled_in(self):
        result = IL.sanitize_svg('<svg width="10" height="10"><defs><g id="a"/></defs><use xlink:href="#a"/></svg>',
                                 1080, 1080)
        root = ET.fromstring(result.svg)
        self.assertEqual(root.tag, f"{{{IL.SVG_NS}}}svg")
        self.assertEqual(root.find("s:use", NS).get("href"), "#a")

    def test_links_and_switches_become_groups_and_keep_their_children(self):
        root = ET.fromstring(clean('<a href="https://evil/"><rect id="r"/></a><switch><text>文</text></switch>').svg)
        groups = root.findall("s:g", NS)
        self.assertEqual(len(groups), 2)
        self.assertIsNone(groups[0].get("href"))
        self.assertIsNotNone(groups[0].find("s:rect", NS))
        self.assertIsNotNone(groups[1].find("s:text", NS))

    def test_text_after_a_removed_element_is_not_lost(self):
        root = ET.fromstring(clean("<text>前<script>x</script>後</text>").svg)
        self.assertEqual("".join(root.find("s:text", NS).itertext()), "前後")

    def test_dangerous_or_huge_documents_are_refused(self):
        with self.assertRaises(IL.SvgError):
            IL.sanitize_svg('<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg>&x;</svg>', 10, 10)
        with self.assertRaises(IL.SvgError):
            IL.sanitize_svg('<svg xmlns="http://www.w3.org/2000/svg"><!ENTITY a "b"></svg>', 10, 10)
        with self.assertRaises(IL.SvgError):
            IL.sanitize_svg('<html xmlns="http://www.w3.org/1999/xhtml"></html>', 10, 10)
        with self.assertRaises(IL.SvgError):
            IL.sanitize_svg("<svg>" + "<g>" * 50 + "</g>" * 50 + "</svg>", 10, 10)
        with self.assertRaises(IL.SvgError):
            IL.sanitize_svg("<svg>" + "<rect/>" * (IL.MAX_ELEMENTS + 1) + "</svg>", 10, 10)
        with self.assertRaises(IL.SvgError):
            IL.sanitize_svg("<svg>" + " " * IL.MAX_SVG_CHARS + "</svg>", 10, 10)
        with self.assertRaises(IL.SvgError):
            IL.sanitize_svg("<svg><rect></svg>", 10, 10)

    def test_root_must_be_svg(self):
        with self.assertRaises(IL.SvgError) as error:
            IL.sanitize_svg('<x:svg xmlns:x="urn:not-svg"/>', 10, 10)
        self.assertIn("SVG", error.exception.message)

    def test_output_reparses_and_has_the_title(self):
        result = clean("<title>  模擬店の\n値段表  </title><rect/>")
        self.assertEqual(result.title, "模擬店の 値段表")
        ET.fromstring(result.svg)
        self.assertEqual(IL.title_for(result, "依頼"), "模擬店の 値段表")
        untitled = clean("<rect/>")
        self.assertEqual(IL.title_for(untitled, "焼きそばの値段表\n赤と黄色"), "焼きそばの値段表")


class PromptTests(unittest.TestCase):
    def test_prompt_names_the_canvas_the_faces_and_fences_the_request(self):
        prompt = IL.build_image_prompt("模擬店の値段表", "9:16")
        self.assertIn('width="900" height="1600" viewBox="0 0 900 1600"', prompt)
        for family in IL.FONT_FAMILIES:
            self.assertIn(family, prompt)
        self.assertIn("<<<\n模擬店の値段表\n>>>", prompt)
        self.assertIn("<image>", prompt)   # 使わない要素として明示
        retry = IL.build_retry_prompt("模擬店の値段表", "9:16", "SVG が途中で切れていました")
        self.assertIn("SVG が途中で切れていました", retry)
        self.assertTrue(retry.startswith(prompt))

    def test_sizes_and_request_cleaning(self):
        self.assertEqual(IL.size_for("16:9"), (1600, 900))
        self.assertEqual(IL.size_for("unknown"), (1080, 1080))
        self.assertEqual(set(IL.ASPECT_SIZES), set(IL.ASPECT_LABELS))
        self.assertEqual(IL.clean_request(" \x00赤い\r\n看板\x07 "), "赤い\n看板")


if __name__ == "__main__":
    unittest.main()
