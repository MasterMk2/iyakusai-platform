"""Synthetic CDN and normal-delivery regression tests; no real content or HTTP."""
import dataclasses
import hashlib
import io
from pathlib import Path
import sqlite3
import unittest
from unittest.mock import patch
import zipfile

from attachment_receipts import (NoRedirect, download_verified_attachment,
    validate_attachment_url, validate_positive_receipt)
from delivery import Delivery
from discord_transport import OutcomeUnknown
from oa_relay import Attachment, Part, ValidationError
from operating_policy import BOT, plan_for_committee
from test_delivery import FakeAPI
from test_jpeg_receipt import build, exif, ICC
from test_oa_relay import StateFixture, FORUM, CATEGORY, THREAD, event, key, registry, test_directory


class CDN:
    def __init__(self, data, *, error=None):
        self.data, self.error, self.requests, self.limits = data, error, [], []

    def open(self, request, *, timeout):
        self.requests.append((request, timeout))
        if self.error:
            raise self.error
        return self

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self, size):
        self.limits.append(size)
        return self.data[:size]


def office():
    out = io.BytesIO()
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('[Content_Types].xml', '<Types/>')
        archive.writestr('xl/workbook.xml', '<workbook/>')
        archive.writestr('xl/worksheets/sheet1.xml', '<worksheet><v>Fixture</v></worksheet>')
    return out.getvalue()


class CDNTests(unittest.TestCase):
    def test_allowed_hosts_and_thread_path_only(self):
        for host in ['cdn.discordapp.com', 'media.discordapp.net']:
            validate_attachment_url('https://'+host+'/attachments/'+THREAD['id']+'/1/a.jpg?fixture=1', THREAD['id'])
        for url in [None, 'http://cdn.discordapp.com/attachments/'+THREAD['id']+'/x',
                    'https://cdn.discordapp.com.evil.invalid/attachments/'+THREAD['id']+'/x',
                    'https://fixture@cdn.discordapp.com/attachments/'+THREAD['id']+'/x',
                    'https://cdn.discordapp.com:81/attachments/'+THREAD['id']+'/x',
                    'https://cdn.discordapp.com/attachments/1999999999999999999/x',
                    'https://cdn.discordapp.com:bad/attachments/'+THREAD['id']+'/x']:
            with self.subTest(url=url), self.assertRaisesRegex(ValidationError, 'url_invalid'):
                validate_attachment_url(url, THREAD['id'])

    def test_redirect_always_rejected(self):
        with self.assertRaisesRegex(ValidationError, 'redirect_rejected'):
            NoRedirect().redirect_request(None, None, 302, '', {}, 'https://cdn.discordapp.com/x')

    def source(self, root, data=b'Fixture bytes', name='試験.txt'):
        path = root / 'source'
        path.write_bytes(data)
        return Attachment(path, name, len(data), hashlib.sha256(data).hexdigest())

    def read(self, root, item, received):
        cdn = CDN(received)
        with patch('attachment_receipts.urllib.request.build_opener', return_value=cdn):
            proof = download_verified_attachment('https://cdn.discordapp.com/attachments/'+THREAD['id']+'/1/file',
                item, THREAD['id'], received_size=len(received), media_root=root)
        return proof, cdn

    def test_exact_bytes_no_authorization_and_bounded_read(self):
        with test_directory() as folder:
            root = Path(folder)
            item = self.source(root)
            proof, cdn = self.read(root, item, item.path.read_bytes())
            self.assertEqual(proof['method'], 'exact_bytes')
            self.assertEqual(cdn.limits, [item.size+1])
            self.assertEqual(cdn.requests[0][1], 25)
            self.assertNotIn('authorization', {k.lower() for k in cdn.requests[0][0].headers})

    def test_source_outside_store_is_never_requested(self):
        with test_directory() as a, test_directory() as b:
            root = Path(a)
            item = self.source(Path(b))
            cdn = CDN(b'Fixture bytes')
            with patch('attachment_receipts.urllib.request.build_opener', return_value=cdn):
                with self.assertRaisesRegex(ValidationError, 'outside_official_store'):
                    download_verified_attachment('https://cdn.discordapp.com/attachments/'+THREAD['id']+'/1/file',
                        item, THREAD['id'], received_size=item.size, media_root=root)
            self.assertEqual(cdn.requests, [])

    def test_changed_source_or_received_document_fails(self):
        with test_directory() as folder:
            root = Path(folder)
            item = self.source(root, b'ABCDE', '試験.xlsx')
            with self.assertRaisesRegex(ValidationError, 'bytes_not_verified'):
                self.read(root, item, b'ABCDF')
            item.path.write_bytes(b'ABCDX')
            with self.assertRaisesRegex(ValidationError, 'bytes_not_verified'):
                self.read(root, item, b'ABCDE')

    def test_safe_jpeg_metadata_and_different_hashes(self):
        with test_directory() as folder:
            root = Path(folder)
            item = self.source(root, build([exif()]), '写真.jpg')
            proof, _ = self.read(root, item, build())
            self.assertEqual(proof['method'], 'jpeg_safe_metadata_only')
            self.assertNotEqual(proof['source_sha256'], proof['received_sha256'])

    def test_jpeg_image_or_color_changes_rejected(self):
        with test_directory() as folder:
            root = Path(folder)
            item = self.source(root, build([exif()]), '写真.jpg')
            for data in [build(w=17), build(icc=ICC+b'x'), build(scan=b'changed')]:
                with self.subTest(data=data[:2]), self.assertRaisesRegex(ValidationError, 'bytes_not_verified'):
                    self.read(root, item, data)

    def test_receipt_body_author_destination_remain_exact(self):
        part = Part(1, 'Fixture [marker]', 'marker', None)
        received = {'id': '1888888888888888888', 'author': {'id': BOT},
            'channel_id': THREAD['id'], 'content': part.content, 'attachments': []}
        for field, bad in [('author', {'id': '1999999999999999999'}), ('author', None),
                           ('channel_id', '1999999999999999999'), ('content', 'changed'),
                           ('id', 1888888888888888888), ('attachments', {})]:
            with self.subTest(field=field), self.assertRaises(ValidationError):
                validate_positive_receipt(dict(received, **{field: bad}), THREAD['id'], part, media_root=Path('unused'))


