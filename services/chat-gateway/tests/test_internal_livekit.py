"""``GET /internal/livekit-zugang`` (Gegenprüfung des Security-Audits, M7).

voice-signaling fragt bei jedem Beitritt in einen LiveKit-Raum, ob die Person
noch hinein darf — ein gebanntes Mitglied trat vorher mit seinem 4-h-Token
wieder bei. Hier: Auth, Sprachkanal (Mitglied, Bann, entzogenes CONNECT) und
Anruf-Raum (Teilnehmer ja, Fremder nein)."""

from __future__ import annotations

import random

import pytest
import pytest_asyncio
from dcc_shared.permission_resolver import OVERWRITE_TARGET_USER
from dcc_shared.permissions import Permissions

from .conftest import beitreten_per_einladung, make_auth_header

pytestmark = pytest.mark.usefixtures("cloud_mode")

_SECRET = "test-internal-secret-do-not-leak"
_H = {"X-Pulse-Internal-Secret": _SECRET}


@pytest_asyncio.fixture
async def _secret(_isolate_chat_settings):
    original = _isolate_chat_settings.internal_service_secret
    _isolate_chat_settings.internal_service_secret = _SECRET
    yield
    _isolate_chat_settings.internal_service_secret = original


def _konto(_auth_signer) -> tuple[str, int]:
    uid = random.randint(1, 1_000_000_000)
    return _auth_signer.issue_access(uid, f"u{uid}"), uid


async def _erlaubt(client, raum: str, nutzer: int) -> bool:
    r = await client.get("/internal/livekit-zugang", params={"raum": raum, "nutzer": nutzer}, headers=_H)
    assert r.status_code == 200, r.text
    return r.json()["erlaubt"]


async def _sprachkanal(client, session_factory, _auth_signer):
    from dcc_chat_gateway.models import CHANNEL_TYPE_VOICE, Channel
    from dcc_chat_gateway.snowflake import next_id

    t_owner, _ = _konto(_auth_signer)
    _, uid = _konto(_auth_signer)
    g = (await client.post("/guilds", json={"name": "g"}, headers=make_auth_header(t_owner))).json()
    await beitreten_per_einladung(client, g["id"], str(uid), t_owner)
    cid = next_id()
    async with session_factory() as s:
        s.add(Channel(id=cid, guild_id=int(g["id"]), name="voice", type=CHANNEL_TYPE_VOICE))
        await s.commit()
    return t_owner, g["id"], cid, uid


@pytest.mark.asyncio
async def test_braucht_secret(client):
    r = await client.get("/internal/livekit-zugang", params={"raum": "channel-1", "nutzer": 1})
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_dienstverkehr_drosselt_sich_nicht_selbst(client, _secret, monkeypatch):
    """Nur falsche Secrets zählen gegen die Bremse: sonst drosselte schnelles
    Wiederbeitreten (je Beitritt eine Abfrage) alle internen Abfragen, und
    voice-signaling ließe bei 429 durch — der Bann wäre umgangen."""
    import dcc_chat_gateway.ratelimit as ratelimit

    monkeypatch.setitem(ratelimit._RULES, "internal_secret", (2, 60.0))
    params = {"raum": "channel-1", "nutzer": 1}
    falsch = {"X-Pulse-Internal-Secret": "falsch"}
    try:
        for _ in range(5):
            assert await _erlaubt(client, "channel-123456", 1) is False
        for _ in range(2):
            r = await client.get("/internal/livekit-zugang", params=params, headers=falsch)
            assert r.status_code == 401
        r = await client.get("/internal/livekit-zugang", params=params, headers=_H)
        assert r.status_code == 429
    finally:
        ratelimit.reset()


@pytest.mark.asyncio
async def test_nur_bekannte_raumarten(client, _secret):
    r = await client.get("/internal/livekit-zugang", params={"raum": "fremd-1", "nutzer": 1}, headers=_H)
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_gebanntes_mitglied_darf_nicht_mehr_in_den_sprachkanal(
    client, session_factory, _auth_signer, _secret
):
    t_owner, gid, cid, uid = await _sprachkanal(client, session_factory, _auth_signer)
    assert await _erlaubt(client, f"channel-{cid}", uid) is True

    r = await client.put(f"/guilds/{gid}/bans/{uid}", json={}, headers=make_auth_header(t_owner))
    assert r.status_code in (200, 204), r.text
    assert await _erlaubt(client, f"channel-{cid}", uid) is False


@pytest.mark.asyncio
async def test_entzogenes_connect_sperrt_den_beitritt(
    client, session_factory, _auth_signer, _secret
):
    t_owner, _, cid, uid = await _sprachkanal(client, session_factory, _auth_signer)
    r = await client.put(
        f"/channels/{cid}/permissions/{OVERWRITE_TARGET_USER}/{uid}",
        json={"allow": "0", "deny": str(int(Permissions.CONNECT))},
        headers=make_auth_header(t_owner),
    )
    assert r.status_code in (200, 204), r.text
    assert await _erlaubt(client, f"channel-{cid}", uid) is False


@pytest.mark.asyncio
async def test_unbekannter_kanal_ist_kein_zugang(client, _secret):
    assert await _erlaubt(client, "channel-123456", 1) is False


@pytest.mark.asyncio
async def test_anruf_nur_fuer_teilnehmer(client, _auth_signer, friend_pair, _secret):
    t_a, uid_a = _konto(_auth_signer)
    _, uid_b = _konto(_auth_signer)
    _, uid_fremd = _konto(_auth_signer)
    await friend_pair(uid_a, uid_b)
    heads = make_auth_header(t_a)
    dm = (await client.post("/dm-channels", json={"target_user_id": str(uid_b)}, headers=heads)).json()
    r = await client.post("/anrufe", json={"art": "dm", "channel_id": dm["id"]}, headers=heads)
    assert r.status_code == 201, r.text
    raum = f"call-{r.json()['id']}"

    assert await _erlaubt(client, raum, uid_b) is True
    assert await _erlaubt(client, raum, uid_fremd) is False
    assert await _erlaubt(client, "call-123456", uid_a) is False
