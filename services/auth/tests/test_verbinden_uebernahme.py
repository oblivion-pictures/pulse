"""Widerspruchsfrist, bevor ein fremdes Konto eine eingetragene Adresse übernimmt.

Entwurf 2026-10-09, E2 (Nachtrag 2026-10-11): Bestätigt ein fremdes Konto eine
Adresse, die schon für jemanden eingetragen ist, entsteht nur ein Antrag. Erst
nach 72 Stunden und einem zweiten Nachweis wechselt der Eintrag; der bisherige
Besitzer kann bis dahin widersprechen, solange unter der Adresse noch sein
Server antwortet.

Die Uhr stellen die Tests über ``verbinden_uebernahme._jetzt`` vor, statt zu
schlafen. Ersetzt sind die beiden Abrufe von aussen: ``nachweis_pruefen``
(eigene Tests in ``test_verbinden_nachweis.py``) und ``server_info_instanz``.
"""

from __future__ import annotations

import itertools
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import httpx
import pytest
import pytest_asyncio
from sqlalchemy import delete, event, select
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_auth import email_verbinden, routes_uebernahme, routes_verbinden, verbinden_uebernahme
from dcc_auth import verbinden_nachweis as vn
from dcc_auth.models import User
from dcc_auth.models_instances import (
    InstanzUebernahme,
    RegisteredInstance,
    SuspendedInstance,
    UserInstanceMembership,
)
from dcc_auth.selfhost_probe import Schritt
from dcc_auth.verbinden_uebernahme import _utc

_HOST = "mein.example.org"
_ALT = 970000
_T0 = datetime(2026, 10, 11, 12, 0, tzinfo=UTC)
_FRIST = timedelta(hours=72)
_VERFALL = timedelta(days=7)
_SPERRE = timedelta(days=30)
_ANTRAG = "Pulse: Jemand möchte deinen Server übernehmen"
_VOLLZUG = "Pulse: Dein Server wurde mit einem anderen Konto verbunden"
_HINWEIS = "Pulse: Ein Server wurde mit deinem Konto verbunden"
_KENNUNGEN = itertools.count()


@pytest.fixture
async def mit_redis(app, redis_echt):
    app.state.redis = redis_echt
    yield redis_echt
    app.state.redis = None


@pytest.fixture
def nachweis(monkeypatch):
    """Jede Prüfung von aussen besteht."""

    async def bestanden(hostname: str, erwartet: str) -> str | None:
        return None

    monkeypatch.setattr(routes_verbinden, "nachweis_pruefen", bestanden)


@pytest.fixture
def uhr(monkeypatch):
    stand = SimpleNamespace(jetzt=_T0)

    def vor(**delta) -> None:
        stand.jetzt += timedelta(**delta)

    stand.vor = vor
    monkeypatch.setattr(verbinden_uebernahme, "_jetzt", lambda: stand.jetzt)
    return stand


@pytest.fixture
def post(monkeypatch):
    stand = SimpleNamespace(gesendet=[])

    async def mitschreiben(to, subject, body_plain, session=None):
        stand.gesendet.append((to, subject, body_plain))

    monkeypatch.setattr(email_verbinden, "send_email", mitschreiben)
    stand.betreffe_an = lambda konto: [b for an, b, _ in stand.gesendet if an == konto["email"]]
    return stand


@pytest.fixture
def server_info(monkeypatch):
    """Was unter der Adresse als ``instance_id`` antwortet."""
    stand = SimpleNamespace(antwort=None, aufrufe=[])

    async def gefaelscht(hostname: str) -> str | None:
        stand.aufrufe.append(hostname)
        return stand.antwort

    monkeypatch.setattr(routes_uebernahme, "server_info_instanz", gefaelscht)
    return stand


