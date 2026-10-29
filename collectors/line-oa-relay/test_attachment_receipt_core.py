import hashlib
import unittest

import attachment_receipt_core as arc

DOC = b'synthetic-document-bytes-0123456789'
DOC_SHA = hashlib.sha256(DOC).hexdigest()
JPG = b'FAKEJPEG-frame-data-AAAA'
JPG_SHA = hashlib.sha256(JPG).hexdigest()
JPG2 = b'FAKEJPEG-frame-data-AAAA-meta-stripped'
MIB10 = 10 * 1024 * 1024


class Recorder:
    def __init__(self, result=True, exc=None):
        self.calls = 0
        self.result = result
        self.exc = exc

    def __call__(self, a, b):
        self.calls += 1
        if self.exc:
            raise self.exc
        return self.result


def meta(name='sample_doc.pdf', title='sample_doc', size=len(DOC)):
    return {'filename': name, 'title': title, 'size': size}


class MetadataTests(unittest.TestCase):
    def check(self, received, code, name='sample_doc.pdf', size=len(DOC)):
        with self.assertRaises(ValueError) as cm:
            arc.validate_attachment_metadata(received, expected_name=name, expected_size=size)
        self.assertEqual(str(cm.exception), code)

    def test_exact_name_ok(self):
        self.assertIsNone(arc.validate_attachment_metadata(
            meta(), expected_name='sample_doc.pdf', expected_size=len(DOC)))

    def test_safe_renamed_same_suffix_ok(self):
        arc.validate_attachment_metadata(meta(name='renamed(1).pdf'),
                                         expected_name='sample_doc.pdf', expected_size=len(DOC))

    def test_suffix_change_rejected(self):
        self.check(meta(name='sample_doc.exe'), arc.E_RECEIVED_NAME)

    def test_path_separators_rejected(self):
        self.check(meta(name='dir/sample_doc.pdf'), arc.E_RECEIVED_NAME)
        self.check(meta(name='dir' + chr(92) + 'sample_doc.pdf'), arc.E_RECEIVED_NAME)
        self.check(meta(name='dir' + chr(0xFF0F) + 'x.pdf'), arc.E_RECEIVED_NAME)
        self.check(meta(), arc.E_EXPECTED_NAME, name='a/sample_doc.pdf')

    def test_title_missing_or_wrong(self):
        r = meta(name='renamed.pdf')
        del r['title']
        self.check(r, arc.E_RECEIVED_TITLE)
        self.check(meta(name='renamed.pdf', title='other'), arc.E_RECEIVED_TITLE)
        self.check(meta(name='renamed.pdf', title='sample' + chr(0xFF3F) + 'doc'), arc.E_RECEIVED_TITLE)

    def test_exact_name_needs_no_optional_title(self):
        arc.validate_attachment_metadata(meta(title=None), expected_name='sample_doc.pdf', expected_size=len(DOC))

    def test_fullwidth_japanese_name_remains_exact(self):
        name='架空＿一覧.xlsx'
        arc.validate_attachment_metadata(meta(name='fixture.xlsx', title='架空＿一覧'), expected_name=name, expected_size=len(DOC))

    def test_bool_and_range_sizes(self):
        self.check(meta(size=True), arc.E_RECEIVED_SIZE)
        self.check(meta(size=0), arc.E_RECEIVED_SIZE)
        self.check(meta(size=MIB10 + 1), arc.E_RECEIVED_SIZE)
        self.check(meta(), arc.E_EXPECTED_SIZE, size=True)
        self.check(meta(), arc.E_EXPECTED_SIZE, size=MIB10 + 1)

    def test_document_size_must_match_jpeg_may_differ(self):
        self.check(meta(size=len(DOC) + 1), arc.E_SIZE_MISMATCH)
        arc.validate_attachment_metadata(
            {'filename': 'photo_x.jpg', 'title': 'photo_x', 'size': 999},
            expected_name='photo_x.jpg', expected_size=500)

    def test_errors_do_not_leak_input(self):
        with self.assertRaises(ValueError) as cm:
            arc.validate_attachment_metadata(meta(name='secret_fake/zz.pdf'),
                                             expected_name='sample_doc.pdf', expected_size=len(DOC))
        self.assertNotIn('secret_fake', str(cm.exception))
        self.assertNotIn('sample_doc', str(cm.exception))


