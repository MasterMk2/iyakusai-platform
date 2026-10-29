"""Committee login card writer: blank RC-S966 only, with independent same-card readback.

Credentials are kept in memory; no URL, raw blocks or clipboard content is logged or saved.
Existing/residual data are refused. Failed writes can be verified read-only with the same URL.
"""
from __future__ import annotations
import re
from urllib.parse import urlsplit
import single_card_trial as trial

ORIGIN = 'https://app.iyakusai.com'


def validate_login_url(url):
    parts = urlsplit(url)
    if (parts.scheme != 'https' or parts.netloc != 'app.iyakusai.com' or
            parts.path != '/card' or parts.query or parts.username or parts.password or
            not re.fullmatch(r'[A-Za-z0-9_-]{43}', parts.fragment)):
        raise trial.TrialError('委員カードの書込み情報ではありません。設定画面からコピーし直してください。')
    return trial.encode_url(url)


def verify_card(tag, url, expected_id=None):
    encoded = validate_login_url(url)
    snapshot = trial.take_snapshot(tag, expected_id)
    trial.verify_snapshot(snapshot, snapshot['idm'], encoded, url)
    return {'status': 'passed', 'idm_tail': snapshot['idm'][-4:], 'ndef_bytes': len(encoded), 'url_equal': True}


def write_blank_card(tag, url, reacquire):
    encoded = validate_login_url(url)
    before = trial.take_snapshot(tag)
    formatted = trial.check_writeable(before, encoded, allow_format=True, allow_overwrite=False)
    idm = before['idm']
    if formatted:
        if tag.format(version=0x10, wipe=None) is not True:
            raise trial.TrialError('カードを準備できませんでした。有効化せず、担当へ確認してください。')
        after_format = trial.take_snapshot(tag, idm)
        trial.check_mc_change(before, after_format, True)
        tag = reacquire(tag, idm, 'カードの準備ができました。一度離し、同じカードをもう一度タッチしてください。')
        ready = trial.take_snapshot(tag, idm)
        trial.check_mc_change(before, ready, True)
        trial.check_writeable(ready, encoded, False, False)
    area = tag.ndef
    if area is None or not area.is_writeable or len(encoded) > area.capacity:
        raise trial.TrialError('書込み可能な空のカードを確認できません。')
    # Exactly one NDEF write; keys, MAC configuration and protection are untouched.
    area.octets = encoded
    immediate = trial.take_snapshot(tag, idm)
    trial.verify_snapshot(immediate, idm, encoded, url)
    trial.check_mc_change(before, immediate, formatted)
    tag = reacquire(tag, idm, '書込みできました。一度離し、同じカードをタッチして読取確認します。')
    final = trial.take_snapshot(tag, idm)
    trial.verify_snapshot(final, idm, encoded, url)
    trial.check_mc_change(before, final, formatted)
    return {'status': 'passed', 'idm_tail': idm[-4:], 'ndef_bytes': len(encoded), 'url_equal': True}