@pytest_asyncio.fixture
async def fremdschluessel(engine):
    """SQLite wertet ``ON DELETE SET NULL`` nur mit ``PRAGMA foreign_keys`` aus
    (Muster ``test_account_delete.py``). Ohne das blieben die Tests zum
    gelöschten Antragsteller grün, auch wenn der Antrag mit dem Konto
    verschwände und die 30-Tage-Sperre mitnähme."""
    from dcc_auth.db import Base

    def _pragma(dbapi_conn, _record):
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA foreign_keys = ON")
        cur.close()

    event.listen(engine.sync_engine, "connect", _pragma)
    await engine.dispose()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await conn.exec_driver_sql("INSERT INTO auth_settings (id) VALUES (1)")
        await conn.exec_driver_sql("INSERT INTO smtp_settings (id) VALUES (1)")
    yield
    event.remove(engine.sync_engine, "connect", _pragma)


async def _konto(client, name: str) -> dict:
    reg = {
        "username": name,
        "email": f"{name}@dcc-test.example.com",
        "password": "correct horse battery staple",
        "display_name": name.capitalize(),
    }
    r = await client.post("/register", json=reg)
    assert r.status_code == 201, r.text
    r = await client.post(
        "/login", json={"email_or_username": reg["email"], "password": reg["password"]}
    )
    cookie = f"pulse_session={r.cookies.get('pulse_session')}"
    me = await client.get("/me", headers={"Cookie": cookie})
    return {"cookie": cookie, "id": int(me.json()["id"]), "email": reg["email"]}


async def _start(client, hostname: str = _HOST) -> tuple[str, str]:
    """Ein neuer Lauf von ``pulse-connect``: neue Kennung, neuer Code."""
    kennung = f"kennung-{next(_KENNUNGEN):06d}-" + "k" * 32
    r = await client.post(
        "/selfhost/verbinden/start", json={"hostname": hostname, "kennung": kennung}
    )
    assert r.status_code == 201, r.text
    return kennung, r.json()["code"]


async def _entscheiden(client, konto: dict, code: str, aktion: str = "verbinden"):
    return await client.post(
        "/me/selfhost/verbinden/entscheidung",
        json={"code": code, "aktion": aktion},
        headers={"Cookie": konto["cookie"]},
    )


async def _bestaetigen(client, konto: dict, hostname: str = _HOST) -> SimpleNamespace:
    kennung, code = await _start(client, hostname)
    antwort = await _entscheiden(client, konto, code)
    return SimpleNamespace(antwort=antwort, kennung=kennung, code=code)


async def _abholen(client, kennung: str):
    return await client.post("/selfhost/verbinden/abholen", json={"kennung": kennung})


async def _ansehen(client, konto: dict, code: str):
    return await client.post(
        "/me/selfhost/verbinden/vorgang", json={"code": code}, headers={"Cookie": konto["cookie"]}
    )


async def _widersprechen(client, konto: dict, iid: int | str = _ALT):
    return await client.post(
        f"/me/instances/{iid}/uebernahme/widerspruch", headers={"Cookie": konto["cookie"]}
    )


async def _meine_server(client, konto: dict) -> dict[str, dict]:
    r = await client.get("/me/instances", headers={"Cookie": konto["cookie"]})
    assert r.status_code == 200, r.text
    return {i["id"]: i for i in r.json()}


async def _eintrag(
    session_factory, besitzer: dict | None, iid: int = _ALT, hostname: str = _HOST
) -> None:
    """Ein verbundener, eingerichteter Server samt Besitzer-Mitgliedschaft."""
    async with session_factory() as s:
        s.add(
            RegisteredInstance(
                id=iid,
                hostname=hostname,
                client_id=f"vorhanden-{iid}",
                client_secret="$argon2id$v=19$m=65536,t=3,p=4$x",
                status="active",
                origin="vps",
                registered_by=besitzer["id"] if besitzer else None,
                ohne_freigabe=True,
                verbunden_at=datetime.now(UTC),
            )
        )
        if besitzer:
            s.add(UserInstanceMembership(user_id=besitzer["id"], instance_id=iid, role="owner"))
        await s.commit()


async def _instanz(session_factory, iid: int = _ALT) -> RegisteredInstance:
    async with session_factory() as s:
        return await s.get(RegisteredInstance, iid)


async def _antraege(session_factory) -> list[InstanzUebernahme]:
    async with session_factory() as s:
        return list(
            (
                await s.execute(
                    select(InstanzUebernahme).order_by(
                        InstanzUebernahme.beantragt_at, InstanzUebernahme.id
                    )
                )
            ).scalars()
        )


