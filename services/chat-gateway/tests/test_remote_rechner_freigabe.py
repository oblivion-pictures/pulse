"""Remote-Rechner nur über die Freigabeliste (Eigentümer-Entscheid 2026-10-16).

Geprüft wird, was die Spezifikation verbindlich macht (R1–R6):

* Wecken und Geräte-Anfrage nur mit Sicht am Standplatz UND deckender,
  nicht abgelaufener Freigabe (Nutzer / Rolle / ``everyone``);
  ``REMOTE_CONTROL`` zählt dafür nicht.
* Zuschauen beim Strom eines Geräts nur für Besitzer, Steuernden, Wecker (in
  der Frist) oder bei belegtem Gerät; ein normaler Go-Live-Strom bleibt, wie
  er war.
* ``steuerbar`` je Betrachter in der Geräteliste, ``device_access_changed``
  beim Ersetzen der Liste.
* Entzug oder Ablauf der Freigabe beendet die laufende Gerätesitzung — beim
  Ersetzen der Liste sofort, sonst im Takt der Wache.

Testhilfen sind je Datei selbsttragend (Repo-Konvention), Muster aus
``test_devices.py`` und ``test_streaming.py``.
"""

from __future__ import annotations

import json
import time
import uuid
from datetime import UTC, datetime, timedelta

import dcc_chat_gateway.routes.streaming as streaming_routes
import httpx
import pytest
from dcc_chat_gateway.models import (
    CHANNEL_TYPE_VOICE,
    SUBJECT_EVERYONE,
    DeviceGrant,
    MemberRole,
    PermissionOverwrite,
    Role,
)
from dcc_chat_gateway.snowflake import next_id
from dcc_shared.permissions import Permissions
from dcc_shared.streaming import active_key, read_cache_key, token_key


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _make_token(signer) -> tuple[str, int]:
    uid = abs(hash(uuid.uuid4())) & ((1 << 31) - 1)
    return signer.issue_access(uid, f"u{uid}"), uid


async def _guild(client, token: str) -> int:
    r = await client.post("/guilds", json={"name": "werkstatt"}, headers=_auth(token))
    assert r.status_code == 201, r.text
    return int(r.json()["id"])


async def _voice_channel(client, token: str, gid: int, name: str = "werkbank") -> int:
    r = await client.post(
        f"/guilds/{gid}/channels",
        json={"name": name, "type": CHANNEL_TYPE_VOICE},
        headers=_auth(token),
    )
    assert r.status_code == 201, r.text
    return int(r.json()["id"])


async def _mitglied(client, owner_token: str, gid: int, signer) -> tuple[str, int]:
    token, uid = await _make_token(signer)
    invite = (
        await client.post(f"/guilds/{gid}/invites", json={}, headers=_auth(owner_token))
    ).json()
    r = await client.post(f"/invites/{invite['code']}/accept", headers=_auth(token))
    assert r.status_code in (200, 201), r.text
    return token, uid


class _Sock:
    def __init__(self, app=None) -> None:
        self.sent: list[dict] = []
        self.app = app

    async def send_json(self, payload: dict) -> None:
        self.sent.append(payload)


class _User:
    def __init__(self, uid: int) -> None:
        self.id = uid
        self.username = f"u{uid}"
        self.is_admin = False
        self.is_owner = False
        self.payload: dict = {}
        self.user_identifier = str(uid)
        self.is_self_host = False


class _Ctx:
    def __init__(self, sock, user) -> None:
        self.websocket = sock
        self.user = user
        self.last_remote_request = 0.0
        self.last_device_announce = 0.0
        self.last_device_wake = 0.0


def _mgr(client):
    return client._transport.app.state.connection_manager


def _ctx(client, uid: int) -> _Ctx:
    return _Ctx(_Sock(client._transport.app), _User(uid))


async def _freigabe(session_factory, device_id: int, art: str, subject_id=None, expires_at=None):
    async with session_factory() as s:
        s.add(
            DeviceGrant(
                id=next_id(),
                device_id=int(device_id),
                subject_type=art,
                subject_id=subject_id,
                expires_at=expires_at,
                created_by_user_id=1,
            )
        )
        await s.commit()


