"""Windows preparation workflow; no card access and no persisted credentials.

Two kinds of rental server are supported, detected from the server itself:
- the unified committee app (https://app.iyakusai.com): student ID and password of the
  Discord account login; the rental API lives under /api/rental and the label URLs use the
  item origin the server reports (https://app.iyakusai.com since 2026-10-13);
- the earlier rental server (https://rental.iyakusai.com before the switch): staff code.
"""
from __future__ import annotations

import csv
from concurrent.futures import ThreadPoolExecutor
import hashlib
import uuid
import http.cookiejar
import io
import json
import os
import re
import sys
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

BASE = Path(__file__).resolve().parents[1]
if str(BASE) not in sys.path:
    sys.path.insert(0, str(BASE))

UNIFIED_ORIGIN = "https://app.iyakusai.com"
LEGACY_ORIGIN = "https://rental.iyakusai.com"
DEFAULT_ORIGIN = UNIFIED_ORIGIN
MAX_ITEMS = 10000
MAX_DOCUMENT_BYTES = 16 * 1024 * 1024
HEADER_ALIASES = {
    "borrower_name": {"貸出先", "貸出先団体", "貸出先団体名", "団体", "団体名", "部署", "borrower_name"},
    "name": {"物品", "物品名", "品名", "name"},
    "quantity": {"数量", "個数", "数", "quantity"},
}


class WorkflowError(ValueError):
    """A safe, user-readable validation or connection failure."""


def normalize_origin(origin):
    if not isinstance(origin, str) or not origin.strip():
        raise WorkflowError("接続先のHTTPS URLを指定してください。")
    origin = origin.strip().rstrip("/")
    try:
        parts = urllib.parse.urlsplit(origin)
        allowed = parts.scheme == "https" or (parts.scheme == "http" and parts.hostname in ("localhost", "127.0.0.1", "::1"))
        if not allowed or not parts.hostname or parts.username or parts.password or parts.path or parts.query or parts.fragment:
            raise ValueError()
        if parts.port is not None and not 1 <= parts.port <= 65535:
            raise ValueError()
        if any(ord(c) <= 32 or ord(c) > 126 for c in origin):
            raise ValueError()
    except ValueError:
        raise WorkflowError("接続先はパスなしのHTTPS URLにしてください。ローカル試験だけHTTPを使えます。") from None
    return origin


def _text(value, label, limit):
    if not isinstance(value, str):
        raise WorkflowError(f"{label}を文字で入力してください。")
    text = value.strip()
    if not text or len(text) > limit or any(ord(c) < 32 or ord(c) == 127 for c in text):
        raise WorkflowError(f"{label}は改行なしの1〜{limit}文字にしてください。")
    return text


def _quantity(value):
    if type(value) is int:
        number = value
    elif isinstance(value, str) and re.fullmatch(r"[0-9]+", unicodedata.normalize("NFKC", value.strip())):
        digits = unicodedata.normalize("NFKC", value.strip())
        if len(digits) > 5:
            raise WorkflowError("数量は1〜10000の整数にしてください。")
        number = int(digits)
    else:
        raise WorkflowError("数量は1〜10000の整数にしてください。")
    if not 1 <= number <= MAX_ITEMS:
        raise WorkflowError("数量は1〜10000の整数にしてください。")
    return number


