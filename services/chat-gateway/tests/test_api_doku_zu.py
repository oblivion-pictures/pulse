"""Security-Scan 2026-11-04: Routenkatalog des chat-gateway nicht öffentlich.

``/api/ws/`` schrieb in nginx JEDEN Unterpfad aufs chat-gateway um — die
Sperren für ``/internal/`` und die API-Doku griffen dort nicht, und
``/api/ws/openapi.json`` lieferte den vollständigen Routenkatalog samt
internen Routen. Zwei Schichten: das chat-gateway schaltet die Doku ab wie
der auth-Service (``PULSE_DOCS=1`` für Entwicklung), und nginx lässt unter
``/api/ws/`` nur noch den WebSocket-Pfad durch.
"""

from __future__ import annotations

import re
from pathlib import Path

import httpx
import pytest

NGINX = Path(__file__).resolve().parents[3] / "infra" / "prod" / "web-nginx.conf"


@pytest.mark.asyncio
async def test_openapi_und_docs_sind_aus(monkeypatch):
    monkeypatch.delenv("PULSE_DOCS", raising=False)
    from dcc_chat_gateway.app import create_app

    app = create_app(skip_redis=True)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
        for pfad in ("/openapi.json", "/docs", "/redoc"):
            assert (await c.get(pfad)).status_code == 404, pfad


def test_nginx_leitet_unter_api_ws_nur_den_websocket_weiter():
    text = NGINX.read_text()
    assert not re.search(r"location\s+/api/ws/\s*\{", text)
    assert re.search(r"location\s*=\s*/api/ws/ws\s*\{", text)
