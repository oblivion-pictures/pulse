"""WebSocket round-trip tests for direct-message channels.

Mirrors test_ws.py for guild channels: subscribe + ready payload, but
exercising the DM-side of the polymorphic /ws endpoint.

Senden gehört seit 2026-11-05 nicht mehr dazu: Klartext in DMs lehnt der
Server ab (4016, ``DM_KLARTEXT_DETAIL``), verschlüsselt geht es über das
Postfach. Geprüft wird hier deshalb nur noch die Ablehnung samt fehlender
Nebenwirkungen.
"""

from __future__ import annotations

import asyncio
import random

import pytest
from starlette.testclient import TestClient

import dcc_chat_gateway.config as chat_cfg

from .conftest import install_friendship_sync, ping_barrier, receive_skipping

# DM routes and ready-frame DM payload are cloud-only.
pytestmark = pytest.mark.usefixtures("cloud_mode")


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _bootstrap_dm_sync(tc: TestClient, signer) -> tuple[str, int, str, int, str]:
    """Create two users + a DM channel between them; return tokens + ids.

    Etappe-2: pre-installs a Friendship row (raw SQL into the ws_app's
    tmp-file SQLite) so the friend-gated /dm-channels endpoint lets the
    create through. Tests that exercise the friend-gate explicitly skip
    this helper and call install_friendship_sync directly."""
    uid_a = random.randint(1, 1_000_000)
    uid_b = random.randint(1, 1_000_000)
    t_a = signer.issue_access(uid_a, f"a{uid_a}")
    t_b = signer.issue_access(uid_b, f"b{uid_b}")
    install_friendship_sync(chat_cfg.get_settings().database_url, uid_a, uid_b)
    r = tc.post(
        "/dm-channels", json={"target_user_id": uid_b}, headers=_auth(t_a)
    )
    assert r.status_code == 201, r.text
    return t_a, uid_a, t_b, uid_b, r.json()["id"]


@pytest.mark.asyncio
async def test_ws_ready_includes_dm_channels(ws_app, _auth_signer):
    """The ready payload must seed clients with their DM channel list."""

    def _run():
        with TestClient(ws_app) as tc:
            t_a, _, _, uid_b, dm_id = _bootstrap_dm_sync(tc, _auth_signer)
            with tc.websocket_connect(f"/ws?token={t_a}") as ws:
                ws.receive_json()  # hello
                payload = ws.receive_json()
                assert payload["op"] == "ready"
                dm_list = payload.get("dm_channels")
                assert isinstance(dm_list, list)
                ids = {d["id"] for d in dm_list}
                assert dm_id in ids
                entry = next(d for d in dm_list if d["id"] == dm_id)
                assert entry["other_user_id"] == str(uid_b)
                assert entry["last_message_id"] is None

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_ws_subscribe_dm_as_member(ws_app, _auth_signer):
    def _run():
        with TestClient(ws_app) as tc:
            t_a, _, _, _, dm_id = _bootstrap_dm_sync(tc, _auth_signer)
            with tc.websocket_connect(f"/ws?token={t_a}") as ws:
                receive_skipping(ws)  # skip hello + ready
                ws.send_json({"op": "subscribe", "channel_id": dm_id})
                # No error frame should arrive — but pulling one would block,
                # so instead send a follow-up echo (a no-op subscribe to a
                # bogus id will error and round-trip).
                ws.send_json({"op": "subscribe", "channel_id": "not-a-number"})
                resp = ws.receive_json()
                # The error we expect is for the *second* (bogus) op only.
                assert resp["op"] == "error"
                assert resp["code"] == 4003

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_ws_subscribe_dm_as_non_member_rejected(ws_app, _auth_signer):
    """A user who is NOT one of the DM's two members must not be allowed
    to subscribe — snowflake DM IDs are enumerable so this is the only
    barrier."""

    def _run():
        with TestClient(ws_app) as tc:
            _, _, _, _, dm_id = _bootstrap_dm_sync(tc, _auth_signer)
            uid_c = random.randint(1, 1_000_000)
            t_c = _auth_signer.issue_access(uid_c, f"c{uid_c}")
            with tc.websocket_connect(f"/ws?token={t_c}") as ws:
                receive_skipping(ws)  # skip hello + ready
                ws.send_json({"op": "subscribe", "channel_id": dm_id})
                resp = ws.receive_json()
                assert resp["op"] == "error"
                assert resp["code"] == 4004

    await asyncio.to_thread(_run)


