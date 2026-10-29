# -*- coding: utf-8 -*-
"""委員会の名前とキャンパス、文書の中で伏せずに残すメールドメイン。

学校名・キャンパス名・学校のドメインはコードに書かず、config.toml の [org] に置く(未設定なら既定値)。
起動時に bot.setup_hook が configure を呼ぶ。手動の mirror ビルドのように configure を呼ばない経路は既定値で動く
(残すドメインが委員会のものだけになるので、伏せる側に倒れる)。

AI への指示文は {委員会名}・{キャンパス}・{他キャンパス} の目印を書いておき、使うときに fill で埋める。
f-string の中では name()・campus() を直接呼ぶ。
"""

import re

DEFAULT_NAME = "医学薬学祭実行委員会"
DEFAULT_CAMPUS = "本キャンパス"
DEFAULT_OTHER_CAMPUSES = "ほかのキャンパスの学祭"
# 委員会自身のドメイン。[org] keep_mail_domains はこれに足す
OWN_MAIL_DOMAINS = ("iyakusai.com", "iyakusai.jp")

_DOMAIN_RE = re.compile(r"[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+")

_name = DEFAULT_NAME
_campus = DEFAULT_CAMPUS
_other_campuses = DEFAULT_OTHER_CAMPUSES
_keep_mail_domains = OWN_MAIL_DOMAINS
_mail_mask_cache: dict[tuple[str, ...], re.Pattern] = {}


def valid_domain(domain: str) -> bool:
    return bool(_DOMAIN_RE.fullmatch(domain))


def configure(name: str | None = None, campus: str | None = None, other_campuses: str | None = None,
              keep_mail_domains: list[str] | tuple[str, ...] | None = None) -> None:
    global _name, _campus, _other_campuses, _keep_mail_domains
    _name = (name or "").strip() or DEFAULT_NAME
    _campus = (campus or "").strip() or DEFAULT_CAMPUS
    _other_campuses = (other_campuses or "").strip() or DEFAULT_OTHER_CAMPUSES
    extra = tuple(d for d in (keep_mail_domains or ()) if d not in OWN_MAIL_DOMAINS)
    _keep_mail_domains = OWN_MAIL_DOMAINS + extra


def name() -> str:
    return _name


def campus() -> str:
    return _campus


def other_campuses() -> str:
    return _other_campuses


def fill(text: str) -> str:
    return (text.replace("{委員会名}", _name)
            .replace("{キャンパス}", _campus)
            .replace("{他キャンパス}", _other_campuses))


def mail_mask_re() -> re.Pattern:
    """残すドメイン以外のメールアドレスに当たる式(伏せる側)。サブドメインは残さない。"""
    key = _keep_mail_domains
    pat = _mail_mask_cache.get(key)
    if pat is None:
        keep = "|".join(re.escape(d) for d in key)
        pat = re.compile(r"\b[A-Za-z0-9._%+-]+@(?!(?:" + keep + r")(?![\w.-]))[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")
        _mail_mask_cache[key] = pat
    return pat
