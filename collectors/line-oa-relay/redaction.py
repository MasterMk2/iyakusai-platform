"""Span-bound local redaction. Source values are never returned in audit data."""
from dataclasses import dataclass
import re
import unicodedata

from content_policy import COMPILED

ORIGINAL_GUIDANCE = "原文は公式LINEの管理画面で、この受信日時のメッセージを確認してください（既存の閲覧権限がある担当者向け）。"

VALUE_PATTERNS = (
    re.compile(r"(?i:\bauthorization[\"']?\s*[:=]\s*[\"']?)(?P<value>(?i:bearer|basic)\s+[A-Za-z0-9+/=_-]+)"),
    re.compile(r"-----BEGIN (?:[A-Z ]*PRIVATE KEY(?: BLOCK)?)-----[\s\S]*?(?:-----END (?:[A-Z ]*PRIVATE KEY(?: BLOCK)?)-----|\Z)"),
    re.compile(r"(?i:\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{15,}|AKIA[A-Z0-9]{16})\b)"),
    re.compile(r"(?i:\b(?:password|passwd|pwd|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|secret|authorization)[\"']?\s*[:=]\s*[\"']?)(?P<value>[^\s\"'<>&,;]{1,})"),
    re.compile(r"(?i:\b(?:bearer|basic)\s+)(?P<value>[A-Za-z0-9+/=_-]{12,})"),
    re.compile(r"\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b"),
    re.compile(r"(?:パスワード|暗証番号|認証コード|ワンタイムコード|APIキー)(?:\s*(?:[:=：]|は)\s*)(?P<value>[A-Za-z0-9_+/=!@#$%*-]{3,})"),
    re.compile(r"(?i:https?://)(?P<value>[^\s/@:]+:[^\s/@]{3,})@"),

)


@dataclass(frozen=True)
class Redaction:
    text: str
    codes: tuple[str, ...]
    spans_redacted: int


def normalized_positions(text):
    characters, starts, ends = [], [], []
    for index, character in enumerate(text):
        if unicodedata.category(character) == "Cf":
            continue
        normalized = unicodedata.normalize("NFKC", character)
        if unicodedata.combining(character) and characters:
            previous = characters.pop()
            previous_start = starts.pop()
            ends.pop()
            normalized = unicodedata.normalize("NFKC", previous + character)
            start = previous_start
        else:
            start = index
        for value in normalized:
            characters.append(value)
            starts.append(start)
            ends.append(index + 1)
    return "".join(characters), starts, ends


def redact_text(text: str) -> Redaction:
    normalized, starts, ends = normalized_positions(text)
    spans, codes = [], set()
    for expression in VALUE_PATTERNS:
        for match in expression.finditer(normalized):
            begin, end = match.span("value") if "value" in match.re.groupindex else match.span()
            if end > begin:
                spans.append((starts[begin], ends[end - 1]))
    for code, expression in COMPILED:
        matches = list(expression.finditer(normalized))
        if not matches:
            continue
        codes.add(code)
    # Credential detection without a more specific value matcher must never
    # leak a partial key. For those exact detected spans, hide the full match.
    for code, expression in COMPILED:
        if code != "credential_material":
            continue
        for match in expression.finditer(normalized):
            begin, end = starts[match.start()], ends[match.end() - 1]
            if not any(a < end and b > begin for a, b in spans):
                spans.append((begin, end))
    if not spans:
        return Redaction(text, (), 0)
    combined = []
    for begin, end in sorted(spans):
        if combined and begin <= combined[-1][1]:
            combined[-1] = (combined[-1][0], max(end, combined[-1][1]))
        else:
            combined.append((begin, end))
    output, position = [], 0
    for begin, end in combined:
        output.extend([text[position:begin], "＜保護対象の情報を伏せました＞"])
        position = end
    output.append(text[position:])
    return Redaction("".join(output), tuple(sorted(codes)), len(combined))
