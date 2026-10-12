"""Tests für /me/instances (Phase 2.2).

Antrag (``/me/instance-applications``) und ``.env``-Download sind seit
Oktober 2026 entfernt (Spec E11); ``test_antrag_und_env_download_sind_entfernt``
hält das fest.
"""

from __future__ import annotations

import secrets
from datetime import UTC, datetime

import pytest
import pytest_asyncio

from sqlalchemy import update

from dcc_auth.models_instances import (
    InstanceBootstrapToken,
    RegisteredInstance,
    UserInstanceMembership,
)

# ---------------------------------------------------------------------------
# Shared test credentials
# ---------------------------------------------------------------------------

_REG_A = {
    "username": "inst_alice",
    "email": "inst_alice@dcc-test.example.com",
    "password": "correct horse battery staple",
    "display_name": "Alice",
}
_REG_B = {
    "username": "inst_bob",
    "email": "inst_bob@dcc-test.example.com",
    "password": "correct horse battery staple",
    "display_name": "Bob",
}
_LOGIN_A = {"email_or_username": _REG_A["email"], "password": _REG_A["password"]}
_LOGIN_B = {"email_or_username": _REG_B["email"], "password": _REG_B["password"]}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _reg_and_login(client, reg: dict, login: dict) -> str:
    """Register + login, return cookie header string."""
    await client.post("/register", json=reg)
    r = await client.post("/login", json=login)
    assert r.status_code == 200, r.text
    sid = r.cookies.get("pulse_session")
    assert sid, "pulse_session cookie fehlt"
    return f"pulse_session={sid}"


@pytest_asyncio.fixture
async def alice_cookie(client) -> str:
    return await _reg_and_login(client, _REG_A, _LOGIN_A)


@pytest_asyncio.fixture
async def bob_cookie(client) -> str:
    return await _reg_and_login(client, _REG_B, _LOGIN_B)


@pytest_asyncio.fixture
async def alice_instance(session_factory, alice_cookie, client) -> RegisteredInstance:
    """Seed a RegisteredInstance for Alice plus her Owner-Membership."""
    # Wir brauchen Alice's User-ID. Wir holen sie aus dem /me-Endpoint.
    r = await client.get("/me", headers={"Cookie": alice_cookie})
    assert r.status_code == 200, r.text
    alice_id = r.json()["id"]

    async with session_factory() as session:
        inst = RegisteredInstance(
            id=10000000000000001,
            hostname="alice-instance.example.com",
            client_id=f"ci_{secrets.token_hex(8)}",
            client_secret="$argon2id$v=19$m=65536,t=3,p=4$fakehash",
            worker_id_chat=100,
            worker_id_voice=101,
            worker_id_media=102,
            status="active",
            registered_by=int(alice_id),
        )
        session.add(inst)
        await session.commit()
        await session.refresh(inst)
        # Membership anlegen, damit GET /me/instances die Instanz via JOIN findet
        # (Migration 0037, Account-basierte Server-Liste statt Vault).
        session.add(
            UserInstanceMembership(
                user_id=int(alice_id),
                instance_id=inst.id,
                role="owner",
            )
        )
        await session.commit()
    return inst


# ---------------------------------------------------------------------------
# Auth-Required-Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_instances_requires_cookie(client):
    r = await client.get("/me/instances")
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_antrag_und_env_download_sind_entfernt(client, alice_cookie, alice_instance):
    """Seit Oktober 2026 gibt es weder Antrag noch ``.env``-Download (Spec E11).

    Ein Server verbindet sich per Gerätecode selbst (``routes_verbinden.py``).
    Die alten Wege dürfen nicht still weiterleben: der eine legte Anträge an,
    die niemand mehr bearbeitet, der andere gab frische Zugangsdaten aus.
    """
    h = {"Cookie": alice_cookie}
    r = await client.post(
        "/me/instance-applications", json={"hostname": "neu.example.com"}, headers=h
    )
    assert r.status_code == 404
    assert (await client.get("/me/instance-applications", headers=h)).status_code == 404
    r = await client.post(f"/me/instances/{alice_instance.id}/env-file", headers=h)
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# GET /me/instances — nur eigene Instanzen
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_instances_empty(client, alice_cookie):
    r = await client.get("/me/instances", headers={"Cookie": alice_cookie})
    assert r.status_code == 200
    assert r.json() == []


