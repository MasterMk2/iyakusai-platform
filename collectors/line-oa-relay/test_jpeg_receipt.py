import struct
import unittest

from jpeg_receipt import metadata_only_jpeg_change as f

EXIF = b'Exif' + bytes(2)
SCAN = bytes([0x12, 0x34, 0xFF, 0x00, 0x56, 0x78])
ICC = b'ICC_PROFILE' + bytes([0, 1, 1]) + b'fakeicc'
XMP = b'http://ns.adobe.com/xap/1.0/' + bytes(1) + b'<x/>'


def seg(m, p):
    return bytes([0xFF, m]) + struct.pack('>H', len(p) + 2) + p


def tiff(order=b'II', entries=((0x0112, 3, 1, 1),), off=8, nxt=0, n=None, magic=42):
    e = '<' if order == b'II' else '>'
    body = order + struct.pack(e + 'H', magic) + struct.pack(e + 'I', off)
    body += struct.pack(e + 'H', len(entries) if n is None else n)
    for tag, typ, cnt, val in entries:
        body += struct.pack(e + 'HHI', tag, typ, cnt) + struct.pack(e + 'H', val) + bytes(2)
    return body + struct.pack(e + 'I', nxt)


def exif(**kw):
    return seg(0xE1, EXIF + tiff(**kw))


def build(app=(), w=16, scan=SCAN, icc=ICC):
    parts = [bytes([0xFF, 0xD8]), seg(0xE0, b'JFIF' + bytes([0, 1, 1, 0, 0, 1, 0, 1, 0, 0]))]
    parts += list(app)
    if icc is not None:
        parts.append(seg(0xE2, icc))
    parts.append(seg(0xDB, bytes(1) + bytes(range(1, 65))))
    parts.append(seg(0xC0, bytes([8]) + struct.pack('>HH', 16, w) + bytes([1, 1, 0x11, 0])))
    parts.append(seg(0xC4, bytes(1) + bytes([1]) + bytes(15) + bytes([0])))
    parts.append(seg(0xDA, bytes([1, 1, 0, 0, 0x3F, 0])))
    parts.append(scan)
    parts.append(bytes([0xFF, 0xD9]))
    return b''.join(parts)


class T(unittest.TestCase):
    def test_exif_stripped_match(self):
        self.assertTrue(f(build([exif()]), build()))

    def test_identical_no_exif(self):
        self.assertFalse(f(build(), build()))

    def test_scan_change_rejected(self):
        self.assertFalse(f(build([exif()]), build(scan=bytes([0x12, 0x34, 0xFF, 0x00, 0x57, 0x78]))))

    def test_dimension_change_rejected(self):
        self.assertFalse(f(build([exif()]), build(w=17)))

    def test_icc_change_or_removal_rejected(self):
        self.assertFalse(f(build([exif()]), build(icc=None)))
        self.assertFalse(f(build(), build(icc=ICC + b'x')))

    def test_orientation_6_rejected(self):
        src = build([exif(entries=((0x0112, 3, 1, 6),))])
        self.assertFalse(f(src, build()))
        self.assertFalse(f(src, src))

    def test_ii_mm_orientation1_ok_and_both_keep_exif(self):
        self.assertTrue(f(build([exif(order=b'II')]), build()))
        self.assertTrue(f(build([exif(order=b'MM')]), build()))
        self.assertTrue(f(build([exif(order=b'MM')]), build([exif(order=b'II')])))
        self.assertTrue(f(build([exif(entries=((0x010F, 2, 1, 0),))]), build()))

    def test_bad_exif_rejected(self):
        bad = [
            exif(entries=((0x0112, 3, 1, 1), (0x0112, 3, 1, 1))),
            exif(entries=((0x0112, 4, 1, 1),)),
            exif(entries=((0x0112, 3, 2, 1),)),
            exif(off=500),
            exif(off=4),
            exif(n=40),
            exif(nxt=9999),
            exif(magic=43),
            seg(0xE1, EXIF + b'XX' + bytes(10)),
            exif() + exif(),
        ]
        for b in bad:
            with self.subTest(b=b.hex()[:24]):
                self.assertFalse(f(build([b]), build()))

    def test_bad_jpeg_structure_rejected(self):
        good = build()
        self.assertFalse(f(good[:-2], good[:-2]))
        self.assertFalse(f(b'xx' + good[2:], good))
        broken = good[:4] + bytes([0xFF, 0xFF]) + good[6:]
        self.assertFalse(f(broken, broken))
        no_sof = good.replace(bytes([0xFF, 0xC0]), bytes([0xFF, 0xE5]), 1)
        self.assertFalse(f(no_sof, no_sof))
        self.assertFalse(f('str', good))

    def test_xmp_and_other_markers_must_be_kept(self):
        self.assertFalse(f(build([seg(0xE1, XMP)]), build()))
        self.assertFalse(f(build([seg(0xFE, b'c')]), build()))
        self.assertFalse(f(build([seg(0xEE, b'Adobe' + bytes(7))]), build()))
        self.assertTrue(f(build([exif(), seg(0xE1, XMP)]), build([seg(0xE1, XMP)])))


if __name__ == '__main__':
    unittest.main()