async def _konto_loeschen(session_factory, konto: dict) -> None:
    """Was ``DELETE /me`` an der Datenbank tut (der Antragsteller besitzt
    keinen Server, also bleibt nur die Nutzerzeile)."""
    async with session_factory() as s:
        await s.execute(delete(User).where(User.id == konto["id"]))
        await s.commit()


def _offen(antrag: InstanzUebernahme) -> bool:
    return (antrag.widersprochen_at, antrag.vollzogen_at, antrag.verfallen_at) == (None,) * 3


async def test_fremde_adresse_beantragt_statt_zu_uebernehmen(
    client, session_factory, mit_redis, nachweis, uhr, post
):
    a = await _konto(client, "altbesitz")
    b = await _konto(client, "antrag")
    await _eintrag(session_factory, a)

    lauf = await _bestaetigen(client, b)
    assert lauf.antwort.status_code == 200, lauf.antwort.text
    frist = (_T0 + _FRIST).isoformat()
    assert lauf.antwort.json() == {
        "status": "uebernahme_beantragt",
        "hostname": _HOST,
        "frist_bis": frist,
    }

    alt = await _instanz(session_factory)
    assert (alt.status, alt.hostname, alt.registered_by) == ("active", _HOST, a["id"])
    async with session_factory() as s:
        assert await s.get(SuspendedInstance, _ALT) is None
        assert await s.get(UserInstanceMembership, (a["id"], _ALT)) is not None
    (antrag,) = await _antraege(session_factory)
    assert (antrag.alte_instanz_id, antrag.neues_konto_id, antrag.hostname) == (
        _ALT,
        b["id"],
        _HOST,
    )
    assert _offen(antrag)

    r = await _abholen(client, lauf.kennung)
    assert r.status_code == 409, r.text
    assert r.json()["detail"] == {"code": "uebernahme_beantragt", "frist_bis": frist}
    assert (await _abholen(client, lauf.kennung)).status_code == 410


async def test_vor_fristende_bleibt_es_beim_antrag(
    client, session_factory, mit_redis, nachweis, uhr, post
):
    a = await _konto(client, "geduldalt")
    b = await _konto(client, "geduldneu")
    await _eintrag(session_factory, a)
    erster = (await _bestaetigen(client, b)).antwort.json()["frist_bis"]

    uhr.vor(hours=71)
    lauf = await _bestaetigen(client, b)
    assert lauf.antwort.status_code == 200, lauf.antwort.text
    assert lauf.antwort.json()["status"] == "uebernahme_beantragt"
    assert lauf.antwort.json()["frist_bis"] == erster
    assert len(await _antraege(session_factory)) == 1
    assert post.betreffe_an(a) == [_ANTRAG]
    assert (await _abholen(client, lauf.kennung)).json()["detail"]["frist_bis"] == erster


async def test_nach_fristende_wird_vollzogen(
    client, session_factory, mit_redis, nachweis, uhr, post
):
    a = await _konto(client, "abgeber")
    b = await _konto(client, "uebernehmer")
    await _eintrag(session_factory, a)
    await _bestaetigen(client, b)

    uhr.vor(hours=72)
    lauf = await _bestaetigen(client, b)
    assert lauf.antwort.status_code == 200, lauf.antwort.text
    assert lauf.antwort.json()["status"] == "verbunden"
    neu = lauf.antwort.json()["instance_id"]
    assert neu != str(_ALT)

    assert (await _instanz(session_factory)).status == "deleted"
    async with session_factory() as s:
        assert await s.get(SuspendedInstance, _ALT) is not None
        assert await s.get(UserInstanceMembership, (a["id"], _ALT)) is None
    (antrag,) = await _antraege(session_factory)
    assert _utc(antrag.vollzogen_at) == _T0 + _FRIST
    assert (antrag.widersprochen_at, antrag.verfallen_at) == (None, None)
    assert post.betreffe_an(a) == [_ANTRAG, _VOLLZUG]
    assert post.betreffe_an(b) == [_HINWEIS]

    r = await _abholen(client, lauf.kennung)
    assert r.status_code == 200, r.text
    assert (r.json()["instance_id"], r.json()["owner_user_id"]) == (neu, str(b["id"]))


