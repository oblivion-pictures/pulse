"""Online-Zustand + Anzeigename von Heim-Servern (instance_status.py, 2026-10-08).

Die Server-Leiste blendet gestoppte Heim-Server für ALLE aus und zeigt den
Namen statt der Relay-Adresse. Geprüft wird: Heartbeat/Abschied/Zeitablauf
setzen ``online`` und melden NUR beim Wechsel an jedes Mitglied; der Server
setzt seinen Namen selbst; ``/me/instances`` trägt beides.
"""

from __future__ import annotations

import json
import secrets
from datetime import UTC, datetime, timedelta

import pytest_asyncio
from sqlalchemy import update

from dcc_auth.instance_status import waechter_einmal
from dcc_auth.models_instances import (
    InstanceDirectEndpoint,
    RegisteredInstance,
    UserInstanceMembership,
)
from dcc_auth.relay import generate_relay_token, hash_relay_token
from dcc_auth.security import hash_password

_FINGERPRINT = "sha-256 AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89"
_INSTANCE_ID = 21000000000000077


class _Sammler:
    """Fängt ``publish`` ab — mehr braucht instance_status nicht."""

    def __init__(self) -> None:
        self.nachrichten: list[tuple[str, dict]] = []

    async def publish(self, kanal: str, nutzlast: str) -> None:
        self.nachrichten.append((kanal, json.loads(nutzlast)))

    def an(self) -> list[str]:
        return sorted(n["_target_user_id"] for _, n in self.nachrichten)


async def _konto(client, name: str) -> dict:
    reg = {
        "username": name,
        "email": f"{name}@dcc-test.example.com",
        "password": "correct horse battery staple",
        "display_name": name,
    }
    await client.post("/register", json=reg)
    r = await client.post("/login", json={"email_or_username": reg["email"], "password": reg["password"]})
    sid = r.cookies.get("pulse_session")
    me = await client.get("/me", headers={"Cookie": f"pulse_session={sid}"})
    return {"cookie": f"pulse_session={sid}", "id": me.json()["id"]}


@pytest_asyncio.fixture
async def sammler(app):
    s = _Sammler()
    app.state.redis = s
    yield s
    app.state.redis = None


@pytest_asyncio.fixture
async def aufbau(client, session_factory):
    owner = await _konto(client, "status_owner")
    gast = await _konto(client, "status_gast")
    token = generate_relay_token()
    async with session_factory() as s:
        s.add(RegisteredInstance(
            id=_INSTANCE_ID, hostname="app-x.example.com", client_id=f"ci_{secrets.token_hex(8)}",
            client_secret="$argon2id$v=19$m=65536,t=3,p=4$fakehash",
            worker_id_chat=410, worker_id_voice=411, worker_id_media=412,
            status="active", origin="app_host", registered_by=int(owner["id"]),
            relay_subdomain="rapid-comet-58ed.relay.example.com",
            relay_tunnel_token_hash=hash_relay_token(token),
        ))
        s.add(UserInstanceMembership(user_id=int(owner["id"]), instance_id=_INSTANCE_ID, role="owner"))
        s.add(UserInstanceMembership(user_id=int(gast["id"]), instance_id=_INSTANCE_ID, role="member"))
        await s.commit()
    return {"owner": owner, "gast": gast, "token": token}


def _hb(token: str) -> dict:
    return {
        "instance_id": str(_INSTANCE_ID), "token": token,
        "candidates": [{"ip": "9.9.9.9", "port": 7900, "protocol": "udp"}],
        "fingerprint": _FINGERPRINT,
    }


async def _eintrag(client, cookie: str) -> dict:
    r = await client.get("/me/instances", headers={"Cookie": cookie})
    return next(i for i in r.json() if i["id"] == str(_INSTANCE_ID))