async def _aufbau(client, signer):
    """Besitzer der Community + ein Mitglied als Gerätebesitzer mit einem Gerät
    im Standplatz, + ein drittes Mitglied (der Steuernde)."""
    admin_token, admin_uid = await _make_token(signer)
    gid = await _guild(client, admin_token)
    cid = await _voice_channel(client, admin_token, gid)
    owner_token, owner_uid = await _mitglied(client, admin_token, gid, signer)
    device = (
        await client.post(
            f"/guilds/{gid}/devices",
            json={"channel_id": str(cid), "name": "werkstatt-pc"},
            headers=_auth(owner_token),
        )
    ).json()
    ctrl_token, ctrl_uid = await _mitglied(client, admin_token, gid, signer)
    return {
        "admin_token": admin_token,
        "admin_uid": admin_uid,
        "gid": gid,
        "cid": cid,
        "owner_token": owner_token,
        "owner_uid": owner_uid,
        "did": int(device["id"]),
        "ctrl_token": ctrl_token,
        "ctrl_uid": ctrl_uid,
    }


def _geraet_verbinden(client, a) -> _Sock:
    mgr = _mgr(client)
    sock = _Sock(client._transport.app)
    mgr._ws_user[sock] = _User(a["owner_uid"])
    mgr._user_conns.setdefault(a["owner_uid"], set()).add(sock)
    mgr.device_announce(sock, a["did"], a["gid"], a["cid"])
    return sock


async def _laufende_sitzung(client, a, geraet_sock) -> tuple:
    """Eine angenommene Gerätesitzung: Steuernder ``ctrl_uid``, Gerät belegt."""
    mgr = _mgr(client)
    ctrl_sock = _Sock(client._transport.app)
    mgr._ws_user[ctrl_sock] = _User(a["ctrl_uid"])
    sess = await mgr.remote_create(
        str(a["cid"]), str(a["owner_uid"]), geraet_sock, str(a["ctrl_uid"]), ctrl_sock,
        device_id=str(a["did"]),
    )
    assert await mgr.remote_activate(sess.session_id)
    await mgr.device_mark_busy_and_publish(a["did"], str(a["ctrl_uid"]), geraet_sock)
    return sess, ctrl_sock


# ── R1/R2: Wecken je Art der Freigabe ────────────────────────────────────────


@pytest.mark.asyncio
async def test_wecken_mit_rollen_freigabe(client, _auth_signer, session_factory):
    from dcc_chat_gateway.routes import ws_device_handlers

    a = await _aufbau(client, _auth_signer)
    rolle = next_id()
    async with session_factory() as s:
        s.add(Role(id=rolle, guild_id=a["gid"], name="werkstatt", position=1, permissions=0))
        s.add(MemberRole(guild_id=a["gid"], user_id=a["ctrl_uid"], role_id=rolle))
        await s.commit()
    await _freigabe(session_factory, a["did"], "role", rolle)
    geraet = _geraet_verbinden(client, a)

    ctx = _ctx(client, a["ctrl_uid"])
    await ws_device_handlers.handle_wake(ctx, {"device_id": str(a["did"])})
    assert ctx.websocket.sent == []
    assert geraet.sent[-1]["op"] == "device_wake"


@pytest.mark.asyncio
async def test_wecken_freigabe_fuer_jemand_anderen_deckt_nicht(
    client, _auth_signer, session_factory
):
    from dcc_chat_gateway.routes import ws_device_handlers

    a = await _aufbau(client, _auth_signer)
    await _freigabe(session_factory, a["did"], "user", a["admin_uid"])
    geraet = _geraet_verbinden(client, a)

    ctx = _ctx(client, a["ctrl_uid"])
    await ws_device_handlers.handle_wake(ctx, {"device_id": str(a["did"])})
    assert ctx.websocket.sent[-1]["code"] == 4062
    assert geraet.sent == []
    assert _mgr(client).device_wecker(a["did"]) is None


