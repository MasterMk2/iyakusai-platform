"""Deferred aiohttp HTTPS server composition; no import, socket, or login at import time.

The caller supplies an already validated server SSLContext and the existing Bot's
adapter. This module never reads certificates, starts an SDK client, installs a
dependency, changes signal handlers, or chooses trusted peers.
"""

from __future__ import annotations

import asyncio
import importlib
import logging
from collections.abc import Mapping
from typing import Any


SUPPORTED_AIOHTTP_VERSION = "3.14.3"


class ServerLifecycleError(RuntimeError):
    """A payload-free lifecycle failure; underlying exceptions are not retained."""


def _setting(settings: Any, name: str) -> Any:
    return settings[name] if isinstance(settings, Mapping) else getattr(settings, name)


def _silent_logger() -> logging.Logger:
    # A private object, not getLogger(): do not mutate Bot/global logging.
    logger = logging.Logger("iyakusai.dm.runtime", logging.CRITICAL + 1)
    logger.disabled = True
    logger.propagate = False
    return logger


class AiohttpServer:
    """One lifecycle only. A fresh start requires a new server/adapter instance.

    ``web_module`` is an anonymous test seam. Production leaves it unset and the
    installed aiohttp version is checked immediately before deferred import/use.
    ``adapter.begin_shutdown()`` is synchronous; ``adapter.drain()`` is awaited.
    A failed drain deliberately retains the runner so unsafe SDK work is not
    cancelled by runner cleanup. Its owner must retain the ledger on stop failure.
    """

    def __init__(self, adapter: Any, settings: Any, tls_context: Any, *, web_module: Any = None):
        if tls_context is None:
            raise ValueError("server_tls_required")
        if not callable(getattr(adapter, "handle", None)):
            raise ValueError("adapter_handle_required")
        if not callable(getattr(adapter, "begin_shutdown", None)):
            raise ValueError("adapter_shutdown_required")
        if not callable(getattr(adapter, "drain", None)):
            raise ValueError("adapter_drain_required")
        self._adapter = adapter
        self._settings = settings
        self._tls_context = tls_context
        self._web = web_module
        self._runner = None
        self._site = None
        self._running = False
        self._closed = False
        self._lock = asyncio.Lock()

    @property
    def is_running(self) -> bool:
        return self._running

    @property
    def cleanup_pending(self) -> bool:
        return self._runner is not None or self._site is not None

    def _load_web(self) -> Any:
        if self._web is not None:
            return self._web
        failed = False
        module = None
        try:
            installed = importlib.import_module("aiohttp")
            if getattr(installed, "__version__", None) != SUPPORTED_AIOHTTP_VERSION:
                failed = True
            else:
                module = importlib.import_module("aiohttp.web")
        except Exception:
            failed = True
        if failed or module is None:
            raise ServerLifecycleError("aiohttp_metadata_mismatch") from None
        self._web = module
        return module

    async def _handle(self, request: Any) -> Any:
        # Forward the original Request unchanged: raw duplicate headers, original
        # body bytes and actual transport belong to the adapter's strict checks.
        failed = False
        reply = None
        try:
            reply = await self._adapter.handle(request)
            if (type(reply.status) is not int or not 100 <= reply.status <= 599
                    or not isinstance(reply.body, dict)):
                failed = True
        except Exception:
            failed = True
        status = 503 if failed else reply.status
        body = {"error": "unavailable"} if failed else reply.body
        response_failed = False
        response = None
        try:
            response = self._web.json_response(
                body, status=status, headers={"cache-control": "no-store"}
            )
            response.force_close()
        except Exception:
            response_failed = True
        if response_failed:
            response = self._web.json_response(
                {"error": "unavailable"}, status=503,
                headers={"cache-control": "no-store"},
            )
            response.force_close()
        return response

    async def start(self) -> None:
        async with self._lock:
            if self._running:
                return
            if self._closed or self.cleanup_pending:
                raise ServerLifecycleError("server_closed")
            failed = False
            cancelled = False
            try:
                web = self._load_web()
                logger = _silent_logger()
                app = web.Application(client_max_size=4096, logger=logger)
                app.router.add_route("*", "/{tail:.*}", self._handle)
                self._runner = web.AppRunner(
                    app,
                    handle_signals=False,
                    access_log=None,
                    logger=logger,
                    handler_cancellation=False,
                    auto_decompress=False,
                    max_line_size=8190,
                    max_headers=48,
                    max_field_size=1024,
                    read_bufsize=4096,
                    keepalive_timeout=2,
                    lingering_time=0,
                    shutdown_timeout=_setting(self._settings, "shutdown_timeout"),
                )
                await self._runner.setup()
                self._site = web.TCPSite(
                    self._runner,
                    _setting(self._settings, "host"),
                    _setting(self._settings, "port"),
                    ssl_context=self._tls_context,
                    backlog=_setting(self._settings, "backlog"),
                    reuse_address=False,
                    reuse_port=False,
                )
                await self._site.start()
            except asyncio.CancelledError:
                cancelled = True
            except Exception:
                failed = True
            if failed or cancelled:
                self._closed = True
                # Even a partially started site must stop accepting requests and
                # drain before runner cleanup. Keep resources if cleanup fails.
                try:
                    await self._stop_resources()
                except (Exception, asyncio.CancelledError):
                    pass
                if cancelled:
                    raise asyncio.CancelledError() from None
                raise ServerLifecycleError("server_start_failed") from None
            self._running = True

    async def _stop_resources(self) -> None:
        if not self.cleanup_pending:
            return
        if self._site is not None:
            self._adapter.begin_shutdown()
            await self._site.stop()
            self._site = None
        # Also retry drain after a previous stop succeeded but drain failed.
        await self._adapter.drain()
        if self._runner is not None:
            await self._runner.cleanup()
            self._runner = None

    async def stop(self) -> None:
        async with self._lock:
            self._closed = True
            self._running = False
            failed = False
            cancelled = False
            try:
                await self._stop_resources()
            except asyncio.CancelledError:
                cancelled = True
            except Exception:
                failed = True
            if cancelled:
                raise asyncio.CancelledError() from None
            if failed:
                raise ServerLifecycleError("server_stop_failed") from None