async def test_heartbeat_meldet_online_einmal_an_alle_mitglieder(client, aufbau, sammler):
    assert (await _eintrag(client, aufbau["gast"]["cookie"]))["online"] is False
    assert (await client.post("/selfhost/directory/heartbeat", json=_hb(aufbau["token"]))).status_code == 204
    assert sammler.an() == sorted([aufbau["owner"]["id"], aufbau["gast"]["id"]])
    kanal, n = sammler.nachrichten[0]
    assert kanal == "user:events"
    assert n["op"] == "instance_status"
    assert n["data"] == {"instance_id": str(_INSTANCE_ID), "online": True, "anzeigename": None}
    # Der nächste Heartbeat ist kein Wechsel — niemand wird geweckt.
    await client.post("/selfhost/directory/heartbeat", json=_hb(aufbau["token"]))
    assert len(sammler.nachrichten) == 2
    assert (await _eintrag(client, aufbau["gast"]["cookie"]))["online"] is True


async def test_abschied_meldet_offline_sofort(client, aufbau, sammler):
    await client.post("/selfhost/directory/heartbeat", json=_hb(aufbau["token"]))
    sammler.nachrichten.clear()
    r = await client.post("/selfhost/directory/offline",
                          json={"instance_id": str(_INSTANCE_ID), "token": aufbau["token"]})
    assert r.status_code == 204
    assert {n["data"]["online"] for _, n in sammler.nachrichten} == {False}
    assert len(sammler.nachrichten) == 2
    assert (await _eintrag(client, aufbau["owner"]["cookie"]))["online"] is False


async def test_waechter_wertet_verstummten_server_als_offline(client, aufbau, sammler, session_factory):
    """Absturz/Stromausfall: kein Abschied, nur ein veralteter Heartbeat."""
    await client.post("/selfhost/directory/heartbeat", json=_hb(aufbau["token"]))
    sammler.nachrichten.clear()
    # Frischer Heartbeat: der Wächter tut nichts.
    assert await waechter_einmal(sammler, session_factory, 300) == 0
    async with session_factory() as s:
        await s.execute(update(InstanceDirectEndpoint).values(
            updated_at=datetime.now(UTC) - timedelta(seconds=301)))
        await s.commit()
    assert await waechter_einmal(sammler, session_factory, 300) == 1
    assert {n["data"]["online"] for _, n in sammler.nachrichten} == {False}
    # Ein zweiter Durchgang meldet nicht erneut.
    assert await waechter_einmal(sammler, session_factory, 300) == 0


async def test_server_setzt_anzeigenamen_und_alle_sehen_ihn(client, aufbau, sammler):
    r = await client.post("/selfhost/anzeigename", json={
        "instance_id": str(_INSTANCE_ID), "token": aufbau["token"],
        "anzeigename": "  Michaels\u0007 Server  ",
    })
    assert r.status_code == 204
    # Steuerzeichen raus, Ränder weg.
    assert (await _eintrag(client, aufbau["gast"]["cookie"]))["anzeigename"] == "Michaels Server"
    assert {n["data"]["anzeigename"] for _, n in sammler.nachrichten} == {"Michaels Server"}
    # Gleicher Name: kein zweites Ereignis.
    n_vorher = len(sammler.nachrichten)
    await client.post("/selfhost/anzeigename", json={
        "instance_id": str(_INSTANCE_ID), "token": aufbau["token"], "anzeigename": "Michaels Server"})
    assert len(sammler.nachrichten) == n_vorher
    # Leer = entfernt.
    await client.post("/selfhost/anzeigename", json={
        "instance_id": str(_INSTANCE_ID), "token": aufbau["token"], "anzeigename": ""})
    assert (await _eintrag(client, aufbau["gast"]["cookie"]))["anzeigename"] is None


async def test_anzeigename_nur_mit_instanz_zugangsdaten(client, aufbau, sammler):
    r = await client.post("/selfhost/anzeigename", json={
        "instance_id": str(_INSTANCE_ID), "token": "falsch", "anzeigename": "Gekapert"})
    assert r.status_code == 401
    assert sammler.nachrichten == []