@pytest.mark.asyncio
async def test_wecken_mit_abgelaufener_freigabe(client, _auth_signer, session_factory):
    from dcc_chat_gateway.routes import ws_device_handlers

    a = await _aufbau(client, _auth_signer)
    await _freigabe(
        session_factory, a["did"], SUBJECT_EVERYONE,
        expires_at=datetime.now(UTC) - timedelta(minutes=1),
    )
    _geraet_verbinden(client, a)
    ctx = _ctx(client, a["ctrl_uid"])
    await ws_device_handlers.handle_wake(ctx, {"device_id": str(a["did"])})
    assert ctx.websocket.sent[-1]["code"] == 4062


@pytest.mark.asyncio
async def test_wecken_mit_everyone_und_noch_gueltiger_frist(
    client, _auth_signer, session_factory
):
    from dcc_chat_gateway.routes import ws_device_handlers

    a = await _aufbau(client, _auth_signer)
    await _freigabe(
        session_factory, a["did"], SUBJECT_EVERYONE,
        expires_at=datetime.now(UTC) + timedelta(hours=1),
    )
    geraet = _geraet_verbinden(client, a)
    ctx = _ctx(client, a["ctrl_uid"])
    await ws_device_handlers.handle_wake(ctx, {"device_id": str(a["did"])})
    assert geraet.sent[-1]["op"] == "device_wake"


@pytest.mark.asyncio
async def test_anfrage_ohne_geraet_bleibt_bei_remote_control(
    client, _auth_signer, session_factory
):
    """Die normale Fernsteuerung (Person → streamende Person) ist unberührt:
    ohne ``REMOTE_CONTROL`` 4051, mit dem Recht geht die Einladung hinaus —
    eine Freigabeliste spielt dort keine Rolle."""
    from dcc_chat_gateway.routes import ws_remote_handlers

    from .conftest import everyone_remote_control_entfernen

    a = await _aufbau(client, _auth_signer)
    mgr = _mgr(client)
    host_sock = _Sock(client._transport.app)
    mgr._ws_user[host_sock] = _User(a["admin_uid"])
    mgr._user_conns.setdefault(a["admin_uid"], set()).add(host_sock)

    ctx = _ctx(client, a["ctrl_uid"])
    msg = {"channel_id": str(a["cid"]), "host_user_id": str(a["admin_uid"])}
    await ws_remote_handlers.handle_request(ctx, msg, session_factory=session_factory)
    einladung = [f for f in host_sock.sent if f.get("op") == "remote_request"]
    assert len(einladung) == 1 and "freigabe" not in einladung[0]
    for sess in mgr.remote_sessions_snapshot():
        mgr.remote_cancel_timeout(sess.session_id)
        await mgr.remote_end(sess.session_id)

    await everyone_remote_control_entfernen(client, a["admin_token"], a["gid"])
    ctx2 = _ctx(client, a["ctrl_uid"])
    await ws_remote_handlers.handle_request(ctx2, msg, session_factory=session_factory)
    assert ctx2.websocket.sent[-1]["code"] == 4051


# ── R3: der Wecker-Merker ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_wecker_merker_faellt_bei_zusage_ende_und_frist(client, _auth_signer):
    a = await _aufbau(client, _auth_signer)
    mgr = _mgr(client)
    geraet = _geraet_verbinden(client, a)

    mgr.device_wecker_setzen(a["did"], a["ctrl_uid"])
    assert mgr.device_wecker(a["did"]) == str(a["ctrl_uid"])
    # Zusage: ab jetzt zählt die Belegung.
    sess, _ctrl = await _laufende_sitzung(client, a, geraet)
    assert mgr.device_wecker(a["did"]) is None

    # Sitzungsende räumt einen (erneut gesetzten) Merker ebenfalls.
    mgr.device_wecker_setzen(a["did"], a["ctrl_uid"])
    await mgr.remote_terminate(sess.session_id, "test")
    assert mgr.device_wecker(a["did"]) is None

    # Und die Frist: ein abgelaufener Eintrag gilt nicht mehr.
    mgr._device_wecker[a["did"]] = (str(a["ctrl_uid"]), time.monotonic() - 1)
    assert mgr.device_wecker(a["did"]) is None