class BytesTests(unittest.TestCase):
    def run_doc(self, received, received_size=None, cb=None, source=DOC, sha=DOC_SHA):
        return arc.verify_attachment_bytes(
            source, received, expected_name='sample_doc.pdf', expected_size=len(DOC),
            expected_sha256=sha,
            received_size=len(received) if received_size is None else received_size,
            jpeg_equivalent=cb or Recorder())

    def run_jpg(self, cb, received=JPG2):
        return arc.verify_attachment_bytes(
            JPG, received, expected_name='photo_x.jpeg', expected_size=len(JPG),
            expected_sha256=JPG_SHA, received_size=len(received), jpeg_equivalent=cb)

    def assertCode(self, code, fn, *a, **k):
        with self.assertRaises(ValueError) as cm:
            fn(*a, **k)
        self.assertEqual(str(cm.exception), code)

    def test_exact_bytes_proof(self):
        cb = Recorder()
        out = self.run_doc(DOC, cb=cb)
        self.assertEqual(out, {'method': 'exact_bytes', 'source_size': len(DOC),
                               'source_sha256': DOC_SHA, 'received_size': len(DOC),
                               'received_sha256': DOC_SHA})
        self.assertEqual(cb.calls, 0)

    def test_jpeg_transformed_proof_distinct_hashes(self):
        out = self.run_jpg(lambda s, r: True)
        self.assertEqual(out['method'], 'jpeg_safe_metadata_only')
        self.assertEqual(out['source_sha256'], JPG_SHA)
        self.assertEqual(out['received_sha256'], hashlib.sha256(JPG2).hexdigest())
        self.assertNotEqual(out['source_sha256'], out['received_sha256'])
        self.assertEqual(set(out), {'method', 'source_size', 'source_sha256',
                                    'received_size', 'received_sha256'})
        for v in out.values():
            self.assertNotIsInstance(v, bytes)

    def test_changed_source_rejected(self):
        bad = b'X' + DOC[1:]
        self.assertCode(arc.E_SOURCE_HASH, self.run_doc, DOC, source=bad)
        self.assertCode(arc.E_SOURCE_SIZE, self.run_doc, DOC, source=DOC + b'!')
        self.assertCode(arc.E_EXPECTED_HASH, self.run_doc, DOC, sha=DOC_SHA.upper())

    def test_same_size_changed_document_never_calls_callback(self):
        cb = Recorder(result=True)
        changed = DOC[:-1] + b'Z'
        self.assertCode(arc.E_CONTENT_MISMATCH, self.run_doc, changed, cb=cb)
        self.assertEqual(cb.calls, 0)

    def test_received_size_mismatch_and_bool(self):
        self.assertCode(arc.E_SIZE_MISMATCH, self.run_doc, DOC, received_size=len(DOC) + 1)
        self.assertCode(arc.E_RECEIVED_SIZE, self.run_doc, DOC, received_size=True)
        self.assertCode(arc.E_RECEIVED_SIZE, self.run_doc, DOC, received_size=MIB10 + 1)

    def test_orientation_or_icc_change_callback_false(self):
        self.assertCode(arc.E_JPEG_NOT_EQUIVALENT, self.run_jpg, lambda s, r: False)

    def test_callback_exception_fails_closed(self):
        self.assertCode(arc.E_CALLBACK, self.run_jpg, Recorder(exc=RuntimeError('boom fake')))

    def test_malicious_truthy_callback_values(self):
        for v in (1, 'yes', [1], object()):
            self.assertCode(arc.E_JPEG_NOT_EQUIVALENT, self.run_jpg, lambda s, r, v=v: v)

    def test_unsafe_expected_name_rejected(self):
        self.assertCode(arc.E_EXPECTED_NAME, arc.verify_attachment_bytes, DOC, DOC,
                        expected_name='../sample_doc.pdf', expected_size=len(DOC),
                        expected_sha256=DOC_SHA, received_size=len(DOC),
                        jpeg_equivalent=lambda s, r: True)


if __name__ == '__main__':
    unittest.main()