async def test_vps_instanz_hat_keinen_online_zustand(client, aufbau, session_factory):
    """VPS melden sich nicht beim Telefonbuch — ``None`` heißt „nicht ausblenden"."""
    async with session_factory() as s:
        await s.execute(update(RegisteredInstance).values(origin="vps"))
        await s.commit()
    assert (await _eintrag(client, aufbau["owner"]["cookie"]))["online"] is None


# ---------------------------------------------------------------------------
# Server per Gerätecode verbunden (``origin="vps"``): der Weg, auf dem der
# Betreiber seinen Server umbenennt. Anders als ein Heim-Server weist er sich
# mit ``client_id`` + Secret aus (kein Relay-Token) und meldet sich nie beim
# Telefonbuch.
# ---------------------------------------------------------------------------

_VPS_ID = 21000000000000088
_VPS_CLIENT_ID = "ci_vpsverbunden"
_VPS_SECRET = "geheimes-secret-des-servers"


@pytest_asyncio.fixture
async def aufbau_vps(client, session_factory):
    owner = await _konto(client, "vps_owner")
    mitglied = await _konto(client, "vps_mitglied")
    async with session_factory() as s:
        s.add(RegisteredInstance(
            id=_VPS_ID, hostname="selfhost.example.com", client_id=_VPS_CLIENT_ID,
            client_secret=hash_password(_VPS_SECRET), status="active", origin="vps",
            registered_by=int(owner["id"]), ohne_freigabe=True,
        ))
        s.add(UserInstanceMembership(user_id=int(owner["id"]), instance_id=_VPS_ID, role="owner"))
        s.add(UserInstanceMembership(user_id=int(mitglied["id"]), instance_id=_VPS_ID, role="member"))
        await s.commit()
    return {"owner": owner, "mitglied": mitglied}


def _melde_name(name: str | None, **ueber) -> dict:
    return {"instance_id": str(_VPS_ID), "client_id": _VPS_CLIENT_ID, "token": _VPS_SECRET,
            "anzeigename": name, **ueber}


async def _eintrag_vps(client, cookie: str) -> dict:
    r = await client.get("/me/instances", headers={"Cookie": cookie})
    return next(i for i in r.json() if i["id"] == str(_VPS_ID))


async def test_umbenannter_server_zeigt_mitgliedern_den_namen_statt_der_adresse(
    client, aufbau_vps, sammler
):
    """Der Kern des Wunsches: wer den Server noch nie geöffnet hat, sieht in
    ``/me/instances`` den Namen des Betreibers — nicht nur der Betreiber selbst."""
    vorher = await _eintrag_vps(client, aufbau_vps["mitglied"]["cookie"])
    assert vorher["anzeigename"] is None
    assert vorher["hostname"] == "selfhost.example.com"

    r = await client.post("/selfhost/anzeigename", json=_melde_name("Michaels Server"))
    assert r.status_code == 204

    eintrag = await _eintrag_vps(client, aufbau_vps["mitglied"]["cookie"])
    assert eintrag["anzeigename"] == "Michaels Server"
    assert eintrag["role"] == "member"
    assert (await _eintrag_vps(client, aufbau_vps["owner"]["cookie"]))["anzeigename"] == "Michaels Server"
    # Und jedes Mitglied wird live benachrichtigt, nicht nur der Betreiber.
    assert sammler.an() == sorted([aufbau_vps["owner"]["id"], aufbau_vps["mitglied"]["id"]])


