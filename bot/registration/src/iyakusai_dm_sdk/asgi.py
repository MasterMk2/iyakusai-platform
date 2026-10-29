"""Unbound ASGI application; the owner supplies a verified TLS/loopback server."""
import asyncio
import json

from .controller import MAX_BODY_BYTES, PATH, Reply


class DMASGIApplication:
    def __init__(self, controller, *, receive_timeout=5):
        if not isinstance(receive_timeout, (int, float)) or not 0 < receive_timeout <= 30:
            raise ValueError("invalid request deadline")
        self.controller, self.receive_timeout = controller, receive_timeout

    async def _reply(self, send, reply):
        data = json.dumps(reply.body, separators=(",", ":")).encode("utf-8")
        await send({"type": "http.response.start", "status": reply.status,
                    "headers": [(b"content-type", b"application/json"),
                                (b"cache-control", b"no-store"),
                                (b"content-length", str(len(data)).encode("ascii"))]})
        await send({"type": "http.response.body", "body": data})

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http":
            raise ValueError("HTTP only; no lifecycle or server activation")
        try:
            raw_path = scope["raw_path"].decode("ascii")
            query = scope.get("query_string", b"").decode("ascii")
            path = raw_path + ("?" + query if query else "")
            raw_headers = scope["headers"]
            if type(raw_headers) not in {list, tuple} or len(raw_headers) > 48:
                raise ValueError("invalid headers")
            headers = []
            size = 0
            for name, value in raw_headers:
                size += len(name) + len(value)
                if len(name) > 64 or len(value) > 1024 or size > 16_384:
                    raise ValueError("invalid headers")
                headers.append((name.decode("ascii"), value.decode("ascii")))
        except (KeyError, UnicodeError, TypeError, AttributeError, ValueError):
            await self._reply(send, Reply(400, {"error": "invalid_request"}))
            return
        if scope.get("method") != "POST" or path != PATH:
            reply = (Reply(405, {"error": "method_not_allowed"})
                     if scope.get("method") != "POST" else Reply(404, {"error": "not_found"}))
            await self._reply(send, reply)
            return
        body = bytearray()
        deadline = asyncio.get_running_loop().time() + self.receive_timeout
        for _ in range(64):
            try:
                remaining = deadline - asyncio.get_running_loop().time()
                if remaining <= 0:
                    raise asyncio.TimeoutError()
                message = await asyncio.wait_for(receive(), timeout=remaining)
            except asyncio.TimeoutError:
                await self._reply(send, Reply(408, {"error": "request_timeout"}))
                return
            if type(message) is not dict:
                await self._reply(send, Reply(400, {"error": "invalid_request"}))
                return
            if message.get("type") == "http.disconnect":
                return
            chunk = message.get("body", b"")
            if message.get("type") != "http.request" or type(chunk) is not bytes:
                await self._reply(send, Reply(400, {"error": "invalid_request"}))
                return
            if len(body) + len(chunk) > MAX_BODY_BYTES:
                await self._reply(send, Reply(413, {"error": "body_too_large"}))
                return
            body.extend(chunk)
            if not message.get("more_body", False):
                reply = await self.controller.handle(method=scope.get("method"), path=path,
                                                     headers=headers, body=bytes(body),
                                                     connection=scope)
                await self._reply(send, reply)
                return
        await self._reply(send, Reply(400, {"error": "invalid_request"}))
