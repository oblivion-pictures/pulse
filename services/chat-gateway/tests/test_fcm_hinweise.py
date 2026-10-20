"""@-Erwähnungen und Freundschaftsanfragen als Push ans Handy
(``fcm_hinweise.py``, Push-Bughunt 2026-10-20).

Bis dahin erreichten beide nur den Browser (Web-Push). Jetzt geht je Handy
des Empfängers eine Mitteilung hinaus — nur in der Cloud, nicht bei „Nicht
stören“. Die Tests fahren die echten Routen und schreiben mit, was an
Firebase ginge.
"""

from __future__ import annotations

import json
import random

import pytest
from dcc_chat_gateway import fcm, fcm_hinweise, fcm_nachricht
from dcc_chat_gateway.fcm_empfaenger import android_faehigkeiten_merken
from dcc_chat_gateway.models import FcmToken
from dcc_chat_gateway.presence_keys import PRESENCE_STATUS_KEY

from .conftest import make_auth_header


@pytest.fixture
def handys(monkeypatch):
    """Firebase gilt als eingerichtet; statt zu senden eine Mitschrift der
    Aufrufe von ``fcm_hinweise._send_one``."""
    gesendet: list[dict] = []

    def _fake(**kwargs):
        gesendet.append(kwargs)
        return "ok"

    monkeypatch.setattr(fcm, "ensure_fcm", lambda: object())
    monkeypatch.setattr(fcm_hinweise, "_send_one", _fake)
    return gesendet


def _konto(_auth_signer) -> tuple[dict, int]:
    uid = random.randint(1, 1_000_000_000)
    return make_auth_header(_auth_signer.issue_access(uid, f"u{uid}")), uid


async def _handy(session_factory, uid: int, gid: str = "handy") -> str:
    token = f"tok-{uid}-{gid}"
    async with session_factory() as s:
        s.add(FcmToken(user_id=uid, geraet_id=gid, token=token))
        await s.commit()
    return token


async def _community(client, heads_owner, uid_member) -> tuple[str, str]:
    g = (await client.post("/guilds", json={"name": "Runde"}, headers=heads_owner)).json()
    await client.post(
        f"/guilds/{g['id']}/members", json={"user_id": str(uid_member)}, headers=heads_owner
    )
    c = (
        await client.post(
            f"/guilds/{g['id']}/channels", json={"name": "allgemein"}, headers=heads_owner
        )
    ).json()
    return g["id"], c["id"]


async def _erwaehnen(client, heads, cid: str, uid: int) -> str:
    r = await client.post(
        f"/channels/{cid}/messages", json={"content": f"schau mal <@{uid}> hier"}, headers=heads
    )
    assert r.status_code == 201, r.text
    await fcm_hinweise.hintergrund_abwarten()
    return r.json()["id"]


# MARK: - Erwähnung


@pytest.mark.asyncio
async def test_erwaehnung_erreicht_das_handy(
    client, _auth_signer, session_factory, handys, _isolate_chat_settings
):
    heads_a, uid_a = _konto(_auth_signer)
    _heads_b, uid_b = _konto(_auth_signer)
    gid, cid = await _community(client, heads_a, uid_b)
    token = await _handy(session_factory, uid_b)
    _isolate_chat_settings.pulse_instance_mode = "cloud"

    mid = await _erwaehnen(client, heads_a, cid, uid_b)
    assert len(handys) == 1
    sendung = handys[0]
    assert sendung["token"] == token
    assert sendung["payload"] == {
        "type": "erwaehnung",
        "title": f"u{uid_a} in #allgemein (Runde)",
        "body": "schau mal hier",
        "guild_id": gid,
        "channel_id": cid,
        "message_id": mid,
    }
    assert sendung["kategorie"] == "erwaehnung"
    assert sendung["gruppe"] == sendung["tag"] == cid
    assert sendung["lokal"] is None