@pytest.mark.asyncio
async def test_get_instances_only_own(client, alice_cookie, bob_cookie, alice_instance):
    """Alice sieht ihre Instanz, Bob sieht eine leere Liste."""
    r_alice = await client.get("/me/instances", headers={"Cookie": alice_cookie})
    assert r_alice.status_code == 200
    alice_insts = r_alice.json()
    assert len(alice_insts) == 1
    data = alice_insts[0]
    assert data["hostname"] == "alice-instance.example.com"
    assert data["id"] == str(alice_instance.id)
    # client_secret darf NICHT im Response erscheinen
    assert "client_secret" not in data

    r_bob = await client.get("/me/instances", headers={"Cookie": bob_cookie})
    assert r_bob.status_code == 200
    assert r_bob.json() == []


# ---------------------------------------------------------------------------
# set_up — „ist dieser Server schon versorgt worden"
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_set_up_ist_falsch_solange_keine_zugangsdaten_geholt_wurden(
    client, alice_cookie, alice_instance
):
    """Eine frisch genehmigte Instanz ist NICHT eingerichtet.

    Der Client haengt daran, ob er sie in die Server-Leiste aufnimmt: bis
    2026-08-27 tat er das in der Sekunde der Freigabe, und der Nutzer sah einen
    Server, der nirgends lief.
    """
    r = await client.get("/me/instances", headers={"Cookie": alice_cookie})
    assert r.status_code == 200, r.text
    eintrag = next(i for i in r.json() if i["id"] == str(alice_instance.id))
    assert eintrag["set_up"] is False


@pytest.mark.asyncio
async def test_set_up_bleibt_fuer_bestand_mit_env_download(
    client, alice_cookie, alice_instance, session_factory
):
    """Der ``.env``-Download ist entfernt, sein Zeitstempel zählt weiter.

    Ein Server aus der Freigabe-Zeit, der per ``.env`` eingerichtet wurde, hat
    nur ``env_file_downloaded_at`` — kein eingelöstes Token, kein Verbinden.
    Fiele er aus ``set_up``, verschwände er aus der Leiste seiner Mitglieder.
    """
    async with session_factory() as session:
        await session.execute(
            update(RegisteredInstance)
            .where(RegisteredInstance.id == alice_instance.id)
            .values(env_file_downloaded_at=datetime.now(UTC))
        )
        await session.commit()

    r = await client.get("/me/instances", headers={"Cookie": alice_cookie})
    eintrag = next(i for i in r.json() if i["id"] == str(alice_instance.id))
    assert eintrag["set_up"] is True


@pytest.mark.asyncio
async def test_set_up_nach_eingeloestem_bootstrap_token(
    client, alice_cookie, alice_instance, session_factory
):
    """Der Installer-Weg zaehlt ebenso — geprueft wird das EINGELOESTE Token,
    nicht das blosse Ausstellen: ein ungenutzter Mint richtet nichts ein."""
    r = await client.post(
        f"/me/instances/{alice_instance.id}/bootstrap-token",
        headers={"Cookie": alice_cookie},
    )
    assert r.status_code == 201, r.text

    r = await client.get("/me/instances", headers={"Cookie": alice_cookie})
    eintrag = next(i for i in r.json() if i["id"] == str(alice_instance.id))
    assert eintrag["set_up"] is False, "ausgestellt ist nicht eingeloest"

    async with session_factory() as session:
        await session.execute(
            update(InstanceBootstrapToken)
            .where(InstanceBootstrapToken.instance_id == alice_instance.id)
            .values(consumed_at=datetime.now(UTC))
        )
        await session.commit()

    r = await client.get("/me/instances", headers={"Cookie": alice_cookie})
    eintrag = next(i for i in r.json() if i["id"] == str(alice_instance.id))
    assert eintrag["set_up"] is True


# ---------------------------------------------------------------------------
# POST/DELETE /me/instances/{id}/membership — eingeladene Nicht-Owner-User
# (Phase 4-6: Self-Host-Server taucht auch im Browser/auf anderen Geräten auf)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_join_membership_makes_instance_visible(
    client, bob_cookie, alice_instance
):
    """Bob ist nicht Owner → sieht Alices Instanz erst NACH dem Membership-Join."""
    before = await client.get("/me/instances", headers={"Cookie": bob_cookie})
    assert before.status_code == 200
    assert before.json() == []

    join = await client.post(
        f"/me/instances/{alice_instance.id}/membership",
        headers={"Cookie": bob_cookie},
    )
    assert join.status_code == 204, join.text

    after = await client.get("/me/instances", headers={"Cookie": bob_cookie})
    assert after.status_code == 200
    ids = [i["id"] for i in after.json()]
    assert str(alice_instance.id) in ids