def _normalize_rows(rows):
    if not isinstance(rows, list) or not rows or len(rows) > MAX_ITEMS:
        raise WorkflowError("貸出先・物品名・数量を1行以上入力してください。最大10000行です。")
    normalized, total = [], 0
    for number, row in enumerate(rows, 1):
        if not isinstance(row, dict):
            raise WorkflowError(f"{number}行目の形式が正しくありません。")
        try:
            borrower = _text(row.get("borrower_name"), "貸出先団体名", 120)
            name = _text(row.get("name"), "物品名", 160)
            quantity = _quantity(row.get("quantity"))
        except WorkflowError as error:
            raise WorkflowError(f"{number}行目：{error}") from None
        total += quantity
        if total > MAX_ITEMS:
            raise WorkflowError("数量の合計は10000個体までです。表を分けてください。")
        value = {"borrower_name": borrower, "name": name, "quantity": quantity}
        if "item_scope" in row:
            scope = row["item_scope"]
            if scope not in ("学内", "学外", "委員会", "区分未確認"):
                raise WorkflowError(f"{number}行目：物品区分は学内・学外・委員会・区分未確認のいずれかにしてください。")
            value["item_scope"] = scope
        if "item_owner" in row:
            value["item_owner"] = _text(row["item_owner"], "借用元", 120)
        normalized.append(value)
    return normalized


def prepare_set_rows(rows):
    """One sidewall card per borrower/owner; one tent frame card per tent.

    Composition is part of the persisted name, so existing servers, saved plans,
    issuance manifests and handwritten sheets retain it without a schema migration.
    Never combine different scopes, suppliers or pickup/return locations.
    """
    result, sets = [], {}
    for original in rows:
        row = dict(original)
        source = row.get("source", {})
        if source.get("card_template_applied"):
            result.append(row)
            continue
        name = unicodedata.normalize("NFKC", row["name"]).strip()
        wall = re.fullmatch(r"横幕\s*([23])\s*[Kk](?:\s*\(([^()]*)\))?", name)
        tent = re.fullmatch(r"テント\s*2\s*[Kk]\s*[×xX]\s*3\s*[Kk]", name)
        template = source.get("card_template")
        if template is None and wall:
            owner = wall.group(2) or row.get("item_owner") or row.get("item_scope", "区分未確認")
            template = {"mode":"団体別セット", "label":f"横幕セット（{owner}）", "detail":wall.group(1)+"K", "unit":"枚"}
        elif template is None and tent:
            owner = row.get("item_owner") or row.get("item_scope", "区分未確認")
            template = {"mode":"1張ごと", "label":f"テントの足 2K×3K（{owner}）", "detail":"1張分", "unit":"セット"}
        if not template or template["mode"] == "個別":
            result.append(row)
            continue
        if template["mode"] == "団体別セット":
            key = (row["borrower_name"], row.get("item_scope", "区分未確認"), row.get("item_owner", ""), template["label"],
                   source.get("sheet_name", ""), source.get("pickup_location", ""), source.get("return_location", ""))
            if key not in sets:
                bundle = {**row, "quantity": 1, "source": {**source, "master_item_code": "", "set_components": [], "card_template_applied":True}}
                sets[key] = bundle
                result.append(bundle)
            bundle = sets[key]
            bundle["source"]["set_components"].append({"name": row["name"], "size":template["detail"], "unit":template["unit"], "quantity": _quantity(row["quantity"]), "source": source})
            counts = {}
            for component in bundle["source"]["set_components"]:
                component_key = (component['size'],component['unit'])
                counts[component_key] = counts.get(component_key,0)+component['quantity']
            detail = "・".join(f"{size} {count}{unit}" for (size,unit),count in counts.items())
            bundle["name"] = f"{template['label']}｜{detail}"
        elif template["mode"] == "1張ごと":
            row["name"] = f"{template['label']}｜{template['detail']}・1{template['unit']}"
            row["source"] = {**source,"card_template_applied":True}
            result.append(row)
        else:
            raise WorkflowError("カード発行単位は個別・団体別セット・1張ごとから選んでください。")
    return result