# ── R6: steuerbar + device_access_changed ────────────────────────────────────


@pytest.mark.asyncio
async def test_steuerbar_je_betrachter(client, _auth_signer, session_factory):
    a = await _aufbau(client, _auth_signer)
    await _freigabe(session_factory, a["did"], "user", a["ctrl_uid"])

    def _feld(token):
        async def _hole():
            r = await client.get(f"/guilds/{a['gid']}/devices", headers=_auth(token))
            assert r.status_code == 200, r.text
            return r.json()[0]["steuerbar"]

        return _hole()

    assert await _feld(a["ctrl_token"]) is True
    # REMOTE_CONTROL (Community-Besitzer) ohne Freigabe: nicht steuerbar.
    assert await _feld(a["admin_token"]) is False
    # Der Besitzer kann sein eigenes Gerät nicht fernsteuern.
    assert await _feld(a["owner_token"]) is False


@pytest.mark.asyncio
async def test_freigabe_aendern_meldet_und_beendet_sofort(client, _auth_signer, session_factory):
    """R5 + R6: ersetzt der Besitzer die Liste, verliert ein nicht mehr
    gedeckter Steuernder seine Sitzung sofort, und alle, die den Standplatz
    sehen, bekommen ``device_access_changed`` zum Neuladen."""
    a = await _aufbau(client, _auth_signer)
    await _freigabe(session_factory, a["did"], "user", a["ctrl_uid"])
    mgr = _mgr(client)
    geraet = _geraet_verbinden(client, a)
    sess, ctrl_sock = await _laufende_sitzung(client, a, geraet)

    gesendet: list = []

    async def _merken(evt):
        gesendet.append(evt)

    mgr.publish_guild_event = _merken
    r = await client.put(
        f"/guilds/{a['gid']}/devices/{a['did']}/grants",
        json={"grants": [{"subject_type": "user", "subject_id": str(a["admin_uid"])}]},
        headers=_auth(a["owner_token"]),
    )
    assert r.status_code == 200, r.text
    assert mgr.remote_get(sess.session_id) is None
    assert ctrl_sock.sent[-1] == {
        "op": "remote_ended", "session_id": sess.session_id, "reason": "permission_revoked",
    }
    zugang = [e for e in gesendet if getattr(e, "op", None) == "device_access_changed"]
    assert len(zugang) == 1
    assert zugang[0].device_id == str(a["did"])
    assert zugang[0].channel_id == str(a["cid"])


@pytest.mark.asyncio
async def test_freigabe_aendern_laesst_gedeckte_sitzung_leben(
    client, _auth_signer, session_factory
):
    a = await _aufbau(client, _auth_signer)
    await _freigabe(session_factory, a["did"], "user", a["ctrl_uid"])
    mgr = _mgr(client)
    geraet = _geraet_verbinden(client, a)
    sess, _ctrl = await _laufende_sitzung(client, a, geraet)
    r = await client.put(
        f"/guilds/{a['gid']}/devices/{a['did']}/grants",
        json={"grants": [{"subject_type": "everyone"}]},
        headers=_auth(a["owner_token"]),
    )
    assert r.status_code == 200, r.text
    assert mgr.remote_get(sess.session_id) is not None
    await mgr.remote_terminate(sess.session_id, "test")


# ── R5: die Wache im Takt ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_wache_beendet_bei_abgelaufener_freigabe(client, _auth_signer, session_factory):
    from dcc_chat_gateway.remote_guard import audit_remote_sessions

    a = await _aufbau(client, _auth_signer)
    async with session_factory() as s:
        zeile = DeviceGrant(
            id=next_id(), device_id=a["did"], subject_type="user",
            subject_id=a["ctrl_uid"], expires_at=datetime.now(UTC) + timedelta(hours=1),
            created_by_user_id=a["owner_uid"],
        )
        s.add(zeile)
        await s.commit()
    mgr = _mgr(client)
    geraet = _geraet_verbinden(client, a)
    sess, _ctrl = await _laufende_sitzung(client, a, geraet)
    assert await audit_remote_sessions(mgr) == 0

    async with session_factory() as s:
        z = await s.get(DeviceGrant, zeile.id)
        z.expires_at = datetime.now(UTC) - timedelta(seconds=1)
        await s.commit()
    assert await audit_remote_sessions(mgr) == 1
    assert mgr.remote_get(sess.session_id) is None