@pytest.mark.asyncio
async def test_erwaehnung_schweigt_bei_nicht_stoeren(
    app, client, _auth_signer, session_factory, handys, _isolate_chat_settings
):
    heads_a, _ = _konto(_auth_signer)
    _heads_b, uid_b = _konto(_auth_signer)
    _gid, cid = await _community(client, heads_a, uid_b)
    await _handy(session_factory, uid_b)
    _isolate_chat_settings.pulse_instance_mode = "cloud"
    schluessel = PRESENCE_STATUS_KEY.format(user_id=uid_b)
    await app.state.redis.set(schluessel, "dnd", ex=60)
    try:
        await _erwaehnen(client, heads_a, cid, uid_b)
    finally:
        await app.state.redis.delete(schluessel)
    assert handys == []


@pytest.mark.asyncio
async def test_self_host_schickt_keinen_handy_push(
    client, _auth_signer, session_factory, handys
):
    """Ein Self-Host hat keinen Firebase-Zugang — auch mit (versehentlich)
    gesetztem Schlüssel geht hier nichts hinaus."""
    heads_a, _ = _konto(_auth_signer)
    _heads_b, uid_b = _konto(_auth_signer)
    _gid, cid = await _community(client, heads_a, uid_b)
    await _handy(session_factory, uid_b)
    await _erwaehnen(client, heads_a, cid, uid_b)
    assert handys == []


# MARK: - Freundschaftsanfrage


@pytest.mark.asyncio
async def test_freundschaftsanfrage_erreicht_das_handy_mit_schluessel_wo_zugesagt(
    app, client, _auth_signer, session_factory, handys, cloud_mode
):
    heads_a, uid_a = _konto(_auth_signer)
    _heads_b, uid_b = _konto(_auth_signer)
    neu = await _handy(session_factory, uid_b, "neu")
    alt = await _handy(session_factory, uid_b, "alt")
    await android_faehigkeiten_merken(
        app.state.redis, user_id=uid_b, geraet_id="neu", faehigkeiten=["texte_lokal"]
    )
    r = await client.post(
        "/friend-requests", json={"target_user_id": str(uid_b)}, headers=heads_a
    )
    assert r.status_code == 201, r.text
    await fcm_hinweise.hintergrund_abwarten()

    je_token = {s["token"]: s for s in handys}
    assert set(je_token) == {neu, alt}
    payload = je_token[neu]["payload"]
    assert payload == {
        "type": "freundschaft",
        "title": f"u{uid_a}",
        "body": "Möchte mit dir befreundet sein",
        "user_id": str(uid_a),
    }
    assert je_token[neu]["tag"] == f"freundschaft:{uid_a}"
    assert je_token[neu]["kategorie"] == "freundschaft"
    assert je_token[neu]["lokal"].schluessel == "Möchte mit dir befreundet sein"
    assert je_token[alt]["lokal"] is None


# MARK: - Der Bau


def _kodiere(msg) -> dict:
    from firebase_admin.messaging import _messaging_encoder

    return json.loads(json.dumps(msg, cls=_messaging_encoder.MessageEncoder))


def test_freundschaft_als_android_ressource_und_ios_schluessel():
    from dcc_chat_gateway.fcm_texte import Lokal

    payload = {"type": "freundschaft", "title": "Bob", "body": "x", "user_id": "5"}
    d = _kodiere(
        fcm_nachricht.mitteilung(
            token="t", payload=payload, lokal=Lokal("Möchte mit dir befreundet sein", titel="Bob"),
            kategorie="freundschaft", gruppe="freundschaft", tag="freundschaft:5",
            zeitkritisch=False,
        )
    )
    assert d["android"]["notification"]["body_loc_key"] == "push_freundschaft"
    assert d["android"]["notification"]["title"] == "Bob"
    assert d["android"]["notification"]["tag"] == "freundschaft:5"
    aps = d["apns"]["payload"]["aps"]
    assert aps["alert"] == {"title": "Bob", "loc-key": "Möchte mit dir befreundet sein"}
    assert aps["category"] == "freundschaft"
    assert "interruption-level" not in aps
    assert d["data"]["user_id"] == "5"