def parse_plan_tsv(text):
    """Parse an Excel/Sheets three-column paste, with optional reordered headings."""
    if not isinstance(text, str) or len(text.encode("utf-8")) > MAX_DOCUMENT_BYTES:
        raise WorkflowError("貼り付ける表は16 MiB以下の文字列にしてください。")
    try:
        pasted = [row for row in csv.reader(io.StringIO(text.lstrip("\ufeff")), delimiter="\t", strict=True) if any(cell.strip() for cell in row)]
    except csv.Error:
        raise WorkflowError("表を読み取れません。貸出先・物品名・数量をタブ区切りで貼り付けてください。") from None
    if not pasted:
        raise WorkflowError("貸出先・物品名・数量の表を貼り付けてください。")
    columns = {"borrower_name": 0, "name": 1, "quantity": 2}
    heading = [unicodedata.normalize("NFKC", cell.strip()).replace(" ", "") for cell in pasted[0]]
    detected = {key: [i for i, value in enumerate(heading) if value in aliases] for key, aliases in HEADER_ALIASES.items()}
    optional = {
        "item_scope": [i for i, value in enumerate(heading) if value in {"物品区分", "区分", "学内/学外", "学内／学外", "item_scope"}],
        "item_owner": [i for i, value in enumerate(heading) if value in {"借用元", "貸出元", "item_owner"}],
    }
    if all(len(indexes) == 1 for indexes in detected.values()):
        columns = {key: indexes[0] for key, indexes in detected.items()}
        for key, indexes in optional.items():
            if len(indexes) > 1:
                raise WorkflowError("物品区分・借用元の見出しが重複しています。")
            if indexes:
                columns[key] = indexes[0]
        if len(columns) != len(heading):
            raise WorkflowError("団体名・物品名・数量と、任意の物品区分・借用元だけを貼り付けてください。")
        pasted = pasted[1:]
    result = []
    for number, cells in enumerate(pasted, 1):
        if len(cells) not in (3, 4, 5) or max(columns.values()) >= len(cells):
            raise WorkflowError(f"{number}行目は貸出先・物品名・数量の3列、任意で物品区分・借用元を加えた最大5列にしてください。")
        mapped = {key: cells[index] for key, index in columns.items()}
        if len(cells) >= 4 and "item_scope" not in mapped and len(columns) == 3:
            mapped["item_scope"] = cells[3].strip()
        if len(cells) == 5 and "item_owner" not in mapped:
            mapped["item_owner"] = cells[4].strip()
        if not mapped.get("item_owner"):
            mapped.pop("item_owner", None)
        result.append(mapped)
    return _normalize_rows(result)


def split_scope_row(row, counts):
    """Split one allocation by physical ownership without losing or creating quantities."""
    if not isinstance(counts, dict) or set(counts) != {"学内", "学外", "委員会"}:
        raise WorkflowError("学内・学外・委員会の数量を指定してください。")
    pieces = []
    for scope in ("学内", "学外", "委員会"):
        value = counts[scope]
        if isinstance(value, str):
            value = unicodedata.normalize("NFKC", value.strip())
            if not re.fullmatch(r"[0-9]{1,5}", value):
                raise WorkflowError("区分ごとの数量は0以上の整数にしてください。")
            value = int(value)
        if type(value) is not int or not 0 <= value <= MAX_ITEMS:
            raise WorkflowError("区分ごとの数量は0以上の整数にしてください。")
        if value:
            source = {**row.get("source", {}), "item_scope_source": {"reason": "取込確認画面で利用者が数量を指定", "split_quantities": counts}}
            pieces.append({**row, "quantity": value, "item_scope": scope, "source": source})
    if sum(piece["quantity"] for piece in pieces) != row["quantity"]:
        raise WorkflowError(f"区分ごとの数量の合計を、元の{row['quantity']}個に合わせてください。")
    return pieces