async def test_widerspruch_sperrt_dreissig_tage(
    client, session_factory, mit_redis, nachweis, uhr, post, server_info
):
    a = await _konto(client, "wachsam")
    b = await _konto(client, "draengler")
    c = await _konto(client, "dritter")
    await _eintrag(session_factory, a)
    await _bestaetigen(client, b)

    uhr.vor(hours=1)
    server_info.antwort = str(_ALT)
    r = await _widersprechen(client, a)
    assert r.status_code == 204, r.text
    assert server_info.aufrufe == [_HOST]
    widerspruch = _T0 + timedelta(hours=1)
    (antrag,) = await _antraege(session_factory)
    assert _utc(antrag.widersprochen_at) == widerspruch
    bis = (widerspruch + _SPERRE).isoformat()

    uhr.jetzt = _T0 + _FRIST
    lauf = await _bestaetigen(client, b)
    assert lauf.antwort.status_code == 409, lauf.antwort.text
    assert lauf.antwort.json()["detail"] == {"code": "uebernahme_gesperrt", "bis": bis}
    r = await _abholen(client, lauf.kennung)
    assert r.status_code == 403, r.text
    assert r.json()["detail"] == {"code": "uebernahme_gesperrt", "bis": bis}
    assert (await _abholen(client, lauf.kennung)).status_code == 410

    lauf = await _bestaetigen(client, c)
    assert lauf.antwort.status_code == 409, lauf.antwort.text
    assert lauf.antwort.json()["detail"] == {"code": "uebernahme_gesperrt", "bis": bis}
    assert (await _instanz(session_factory)).status == "active"
    assert len(await _antraege(session_factory)) == 1

    uhr.jetzt = widerspruch + _SPERRE
    lauf = await _bestaetigen(client, b)
    assert lauf.antwort.status_code == 200, lauf.antwort.text
    assert lauf.antwort.json()["status"] == "uebernahme_beantragt"
    assert lauf.antwort.json()["frist_bis"] == (widerspruch + _SPERRE + _FRIST).isoformat()
    assert len(await _antraege(session_factory)) == 2


