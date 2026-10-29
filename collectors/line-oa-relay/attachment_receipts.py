"""Positive receipt checks shared by normal delivery and history verification."""
from pathlib import Path
import re
import urllib.parse
import urllib.request

from attachment_receipt_core import validate_attachment_metadata, verify_attachment_bytes
from jpeg_receipt import metadata_only_jpeg_change
from oa_relay import ValidationError
from operating_policy import BOT


def validate_receipt_metadata(message, thread_id, part):
    if (not isinstance(message, dict) or not isinstance(message.get("author"), dict)
            or message["author"].get("id") != BOT or message.get("channel_id") != thread_id
            or message.get("content") != part.content
            or not isinstance(message.get("id"), str)
            or not re.fullmatch(r"\d{17,20}", message["id"])):
        raise ValidationError("receipt_author_destination_or_content_mismatch")
    received = message.get("attachments", [])
    if not isinstance(received, list):
        raise ValidationError("receipt_attachment_mismatch")
    if part.attachment:
        if len(received) != 1:
            raise ValidationError("receipt_attachment_mismatch")
        try:
            validate_attachment_metadata(received[0], expected_name=part.attachment.name,
                expected_size=part.attachment.size)
        except (ValueError, TypeError):
            raise ValidationError("receipt_attachment_mismatch") from None
    elif received:
        raise ValidationError("receipt_unexpected_attachment")
    return message["id"]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValidationError("receipt_attachment_redirect_rejected")


def validate_attachment_url(url, thread_id):
    try:
        parts = urllib.parse.urlsplit(url)
        allowed = (parts.scheme == "https" and parts.hostname in {"cdn.discordapp.com", "media.discordapp.net"}
            and not parts.username and not parts.password and parts.port in {None, 443}
            and parts.path.startswith("/attachments/"+thread_id+"/"))
    except (ValueError, TypeError):
        allowed = False
    if not allowed:
        raise ValidationError("receipt_attachment_url_invalid")


def download_verified_attachment(url, attachment, thread_id, *, received_size, media_root):
    validate_attachment_url(url, thread_id)
    if type(received_size) is not int or not 0 < received_size <= 10 * 1024 * 1024:
        raise ValidationError("receipt_attachment_size_invalid")
    root = Path(media_root).resolve(strict=True)
    source_path = attachment.path.resolve(strict=True)
    if not source_path.is_relative_to(root) or not source_path.is_file():
        raise ValidationError("receipt_source_outside_official_store")
    with source_path.open("rb") as source:
        original = source.read(attachment.size+1)
    # CDN requests carry no Bot authorization and reject every redirect.
    request = urllib.request.Request(url, headers={"User-Agent": "IyakusaiOfficialLINE/1.0"})
    with urllib.request.build_opener(NoRedirect()).open(request, timeout=25) as response:
        received = response.read(received_size+1)
    try:
        return verify_attachment_bytes(original, received, expected_name=attachment.name,
            expected_size=attachment.size, expected_sha256=attachment.sha256,
            received_size=received_size, jpeg_equivalent=metadata_only_jpeg_change)
    except (ValueError, TypeError):
        raise ValidationError("receipt_attachment_bytes_not_verified") from None


def validate_positive_receipt(message, thread_id, part, *, media_root, downloader=download_verified_attachment):
    message_id = validate_receipt_metadata(message, thread_id, part)
    proof = None
    if part.attachment:
        received = message["attachments"][0]
        proof = downloader(received["url"], part.attachment, thread_id,
            received_size=received["size"], media_root=media_root)
    return message_id, proof