@pytest.mark.asyncio
async def test_ws_dm_klartext_wird_abgelehnt(ws_app, _auth_signer, monkeypatch):
    """Ein WS-``send`` in eine DM endet seit 2026-11-05 mit 4016
    (``DM_KLARTEXT_DETAIL``) — auf dem langsamen Pfad (nicht abonniert, die
    Mitgliedschaft wird erst aufgelöst) wie auf dem schnellen (abonniert).

    Früher folgten darauf Fan-out an beide Teilnehmer, ein ``dm_bump``, ein
    DM-Push und der ``last_message_id``-Schub. Nichts davon darf mehr
    passieren: das Gegenüber bekommt kein Frame, keine Zeile landet in der
    Datenbank, der nächste ``ready`` zeigt keine letzte Nachricht.
    """
    import dcc_chat_gateway.routes.ws_op_send as ws_op_send
    from dcc_chat_gateway import push
    from dcc_chat_gateway.models import DM_KLARTEXT_DETAIL
    from sqlalchemy import create_engine, text

    pushes: list[dict] = []

    async def _fake_push(*args, **kwargs):
        pushes.append({"args": args, **kwargs})

    # Jeder Web-Push läuft über ``_fan_out_payload``; der Erwähnungs-Push
    # zusätzlich über seinen eigenen Namen im Sendeweg.
    monkeypatch.setattr(push, "_fan_out_payload", _fake_push)
    monkeypatch.setattr(ws_op_send, "fan_out_mention_push", _fake_push)
    erwartet = {"op": "error", "code": 4016, "msg": DM_KLARTEXT_DETAIL}

    def _run():
        with TestClient(ws_app) as tc:
            t_a, _, t_b, _, dm_id = _bootstrap_dm_sync(tc, _auth_signer)
            with (
                tc.websocket_connect(f"/ws?token={t_a}") as ws_a,
                tc.websocket_connect(f"/ws?token={t_b}") as ws_b,
            ):
                receive_skipping(ws_a)  # ready
                receive_skipping(ws_b)  # ready
                ws_b.send_json({"op": "subscribe", "channel_id": dm_id})
                ping_barrier(ws_b)

                # Langsamer Pfad: A hat die DM nicht abonniert.
                ws_a.send_json(
                    {"op": "send", "channel_id": dm_id, "content": "langsam", "nonce": "k1"}
                )
                assert receive_skipping(ws_a) == erwartet

                # Schneller Pfad: nach dem Abonnieren.
                ws_a.send_json({"op": "subscribe", "channel_id": dm_id})
                ws_a.send_json(
                    {"op": "send", "channel_id": dm_id, "content": "schnell", "nonce": "k2"}
                )
                assert receive_skipping(ws_a) == erwartet

                # Kein message/dm_bump auf beiden Seiten: das nächste Frame
                # ist jeweils das pong der Barriere.
                ping_barrier(ws_a)
                ping_barrier(ws_b)

            eng = create_engine(chat_cfg.get_settings().database_url.replace("+aiosqlite", ""))
            try:
                with eng.connect() as conn:
                    zeilen = conn.execute(
                        text("SELECT count(*) FROM messages WHERE channel_id = :c"),
                        {"c": int(dm_id)},
                    ).scalar()
            finally:
                eng.dispose()
            assert zeilen == 0

            with tc.websocket_connect(f"/ws?token={t_a}") as ws2:
                ws2.receive_json()  # hello
                payload = ws2.receive_json()  # ready
                entry = next(d for d in payload["dm_channels"] if d["id"] == dm_id)
                assert entry["last_message_id"] is None

        assert pushes == []

    await asyncio.to_thread(_run)