@pytest.mark.parametrize("unter_der_adresse", ["andere_nummer", "null", "nicht_erreichbar"])
async def test_widerspruch_ohne_eigenen_server(
    client, session_factory, mit_redis, nachweis, uhr, post, monkeypatch, unter_der_adresse
):
    a = await _konto(client, "umgezogen")
    b = await _konto(client, "neuerort")
    await _eintrag(session_factory, a)
    frist = (await _bestaetigen(client, b)).antwort.json()["frist_bis"]

    if unter_der_adresse == "nicht_erreichbar":
        # Der echte Abruf, nur antwortet unter der Adresse niemand.
        async def dns(_host):
            return Schritt("dns", True, "aufgeloest", adressen=["203.0.113.7"])

        def verweigert(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("Connection refused", request=request)

        monkeypatch.setattr(vn, "pruefe_dns", dns)
        monkeypatch.setattr(
            vn, "_klient", lambda: httpx.AsyncClient(transport=httpx.MockTransport(verweigert))
        )
    else:
        gemeldet = "4711" if unter_der_adresse == "andere_nummer" else None

        async def meldet(_hostname: str) -> str | None:
            return gemeldet

        monkeypatch.setattr(routes_uebernahme, "server_info_instanz", meldet)

    uhr.vor(hours=2)
    r = await _widersprechen(client, a)
    assert r.status_code == 409, r.text
    assert r.json()["detail"] == {"code": "widerspruch_ohne_server"}
    (antrag,) = await _antraege(session_factory)
    assert _offen(antrag)
    assert (await _meine_server(client, a))[str(_ALT)]["uebernahme_frist_bis"] == frist


async def test_widerspruch_nach_fristende_solange_nicht_vollzogen(
    client, session_factory, mit_redis, nachweis, uhr, post, server_info
):
    a = await _konto(client, "spaetwach")
    b = await _konto(client, "zoegerer")
    await _eintrag(session_factory, a)
    await _bestaetigen(client, b)

    uhr.vor(hours=80)
    server_info.antwort = str(_ALT)
    assert (await _widersprechen(client, a)).status_code == 204

    lauf = await _bestaetigen(client, b)
    assert lauf.antwort.status_code == 409, lauf.antwort.text
    assert lauf.antwort.json()["detail"] == {
        "code": "uebernahme_gesperrt",
        "bis": (_T0 + timedelta(hours=80) + _SPERRE).isoformat(),
    }
    assert (await _instanz(session_factory)).status == "active"


async def test_zweites_fremdes_konto_wartet(
    client, session_factory, mit_redis, nachweis, uhr, post
):
    a = await _konto(client, "begehrt")
    b = await _konto(client, "erster")
    c = await _konto(client, "zweiter")
    await _eintrag(session_factory, a)
    await _bestaetigen(client, b)

    uhr.vor(hours=5)
    lauf = await _bestaetigen(client, c)
    assert lauf.antwort.status_code == 409, lauf.antwort.text
    assert lauf.antwort.json()["detail"] == {
        "code": "uebernahme_gesperrt",
        "bis": (_T0 + _FRIST + _VERFALL).isoformat(),
    }
    (antrag,) = await _antraege(session_factory)
    assert antrag.neues_konto_id == b["id"]
    assert post.betreffe_an(a) == [_ANTRAG]


@pytest.mark.parametrize("wer", ["antragsteller", "anderes_konto"])
async def test_verfallener_antrag_blockiert_niemanden(
    client, session_factory, mit_redis, nachweis, uhr, post, wer
):
    a = await _konto(client, "vergessen")
    b = await _konto(client, "saeumig")
    c = await _konto(client, "naechster")
    await _eintrag(session_factory, a)
    await _bestaetigen(client, b)

    uhr.jetzt = _T0 + _FRIST + _VERFALL + timedelta(seconds=1)
    assert (await _meine_server(client, a))[str(_ALT)]["uebernahme_frist_bis"] is None

    konto = b if wer == "antragsteller" else c
    lauf = await _bestaetigen(client, konto)
    assert lauf.antwort.status_code == 200, lauf.antwort.text
    assert lauf.antwort.json()["status"] == "uebernahme_beantragt"
    assert lauf.antwort.json()["frist_bis"] == (uhr.jetzt + _FRIST).isoformat()
    alt, neu = await _antraege(session_factory)
    assert _utc(alt.verfallen_at) == uhr.jetzt
    assert (alt.widersprochen_at, alt.vollzogen_at) == (None, None)
    assert neu.neues_konto_id == konto["id"] and _offen(neu)
    assert post.betreffe_an(a) == [_ANTRAG, _ANTRAG]


async def test_loeschen_macht_die_adresse_sofort_frei(
    client, session_factory, mit_redis, nachweis, uhr, post
):
    a = await _konto(client, "verkaeufer")
    b = await _konto(client, "kaeufer")
    await _eintrag(session_factory, a)
    await _bestaetigen(client, b)

    uhr.vor(hours=1)
    r = await client.delete(f"/me/instances/{_ALT}", headers={"Cookie": a["cookie"]})
    assert r.status_code == 204, r.text

    lauf = await _bestaetigen(client, b)
    assert lauf.antwort.status_code == 200, lauf.antwort.text
    assert lauf.antwort.json()["status"] == "verbunden"
    r = await _abholen(client, lauf.kennung)
    assert r.status_code == 200, r.text
    assert r.json()["owner_user_id"] == str(b["id"])


async def test_eigener_eintrag_ohne_frist(
    client, session_factory, mit_redis, nachweis, uhr, post
):
    a = await _konto(client, "neuinstall")
    await _eintrag(session_factory, a)

    lauf = await _bestaetigen(client, a)
    assert lauf.antwort.status_code == 200, lauf.antwort.text
    assert lauf.antwort.json()["status"] == "verbunden"
    assert lauf.antwort.json()["instance_id"] == str(_ALT)
    assert await _antraege(session_factory) == []
    assert post.betreffe_an(a) == [_HINWEIS]


async def test_eintrag_ohne_besitzer_hat_auch_frist(
    client, session_factory, mit_redis, nachweis, uhr, post
):
    b = await _konto(client, "finder")
    await _eintrag(session_factory, None)

    lauf = await _bestaetigen(client, b)
    assert lauf.antwort.status_code == 200, lauf.antwort.text
    assert lauf.antwort.json()["status"] == "uebernahme_beantragt"
    assert post.gesendet == []

    uhr.vor(hours=72)
    lauf = await _bestaetigen(client, b)
    assert lauf.antwort.status_code == 200, lauf.antwort.text
    assert lauf.antwort.json()["status"] == "verbunden"
    assert (await _instanz(session_factory)).status == "deleted"
    assert post.betreffe_an(b) == [_HINWEIS]
    assert len(post.gesendet) == 1


async def test_alter_eintrag_gewechselt(
    client, session_factory, mit_redis, nachweis, uhr, post
):
    a = await _konto(client, "erstbesitz")
    b = await _konto(client, "beantrager")
    c = await _konto(client, "zwischenbesitz")
    await _eintrag(session_factory, a)
    await _bestaetigen(client, b)

    uhr.vor(hours=1)
    assert (
        await client.delete(f"/me/instances/{_ALT}", headers={"Cookie": a["cookie"]})
    ).status_code == 204
    lauf = await _bestaetigen(client, c)
    assert lauf.antwort.json()["status"] == "verbunden", lauf.antwort.text
    zweiter_eintrag = int(lauf.antwort.json()["instance_id"])

    uhr.jetzt = _T0 + _FRIST
    lauf = await _bestaetigen(client, b)
    assert lauf.antwort.status_code == 200, lauf.antwort.text
    assert lauf.antwort.json()["status"] == "uebernahme_beantragt"
    assert lauf.antwort.json()["frist_bis"] == (_T0 + _FRIST + _FRIST).isoformat()
    erster, zweiter = await _antraege(session_factory)
    assert erster.alte_instanz_id == _ALT and erster.vollzogen_at is None
    assert zweiter.alte_instanz_id == zweiter_eintrag and _offen(zweiter)
    eintrag = await _instanz(session_factory, zweiter_eintrag)
    assert (eintrag.status, eintrag.registered_by) == ("active", c["id"])
    assert post.betreffe_an(c) == [_HINWEIS, _ANTRAG]


async def test_alter_eintrag_waehrend_der_frist_gesperrt(
    client, session_factory, mit_redis, nachweis, uhr, post
):
    a = await _konto(client, "gesperrtalt")
    b = await _konto(client, "geduldig")
    await _eintrag(session_factory, a)
    await _bestaetigen(client, b)

    uhr.vor(hours=1)
    async with session_factory() as s:
        (await s.get(RegisteredInstance, _ALT)).status = "suspended"
        await s.commit()

    uhr.jetzt = _T0 + _FRIST
    lauf = await _bestaetigen(client, b)
    assert lauf.antwort.status_code == 403, lauf.antwort.text
    assert lauf.antwort.json()["detail"] == "instance_suspended"
    alt = await _instanz(session_factory)
    assert (alt.status, alt.registered_by) == ("suspended", a["id"])


async def test_grenze_schon_beim_antrag(
    client, session_factory, mit_redis, nachweis, uhr, post
):
    a = await _konto(client, "ruhig")
    b = await _konto(client, "sammelwut")
    await _eintrag(session_factory, a)
    for i in range(10):
        await _eintrag(session_factory, b, iid=971000 + i, hostname=f"vps{i}.example.org")

    lauf = await _bestaetigen(client, b)
    assert lauf.antwort.status_code == 409, lauf.antwort.text
    assert lauf.antwort.json()["detail"] == "zu_viele_server"
    assert await _antraege(session_factory) == []
    assert post.gesendet == []


async def test_konto_des_antragstellers_geloescht(
    client, session_factory, fremdschluessel, mit_redis, nachweis, uhr, post, server_info
):
    a = await _konto(client, "standhaft")
    b = await _konto(client, "wegwerf")
    c = await _konto(client, "nachzuegler")
    await _eintrag(session_factory, a)
    await _bestaetigen(client, b)

    uhr.vor(hours=1)
    server_info.antwort = str(_ALT)
    assert (await _widersprechen(client, a)).status_code == 204
    await _konto_loeschen(session_factory, b)
    (antrag,) = await _antraege(session_factory)
    assert antrag.neues_konto_id is None

    uhr.vor(days=10)
    lauf = await _bestaetigen(client, c)
    assert lauf.antwort.status_code == 409, lauf.antwort.text
    assert lauf.antwort.json()["detail"] == {
        "code": "uebernahme_gesperrt",
        "bis": (_T0 + timedelta(hours=1) + _SPERRE).isoformat(),
    }


async def test_gleichzeitige_bestaetigungen(
    client, session_factory, mit_redis, nachweis, uhr, post, monkeypatch
):
    """Beide lesen, bevor einer seinen Antrag schreibt; der zweite scheitert am
    Unique-Index. SQLite ignoriert ``with_for_update`` — belegt ist hier die
    Behandlung des ``IntegrityError``, nicht die Zeilensperre von Postgres."""
    a = await _konto(client, "umworben")
    b = await _konto(client, "langsamer")
    c = await _konto(client, "schneller")
    await _eintrag(session_factory, a)
    _, code_b = await _start(client)
    _, code_c = await _start(client)

    innen: dict = {}
    echt = AsyncSession.flush

    async def getaktet(self, *args, **kwargs):
        # B hat gelesen und will seinen Antrag schreiben: genau jetzt läuft C
        # ganz durch, liest also ebenfalls einen Stand ohne Antrag.
        if "c" not in innen and any(isinstance(o, InstanzUebernahme) for o in self.new):
            innen["c"] = None
            innen["c"] = await _entscheiden(client, c, code_c)
        return await echt(self, *args, **kwargs)

    monkeypatch.setattr(AsyncSession, "flush", getaktet)
    aussen = await _entscheiden(client, b, code_b)

    assert innen["c"].status_code == 200, innen["c"].text
    assert innen["c"].json()["status"] == "uebernahme_beantragt"
    assert aussen.status_code == 409, aussen.text
    assert aussen.json()["detail"] == {
        "code": "uebernahme_gesperrt",
        "bis": (_T0 + _FRIST + _VERFALL).isoformat(),
    }
    (antrag,) = await _antraege(session_factory)
    assert antrag.neues_konto_id == c["id"]
    assert post.betreffe_an(a) == [_ANTRAG]


async def test_mail_nur_beim_anlegen(client, session_factory, mit_redis, nachweis, uhr, post):
    a = await _konto(client, "postfachalt")
    b = await _konto(client, "postfachneu")
    await _eintrag(session_factory, a)

    lauf = await _bestaetigen(client, b)
    ((an, betreff, text),) = post.gesendet
    assert (an, betreff) == (a["email"], _ANTRAG)
    assert _HOST in text and "UTC" in text
    assert f"Fristende: {_T0 + _FRIST:%Y-%m-%d %H:%M} UTC" in text
    fliesstext = " ".join(text.split())
    assert "Hast du den Server nicht abgegeben? Widersprich unter Meine Server." in fliesstext
    assert (
        "Hast du ihn abgegeben, musst du nichts tun — oder lösche ihn unter Meine Server, "
        "dann geht es sofort." in fliesstext
    )
    assert lauf.code not in text and lauf.code.replace("-", "") not in text
    assert post.betreffe_an(b) == []

    uhr.vor(hours=1)
    await _bestaetigen(client, b)
    assert len(post.gesendet) == 1


async def test_widerspruch_nur_fuer_den_besitzer(
    client, session_factory, mit_redis, nachweis, uhr, post, server_info
):
    a = await _konto(client, "eigentum")
    b = await _konto(client, "fremdling")
    c = await _konto(client, "zaungast")
    await _eintrag(session_factory, a)
    # Würde abgefragt, ginge der Widerspruch durch — die 404 käme dann zu spät.
    server_info.antwort = str(_ALT)

    ohne_antrag = await _widersprechen(client, a)
    assert ohne_antrag.status_code == 404, ohne_antrag.text

    await _bestaetigen(client, b)
    for fremd in (b, c):
        r = await _widersprechen(client, fremd)
        assert r.status_code == 404, r.text
        assert r.json() == ohne_antrag.json()
    assert (await _widersprechen(client, a, iid="kein-name")).status_code == 404
    assert server_info.aufrufe == []
    (antrag,) = await _antraege(session_factory)
    assert _offen(antrag)


async def test_meine_server_zeigt_den_antrag(
    client, session_factory, mit_redis, nachweis, uhr, post
):
    a = await _konto(client, "listenalt")
    b = await _konto(client, "listenneu")
    await _eintrag(session_factory, a)
    async with session_factory() as s:
        s.add(UserInstanceMembership(user_id=b["id"], instance_id=_ALT, role="member"))
        await s.commit()
    assert (await _meine_server(client, a))[str(_ALT)]["uebernahme_frist_bis"] is None

    frist = (await _bestaetigen(client, b)).antwort.json()["frist_bis"]
    assert (await _meine_server(client, a))[str(_ALT)]["uebernahme_frist_bis"] == frist
    fuer_b = (await _meine_server(client, b))[str(_ALT)]
    assert fuer_b["role"] == "member"
    assert fuer_b["uebernahme_frist_bis"] is None


async def test_vorgang_meldet_vergebene_adresse(
    client, session_factory, mit_redis, nachweis, uhr
):
    a = await _konto(client, "inhaber")
    b = await _konto(client, "interessent")
    await _eintrag(session_factory, a)
    await _eintrag(session_factory, None, iid=_ALT + 1, hostname="verwaist.example.org")

    _, code = await _start(client)
    r = await _ansehen(client, b, code)
    assert r.status_code == 200, r.text
    # Nur die Warnung, kein Name und keine Nummer des bisherigen Besitzers.
    assert set(r.json()) == {"hostname", "gueltig_bis", "adresse_vergeben"}
    assert r.json()["adresse_vergeben"] is True
    assert (await _ansehen(client, a, code)).json()["adresse_vergeben"] is False

    _, frei = await _start(client, "frei.example.org")
    assert (await _ansehen(client, b, frei)).json()["adresse_vergeben"] is False
    _, verwaist = await _start(client, "verwaist.example.org")
    assert (await _ansehen(client, b, verwaist)).json()["adresse_vergeben"] is True


async def test_widerspruch_nur_in_der_cloud(client, session_factory, monkeypatch):
    import dcc_auth.routes_admin_instances as rai

    a = await _konto(client, "selbsthost")
    await _eintrag(session_factory, a)
    monkeypatch.setattr(
        rai, "get_settings", lambda: SimpleNamespace(pulse_instance_mode="self-host")
    )
    assert (await _widersprechen(client, a)).status_code == 403


async def test_antragsteller_geloescht_ohne_widerspruch(
    client, session_factory, fremdschluessel, mit_redis, nachweis, uhr, post
):
    a = await _konto(client, "verlassen")
    b = await _konto(client, "verschwunden")
    c = await _konto(client, "folgender")
    await _eintrag(session_factory, a)
    await _bestaetigen(client, b)

    uhr.vor(hours=1)
    await _konto_loeschen(session_factory, b)
    assert (await _meine_server(client, a))[str(_ALT)]["uebernahme_frist_bis"] is None

    lauf = await _bestaetigen(client, c)
    assert lauf.antwort.status_code == 200, lauf.antwort.text
    assert lauf.antwort.json()["status"] == "uebernahme_beantragt"
    assert lauf.antwort.json()["frist_bis"] == (uhr.jetzt + _FRIST).isoformat()
    alt, neu = await _antraege(session_factory)
    assert alt.neues_konto_id is None and _utc(alt.verfallen_at) == uhr.jetzt
    assert neu.neues_konto_id == c["id"] and _offen(neu)