def expand_rows(rows, origin, start_number=1):
    origin = normalize_origin(origin)
    rows = _normalize_rows(rows)
    if type(start_number) is not int or not 1 <= start_number <= 999999:
        raise WorkflowError("開始番号は1〜999999の整数にしてください。")
    total = sum(row["quantity"] for row in rows)
    if start_number + total - 1 > 999999:
        raise WorkflowError("個体番号が999999を超えます。開始番号または数量を確認してください。")
    items, number = [], start_number
    for row in rows:
        for _ in range(row["quantity"]):
            code = f"IY-{number:06d}"
            url = f"{origin}/i/{code}"
            if len(url.encode("utf-8")) > 180:
                raise WorkflowError("個体URLがカードの上限180バイトを超えます。短い接続先を使ってください。")
            item = {"code": code, "name": row["name"], "url": url, "borrower_name": row["borrower_name"]}
            if "item_scope" in row:
                item["item_scope"] = row["item_scope"]
            if "item_owner" in row:
                item["item_owner"] = row["item_owner"]
            items.append(item)
            number += 1
    return items


def _label_module():
    from labels import generate_labels
    return generate_labels


def generate_bundle(items, output_pdf, reserved_through=0, ledger_generation=0):
    """Create a new paired PDF+JSON only; neither existing file may be replaced."""
    normalized = _label_module().normalize_items(items)
    output = Path(output_pdf).expanduser()
    if output.suffix != ".pdf":
        raise WorkflowError("保存先の拡張子は小文字の .pdf にしてください。")
    manifest = output.with_suffix(".issuance.json")
    if output.exists() or manifest.exists():
        raise WorkflowError("保存先が存在します。PDFと書込み用データを上書きせず、別の名前で保存してください。")
    numbers = [int(i["code"][3:]) for i in normalized if i["code"][3:].isdigit()]
    if type(reserved_through) is not int or not 0 <= reserved_through <= 999999:
        raise WorkflowError("予約済み番号が不正です。")
    reserved_through = max([reserved_through, *numbers])
    payload = _label_module().build_pdf(normalized)
    sidecar = json.dumps({"format": "rental-label-issuance-v1", "ledger_generation": ledger_generation, "label_mm": [91, 55], "page": "A4", "items": normalized, "reserved_through": reserved_through, "pdf_sha256": hashlib.sha256(payload).hexdigest()}, ensure_ascii=False, indent=2).encode("utf-8")
    output.parent.mkdir(parents=True, exist_ok=True)
    # Both open operations are exclusive. A partial failure never reports a valid pair.
    try:
        with output.open("xb") as pdf:
            with manifest.open("xb") as metadata:
                pdf.write(payload)
                pdf.flush()
                os.fsync(pdf.fileno())
                metadata.write(sidecar)
                metadata.flush()
                os.fsync(metadata.fileno())
    except OSError:
        raise WorkflowError("PDFと書込み用データを保存できませんでした。既存・途中のファイルを残したまま、別の名前で保存してください。") from None
    return manifest


def load_bundle(manifestpath):
    source = Path(manifestpath).expanduser()
    try:
        if not source.name.endswith(".issuance.json") or source.stat().st_size > MAX_DOCUMENT_BYTES:
            raise WorkflowError("印刷したPDFに対応する .issuance.json（16 MiB以下）を選んでください。")
        obj = json.loads(source.read_text(encoding="utf-8-sig"))
        if not isinstance(obj, dict) or obj.get("format") != "rental-label-issuance-v1" or obj.get("label_mm") != [91, 55] or obj.get("page") != "A4":
            raise WorkflowError("対応していない書込み用データです。A4・91×55mmの形式を使ってください。")
        digest = obj.get("pdf_sha256")
        if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise WorkflowError("PDFのSHA256が記録されていません。")
        pdf = source.with_name(source.name[:-len(".issuance.json")] + ".pdf")
        if not pdf.is_file() or hashlib.sha256(pdf.read_bytes()).hexdigest() != digest:
            raise WorkflowError("同じ名前のPDFが見つからないか、書込み用データと一致しません。")
        return _label_module().normalize_items(obj.get("items"))
    except WorkflowError:
        raise
    except (OSError, ValueError, TypeError):
        raise WorkflowError("書込み用データを読み取れません。ファイルと対応するPDFを確認してください。") from None