async def test_umbenennen_behauptet_bei_einem_vps_nicht_er_sei_offline(client, aufbau_vps, sammler):
    """Ein per Gerätecode verbundener Server meldet sich nie beim Telefonbuch —
    sein ``online_gemeldet`` steht dauerhaft auf ``false``, ohne etwas
    auszusagen. Das Ereignis trug dieses ``false`` trotzdem als ``online``; die
    Oberfläche las es als „Server gestoppt" und warf jeden, der gerade auf
    diesem Server war (auch den Umbenennenden), auf die Cloud zurück. Gesagt
    wird nur, was gemessen wurde: ``/me/instances`` meldet für denselben Server
    ``null``, das Ereignis muss dasselbe tun."""
    await client.post("/selfhost/anzeigename", json=_melde_name("Michaels Server"))
    assert sammler.nachrichten, "es wurde nichts gemeldet"
    for _, n in sammler.nachrichten:
        assert n["op"] == "instance_status"
        assert n["data"]["online"] is None
        assert n["data"]["anzeigename"] == "Michaels Server"
    assert (await _eintrag_vps(client, aufbau_vps["owner"]["cookie"]))["online"] is None


async def test_cloud_bereinigt_den_namen_wie_der_server(client, aufbau_vps, sammler):
    """Server und Cloud nutzen dieselbe Funktion (``dcc_shared.anzeigename``):
    Steuerzeichen fallen weg, ein zusammengesetztes Emoji bleibt heil."""
    familie = "\U0001f468\u200d\U0001f469\u200d\U0001f467"
    await client.post("/selfhost/anzeigename", json=_melde_name(f"  Clan\u0007 {familie} "))
    eintrag = await _eintrag_vps(client, aufbau_vps["mitglied"]["cookie"])
    assert eintrag["anzeigename"] == f"Clan {familie}"


async def test_cloud_liefert_keine_umkehrende_oder_unsichtbare_schrift_aus(
    client, aufbau_vps, sammler
):
    """Ein RLO kehrt Text um, und ein Name nur aus Formatzeichen wirkt leer —
    beides ginge sonst an alle Mitglieder. Der zweite gilt als „kein Name“."""
    await client.post("/selfhost/anzeigename", json=_melde_name("Admin\u202etxt"))
    eintrag = await _eintrag_vps(client, aufbau_vps["mitglied"]["cookie"])
    assert eintrag["anzeigename"] == "Admintxt"

    sammler.nachrichten.clear()
    await client.post("/selfhost/anzeigename", json=_melde_name("\u202e\u200b\u2066\u00ad"))
    assert (await _eintrag_vps(client, aufbau_vps["mitglied"]["cookie"]))["anzeigename"] is None
    assert {n["data"]["anzeigename"] for _, n in sammler.nachrichten} == {None}


async def test_anzeigename_zuruecksetzen_meldet_leeren_namen(client, aufbau_vps, sammler):
    await client.post("/selfhost/anzeigename", json=_melde_name("Michaels Server"))
    sammler.nachrichten.clear()
    assert (await client.post("/selfhost/anzeigename", json=_melde_name(""))).status_code == 204
    assert {n["data"]["anzeigename"] for _, n in sammler.nachrichten} == {None}
    assert (await _eintrag_vps(client, aufbau_vps["mitglied"]["cookie"]))["anzeigename"] is None


async def test_vps_anzeigename_nur_mit_richtigem_secret(client, aufbau_vps, sammler):
    r = await client.post("/selfhost/anzeigename", json=_melde_name("Gekapert", token="falsch"))
    assert r.status_code == 401
    r = await client.post("/selfhost/anzeigename", json=_melde_name("Gekapert", client_id="ci_fremd"))
    assert r.status_code == 401
    assert sammler.nachrichten == []
    assert (await _eintrag_vps(client, aufbau_vps["mitglied"]["cookie"]))["anzeigename"] is None


async def test_gestoppter_heimserver_meldet_weiter_online_false(client, aufbau, sammler):
    """Gegenprobe: ein Heim-Server MELDET sich beim Telefonbuch, dort bleibt
    ``false`` eine echte Aussage."""
    await client.post("/selfhost/directory/heartbeat", json=_hb(aufbau["token"]))
    sammler.nachrichten.clear()
    await client.post("/selfhost/directory/offline",
                      json={"instance_id": str(_INSTANCE_ID), "token": aufbau["token"]})
    assert {n["data"]["online"] for _, n in sammler.nachrichten} == {False}
