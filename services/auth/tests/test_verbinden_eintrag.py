"""Server-Eintrag beim Verbinden: neu, wiederverwenden oder übernehmen.

Die Route hat den Nachweis schon geprüft, wenn ``instanz_verbinden`` läuft:
Unter der Adresse antwortet der Server, der den Code angefragt hat. Daraus
folgt die ganze Regel (Spec 2026-10-09, E2) — wer die Adresse nachweislich
betreibt, bekommt den Eintrag. Bei einem fremden Eintrag hat die Route vorher
die Widerspruchsfrist geprüft (``verbinden_uebernahme.py``); hier geht es nur
um den Vollzug.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from sqlalchemy import select

from dcc_auth.models import User
from dcc_auth.models_instances import (
    RegisteredInstance,
    SuspendedInstance,
    UserInstanceMembership,
)
from dcc_auth.routes_instance_delete import soft_delete_instance
from dcc_auth.security import verify_password
from dcc_auth.verbinden_eintrag import (
    HOECHSTENS_SERVER,
    InstanzGesperrt,
    ZuVieleServer,
    adresse_gesperrt,
    instanz_verbinden,
)

_EINSTELLUNGEN = SimpleNamespace(
    pulse_oidc_issuer="https://howispulse.com",
    pulse_relay_base_domain="relay.howispulse.com",
)


async def _konto(client, name: str) -> int:
    reg = {
        "username": name,
        "email": f"{name}@dcc-test.example.com",
        "password": "correct horse battery staple",
        "display_name": name,
    }
    await client.post("/register", json=reg)
    r = await client.post(
        "/login", json={"email_or_username": reg["email"], "password": reg["password"]}
    )
    me = await client.get(
        "/me", headers={"Cookie": f"pulse_session={r.cookies.get('pulse_session')}"}
    )
    return int(me.json()["id"])


async def _instanz(
    session_factory,
    *,
    iid: int,
    hostname: str,
    besitzer: int,
    status: str = "active",
    origin: str = "vps",
) -> None:
    async with session_factory() as s:
        s.add(
            RegisteredInstance(
                id=iid,
                hostname=hostname,
                client_id=f"ve-{iid}",
                client_secret="$argon2id$v=19$m=65536,t=3,p=4$alt",
                status=status,
                origin=origin,
                registered_by=besitzer,
            )
        )
        s.add(UserInstanceMembership(user_id=besitzer, instance_id=iid, role="owner"))
        await s.commit()


async def _verbinden(session_factory, user_id: int, hostname: str):
    async with session_factory() as db:
        user = await db.get(User, user_id)
        ergebnis = await instanz_verbinden(db, user, hostname)
        await db.commit()
    return ergebnis


@pytest.mark.parametrize(
    ("host", "gesperrt"),
    [
        ("howispulse.com", True),
        ("evil.howispulse.com", True),
        ("x.relay.howispulse.com", True),
        ("howispulse.com.example.org", False),
        ("nothowispulse.com", False),
        ("chat.example.org", False),
    ],
)
def test_eigene_domains_sind_gesperrt(host, gesperrt):
    assert adresse_gesperrt(host, _EINSTELLUNGEN) is gesperrt


async def test_neue_adresse_ergibt_einen_eintrag_ohne_freigabe(client, session_factory):
    uid = await _konto(client, "ve_neu")
    ergebnis = await _verbinden(session_factory, uid, "neu.example.org")
    assert ergebnis.abgeloest is None

    async with session_factory() as s:
        inst = await s.get(RegisteredInstance, ergebnis.instanz.id)
        mitglied = await s.get(UserInstanceMembership, (uid, inst.id))
    assert inst.hostname == "neu.example.org"
    assert (inst.origin, inst.status, inst.registered_by) == ("vps", "active", uid)
    assert inst.ohne_freigabe is True
    assert inst.verbunden_at is None
    assert (inst.worker_id_chat, inst.worker_id_voice, inst.worker_id_media) == (None, None, None)
    # Ein echter Argon2-Hash eines verworfenen Zufallswerts: bis zum Abholen
    # meldet sich niemand als dieser Server an.
    assert inst.client_secret.startswith("$argon2")
    assert not verify_password("", inst.client_secret)
    assert mitglied is not None and mitglied.role == "owner"


async def test_eigene_adresse_wird_wiederverwendet(client, session_factory):
    """Neuinstallation desselben Besitzers: derselbe Eintrag, dieselbe Nummer —
    Mitglieder und Communitys auf dem Server bleiben gültig."""
    uid = await _konto(client, "ve_eigen")
    await _instanz(session_factory, iid=950001, hostname="eigen.example.org", besitzer=uid)
    ergebnis = await _verbinden(session_factory, uid, "eigen.example.org")
    assert ergebnis.instanz.id == 950001
    assert ergebnis.abgeloest is None
    assert ergebnis.instanz.ohne_freigabe is False


async def test_fremde_adresse_wird_uebernommen(client, session_factory):
    alt = await _konto(client, "ve_alt")
    neu = await _konto(client, "ve_neu2")
    await _instanz(session_factory, iid=950002, hostname="wechsel.example.org", besitzer=alt)

    ergebnis = await _verbinden(session_factory, neu, "wechsel.example.org")
    assert ergebnis.abgeloest == 950002
    assert ergebnis.instanz.id != 950002

    async with session_factory() as s:
        vorher = await s.get(RegisteredInstance, 950002)
        sperre = await s.get(SuspendedInstance, 950002)
        alte_mitglieder = (
            await s.execute(
                select(UserInstanceMembership).where(
                    UserInstanceMembership.instance_id == 950002
                )
            )
        ).all()
        jetzt = await s.get(RegisteredInstance, ergebnis.instanz.id)
    # Soft-Delete wie routes_instance_delete: der alte Server steht über die
    # Sperrliste still, seine Adresse ist frei.
    assert vorher.status == "deleted"
    assert vorher.hostname == "deleted-950002.invalid"
    assert sperre is not None
    assert alte_mitglieder == []
    assert (jetzt.hostname, jetzt.registered_by) == ("wechsel.example.org", neu)


async def test_gesperrter_server_ist_nicht_zu_uebernehmen(client, session_factory):
    """Sonst entkäme ein gesperrter Server seiner Sperre durch Neuverbinden."""
    uid = await _konto(client, "ve_sperr")
    await _instanz(
        session_factory, iid=950003, hostname="sperr.example.org", besitzer=uid,
        status="suspended",
    )
    with pytest.raises(InstanzGesperrt):
        await _verbinden(session_factory, uid, "sperr.example.org")
    async with session_factory() as s:
        assert (await s.get(RegisteredInstance, 950003)).status == "suspended"


async def _loeschen(session_factory, iid: int) -> None:
    """Der Besitzer löscht den Eintrag (``DELETE /me/instances/{id}``)."""
    async with session_factory() as s:
        await soft_delete_instance(s, await s.get(RegisteredInstance, iid))
        await s.commit()


async def test_gesperrt_und_geloescht_haelt_die_adresse_gesperrt(client, session_factory):
    """Der Besitzer darf eine gesperrte Instanz löschen. Bliebe die Adresse
    danach frei, verbände er sich sofort neu: die Sperre wäre umgangen."""
    besitzer = await _konto(client, "ve_gloe")
    fremder = await _konto(client, "ve_gloe2")
    await _instanz(
        session_factory, iid=950010, hostname="gloe.example.org", besitzer=besitzer,
        status="suspended",
    )
    async with session_factory() as s:
        s.add(SuspendedInstance(instance_id=950010, reason="admin"))
        await s.commit()
    await _loeschen(session_factory, 950010)

    for konto in (besitzer, fremder):
        with pytest.raises(InstanzGesperrt):
            await _verbinden(session_factory, konto, "gloe.example.org")

    async with session_factory() as s:
        eintraege = (
            await s.execute(
                select(RegisteredInstance).where(RegisteredInstance.hostname == "gloe.example.org")
            )
        ).scalars().all()
    # Nichts Neues angelegt, der gelöschte Eintrag unangetastet.
    assert [(e.id, e.status) for e in eintraege] == [(950010, "deleted")]


@pytest.mark.parametrize("konto_ist_besitzer", [True, False])
async def test_normal_geloescht_gibt_die_adresse_frei(client, session_factory, konto_ist_besitzer):
    """Gegenstück: wer eine NICHT gesperrte Instanz löscht, gibt die Adresse frei."""
    besitzer = await _konto(client, "ve_frei")
    fremder = await _konto(client, "ve_frei2")
    await _instanz(session_factory, iid=950011, hostname="frei.example.org", besitzer=besitzer)
    await _loeschen(session_factory, 950011)

    konto = besitzer if konto_ist_besitzer else fremder
    ergebnis = await _verbinden(session_factory, konto, "frei.example.org")
    assert ergebnis.instanz.id != 950011
    assert ergebnis.abgeloest is None
    async with session_factory() as s:
        alt = await s.get(RegisteredInstance, 950011)
    assert (alt.status, alt.hostname) == ("deleted", "deleted-950011.invalid")


async def test_grenze_gilt_fuer_neue_adressen(client, session_factory):
    uid = await _konto(client, "ve_grenze")
    for i in range(HOECHSTENS_SERVER):
        await _instanz(
            session_factory, iid=951000 + i, hostname=f"s{i}.example.org", besitzer=uid
        )
    with pytest.raises(ZuVieleServer):
        await _verbinden(session_factory, uid, "elf.example.org")
    # Eine eigene Adresse neu zu verbinden kostet keinen Platz.
    ergebnis = await _verbinden(session_factory, uid, "s3.example.org")
    assert ergebnis.instanz.id == 951003


async def test_grenze_zaehlt_nur_aktive_gemietete_server(client, session_factory):
    uid = await _konto(client, "ve_zaehlen")
    for i in range(HOECHSTENS_SERVER - 1):
        await _instanz(
            session_factory, iid=952000 + i, hostname=f"z{i}.example.org", besitzer=uid
        )
    await _instanz(
        session_factory, iid=952100, hostname="app-952100.relay.howispulse.com",
        besitzer=uid, origin="app_host",
    )
    await _instanz(
        session_factory, iid=952101, hostname="gesperrt.example.org", besitzer=uid,
        status="suspended",
    )
    ergebnis = await _verbinden(session_factory, uid, "zehnter.example.org")
    assert ergebnis.instanz.hostname == "zehnter.example.org"
