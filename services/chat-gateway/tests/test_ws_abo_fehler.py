"""Fehlerrahmen eines gescheiterten ``subscribe`` nennen Op und Kanal.

Der Klient haelt einen Kanal in seinen ``subs``, sobald er das ``subscribe``
geschickt hat — ob der Server es angenommen hat, erfaehrt er nur aus einem
Fehlerrahmen. Ohne Bezug darin konnte er einen Fehlschlag keinem Kanal
zuordnen, verwarf ihn, und der Kanal blieb am Server unabonniert: keine
Live-Nachricht mehr, bis zum naechsten Neuaufbau (Push-Bughunt, Befund 3).
Die Wiederholung selbst steht im Klienten (``web/src/lib/ws/aboWiederholung.ts``).
"""

from __future__ import annotations

import asyncio
import random

import pytest
from starlette.testclient import TestClient

from dcc_chat_gateway.routes import ws_ops_handlers

from .conftest import receive_skipping


@pytest.mark.asyncio
async def test_unerreichbarer_kanal_nennt_op_und_kanal(ws_app, _auth_signer):
    def _run():
        uid = random.randint(1, 1_000_000)
        token = _auth_signer.issue_access(uid, f"u{uid}")
        kanal = str(random.randint(10**15, 10**16))
        with TestClient(ws_app) as tc, tc.websocket_connect(f"/ws?token={token}") as ws:
            receive_skipping(ws)  # ready
            ws.send_json({"op": "subscribe", "channel_id": kanal})
            fehler = receive_skipping(ws)
            assert fehler["op"] == "error" and fehler["code"] == 4004
            assert fehler["ref_op"] == "subscribe"
            assert fehler["channel_id"] == kanal

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_interner_fehler_beim_abo_nennt_op_und_kanal(
    ws_app, _auth_signer, monkeypatch
):
    """Ein Ausnahmefehler im Handler kommt als 5000 an — mit Bezug, damit der
    Klient genau diesen Kanal neu abonnieren kann."""

    async def _kaputt(*_a, **_k):
        raise RuntimeError("db weg")

    monkeypatch.setattr(ws_ops_handlers, "resolve_channel_for_user", _kaputt)

    def _run():
        uid = random.randint(1, 1_000_000)
        token = _auth_signer.issue_access(uid, f"u{uid}")
        kanal = str(random.randint(10**15, 10**16))
        with TestClient(ws_app) as tc, tc.websocket_connect(f"/ws?token={token}") as ws:
            receive_skipping(ws)  # ready
            ws.send_json({"op": "subscribe", "channel_id": kanal})
            fehler = receive_skipping(ws)
            assert fehler["op"] == "error" and fehler["code"] == 5000
            assert fehler["ref_op"] == "subscribe"
            assert fehler["channel_id"] == kanal

    await asyncio.to_thread(_run)