@pytest.mark.asyncio
async def test_role_unterscheidet_besitzer_von_mitglied(
    client, alice_cookie, bob_cookie, alice_instance
):
    """Der Beigetretene sieht den Server als ``member``, die Besitzerin als
    ``owner`` — ohne das Feld kann die Oberfläche beides nicht auseinanderhalten
    und bietet einem Mitglied Einrichten/Löschen für einen fremden Server an.
    Gegenprobe unten: die Routen dahinter sind owner-verriegelt, der Fehler war
    also die Anzeige, nicht der Zugriff.
    """
    join = await client.post(
        f"/me/instances/{alice_instance.id}/membership",
        headers={"Cookie": bob_cookie},
    )
    assert join.status_code == 204, join.text

    bob_sicht = (await client.get("/me/instances", headers={"Cookie": bob_cookie})).json()
    assert [i["role"] for i in bob_sicht] == ["member"]

    alice_sicht = (await client.get("/me/instances", headers={"Cookie": alice_cookie})).json()
    assert [i["role"] for i in alice_sicht] == ["owner"]

    # Gegenprobe: Bob kommt an keine der Verwaltungs-Routen heran.
    r = await client.post(
        f"/me/instances/{alice_instance.id}/bootstrap-token",
        headers={"Cookie": bob_cookie},
    )
    assert r.status_code == 404, r.text
    r = await client.delete(f"/me/instances/{alice_instance.id}", headers={"Cookie": bob_cookie})
    assert r.status_code == 404, r.text


@pytest.mark.asyncio
async def test_join_membership_idempotent(client, bob_cookie, alice_instance):
    """Zweimal joinen ändert nichts (kein 409, eine Zeile)."""
    for _ in range(2):
        r = await client.post(
            f"/me/instances/{alice_instance.id}/membership",
            headers={"Cookie": bob_cookie},
        )
        assert r.status_code == 204, r.text
    after = await client.get("/me/instances", headers={"Cookie": bob_cookie})
    assert [i["id"] for i in after.json()] == [str(alice_instance.id)]


@pytest.mark.asyncio
async def test_join_membership_does_not_downgrade_owner(
    session_factory, client, alice_cookie, alice_instance
):
    """Ein Join des Owners lässt seine ``owner``-Rolle unverändert."""
    r = await client.post(
        f"/me/instances/{alice_instance.id}/membership",
        headers={"Cookie": alice_cookie},
    )
    assert r.status_code == 204, r.text
    async with session_factory() as session:
        row = await session.get(
            UserInstanceMembership,
            (int(alice_instance.registered_by), alice_instance.id),
        )
        assert row is not None and row.role == "owner"


