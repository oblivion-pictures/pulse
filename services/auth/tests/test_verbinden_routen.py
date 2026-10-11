"""Verbinden per Gerätecode — die vier Routen im Zusammenspiel.

Server fragt an (``start``), Betreiber sieht und bestätigt im Browser
(``vorgang``/``entscheidung``, der Code im Körper), Server holt ab
(``abholen``). Die Prüfung von aussen (``nachweis_pruefen``) ist hier
ersetzt; sie hat eigene Tests in ``test_verbinden_nachweis.py``.
"""

from __future__ import annotations

import hashlib
import re
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from dcc_auth import routes_verbinden
from dcc_auth.models import User
from dcc_auth.models_instances import RegisteredInstance, UserInstanceMembership
from dcc_auth.security import verify_password

_KENNUNG = "abholkennung-fuer-den-test-mit-genug-zeichen-0123"
_NACHWEIS = hashlib.sha256(_KENNUNG.encode()).hexdigest()
_HOST = "mein.example.org"


@pytest.fixture
async def mit_redis(app, redis_echt):
    app.state.redis = redis_echt
    yield redis_echt
    app.state.redis = None


@pytest.fixture
def nachweis(monkeypatch):
    """Ersetzt die Prüfung von aussen. ``befund`` = ``None`` heisst bestanden."""
    stand = SimpleNamespace(befund=None, aufrufe=[])

    async def gefaelscht(hostname: str, erwartet: str) -> str | None:
        stand.aufrufe.append((hostname, erwartet))
        return stand.befund

    monkeypatch.setattr(routes_verbinden, "nachweis_pruefen", gefaelscht)
    return stand


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
    return {"cookie": cookie, "id": int(me.json()["id"])}


async def _start(client, hostname: str = _HOST, kennung: str = _KENNUNG):
    return await client.post(
        "/selfhost/verbinden/start", json={"hostname": hostname, "kennung": kennung}
    )


async def _abholen(client, kennung: str = _KENNUNG):
    return await client.post("/selfhost/verbinden/abholen", json={"kennung": kennung})


async def _ansehen(client, konto: dict, code: str):
    return await client.post(
        "/me/selfhost/verbinden/vorgang", json={"code": code}, headers={"Cookie": konto["cookie"]}
    )


async def _entscheiden(client, konto: dict, code: str, aktion: str):
    return await client.post(
        "/me/selfhost/verbinden/entscheidung",
        json={"code": code, "aktion": aktion},
        headers={"Cookie": konto["cookie"]},
    )


def test_code_steht_in_keinem_pfad():
    """Pfade landen in Zugriffsprotokollen (``web-nginx.conf`` loggt ``$uri``);
    wer dort einen offenen Code liest, könnte ihn mit seinem Konto bestätigen."""
    pfade = [route.path for route in routes_verbinden.router.routes]
    assert len(pfade) == 4
    assert all("{" not in pfad for pfad in pfade)


async def test_durchlauf(client, session_factory, mit_redis, nachweis):
    michael = await _konto(client, "michael")

    r = await _start(client, hostname="https://Mein.Example.org:443/")
    assert r.status_code == 201, r.text
    start = r.json()
    assert re.fullmatch(r"[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}", start["code"])
    assert start["link"].endswith(f"/verbinden#{start['code']}")
    assert (start["gueltig_s"], start["abstand_s"]) == (900, 5)
    # Die Cloud prüft den Hash der Kennung, nie die Kennung selbst.
    assert nachweis.aufrufe == [(_HOST, _NACHWEIS)]

    r = await _ansehen(client, michael, start["code"])
    assert r.status_code == 200, r.text
    assert r.json()["hostname"] == _HOST
    assert r.json()["gueltig_bis"]

    r = await _entscheiden(client, michael, start["code"], "verbinden")
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "verbunden"
    assert r.json()["hostname"] == _HOST
    iid = r.json()["instance_id"]
    # Vor dem Bestätigen erneut von aussen geprüft.
    assert len(nachweis.aufrufe) == 2

    r = await _abholen(client)
    assert r.status_code == 200, r.text
    zugang = r.json()
    assert zugang["instance_id"] == iid
    assert zugang["owner_user_id"] == str(michael["id"])
    assert zugang["owner_name"] == "Michael"
    assert zugang["hostname"] == _HOST
    assert zugang["admin_email"] == "michael@dcc-test.example.com"
    assert zugang["cloud_origin"].startswith("https://")
    assert "relay_subdomain" not in zugang

    async with session_factory() as s:
        inst = await s.get(RegisteredInstance, int(iid))
        mitglied = await s.get(UserInstanceMembership, (michael["id"], int(iid)))
    assert inst.client_id == zugang["client_id"]
    assert verify_password(zugang["client_secret"], inst.client_secret)
    assert inst.verbunden_at is not None
    assert inst.ohne_freigabe is True
    assert mitglied.role == "owner"

    # Genau einmal: danach gibt es nichts mehr abzuholen.
    assert (await _abholen(client)).status_code == 410

    # Der Server steht im Konto, eingerichtet — also in der Leiste aller Geräte.
    r = await client.get("/me/instances", headers={"Cookie": michael["cookie"]})
    (eintrag,) = [i for i in r.json() if i["id"] == iid]
    assert eintrag["set_up"] is True and eintrag["role"] == "owner"