def generate_loan_sheet(manifestpath):
    """The handwritten loan sheet for these labels, as a new PDF next to the issuance data.

    The issuance data is locked to its label PDF, so an existing sheet of the same name holds the
    same items and is reused, never replaced.
    """
    source = Path(manifestpath).expanduser()
    items = load_bundle(source)
    from labels import loan_sheet
    output = source.with_name(source.name[:-len(".issuance.json")] + "_手書き貸出表.pdf")
    if output.is_file():
        return output
    payload = loan_sheet.build_sheet(items, source=source.name)
    try:
        with output.open("xb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
    except FileExistsError:
        return output
    except OSError:
        raise WorkflowError("手書き用貸出表を保存できませんでした。保存先のフォルダーを確認してください。") from None
    return output


def bundle_reserved_through(manifestpath):
    items = load_bundle(manifestpath)
    obj = json.loads(Path(manifestpath).read_text(encoding="utf-8-sig"))
    value = obj.get("reserved_through", 0)
    if type(value) is not int or not 0 <= value <= 999999:
        raise WorkflowError("書込み用データの予約済み番号が不正です。")
    return max([value, *[int(i["code"][3:]) for i in items if i["code"][3:].isdigit()]])


class _OriginRedirect(urllib.request.HTTPRedirectHandler):
    def __init__(self, origin):
        super().__init__()
        self.origin = origin

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        destination = urllib.parse.urlsplit(urllib.parse.urljoin(req.full_url, newurl))
        if f"{destination.scheme}://{destination.netloc}" != self.origin:
            raise WorkflowError("接続先が別のサイトに移動しました。認証情報を送らずに停止しました。")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class ApiClient:
    def __init__(self, origin=DEFAULT_ORIGIN, timeout=30, opener=None):
        self.origin = normalize_origin(origin)
        self.timeout = timeout
        self.cookies = http.cookiejar.CookieJar()
        self.opener = opener or urllib.request.build_opener(_OriginRedirect(self.origin), urllib.request.HTTPCookieProcessor(self.cookies))
        # Set by login: "account" (unified app) or "staff" (earlier rental server).
        self.mode = None
        self.capabilities = set()
        self.ledger_generation = 0
        self.prefix = "/api"
        # Origin written on labels and cards; the unified app reports it, the earlier server is its own.
        self.item_origin = self.origin
        self.user_name = ""

    def _request(self, path, body=None):
        headers = {"Accept": "application/json", "User-Agent": "IyakusaiRentalDesktop/2.0"}
        data = None
        if body is not None:
            data = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            # X-SMM-CSRF: the unified app requires it on every write (the earlier server ignores it).
            headers.update({"Content-Type": "application/json;charset=utf-8", "Origin": self.origin, "X-SMM-CSRF": "1", "X-Rental-Generation": str(self.ledger_generation)})
        request = urllib.request.Request(self.origin + path, data=data, headers=headers, method="POST" if body is not None else "GET")
        try:
            with self.opener.open(request, timeout=self.timeout) as response:
                raw = response.read(MAX_DOCUMENT_BYTES + 1)
                if len(raw) > MAX_DOCUMENT_BYTES:
                    raise WorkflowError("サーバー応答が大きすぎます。数量を分けてください。")
                result = json.loads(raw.decode("utf-8"))
                if not isinstance(result, dict):
                    raise WorkflowError("サーバー応答の形式を確認できませんでした。")
                return result
        except urllib.error.HTTPError as error:
            message = f"サーバーで処理できませんでした（HTTP {error.code}）。"
            try:
                payload = json.loads(error.read(65536).decode("utf-8"))
                # The unified app answers {error: code, message}; the earlier server {error: message, code}.
                if isinstance(payload, dict) and isinstance(payload.get("message"), str):
                    message = payload["message"][:500]
                elif isinstance(payload, dict) and isinstance(payload.get("error"), str):
                    message = payload["error"][:500]
            except (ValueError, UnicodeError):
                pass
            raise WorkflowError(message) from None
        except WorkflowError:
            raise
        except (urllib.error.URLError, TimeoutError, OSError):
            raise WorkflowError("接続できません。HTTPS URLと通信を確認してください。登録結果が不明な場合は同じ一覧を再送してください。") from None
        except (ValueError, UnicodeError):
            raise WorkflowError("サーバー応答を読み取れませんでした。接続先を確認してください。") from None

    def detect(self):
        """"account" when the server is the unified app (it answers /api/session with authMode
        "discord"), otherwise "staff". Sends no credentials."""
        try:
            session = self._request("/api/session")
        except WorkflowError:
            return "staff"
        return "account" if session.get("authMode") == "discord" else "staff"

    def login(self, code):
        if not isinstance(code, str) or not code.strip() or len(code) > 128 or any(ord(c) < 32 for c in code):
            raise WorkflowError("スタッフコードを入力してください。")
        result = self._request("/api/login", {"staff_code": code.strip()})
        self.mode, self.prefix, self.item_origin = "staff", "/api", self.origin
        self.capabilities = set()
        staff = result.get("staff") if isinstance(result.get("staff"), dict) else {}
        self.user_name = staff.get("name", "") if isinstance(staff.get("name"), str) else ""
        return result

    def login_account(self, login_id, password):
        """Unified app: the student ID (or iy- ID) and password of the committee account.
        Issuing needs the rental.issue permission, given by an access administrator."""
        if not isinstance(login_id, str) or not login_id.strip() or len(login_id) > 64 or any(ord(c) < 32 for c in login_id):
            raise WorkflowError("学籍番号を入力してください。")
        if not isinstance(password, str) or not password or len(password) > 1024:
            raise WorkflowError("パスワードを入力してください。")
        self._request("/api/auth/login", {"loginId": login_id.strip(), "password": password})
        me = self._request("/api/rental/me")
        permissions = me.get("permissions") if isinstance(me.get("permissions"), list) else []
        if "rental.issue" not in permissions:
            raise WorkflowError("この医薬祭アカウントには物品の発行権限（rental.issue）がありません。権限管理者に付与を依頼してください。")
        item_origin = me.get("item_origin")
        self.mode, self.prefix = "account", "/api/rental"
        self.capabilities = {c for c in me.get("capabilities", []) if isinstance(c, str)}
        self.ledger_generation = me.get("ledger_generation", 0)
        self.item_origin = normalize_origin(item_origin) if isinstance(item_origin, str) and item_origin else self.origin
        staff = me.get("staff") if isinstance(me.get("staff"), dict) else {}
        self.user_name = staff.get("name", "") if isinstance(staff.get("name"), str) else ""
        return me

    def borrowers(self):
        result = self._request(f"{self.prefix}/borrowers")
        groups = result.get("groups")
        if not isinstance(groups, list) or any(not isinstance(group, dict) or not isinstance(group.get("id"), str) or not isinstance(group.get("name"), str) for group in groups):
            raise WorkflowError("団体ID付きの貸出先一覧を取得できませんでした。サーバーを更新してください。")
        return [{"id": group["id"], "name": group["name"]} for group in groups]

    def server_state(self):
        """Read published codes and exact URLs. Older servers support reading without writes."""
        if self.mode == 'account':
            me = self._request(f'{self.prefix}/me')
            self.capabilities = {c for c in me.get('capabilities', []) if isinstance(c, str)}
            self.ledger_generation = me.get('ledger_generation', 0)
        if 'issuer_management_v1' in self.capabilities:
            result = self._request(f'{self.prefix}/issuer/state')
        else:
            overview = self._request(f'{self.prefix}/overview')
            listed = overview.get('items')
            if not isinstance(listed, list) or len(listed) > MAX_ITEMS:
                raise WorkflowError('サーバーの物品一覧を読み取れませんでした。')
            codes = [x.get('code') for x in listed if isinstance(x, dict)]
            if len(codes) != len(listed) or len(set(codes)) != len(codes) or any(not isinstance(c, str) or not re.fullmatch(r'IY-[A-Z0-9][A-Z0-9-]{2,39}', c) for c in codes):
                raise WorkflowError('サーバーの個体コードを確認できませんでした。')
            def read(code):
                value = self._request(f'{self.prefix}/items/{urllib.parse.quote(code, safe="")}')
                if value.get('code') != code:
                    raise WorkflowError('サーバーから別のNo.が返されました。')
                return {**value, 'borrower_id': value.get('planned_borrower_id'), 'borrower_name': value.get('planned_borrower_name')}
            with ThreadPoolExecutor(max_workers=4) as pool:
                items = list(pool.map(read, codes))
            result = {'items': items, 'revision': None, 'archived_count': 0, 'reset_allowed': False,
                      'reserved_through': max([100000] + [int(c[3:]) for c in codes if re.fullmatch(r'IY-\d{6}', c)])}
        items = result.get('items')
        if not isinstance(items, list) or len(items) > MAX_ITEMS:
            raise WorkflowError('サーバーの台帳形式を確認できませんでした。')
        if items:
            catalog_label_items({'items': [i for i in items if i.get('url')]})
        return result

    def preview_changes(self, mode, items=None):
        if 'issuer_management_v1' not in self.capabilities:
            raise WorkflowError('このサーバーは上書き・リセット機能にまだ対応していません。サーバー側の更新が必要です。読み出しとラベルの再発行は使えます。')
        if mode == 'force_reset_all' and 'issuer_numbering_reset_v1' not in self.capabilities:
            raise WorkflowError('このサーバーは連番・重複防止の初期化に未対応です。更新後にログインし直してください。')
        if mode == 'force_reset' and 'issuer_force_reset_v1' not in self.capabilities:
            raise WorkflowError('このサーバーは強制リセットに未対応です。サーバー側を更新してからログインし直してください。')
        short_code = mode in ('force_reset', 'force_reset_all') and 'issuer_reset_code_v1' in self.capabilities
        result = self._request(f'{self.prefix}/issuer/preview', {'mode': mode,
            **({'confirmation_style': 'digits3'} if short_code else {}),
            **({'items': items} if mode not in ('reset', 'force_reset', 'force_reset_all') else {})})
        if short_code:
            code = result.get('confirmation_code')
            if not isinstance(code, str) or len(code) != 3 or not code.isascii() or not code.isdigit():
                raise WorkflowError('3桁の確認番号を取得できませんでした。ログインし直して確認画面を開いてください。')
        return result

    def apply_changes(self, token, confirmation, all_writers_stopped=False):
        if 'issuer_management_v1' not in self.capabilities:
            raise WorkflowError('サーバー側の更新が必要です。')
        result = self._request(f'{self.prefix}/issuer/apply', {'token': token, 'confirmation': confirmation, **({'all_writers_stopped': True} if all_writers_stopped else {})})
        self.ledger_generation = result.get('ledger_generation', self.ledger_generation)
        return result

    def create_irregular_bundle(self, count, output_pdf, pending_path):
        """Keep the request ID on disk before sending, so an uncertain response never duplicates cards."""
        if 'irregular_cards_v1' not in self.capabilities:
            raise WorkflowError('接続先がイレギュラーカードに未対応です。サーバーの更新後に使ってください。')
        if type(count) is not int or not 1 <= count <= 100:
            raise WorkflowError('カード枚数は1〜100枚にしてください。')
        target = Path(output_pdf)
        if target.exists() or target.with_suffix('.issuance.json').exists():
            raise WorkflowError('既存のPDF・発行データは残し、別の保存名にしてください。')
        pending = Path(pending_path)
        if pending.exists():
            saved = json.loads(pending.read_text(encoding='utf-8'))
            if saved.get('origin') != self.origin or saved.get('count') != count:
                raise WorkflowError(f"前回の発行（{saved.get('count')}枚）が未完了です。同じ接続先・枚数で再開してください。")
        else:
            saved = {'origin': self.origin, 'count': count, 'request_id': str(uuid.uuid4())}
            pending.parent.mkdir(parents=True, exist_ok=True)
            with pending.open('x', encoding='utf-8') as stream:
                json.dump(saved, stream, ensure_ascii=False)
                stream.flush()
                os.fsync(stream.fileno())
        snapshot = self.server_state()
        reply = self._request(f'{self.prefix}/issuer/irregular-cards', {'count': count, 'request_id': saved['request_id'], 'expected_revision': snapshot['revision']})
        items = _label_module().normalize_items(reply.get('items'))
        if len(items) != count or any(i.get('card_kind') != 'irregular' or i['url'] != f"{self.item_origin}/i/{i['code']}" for i in items):
            raise WorkflowError('サーバーのイレギュラーカード情報を確認できませんでした。同じ枚数で再開してください。')
        manifest = generate_bundle(items, target, snapshot.get('reserved_through', 0), reply['ledger_generation'])
        pending.unlink()
        return str(manifest), items

    def register(self, items):
        normalized = _label_module().normalize_items(items)
        for item in normalized:
            _text(item.get("borrower_name"), "貸出先団体名", 120)
            valid_urls = {f"{self.item_origin}/i/{item['code']}"}
            if "item_metadata_v1" in self.capabilities:
                valid_urls.add(f"{LEGACY_ORIGIN}/i/{item['code']}")
            if item["url"] not in valid_urls:
                raise WorkflowError(f"個体URLと接続先が一致しません：{item['code']}")
        groups, resolved = {}, []
        for item in normalized:
            name = item["borrower_name"]
            if name not in groups:
                reply = self._request(f"{self.prefix}/borrowers", {"name": name})
                group = reply.get("borrower")
                if not isinstance(group, dict) or not isinstance(group.get("id"), str) or group.get("name") != name:
                    raise WorkflowError("登録した団体のIDと名前を確認できませんでした。")
                groups[name] = group
            group = groups[name]
            if item.get("borrower_id") and item["borrower_id"] != group["id"]:
                raise WorkflowError(f"予定団体のIDと名前が一致しません：{item['code']}")
            resolved.append({**item, "borrower_id": group["id"]})
        # Old servers keep the old contract; upgraded servers explicitly advertise metadata support.
        metadata_keys = {"item_scope", "item_owner"}
        server_items = resolved if "item_metadata_v1" in self.capabilities else [{key: value for key, value in item.items() if key not in metadata_keys} for item in resolved]
        reply = self._request(f"{self.prefix}/preassignments", {"items": server_items})
        returned = reply.get("items")
        if not isinstance(returned, list) or len(returned) != len(resolved):
            raise WorkflowError("登録結果の個体数を確認できませんでした。同じ一覧で再確認してください。")
        clean = _label_module().normalize_items(returned)
        compared = [{key: value for key, value in item.items() if key in expected} for item, expected in zip(clean, server_items)]
        if compared != server_items:
            raise WorkflowError("登録結果の個体コード・URL・予定団体が一致しません。同じ一覧で再確認してください。")
        return {**reply, "items": [{**local, **remote} for local, remote in zip(resolved, clean)]}


def catalog_label_items(snapshot):
    """Remove status fields while preserving the server's exact code, URL and optional planned group."""
    items = snapshot.get('items')
    if not isinstance(items, list):
        raise WorkflowError('サーバーの物品一覧がありません。')
    if not items:
        return []
    clean = [{key: item[key] for key in ('code', 'name', 'url', 'borrower_id', 'borrower_name', 'item_scope', 'item_owner', 'card_kind') if item.get(key) is not None} for item in items]
    try:
        return _label_module().normalize_items(clean)
    except (ValueError, TypeError) as error:
        raise WorkflowError(f'サーバーの発行データを確認できませんでした：{error}') from None