@pytest.mark.asyncio
async def test_join_membership_404_nonexistent(client, bob_cookie):
    r = await client.post(
        "/me/instances/9999999999999/membership",
        headers={"Cookie": bob_cookie},
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_join_membership_requires_cookie(client, alice_instance):
    r = await client.post(f"/me/instances/{alice_instance.id}/membership")
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_leave_membership_hides_instance(client, bob_cookie, alice_instance):
    """Nach dem Austritt verschwindet die Instanz wieder aus Bobs Liste."""
    await client.post(
        f"/me/instances/{alice_instance.id}/membership",
        headers={"Cookie": bob_cookie},
    )
    leave = await client.delete(
        f"/me/instances/{alice_instance.id}/membership",
        headers={"Cookie": bob_cookie},
    )
    assert leave.status_code == 204, leave.text
    after = await client.get("/me/instances", headers={"Cookie": bob_cookie})
    assert after.json() == []


@pytest.mark.asyncio
async def test_leave_membership_idempotent_when_absent(
    client, bob_cookie, alice_instance
):
    """Austreten ohne Membership → 204 (idempotent), kein Fehler."""
    r = await client.delete(
        f"/me/instances/{alice_instance.id}/membership",
        headers={"Cookie": bob_cookie},
    )
    assert r.status_code == 204


@pytest.mark.asyncio
async def test_leave_membership_owner_forbidden(client, alice_cookie, alice_instance):
    """Der Owner kann seine Membership nicht per Austritt wegwerfen → 403."""
    r = await client.delete(
        f"/me/instances/{alice_instance.id}/membership",
        headers={"Cookie": alice_cookie},
    )
    assert r.status_code == 403


# ---------------------------------------------------------------------------
# PATCH /me/instances/{id}/preferences — geräteübergreifende Präferenzen
# (Label + Notification-Modus aus user_instance_memberships)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_instance_out_defaults_for_owner(client, alice_cookie, alice_instance):
    """Frische Membership → user_label None, notification_mode 'mentions'."""
    r = await client.get("/me/instances", headers={"Cookie": alice_cookie})
    assert r.status_code == 200
    inst = next(i for i in r.json() if i["id"] == str(alice_instance.id))
    assert inst["user_label"] is None
    assert inst["notification_mode"] == "mentions"


@pytest.mark.asyncio
async def test_patch_preferences_label_and_mode_roundtrip(
    client, alice_cookie, alice_instance
):
    """Label + Modus setzen → tauchen in GET /me/instances auf (geräteübergreifend)."""
    r = await client.patch(
        f"/me/instances/{alice_instance.id}/preferences",
        json={"label": "Mein Server", "notification_mode": "none"},
        headers={"Cookie": alice_cookie},
    )
    assert r.status_code == 204, r.text
    got = await client.get("/me/instances", headers={"Cookie": alice_cookie})
    inst = next(i for i in got.json() if i["id"] == str(alice_instance.id))
    assert inst["user_label"] == "Mein Server"
    assert inst["notification_mode"] == "none"


@pytest.mark.asyncio
async def test_patch_preferences_partial_keeps_other_field(
    client, alice_cookie, alice_instance
):
    """Nur den Modus patchen lässt ein zuvor gesetztes Label stehen."""
    await client.patch(
        f"/me/instances/{alice_instance.id}/preferences",
        json={"label": "Behalten"},
        headers={"Cookie": alice_cookie},
    )
    await client.patch(
        f"/me/instances/{alice_instance.id}/preferences",
        json={"notification_mode": "all"},
        headers={"Cookie": alice_cookie},
    )
    got = await client.get("/me/instances", headers={"Cookie": alice_cookie})
    inst = next(i for i in got.json() if i["id"] == str(alice_instance.id))
    assert inst["user_label"] == "Behalten"
    assert inst["notification_mode"] == "all"


@pytest.mark.asyncio
async def test_patch_preferences_label_null_clears(
    client, alice_cookie, alice_instance
):
    """label=null setzt den Anzeigenamen explizit zurück (Hostname anzeigen)."""
    await client.patch(
        f"/me/instances/{alice_instance.id}/preferences",
        json={"label": "Temp"},
        headers={"Cookie": alice_cookie},
    )
    await client.patch(
        f"/me/instances/{alice_instance.id}/preferences",
        json={"label": None},
        headers={"Cookie": alice_cookie},
    )
    got = await client.get("/me/instances", headers={"Cookie": alice_cookie})
    inst = next(i for i in got.json() if i["id"] == str(alice_instance.id))
    assert inst["user_label"] is None


@pytest.mark.asyncio
async def test_patch_preferences_404_without_membership(
    client, bob_cookie, alice_instance
):
    """Ohne eigene Membership → 404 (kein fremdes Schreiben)."""
    r = await client.patch(
        f"/me/instances/{alice_instance.id}/preferences",
        json={"label": "fremd"},
        headers={"Cookie": bob_cookie},
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_patch_preferences_requires_cookie(client, alice_instance):
    r = await client.patch(
        f"/me/instances/{alice_instance.id}/preferences", json={"label": "x"}
    )
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_me_instances_prefers_relay_subdomain(
    client, alice_cookie, alice_instance, session_factory
):
    """App-Host-Instanzen: der Client muss die ERREICHBARE Adresse bekommen.

    ``hostname`` ist bei ihnen ein synthetischer Platzhalter (``app-<id>.…``,
    existiert nicht im DNS); erreichbar sind sie erst unter der beim Pairing
    vergebenen Relay-Subdomain. Ohne diesen Vorrang baut der Client seine
    Server-URL aus dem Platzhalter, landet auf einem toten Host und der
    Cert-Login scheitert mit 401 (``cert_invalid``).
    """
    async with session_factory() as session:
        inst = await session.get(RegisteredInstance, alice_instance.id)
        inst.hostname = f"app-{alice_instance.id}.relay.example.com"
        inst.origin = "app_host"
        inst.relay_subdomain = "calm-thistle-98e3.relay.example.com"
        await session.commit()

    r = await client.get("/me/instances", headers={"Cookie": alice_cookie})
    assert r.status_code == 200, r.text
    assert r.json()[0]["hostname"] == "calm-thistle-98e3.relay.example.com"


@pytest.mark.asyncio
async def test_me_instances_falls_back_to_hostname_without_subdomain(
    client, alice_cookie, alice_instance
):
    """VPS-Instanzen (kein relay_subdomain) behalten ihren echten Hostname."""
    r = await client.get("/me/instances", headers={"Cookie": alice_cookie})
    assert r.status_code == 200, r.text
    assert r.json()[0]["hostname"] == "alice-instance.example.com"