class AttachmentAPI(FakeAPI):
    def __init__(self, data, name='Fixture_2026.xlsx', *, title=True):
        super().__init__()
        self.data, self.name, self.title = data, name, title

    def modify(self, result, part):
        if part.attachment:
            result['attachments'] = [{'filename': self.name or part.attachment.name,
                'size': len(self.data), 'url': 'https://cdn.discordapp.com/attachments/'+THREAD['id']+'/1/file'}]
            if self.title:
                result['attachments'][0]['title'] = Path(part.attachment.name).stem
        return result

    def create_forum_thread(self, forum_id, plan, root):
        failure, self.failure = self.failure, None
        result = super().create_forum_thread(forum_id, plan, root)
        self.failure = failure
        self.modify(result['message'], plan.parts[0])
        if failure:
            raise failure
        return result

    def create_message(self, thread_id, plan, part, root):
        failure, self.failure = self.failure, None
        result = super().create_message(thread_id, plan, part, root)
        self.failure = failure
        self.modify(result, part)
        if failure:
            raise failure
        return result


class NormalAttachmentTests(StateFixture, unittest.TestCase):
    def plan(self, data, name='団体Ａ＿構成員.xlsx', *, n=2, text='添付します。'):
        message_id = str(50000+n)
        (self.root / message_id).write_bytes(data)
        mime = 'image/jpeg' if name.endswith('.jpg') else 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        (self.root / (message_id+'.meta.json')).write_text('{"content_type":"'+mime+'"}', encoding='utf-8')
        plan = plan_for_committee(event(n, kind='file', file_name=name, text=text), registry(), self.root)
        self.assertIsNotNone(plan.parts[0].attachment)
        self.state.register(plan)
        return plan

    def delivery(self, api):
        return Delivery(api, self.state, FORUM, CATEGORY, self.root)

    def proof(self, plan):
        return self.state.db.execute('SELECT source_sha256,received_sha256,method FROM delivery_attachment_receipts WHERE identity=?', (plan.event.identity,)).fetchone()

    def test_creating_thread_renamed_office_fullwidth_name_and_ledger(self):
        data = office()
        plan = self.plan(data)
        api, cdn = AttachmentAPI(data), CDN(data)
        baseline, activated = self.state.value('baseline'), self.state.value('activated_at')
        with patch('attachment_receipts.urllib.request.build_opener', return_value=cdn):
            self.assertEqual(self.delivery(api).dispatch(plan), 'delivered')
            self.assertEqual(self.delivery(api).dispatch(plan), 'delivered')
        sha = hashlib.sha256(data).hexdigest()
        self.assertEqual(self.proof(plan), (sha, sha, 'exact_bytes'))
        self.assertEqual(len(api.posts), 1)
        self.assertEqual(self.state.value('delivered_cursor'), key(2))
        self.assertEqual((baseline, activated), (self.state.value('baseline'), self.state.value('activated_at')))

    def test_exact_filename_without_title_is_valid(self):
        data = office()
        plan = self.plan(data, 'fixture.xlsx')
        api = AttachmentAPI(data, name=None, title=False)
        with patch('attachment_receipts.urllib.request.build_opener', return_value=CDN(data)):
            self.assertEqual(self.delivery(api).dispatch(plan), 'delivered')

    def test_existing_thread_get_reconciles_timeout_without_second_post(self):
        api = AttachmentAPI(office())
        first = plan_for_committee(event(2), registry(), self.root)
        self.state.register(first)
        self.assertEqual(self.delivery(api).dispatch(first), 'delivered')
        plan = self.plan(office(), n=3)
        api.failure = OutcomeUnknown()
        with patch('attachment_receipts.urllib.request.build_opener', return_value=CDN(office())):
            self.assertEqual(self.delivery(api).dispatch(plan), 'unknown')
            self.assertEqual(self.delivery(api).dispatch(plan), 'delivered')
        self.assertEqual(len(api.posts), 2)
        self.assertEqual(self.proof(plan)[2], 'exact_bytes')

    def test_cdn_timeout_keeps_intent_then_get_only_recovery(self):
        data = office()
        plan, api = self.plan(data), AttachmentAPI(data)
        with patch('attachment_receipts.urllib.request.build_opener', return_value=CDN(data, error=TimeoutError('fixture'))):
            self.assertEqual(self.delivery(api).dispatch(plan), 'unknown')
        self.assertEqual(self.state.value('delivered_cursor'), key(1))
        self.assertIsNone(self.proof(plan))
        with patch('attachment_receipts.urllib.request.build_opener', return_value=CDN(data)):
            self.assertEqual(self.delivery(api).dispatch(plan), 'delivered')
        self.assertEqual(len(api.posts), 1)

    def test_missing_receipt_never_reposts(self):
        data = office()
        plan, api = self.plan(data), AttachmentAPI(data)
        api.failure = OutcomeUnknown()
        self.assertEqual(self.delivery(api).dispatch(plan), 'unknown')
        api.messages = []
        for _ in range(2):
            self.assertEqual(self.delivery(api).dispatch(plan), 'unknown')
        self.assertEqual(len(api.posts), 1)

    def test_duplicate_body_with_invalid_file_is_ambiguous(self):
        data = office()
        plan, api = self.plan(data), AttachmentAPI(data)
        api.failure = OutcomeUnknown()
        self.assertEqual(self.delivery(api).dispatch(plan), 'unknown')
        duplicate = dict(api.messages[0], id='1888888888888888889', attachments=[])
        api.messages.append(duplicate)
        self.assertEqual(self.delivery(api).reconcile(plan), 'ambiguous_receipts')
        self.assertIsNone(self.proof(plan))
        self.assertEqual(len(api.posts), 1)

    def test_changed_office_bytes_remain_unknown_without_repost(self):
        data = office()
        plan, api = self.plan(data), AttachmentAPI(data)
        changed = data[:-1]+bytes([data[-1]^1])
        with patch('attachment_receipts.urllib.request.build_opener', return_value=CDN(changed)):
            for _ in range(2):
                self.assertEqual(self.delivery(api).dispatch(plan), 'unknown')
        self.assertEqual(len(api.posts), 1)
        self.assertIsNone(self.proof(plan))

    def test_safe_jpeg_metadata_receipt_records_both_hashes(self):
        original, received = build([exif()]), build()
        plan = self.plan(original, '写真.jpg')
        api = AttachmentAPI(received, 'fixture.jpg')
        with patch('attachment_receipts.urllib.request.build_opener', return_value=CDN(received)):
            self.assertEqual(self.delivery(api).dispatch(plan), 'delivered')
        proof = self.proof(plan)
        self.assertNotEqual(proof[0], proof[1])
        self.assertEqual(proof[2], 'jpeg_safe_metadata_only')

    def test_ledger_failure_after_post_does_not_reset_intent(self):
        data = office()
        plan, api = self.plan(data), AttachmentAPI(data)
        delivery = self.delivery(api)
        with patch('attachment_receipts.urllib.request.build_opener', return_value=CDN(data)):
            with patch.object(delivery, '_record_attachment_proof', side_effect=sqlite3.OperationalError('fixture')):
                self.assertEqual(delivery.dispatch(plan), 'unknown')
            self.assertEqual(self.delivery(api).dispatch(plan), 'delivered')
        self.assertEqual(len(api.posts), 1)

    def test_long_body_attachment_then_text_parts_are_confirmed_once(self):
        data = office()
        plan = self.plan(data, text='連絡の本文です。'*250)
        self.assertGreater(len(plan.parts), 1)
        api = AttachmentAPI(data)
        with patch('attachment_receipts.urllib.request.build_opener', return_value=CDN(data)):
            self.assertEqual(self.delivery(api).dispatch(plan), 'delivered')
        self.assertEqual(len(api.posts), len(plan.parts))
        self.assertEqual(self.state.value('delivered_cursor'), key(2))


if __name__ == '__main__':
    unittest.main()