async def test_abholen_vor_der_entscheidung_wartet(client, mit_redis, nachweis):
    assert (await _start(client)).status_code == 201
    r = await _abholen(client)
    assert r.status_code == 202
    assert r.json() == {"status": "wartet"}


async def test_fremde_kennung_holt_nichts(client, mit_redis, nachweis):
    """Wer den Code gesehen hat, kennt die Kennung nicht."""
    assert (await _start(client)).status_code == 201
    assert (await _abholen(client, kennung="x" * 43)).status_code == 410


async def test_ablehnen(client, session_factory, mit_redis, nachweis):
    konto = await _konto(client, "ablehner")
    code = (await _start(client)).json()["code"]

    r = await _entscheiden(client, konto, code, "ablehnen")
    assert r.status_code == 200, r.text
    assert r.json() == {"status": "abgelehnt"}

    r = await _abholen(client)
    assert r.status_code == 403
    assert r.json()["detail"] == "abgelehnt"
    assert (await _abholen(client)).status_code == 410
    async with session_factory() as s:
        treffer = (
            await s.execute(select(RegisteredInstance).where(RegisteredInstance.hostname == _HOST))
        ).first()
    assert treffer is None


async def test_entschiedener_code_ist_unbekannt(client, mit_redis, nachweis):
    konto = await _konto(client, "doppelt")
    code = (await _start(client)).json()["code"]
    assert (await _entscheiden(client, konto, code, "verbinden")).status_code == 200
    r = await _entscheiden(client, konto, code, "verbinden")
    assert r.status_code == 404
    assert r.json()["detail"] == "unbekannt"
    # Auch die Bestätigungsseite zeigt einen entschiedenen Code nicht mehr.
    assert (await _ansehen(client, konto, code)).status_code == 404


async def test_abgelaufen(client, mit_redis, nachweis):
    konto = await _konto(client, "spaet")
    code = (await _start(client)).json()["code"]
    # Was Redis nach 15 Minuten von selbst tut.
    async for schluessel in mit_redis.scan_iter(match="auth:verbinden:*"):
        await mit_redis.delete(schluessel)

    r = await _ansehen(client, konto, code)
    assert r.status_code == 404
    assert r.json()["detail"] == "unbekannt"
    assert (await _entscheiden(client, konto, code, "verbinden")).status_code == 404
    r = await _abholen(client)
    assert r.status_code == 410
    assert r.json()["detail"] == "abgelaufen"


async def test_code_in_jeder_schreibweise(client, mit_redis, nachweis):
    konto = await _konto(client, "tipper")
    code = (await _start(client)).json()["code"]
    getippt = code.replace("-", "").lower()
    r = await _ansehen(client, konto, getippt)
    assert r.status_code == 200, r.text


async def test_ohne_anmeldung(client, mit_redis, nachweis):
    code = (await _start(client)).json()["code"]
    r = await client.post("/me/selfhost/verbinden/vorgang", json={"code": code})
    assert r.status_code == 401
    r = await client.post(
        "/me/selfhost/verbinden/entscheidung", json={"code": code, "aktion": "verbinden"}
    )
    assert r.status_code == 401


async def test_gesperrtes_konto_darf_nicht_verbinden(
    client, session_factory, mit_redis, nachweis
):
    konto = await _konto(client, "gesperrt")
    async with session_factory() as s:
        (await s.get(User, konto["id"])).server_verbinden_gesperrt = True
        await s.commit()
    code = (await _start(client)).json()["code"]

    r = await _entscheiden(client, konto, code, "verbinden")
    assert r.status_code == 403
    assert r.json()["detail"] == "verbinden_gesperrt"
    # Ablehnen bleibt möglich, damit der Server nicht 15 Minuten wartet.
    assert (await _entscheiden(client, konto, code, "ablehnen")).status_code == 200