@pytest.mark.asyncio
async def test_wache_verlangt_fuer_geraete_kein_remote_control(
    client, _auth_signer, session_factory
):
    """Der Gegenbeweis: REMOTE_CONTROL fällt weg, die Freigabe bleibt — die
    Gerätesitzung lebt weiter (vorher beendete die Wache sie)."""
    from dcc_chat_gateway.remote_guard import audit_remote_sessions

    from .conftest import everyone_remote_control_entfernen

    a = await _aufbau(client, _auth_signer)
    await _freigabe(session_factory, a["did"], "user", a["ctrl_uid"])
    mgr = _mgr(client)
    geraet = _geraet_verbinden(client, a)
    sess, _ctrl = await _laufende_sitzung(client, a, geraet)
    await everyone_remote_control_entfernen(client, a["admin_token"], a["gid"])
    assert await audit_remote_sessions(mgr) == 0
    assert mgr.remote_get(sess.session_id) is not None
    await mgr.remote_terminate(sess.session_id, "test")


@pytest.mark.asyncio
async def test_wache_beendet_bei_entzogener_sicht(client, _auth_signer, session_factory):
    from dcc_chat_gateway.remote_guard import audit_remote_sessions

    a = await _aufbau(client, _auth_signer)
    await _freigabe(session_factory, a["did"], SUBJECT_EVERYONE)
    mgr = _mgr(client)
    geraet = _geraet_verbinden(client, a)
    sess, _ctrl = await _laufende_sitzung(client, a, geraet)
    async with session_factory() as s:
        s.add(
            PermissionOverwrite(
                channel_id=a["cid"], target_id=a["ctrl_uid"], target_type=1,
                allow_bf=0, deny_bf=int(Permissions.VIEW_CHANNEL),
            )
        )
        await s.commit()
    assert await audit_remote_sessions(mgr) == 1
    assert mgr.remote_get(sess.session_id) is None


# ── R3: Zuschauen beim Gerätestrom ───────────────────────────────────────────


@pytest.fixture
def media(monkeypatch):
    """``_media_svc_request`` durch eine Aufzeichnung ersetzen (Muster aus
    ``test_streaming.py``)."""
    calls: list[tuple] = []

    async def _fake(method, path, *, bearer, json_body=None, http=None):
        calls.append((method, path, json_body))
        return httpx.Response(
            200,
            json={"whep_url": "http://m/x/whep", "token": "t", "mediamtx_path": "p",
                  "push_protocol": "whip", "push_url": "u", "expires_in_s": 60},
            request=httpx.Request(method, "http://media-svc" + path),
        )

    monkeypatch.setattr(streaming_routes, "_media_svc_request", _fake)
    return calls


async def _geraetestrom_markieren(client, a, slot: int = 0) -> str:
    """Den ``stream:active``-Datensatz eines Gerätestroms in Redis legen, wie
    ihn der auth-hook nach dem Publish schreibt."""
    key = active_key(a["cid"], a["owner_uid"], slot)
    await _mgr(client)._redis.set(
        key, json.dumps({"user_id": str(a["owner_uid"]), "path": "p", "device_id": str(a["did"])})
    )
    return key


def _whep(a, slot: int = 0) -> str:
    return f"/channels/{a['cid']}/whep?user_id={a['owner_uid']}&slot={slot}"


@pytest.mark.asyncio
async def test_fremder_sieht_geweckten_aber_ungesteuerten_geraetestrom_nicht(
    client, _auth_signer, media
):
    a = await _aufbau(client, _auth_signer)
    key = await _geraetestrom_markieren(client, a)
    try:
        r = await client.get(_whep(a), headers=_auth(a["ctrl_token"]))
        assert r.status_code == 403
        assert media == []
    finally:
        await _mgr(client)._redis.delete(key)


