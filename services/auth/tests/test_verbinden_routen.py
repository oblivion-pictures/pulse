"""Verbinden per Gerätecode — die vier Routen im Zusammenspiel.

Server fragt an (``start``), Betreiber sieht und bestätigt im Browser
(``vorgang``/``entscheidung``, der Code im Körper), Server holt ab
(``abholen``). Die Prüfung von aussen (``nachweis_pruefen``) ist hier
ersetzt; sie hat eigene Tests in ``test_verbinden_nachweis.py``.
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from dcc_auth import email_verbinden, routes_verbinden, verbinden_uebernahme
from dcc_auth.models import User
from dcc_auth.models_instances import RegisteredInstance, SuspendedInstance, UserInstanceMembership
from dcc_auth.routes_suspended_instances import _BODY_KEY, _ETAG_KEY
from dcc_auth.security import verify_password
from dcc_auth.verbinden import (
    Vorgang,
    vorgang_entscheiden,
    vorgang_hinweis_setzen,
    vorgang_per_nachweis,
)
from dcc_auth.verbinden_antrag import endgueltig_abgelehnt
from dcc_auth.verbinden_eintrag import instanz_verbinden

_KENNUNG = "abholkennung-fuer-den-test-mit-genug-zeichen-0123"
_NACHWEIS = hashlib.sha256(_KENNUNG.encode()).hexdigest()
_HOST = "mein.example.org"
#: Zweiter Lauf von ``pulse-connect`` nach der Widerspruchsfrist — der erste
#: Vorgang ist da schon als Antrag entschieden.
_KENNUNG_NACH_DER_FRIST = "abholkennung-nach-der-widerspruchsfrist-0123456"


@pytest.fixture
async def mit_redis(app, redis_echt):
    app.state.redis = redis_echt
    yield redis_echt
    app.state.redis = None


@pytest.fixture
def uhr(monkeypatch):
    """Die Uhr der Widerspruchsfrist (``verbinden_uebernahme._jetzt``), zum Vorstellen."""
    stand = SimpleNamespace(jetzt=datetime(2026, 10, 11, 12, 0, tzinfo=UTC))

    def vor(**delta) -> None:
        stand.jetzt += timedelta(**delta)

    stand.vor = vor
    monkeypatch.setattr(verbinden_uebernahme, "_jetzt", lambda: stand.jetzt)
    return stand


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


async def _eintrag(session_factory, besitzer: int, iid: int, status: str = "active") -> None:
    """Ein schon bestehender Eintrag unter ``_HOST``."""
    async with session_factory() as s:
        s.add(
            RegisteredInstance(
                id=iid,
                hostname=_HOST,
                client_id=f"vorhanden-{iid}",
                client_secret="$argon2id$v=19$m=65536,t=3,p=4$x",
                status=status,
                origin="vps",
                registered_by=besitzer,
            )
        )
        await s.commit()


async def _eintraege(session_factory) -> list[RegisteredInstance]:
    async with session_factory() as s:
        return list(
            (
                await s.execute(
                    select(RegisteredInstance).where(RegisteredInstance.hostname == _HOST)
                )
            ).scalars()
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
    # Ohne Hinweis genau das alte Bild, kein leeres ``hinweis``-Feld.
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
    """Endgültig: die Cloud lehnt den Vorgang selbst ab und nennt den Grund,
    damit ``pulse-connect`` nicht 15 Minuten auf ein Bestätigen wartet, das nie
    mehr gelingt. Der Browser bekommt dieselbe 403 wie immer."""
    konto = await _konto(client, "gesperrt")
    async with session_factory() as s:
        (await s.get(User, konto["id"])).server_verbinden_gesperrt = True
        await s.commit()
    code = (await _start(client)).json()["code"]

    r = await _entscheiden(client, konto, code, "verbinden")
    assert r.status_code == 403
    assert r.json()["detail"] == "verbinden_gesperrt"
    vorgang = await vorgang_per_nachweis(mit_redis, _NACHWEIS)
    assert (vorgang.status, vorgang.grund) == ("abgelehnt", "verbinden_gesperrt")
    assert vorgang.user_id == str(konto["id"])
    # Ein zweiter Klick findet den Code verbraucht, Ablehnen ebenso.
    for aktion in ("verbinden", "ablehnen"):
        r = await _entscheiden(client, konto, code, aktion)
        assert (r.status_code, r.json()["detail"]) == (404, "unbekannt")

    r = await _abholen(client)
    assert r.status_code == 403
    assert r.json()["detail"] == {"code": "verbinden_gesperrt"}
    assert (await _abholen(client)).status_code == 410


async def test_elfter_server(client, session_factory, mit_redis, nachweis):
    """Wiederholbar: nach einem gelöschten Server genügt ein zweiter Klick. Der
    Vorgang bleibt offen, ``abholen`` sagt ``pulse-connect`` nur, woran es lag."""
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

    vorgang = await vorgang_per_nachweis(mit_redis, _NACHWEIS)
    assert (vorgang.status, vorgang.hinweis, vorgang.grund) == ("wartet", "zu_viele_server", None)
    r = await _abholen(client)
    assert r.status_code == 202
    assert r.json() == {"status": "wartet", "hinweis": "zu_viele_server"}

    async with session_factory() as s:
        (await s.get(RegisteredInstance, 960000)).status = "deleted"
        await s.commit()
    r = await _entscheiden(client, konto, code, "verbinden")
    assert r.status_code == 200, r.text
    assert (await _abholen(client)).status_code == 200


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
    # Wiederholbar: der Vorgang wartet weiter, ``pulse-connect`` erfährt den Grund.
    r = await _abholen(client)
    assert r.status_code == 202
    assert r.json() == {"status": "wartet", "hinweis": "nachweis_fehlt"}

    # Proxy repariert, zweiter Klick: verbunden.
    nachweis.befund = None
    r = await _entscheiden(client, konto, code, "verbinden")
    assert r.status_code == 200, r.text
    assert (await _abholen(client)).status_code == 200


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


async def test_uebernahme_einer_fremden_adresse(
    client, session_factory, mit_redis, nachweis, uhr
):
    alt = await _konto(client, "altbesitzer")
    neu = await _konto(client, "neubesitzer")
    await _eintrag(session_factory, alt["id"], 961000)
    # Was die Sperrliste zwischengespeichert hat; der alte Server steht erst
    # still, wenn die Self-Hosts beim nächsten Abruf die neue Liste bekommen.
    await mit_redis.set(_ETAG_KEY, "alt", ex=60)
    await mit_redis.set(_BODY_KEY, "{}", ex=60)

    # Ein fremdes Konto bekommt die Adresse erst nach der Widerspruchsfrist
    # (verbinden_uebernahme.py); bis dahin bleibt alles, wie es ist.
    code = (await _start(client)).json()["code"]
    r = await _entscheiden(client, neu, code, "verbinden")
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "uebernahme_beantragt"
    async with session_factory() as s:
        assert (await s.get(RegisteredInstance, 961000)).status == "active"
    assert await mit_redis.get(_ETAG_KEY) == "alt"

    uhr.vor(hours=72)
    code = (await _start(client, kennung=_KENNUNG_NACH_DER_FRIST)).json()["code"]
    r = await _entscheiden(client, neu, code, "verbinden")
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "verbunden"
    assert r.json()["instance_id"] != "961000"
    async with session_factory() as s:
        assert (await s.get(RegisteredInstance, 961000)).status == "deleted"
    assert await mit_redis.get(_ETAG_KEY) is None
    assert await mit_redis.get(_BODY_KEY) is None


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


async def test_anderer_tab_gewinnt(client, session_factory, mit_redis, nachweis, monkeypatch):
    """Zwei Klicks auf denselben Code: entschieden wird er genau einmal. Der
    zweite hat seinen Eintrag schon vorbereitet, wenn er merkt, dass er zu spät
    ist — dann darf davon nichts bleiben und die Antwort darf nichts versprechen.

    Der Gewinner läuft hier mitten in der Prüfung von aussen durch, also nach
    dem Lesen des Vorgangs und vor dessen Entscheidung durch den Verlierer."""
    konto = await _konto(client, "zweitab")
    code = (await _start(client)).json()["code"]
    gewinner = {}
    pruefung = routes_verbinden.nachweis_pruefen

    async def mit_anderem_tab(hostname: str, erwartet: str) -> str | None:
        befund = await pruefung(hostname, erwartet)
        async with session_factory() as s:
            user = await s.get(User, konto["id"])
            verbunden = await instanz_verbinden(s, user, hostname)
            gewinner["iid"] = str(verbunden.instanz.id)
            assert await vorgang_entscheiden(
                mit_redis, erwartet, "bestaetigt", instance_id=gewinner["iid"], user_id="1"
            )
            await s.commit()
        return befund

    monkeypatch.setattr(routes_verbinden, "nachweis_pruefen", mit_anderem_tab)

    r = await _entscheiden(client, konto, code, "verbinden")
    assert r.status_code == 404, r.text
    assert r.json()["detail"] == "unbekannt"
    # Nur der Eintrag des Gewinners, und der Server bekommt dessen Ergebnis.
    (eintrag,) = await _eintraege(session_factory)
    assert str(eintrag.id) == gewinner["iid"]
    r = await _abholen(client)
    assert r.status_code == 200, r.text
    assert r.json()["instance_id"] == gewinner["iid"]


async def test_gleichzeitig_eingetragene_adresse_ist_unbekannt(
    client, session_factory, mit_redis, nachweis, monkeypatch
):
    """Die Adresse ist eindeutig: wer nach einem gleichzeitigen Klick
    zweimal einträgt, scheitert an der Datenbank, nicht an der Prüfung davor."""
    konto = await _konto(client, "gleichzeitig")
    code = (await _start(client)).json()["code"]
    await _eintrag(session_factory, konto["id"], 962100)

    async def kollidiert(db, user, hostname):
        db.add(
            RegisteredInstance(
                id=962101,
                hostname=hostname,
                client_id="doppelt",
                client_secret="$argon2id$v=19$m=65536,t=3,p=4$x",
                status="active",
                origin="vps",
                registered_by=user.id,
            )
        )
        await db.flush()
        raise AssertionError("die eindeutige Adresse hätte den Eintrag abweisen müssen")

    monkeypatch.setattr(routes_verbinden, "instanz_verbinden", kollidiert)

    r = await _entscheiden(client, konto, code, "verbinden")
    assert r.status_code == 404, r.text
    assert r.json()["detail"] == "unbekannt"
    assert [e.id for e in await _eintraege(session_factory)] == [962100]
    # Nicht entschieden: der Code bleibt für den Klick offen, der gewonnen hat.
    assert (await _abholen(client)).status_code == 202


async def test_gesperrter_eintrag_wird_nicht_uebernommen(
    client, session_factory, mit_redis, nachweis
):
    """Sonst käme man durch Neuverbinden aus einer Sperre heraus."""
    alt = await _konto(client, "gesperrtalt")
    neu = await _konto(client, "neuversuch")
    await _eintrag(session_factory, alt["id"], 962200, status="suspended")
    code = (await _start(client)).json()["code"]

    r = await _entscheiden(client, neu, code, "verbinden")
    assert r.status_code == 403, r.text
    assert r.json()["detail"] == "instance_suspended"
    (eintrag,) = await _eintraege(session_factory)
    assert (eintrag.id, eintrag.status, eintrag.registered_by) == (962200, "suspended", alt["id"])
    # Endgültig: die Cloud hat den Vorgang abgelehnt, ``pulse-connect`` erfährt es.
    vorgang = await vorgang_per_nachweis(mit_redis, _NACHWEIS)
    assert (vorgang.status, vorgang.grund) == ("abgelehnt", "instance_suspended")
    r = await _entscheiden(client, neu, code, "verbinden")
    assert (r.status_code, r.json()["detail"]) == (404, "unbekannt")
    r = await _abholen(client)
    assert r.status_code == 403
    assert r.json()["detail"] == {"code": "instance_suspended"}
    assert (await _abholen(client)).status_code == 410


async def test_gesperrt_geloeschte_adresse_bleibt_gesperrt_bis_zur_freigabe(
    client, session_factory, mit_redis, nachweis
):
    """Der Besitzer darf eine gesperrte Instanz löschen. Bliebe die Adresse
    danach frei, verbände er sich sofort neu und die Sperre wäre umgangen. Es
    sperrt für JEDES Konto, bis der Admin die Adresse freigibt."""
    besitzer = await _konto(client, "gesperrtbesitzer")
    fremd = await _konto(client, "gesperrtfremd")
    admin = await _konto(client, "gesperrtadmin")
    async with session_factory() as s:
        (await s.get(User, admin["id"])).is_admin = True
        await s.commit()
    token = (
        await client.post(
            "/login",
            json={
                "email_or_username": "gesperrtadmin@dcc-test.example.com",
                "password": "correct horse battery staple",
            },
        )
    ).json()["access_token"]
    await _eintrag(session_factory, besitzer["id"], 962210, status="suspended")
    async with session_factory() as s:
        s.add(SuspendedInstance(instance_id=962210, reason="admin"))
        await s.commit()

    r = await client.delete("/me/instances/962210", headers={"Cookie": besitzer["cookie"]})
    assert r.status_code == 204, r.text
    code = (await _start(client)).json()["code"]

    for konto in (besitzer, fremd):
        r = await _entscheiden(client, konto, code, "verbinden")
        assert r.status_code == 403, r.text
        assert r.json()["detail"] == "instance_suspended"
    (eintrag,) = await _eintraege(session_factory)
    assert (eintrag.id, eintrag.status) == (962210, "deleted")

    r = await client.post(
        "/admin/instances/962210/unsuspend", headers={"Authorization": f"Bearer {token}"}
    )
    assert r.status_code == 204, r.text

    r = await _entscheiden(client, fremd, code, "verbinden")
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "verbunden"
    (neu,) = await _eintraege(session_factory)
    assert (neu.id != 962210, neu.status, neu.registered_by) == (True, "active", fremd["id"])


async def test_geloeschte_adresse_ohne_sperre_ist_sofort_frei(
    client, session_factory, mit_redis, nachweis
):
    """Gegenstück: wer eine NICHT gesperrte Instanz löscht, verbindet sich
    unter derselben Adresse gleich wieder."""
    besitzer = await _konto(client, "loeschtfrei")
    await _eintrag(session_factory, besitzer["id"], 962220)
    r = await client.delete("/me/instances/962220", headers={"Cookie": besitzer["cookie"]})
    assert r.status_code == 204, r.text

    code = (await _start(client)).json()["code"]
    r = await _entscheiden(client, besitzer, code, "verbinden")
    assert r.status_code == 200, r.text
    (neu,) = await _eintraege(session_factory)
    assert (neu.id != 962220, neu.status) == (True, "active")


@pytest.mark.parametrize("zustand", ["deleted", "suspended", "ohne_besitzer", "verschwunden"])
async def test_abholen_nach_veraenderung_des_eintrags(
    client, session_factory, mit_redis, nachweis, zustand
):
    """Zwischen Klick und Abholen können Minuten liegen. Was sich bis dahin
    geändert hat, bekommt keine Zugangsdaten mehr."""
    konto = await _konto(client, "abholer")
    code = (await _start(client)).json()["code"]
    r = await _entscheiden(client, konto, code, "verbinden")
    assert r.status_code == 200, r.text
    iid = int(r.json()["instance_id"])

    async with session_factory() as s:
        inst = await s.get(RegisteredInstance, iid)
        if zustand == "ohne_besitzer":
            inst.registered_by = None
        elif zustand == "verschwunden":
            await s.execute(
                UserInstanceMembership.__table__.delete().where(
                    UserInstanceMembership.instance_id == iid
                )
            )
            await s.delete(inst)
        else:
            inst.status = zustand
        await s.commit()

    r = await _abholen(client)
    assert r.status_code == 410, r.text
    assert r.json()["detail"] == "abgelaufen"
    async with session_factory() as s:
        inst = await s.get(RegisteredInstance, iid)
    assert inst is None or inst.verbunden_at is None


async def test_abholen_trifft_auf_frischen_vorgang(client, mit_redis, nachweis, monkeypatch):
    """Der entschiedene Vorgang läuft zwischen Lesen und Entnehmen ab, und ein
    neuer Start mit derselben Kennung legt einen frischen an. Der wartet noch
    und hat keine Instanz — das ist ein Ende, kein Fehler."""
    assert (await _start(client)).status_code == 201
    gelesen = routes_verbinden.vorgang_per_nachweis

    async def als_entschieden_gelesen(redis, nachweis_hash):
        vorgang = await gelesen(redis, nachweis_hash)
        return vorgang.model_copy(update={"status": "bestaetigt", "instance_id": "123"})

    monkeypatch.setattr(routes_verbinden, "vorgang_per_nachweis", als_entschieden_gelesen)

    r = await _abholen(client)
    assert r.status_code == 410, r.text
    assert r.json()["detail"] == "abgelaufen"


async def test_bestaetigt_ohne_instanz_ist_abgelaufen(client, mit_redis, nachweis):
    assert (await _start(client)).status_code == 201
    assert await vorgang_entscheiden(
        mit_redis, _NACHWEIS, "bestaetigt", instance_id=None, user_id="1"
    )

    r = await _abholen(client)
    assert r.status_code == 410, r.text
    assert r.json()["detail"] == "abgelaufen"


async def test_hinweis_mail_nach_dem_verbinden(client, mit_redis, nachweis, monkeypatch):
    """Gegenmittel gegen untergeschobene Links (Entwurf E5): wer einen fremden
    Link bestätigt hat, erfährt es spätestens aus seinem Postfach."""
    gesendet: list[tuple[str, str, str]] = []

    async def mitschreiben(to, subject, body_plain, session=None):
        gesendet.append((to, subject, body_plain))

    monkeypatch.setattr(email_verbinden, "send_email", mitschreiben)
    konto = await _konto(client, "postfach")

    abgelehnt = (await _start(client)).json()["code"]
    assert (await _entscheiden(client, konto, abgelehnt, "ablehnen")).status_code == 200
    assert gesendet == []

    await _abholen(client)  # räumt den abgelehnten Vorgang
    code = (await _start(client)).json()["code"]
    assert (await _entscheiden(client, konto, code, "verbinden")).status_code == 200

    ((an, betreff, text),) = gesendet
    assert an == "postfach@dcc-test.example.com"
    assert betreff == "Pulse: Ein Server wurde mit deinem Konto verbunden"
    assert _HOST in text
    assert "UTC" in text
    assert "Warst du das nicht? Lösche den Server in Pulse unter Meine Server." in text
    # Beim Versand ist der Server noch nicht abgeholt, also nicht schon da.
    assert "erscheint jetzt" not in text
    assert "Sobald der Server seine Zugangsdaten abgeholt hat" in text
    assert code not in text and code.replace("-", "") not in text


async def test_versandfehler_bricht_das_verbinden_nicht_ab(
    client, mit_redis, nachweis, monkeypatch
):
    import smtplib

    async def kaputt(*_a, **_k):
        raise smtplib.SMTPException("relay down")

    monkeypatch.setattr(email_verbinden, "send_email", kaputt)
    konto = await _konto(client, "ohnepost")
    code = (await _start(client)).json()["code"]

    r = await _entscheiden(client, konto, code, "verbinden")
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "verbunden"
    assert (await _abholen(client)).status_code == 200


async def test_versandfehler_loggt_nur_den_typ_nicht_die_adresse(
    client, mit_redis, nachweis, monkeypatch, caplog
):
    """``SMTPRecipientsRefused`` trägt die Empfängeradresse in seiner Meldung."""
    import smtplib

    adresse = "postfach-kaputt@dcc-test.example.com"

    async def abgelehnt(*_a, **_k):
        raise smtplib.SMTPRecipientsRefused({adresse: (550, b"no such user")})

    monkeypatch.setattr(email_verbinden, "send_email", abgelehnt)
    konto = await _konto(client, "postfach-kaputt")
    code = (await _start(client)).json()["code"]

    with caplog.at_level("WARNING", logger=email_verbinden.__name__):
        r = await _entscheiden(client, konto, code, "verbinden")
    assert r.status_code == 200, r.text
    (zeile,) = [
        z
        for z in caplog.records
        if z.getMessage().startswith("verbinden_hinweis_mail_fehlgeschlagen")
    ]
    assert zeile.getMessage() == (
        f"verbinden_hinweis_mail_fehlgeschlagen user_id={konto['id']}: SMTPRecipientsRefused"
    )
    assert adresse not in caplog.text and "no such user" not in caplog.text


async def test_uebernahme_schreibt_dem_vorbesitzer(
    client, session_factory, mit_redis, nachweis, uhr, monkeypatch
):
    """Bei einer Übernahme ist der alte Eintrag weg und der alte Server steht
    still — sein Besitzer soll das nicht erst am toten Server merken. Schon
    den Antrag erfährt er, damit er in der Frist widersprechen kann."""
    gesendet: list[tuple[str, str, str]] = []

    async def mitschreiben(to, subject, body_plain, session=None):
        gesendet.append((to, subject, body_plain))

    monkeypatch.setattr(email_verbinden, "send_email", mitschreiben)
    alt = await _konto(client, "vorbesitzer")
    neu = await _konto(client, "nachfolger")
    async with session_factory() as s:
        s.add(
            RegisteredInstance(
                id=962000,
                hostname=_HOST,
                client_id="vb-client",
                client_secret="$argon2id$v=19$m=65536,t=3,p=4$x",
                status="active",
                origin="vps",
                registered_by=alt["id"],
            )
        )
        await s.commit()

    def betreffe(an: str) -> list[str]:
        return [m[1] for m in gesendet if m[0] == f"{an}@dcc-test.example.com"]

    code = (await _start(client)).json()["code"]
    r = await _entscheiden(client, neu, code, "verbinden")
    assert r.json()["status"] == "uebernahme_beantragt", r.text
    assert betreffe("vorbesitzer") == ["Pulse: Jemand möchte deinen Server übernehmen"]
    # Das antragstellende Konto erfährt es erst beim Vollzug.
    assert betreffe("nachfolger") == []

    uhr.vor(hours=72)
    code = (await _start(client, kennung=_KENNUNG_NACH_DER_FRIST)).json()["code"]
    r = await _entscheiden(client, neu, code, "verbinden")
    assert r.json()["status"] == "verbunden", r.text
    vollzug = "Pulse: Dein Server wurde mit einem anderen Konto verbunden"
    assert betreffe("vorbesitzer") == ["Pulse: Jemand möchte deinen Server übernehmen", vollzug]
    ((_, _, text),) = [m for m in gesendet if m[1] == vollzug]
    assert _HOST in text and "UTC" in text
    assert "Wer den Server unter dieser Adresse betreibt, hat ihn neu verbunden." in text
    assert "prüfe, wer Zugriff auf den Rechner und die Domain hat." in text
    hinweis = "Pulse: Ein Server wurde mit deinem Konto verbunden"
    assert betreffe("nachfolger") == [hinweis]

    # Derselbe Besitzer verbindet denselben Server neu (dritter Lauf von
    # pulse-connect): kein Besitzerwechsel, also keine weitere Mail an den
    # Vorbesitzer.
    code = (await _start(client, kennung="zweite-abholkennung-fuer-denselben-server")).json()[
        "code"
    ]
    assert (await _entscheiden(client, neu, code, "verbinden")).status_code == 200
    assert len(betreffe("vorbesitzer")) == 2
    assert betreffe("nachfolger") == [hinweis, hinweis]


async def test_abholen_meldet_den_server_an_die_geraete_des_besitzers(
    client, mit_redis, nachweis, monkeypatch
):
    """Entwurf E3: der Server erscheint in der Leiste ALLER Geräte des
    Besitzers — offene Geräte erfahren es über ``user:events``, nicht erst
    beim nächsten Laden von ``/me/instances``."""
    import json

    from dcc_shared.events import EVENT_REGISTRY

    gesendet: list[tuple[str, dict]] = []

    async def mitschreiben(kanal, nutzlast):
        gesendet.append((kanal, json.loads(nutzlast)))
        return 0

    monkeypatch.setattr(mit_redis, "publish", mitschreiben)
    konto = await _konto(client, "geraete")
    code = (await _start(client)).json()["code"]
    iid = (await _entscheiden(client, konto, code, "verbinden")).json()["instance_id"]
    # Bestätigt heisst noch nicht eingerichtet: erst das Abholen zählt.
    assert gesendet == []

    assert (await _abholen(client)).status_code == 200
    ((kanal, nutzlast),) = gesendet
    assert kanal == "user:events"
    assert nutzlast.pop("_target_user_id") == str(konto["id"])
    assert nutzlast == {"op": "instanz_verbunden", "data": {"instance_id": iid}}
    # Genau diese Prüfung macht der chat-gateway vor der Zustellung
    # (pubsub_event_validation.py, strikter Modus).
    EVENT_REGISTRY["instanz_verbunden"].model_validate(nutzlast)


async def test_redis_fehler_beim_melden_kostet_das_abholen_nicht(
    client, mit_redis, nachweis, monkeypatch
):
    async def kaputt(*_a, **_k):
        raise ConnectionError("redis weg")

    monkeypatch.setattr(mit_redis, "publish", kaputt)
    konto = await _konto(client, "unbeirrt")
    code = (await _start(client)).json()["code"]
    assert (await _entscheiden(client, konto, code, "verbinden")).status_code == 200
    assert (await _abholen(client)).status_code == 200


async def test_alter_vorgang_ohne_grund_und_hinweis_ist_lesbar(client, mit_redis, nachweis):
    """Ein Vorgang, den ein Stand vor ``grund``/``hinweis`` geschrieben hat, liegt
    bis zu 15 Minuten in Redis, während der neue Stand schon läuft."""
    assert (await _start(client)).status_code == 201
    schluessel = f"auth:verbinden:vorgang:{_NACHWEIS}"
    alt = {"hostname": _HOST, "code": "K7QM2XDP", "gueltig_bis": "2026-10-12T12:00:00+00:00"}

    await mit_redis.set(schluessel, json.dumps({**alt, "status": "wartet"}), ex=900)
    vorgang = await vorgang_per_nachweis(mit_redis, _NACHWEIS)
    assert (vorgang.grund, vorgang.hinweis) == (None, None)
    r = await _abholen(client)
    assert (r.status_code, r.json()) == (202, {"status": "wartet"})

    # Von Hand abgelehnt, ohne Grund: weiter das schlichte „abgelehnt“.
    await mit_redis.set(schluessel, json.dumps({**alt, "status": "abgelehnt"}), ex=900)
    r = await _abholen(client)
    assert (r.status_code, r.json()["detail"]) == (403, "abgelehnt")


async def test_unbekannter_hinweis_macht_den_vorgang_nicht_unlesbar(client, mit_redis, nachweis):
    """Rollt der Dienst zurück oder kommt ein neuerer Wert dazu, liest ein Stand,
    was ein anderer geschrieben hat — ein Name, den er nicht kennt, darf nicht werfen."""
    assert (await _start(client)).status_code == 201
    schluessel = f"auth:verbinden:vorgang:{_NACHWEIS}"
    daten = {
        "hostname": _HOST,
        "code": "K7QM2XDP",
        "gueltig_bis": "2026-10-12T12:00:00+00:00",
        "status": "wartet",
        "hinweis": "gibt_es_noch_nicht",
    }
    await mit_redis.set(schluessel, json.dumps(daten), ex=900)
    r = await _abholen(client)
    assert (r.status_code, r.json()) == (202, {"status": "wartet", "hinweis": "gibt_es_noch_nicht"})


async def test_hinweis_aendert_nur_einen_wartenden_vorgang(client, mit_redis, nachweis):
    assert (await _start(client)).status_code == 201
    schluessel = f"auth:verbinden:vorgang:{_NACHWEIS}"
    frist_vorher = await mit_redis.ttl(schluessel)

    assert await vorgang_hinweis_setzen(mit_redis, _NACHWEIS, "zu_viele_server") is True
    assert (await vorgang_per_nachweis(mit_redis, _NACHWEIS)).hinweis == "zu_viele_server"
    # Die Frist läuft weiter (``KEEPTTL``), und ein Wiederholen ist harmlos.
    assert 0 < await mit_redis.ttl(schluessel) <= frist_vorher
    assert await vorgang_hinweis_setzen(mit_redis, _NACHWEIS, "zu_viele_server") is True
    # Ein neuer Grund ersetzt den alten.
    assert await vorgang_hinweis_setzen(mit_redis, _NACHWEIS, "nachweis_fehlt") is True
    assert (await vorgang_per_nachweis(mit_redis, _NACHWEIS)).hinweis == "nachweis_fehlt"

    # Entschieden: unberührt.
    assert await vorgang_entscheiden(
        mit_redis, _NACHWEIS, "abgelehnt", instance_id=None, user_id="1"
    )
    assert await vorgang_hinweis_setzen(mit_redis, _NACHWEIS, "zu_viele_server") is False
    vorgang = await vorgang_per_nachweis(mit_redis, _NACHWEIS)
    assert (vorgang.status, vorgang.hinweis) == ("abgelehnt", "nachweis_fehlt")
    # Verschwunden: nichts anzulegen.
    fremd = "0" * 64
    assert await vorgang_hinweis_setzen(mit_redis, fremd, "zu_viele_server") is False
    assert await mit_redis.exists(f"auth:verbinden:vorgang:{fremd}") == 0


async def test_hinweis_scheitert_still_wenn_redis_nicht_antwortet(caplog):
    """Eine Hilfe, kein Teil der Entscheidung: ein Redis-Fehler macht aus dem 409
    keinen 500."""
    from redis.exceptions import ConnectionError as RedisVerbindungsfehler

    class Kaputt:
        def pipeline(self, **_):
            raise RedisVerbindungsfehler("weg")

    with caplog.at_level("WARNING", logger="dcc_auth.verbinden"):
        assert await vorgang_hinweis_setzen(Kaputt(), _NACHWEIS, "nachweis_fehlt") is False
    assert "verbinden_hinweis_fehlgeschlagen fehler=ConnectionError" in caplog.text


async def test_endgueltige_ablehnung_entscheidet_nur_einmal(client, mit_redis, nachweis):
    """Hat ein anderer Tab den Code schon entschieden, bleibt es bei dessen Ergebnis,
    und der Aufrufer bekommt 404 statt 403."""
    assert (await _start(client)).status_code == 201

    erste = await endgueltig_abgelehnt(mit_redis, _NACHWEIS, 7, _HOST, "verbinden_gesperrt")
    assert (erste.status_code, erste.detail) == (403, "verbinden_gesperrt")
    zweite = await endgueltig_abgelehnt(mit_redis, _NACHWEIS, 8, _HOST, "instance_suspended")
    assert (zweite.status_code, zweite.detail) == (404, "unbekannt")
    vorgang = await vorgang_per_nachweis(mit_redis, _NACHWEIS)
    assert (vorgang.status, vorgang.grund, vorgang.user_id) == (
        "abgelehnt",
        "verbinden_gesperrt",
        "7",
    )


def test_vorgang_nimmt_alte_daten_ohne_die_neuen_felder():
    vorgang = Vorgang.model_validate_json(
        '{"hostname": "a.example.org", "code": "K7QM2XDP", "gueltig_bis": "x", "status": "wartet"}'
    )
    assert (vorgang.grund, vorgang.hinweis) == (None, None)
