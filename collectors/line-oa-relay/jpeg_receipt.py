"""Compare JPEG image data while permitting only safe EXIF/JFIF metadata changes."""
import struct

__all__ = ['metadata_only_jpeg_change']

_SOI = bytes.fromhex('ffd8')
_EOI = bytes.fromhex('ffd9')
_EXIF = b'Exif' + bytes(2)
_SOF = frozenset(range(0xC0, 0xD0)) - {0xC4, 0xC8, 0xCC}


class _Bad(Exception):
    """Internal error that carries no input bytes."""


def _parse(data):
    if not isinstance(data, (bytes, bytearray, memoryview)):
        raise _Bad()
    data = bytes(data)
    if len(data) < 8 or data[:2] != _SOI or data[-2:] != _EOI:
        raise _Bad()
    limit = len(data) - 2
    pos = 2
    segs = []
    sof = False
    while True:
        if pos + 4 > limit or data[pos] != 0xFF:
            raise _Bad()
        m = data[pos + 1]
        if m in (0x00, 0x01, 0xFF, 0xD8, 0xD9) or 0xD0 <= m <= 0xD7:
            raise _Bad()
        ln = struct.unpack('>H', data[pos + 2:pos + 4])[0]
        if ln < 2 or pos + 2 + ln > limit:
            raise _Bad()
        seg = data[pos:pos + 2 + ln]
        pos += 2 + ln
        if m in _SOF:
            if sof or ln < 8:
                raise _Bad()
            sof = True
        segs.append((m, seg))
        if m == 0xDA:
            if not sof:
                raise _Bad()
            return segs, data[pos:]


def _exif_ok(t):
    if len(t) < 8:
        return False
    if t[:2] == b'II':
        e = '<'
    elif t[:2] == b'MM':
        e = '>'
    else:
        return False
    if struct.unpack(e + 'H', t[2:4])[0] != 42:
        return False
    off = struct.unpack(e + 'I', t[4:8])[0]
    if off < 8 or off + 2 > len(t):
        return False
    n = struct.unpack(e + 'H', t[off:off + 2])[0]
    end = off + 2 + 12 * n
    if end + 4 > len(t):
        return False
    seen = False
    for i in range(n):
        p = off + 2 + 12 * i
        tag, typ, cnt = struct.unpack(e + 'HHI', t[p:p + 8])
        if tag == 0x0112:
            if seen or typ != 3 or cnt != 1:
                return False
            if struct.unpack(e + 'H', t[p + 8:p + 10])[0] != 1:
                return False
            seen = True
    nxt = struct.unpack(e + 'I', t[end:end + 4])[0]
    if nxt != 0 and (nxt < 8 or nxt + 2 > len(t)):
        return False
    return True


def _canonical(data):
    segs, tail = _parse(data)
    out = [_SOI]
    exif_count = 0
    jfif_count = 0
    for m, seg in segs:
        if m == 0xE1 and seg[4:10] == _EXIF:
            exif_count += 1
            if exif_count > 1 or not _exif_ok(seg[10:]):
                raise _Bad()
            continue
        if m == 0xE0 and seg[4:9] == b'JFIF' + bytes(1):
            # JFIF density/version metadata without a thumbnail. All image
            # frame, entropy, quantization, Huffman, ICC and other bytes stay.
            if (len(seg) != 18 or seg[9:11] not in (b'\x01\x01', b'\x01\x02')
                    or seg[11] not in (0, 1, 2) or seg[16:18] != bytes(2)):
                raise _Bad()
            jfif_count += 1
            if jfif_count > 1:
                raise _Bad()
            continue
        out.append(seg)
    out.append(tail)
    return b''.join(out), exif_count + jfif_count


def metadata_only_jpeg_change(source: bytes, received: bytes) -> bool:
    """Only safe EXIF/JFIF metadata differ; all remaining JPEG bytes match."""
    try:
        canonical_source, source_count = _canonical(source)
        canonical_received, received_count = _canonical(received)
        return (bytes(source) != bytes(received) and source_count + received_count > 0
                and canonical_source == canonical_received)
    except Exception:
        return False