@pytest.mark.asyncio
async def test_besitzer_wecker_und_belegt_duerfen_zusehen(client, _auth_signer, media):
    a = await _aufbau(client, _auth_signer)
    mgr = _mgr(client)
    key = await _geraetestrom_markieren(client, a)
    try:
        # (a) Besitzer — immer.
        r = await client.get(_whep(a), headers=_auth(a["owner_token"]))
        assert r.status_code == 200, r.text
        assert media[-1][1] == _whep(a) + f"&geraet={a['did']}"
        # (c) Wecker in der Frist.
        mgr.device_wecker_setzen(a["did"], a["ctrl_uid"])
        r = await client.get(_whep(a), headers=_auth(a["ctrl_token"]))
        assert r.status_code == 200, r.text
        # … aber nur er: der Community-Besitzer nicht.
        r = await client.get(_whep(a), headers=_auth(a["admin_token"]))
        assert r.status_code == 403
        # (d) belegt — dann jeder, der den Kanal sieht.
        geraet = _geraet_verbinden(client, a)
        sess, _ctrl = await _laufende_sitzung(client, a, geraet)
        r = await client.get(_whep(a), headers=_auth(a["admin_token"]))
        assert r.status_code == 200, r.text
        await mgr.remote_terminate(sess.session_id, "test")
        r = await client.get(_whep(a), headers=_auth(a["admin_token"]))
        assert r.status_code == 403
    finally:
        await mgr._redis.delete(key)


@pytest.mark.asyncio
async def test_geraetestrom_ohne_merkmal_ueber_das_register(client, _auth_signer, media):
    """Rückfall für Geräte-Clients ohne Merkmal: das Register sagt, dass das
    Gerät dieses Besitzers an diesem Standplatz auf Platz 1 sendet."""
    a = await _aufbau(client, _auth_signer)
    mgr = _mgr(client)
    _geraet_verbinden(client, a)
    mgr.device_streams_set(a["did"], {1})
    r = await client.get(_whep(a, slot=1), headers=_auth(a["ctrl_token"]))
    assert r.status_code == 403
    # Platz 0 desselben Besitzers ist sein eigener Go-Live: unverändert.
    r = await client.get(_whep(a, slot=0), headers=_auth(a["ctrl_token"]))
    assert r.status_code == 200, r.text
    assert media[-1][1] == _whep(a, slot=0)


@pytest.mark.asyncio
async def test_normaler_strom_bleibt_unveraendert(client, _auth_signer, media):
    a = await _aufbau(client, _auth_signer)
    key = active_key(a["cid"], a["owner_uid"], 0)
    await _mgr(client)._redis.set(key, json.dumps({"user_id": str(a["owner_uid"]), "path": "p"}))
    try:
        r = await client.get(_whep(a), headers=_auth(a["ctrl_token"]))
        assert r.status_code == 200, r.text
        assert media[-1][1] == _whep(a)
    finally:
        await _mgr(client)._redis.delete(key)


@pytest.mark.asyncio
async def test_stream_token_mit_geraet_nur_fuer_eigenes_geraet_am_standplatz(
    client, _auth_signer, media
):
    a = await _aufbau(client, _auth_signer)
    url = f"/channels/{a['cid']}/stream-token"
    body = {"protocol": "whip", "device_id": str(a["did"])}
    r = await client.post(url, json=body, headers=_auth(a["owner_token"]))
    assert r.status_code == 200, r.text
    assert media[-1][2]["device_id"] == str(a["did"])
    # Fremdes Gerät: 403, media-svc wird gar nicht gefragt.
    anzahl = len(media)
    r = await client.post(url, json=body, headers=_auth(a["ctrl_token"]))
    assert r.status_code == 403
    # Eigenes Gerät, aber anderer Kanal: ebenfalls 403.
    anderer = await _voice_channel(client, a["admin_token"], a["gid"], "lager")
    r = await client.post(
        f"/channels/{anderer}/stream-token", json=body, headers=_auth(a["owner_token"])
    )
    assert r.status_code == 403
    assert len(media) == anzahl
    # Ohne Gerät: der Body bleibt, wie er war (kein ``device_id``).
    r = await client.post(url, json={"protocol": "whip"}, headers=_auth(a["owner_token"]))
    assert r.status_code == 200
    assert "device_id" not in media[-1][2]