async def test_elfter_server(client, session_factory, mit_redis, nachweis):
    konto = await _konto(client, "sammler")
    async with session_factory() as s:
        for i in range(10):
            s.add(
                RegisteredInstance(
                    id=960000 + i,
                    hostname=f"vorhanden{i}.example.org",
                    client_id=f"vr-{i}",
                    client_secret="$argon2id$v=19$m=65536,t=3,p=4$x",
                    status="active",
                    origin="vps",
                    registered_by=konto["id"],
                )
            )
        await s.commit()
    code = (await _start(client)).json()["code"]
    r = await _entscheiden(client, konto, code, "verbinden")
    assert r.status_code == 409
    assert r.json()["detail"] == "zu_viele_server"


async def test_nachweis_fehlt_beim_start(client, mit_redis, nachweis):
    nachweis.befund = "kein_nachweis"
    r = await _start(client)
    assert r.status_code == 409
    assert r.json()["detail"] == {"code": "nachweis_fehlt", "befund": "kein_nachweis"}
    # Kein Code verbraucht, kein Vorgang angelegt.
    assert [k async for k in mit_redis.scan_iter(match="auth:verbinden:*")] == []


async def test_nachweis_fehlt_beim_bestaetigen(client, session_factory, mit_redis, nachweis):
    """Zwischen Anfrage und Klick kann der Server verschwunden sein — dann
    entsteht kein Eintrag, und der Code bleibt offen."""
    konto = await _konto(client, "vorsicht")
    code = (await _start(client)).json()["code"]
    nachweis.befund = "falscher_wert"

    r = await _entscheiden(client, konto, code, "verbinden")
    assert r.status_code == 409
    assert r.json()["detail"]["befund"] == "falscher_wert"
    async with session_factory() as s:
        treffer = (
            await s.execute(select(RegisteredInstance).where(RegisteredInstance.hostname == _HOST))
        ).first()
    assert treffer is None
    assert (await _abholen(client)).status_code == 202


@pytest.mark.parametrize(
    ("hostname", "detail"),
    [
        ("localhost", "adresse_ungueltig"),
        ("203.0.113.7", "adresse_ungueltig"),
        ("frech.howispulse.com", "adresse_gesperrt"),
        ("app-1.relay.howispulse.com", "adresse_gesperrt"),
    ],
)
async def test_unbrauchbare_adressen(client, mit_redis, nachweis, hostname, detail):
    r = await _start(client, hostname=hostname)
    assert r.status_code == 400
    assert r.json()["detail"] == detail
    assert nachweis.aufrufe == []


async def test_uebernahme_einer_fremden_adresse(client, session_factory, mit_redis, nachweis):
    alt = await _konto(client, "altbesitzer")
    neu = await _konto(client, "neubesitzer")
    async with session_factory() as s:
        s.add(
            RegisteredInstance(
                id=961000,
                hostname=_HOST,
                client_id="alt-client",
                client_secret="$argon2id$v=19$m=65536,t=3,p=4$x",
                status="active",
                origin="vps",
                registered_by=alt["id"],
            )
        )
        await s.commit()

    code = (await _start(client)).json()["code"]
    r = await _entscheiden(client, neu, code, "verbinden")
    assert r.status_code == 200, r.text
    assert r.json()["instance_id"] != "961000"
    async with session_factory() as s:
        assert (await s.get(RegisteredInstance, 961000)).status == "deleted"


async def test_zweiter_start_derselben_kennung_liefert_denselben_code(
    client, mit_redis, nachweis
):
    erster = (await _start(client)).json()["code"]
    zweiter = await _start(client)
    assert zweiter.status_code == 201
    assert zweiter.json()["code"] == erster
    anderer_host = await _start(client, hostname="anders.example.org")
    assert anderer_host.status_code == 409
    assert anderer_host.json()["detail"] == "vorgang_laeuft"


async def test_ohne_redis_kein_verbinden(client, nachweis):
    r = await _start(client)
    assert r.status_code == 503
    assert r.json()["detail"] == "verbinden_nicht_verfuegbar"


async def test_nur_in_der_cloud(client, mit_redis, nachweis, monkeypatch):
    import dcc_auth.routes_admin_instances as rai

    monkeypatch.setattr(
        rai, "get_settings", lambda: SimpleNamespace(pulse_instance_mode="self-host")
    )
    assert (await _start(client)).status_code == 403


async def test_bremse_beim_start(client, mit_redis, nachweis):
    codes = [(await _start(client, kennung=f"{i:02d}" + "k" * 41)).status_code for i in range(11)]
    assert codes[:10] == [201] * 10
    assert codes[10] == 429


async def test_bremse_je_konto(client, mit_redis, nachweis):
    konto = await _konto(client, "neugierig")
    code = (await _start(client)).json()["code"]
    codes = [(await _ansehen(client, konto, code)).status_code for _ in range(21)]
    assert codes[:20] == [200] * 20
    assert codes[20] == 429