@pytest.mark.asyncio
async def test_sitzungsende_widerruft_fremde_lese_token(client, _auth_signer):
    """Endet die Steuerung, verlieren die übrigen Zuschauer ihre Lese-Token
    für den Gerätestrom; der Besitzer behält seins, und ein anderer Platz des
    Besitzers (sein eigener Go-Live) bleibt unberührt."""
    a = await _aufbau(client, _auth_signer)
    mgr = _mgr(client)
    redis = mgr._redis
    key = await _geraetestrom_markieren(client, a, slot=0)
    geraet = _geraet_verbinden(client, a)
    sess, _ctrl = await _laufende_sitzung(client, a, geraet)
    fremd = read_cache_key(a["admin_uid"], a["cid"], a["owner_uid"], 0)
    eigen = read_cache_key(a["owner_uid"], a["cid"], a["owner_uid"], 0)
    golive = read_cache_key(a["admin_uid"], a["cid"], a["owner_uid"], 3)
    werte = {fremd: "tok-fremd", eigen: "tok-eigen", golive: "tok-golive"}
    for k, w in werte.items():
        await redis.set(k, w)
        await redis.set(token_key(w), "{}")
    try:
        await mgr.remote_terminate(sess.session_id, "test")
        assert await redis.get(fremd) is None
        assert await redis.get(token_key("tok-fremd")) is None
        assert await redis.get(eigen) is not None
        assert await redis.get(golive) is not None
    finally:
        await redis.delete(key, *werte, *(token_key(w) for w in werte.values()))


# ── Reclaim nach Verbindungsabriss: dieselbe Latte ───────────────────────────


async def _reclaim(client, a, sess, session_factory) -> dict:
    from dcc_chat_gateway.routes import ws_remote_reconnect

    mgr = _mgr(client)

    async def _egal(_sid, _rolle):
        return None

    mgr.remote_schedule_disconnect_grace(sess.session_id, "controller", _egal, delay=30)
    neu = _Sock(client._transport.app)
    await ws_remote_reconnect.handle_reclaim(
        neu, _User(a["ctrl_uid"]), {"session_id": sess.session_id},
        session_factory=session_factory,
    )
    mgr.remote_cancel_disconnect_grace(sess.session_id)
    return neu.sent[-1]


@pytest.mark.asyncio
async def test_reclaim_einer_geraetesitzung_braucht_freigabe_nicht_remote_control(
    client, _auth_signer, session_factory
):
    from .conftest import everyone_remote_control_entfernen

    a = await _aufbau(client, _auth_signer)
    await _freigabe(session_factory, a["did"], "user", a["ctrl_uid"])
    geraet = _geraet_verbinden(client, a)
    sess, _ctrl = await _laufende_sitzung(client, a, geraet)
    await everyone_remote_control_entfernen(client, a["admin_token"], a["gid"])
    antwort = await _reclaim(client, a, sess, session_factory)
    assert antwort["op"] == "remote_reclaimed"
    await _mgr(client).remote_terminate(sess.session_id, "test")


@pytest.mark.asyncio
async def test_reclaim_einer_geraetesitzung_ohne_freigabe_scheitert(
    client, _auth_signer, session_factory
):
    a = await _aufbau(client, _auth_signer)
    geraet = _geraet_verbinden(client, a)
    sess, _ctrl = await _laufende_sitzung(client, a, geraet)
    # REMOTE_CONTROL hat der Steuernde (Vorgabe) — ohne Zeile reicht das nicht.
    antwort = await _reclaim(client, a, sess, session_factory)
    assert antwort == {
        "op": "remote_reclaim_failed", "session_id": sess.session_id, "reason": "no access",
    }
    await _mgr(client).remote_terminate(sess.session_id, "test")
