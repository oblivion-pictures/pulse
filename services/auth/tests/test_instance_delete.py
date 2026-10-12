"""Tests für DELETE /me/instances/{id} — Owner-Löschung (Soft-Delete).

Deckt ab: Happy-Path (Status/Hostname-Platzhalter/Kill-Switch-Eintrag),
Sichtbarkeit (Liste/Snippet/Bootstrap-Token nach Löschung), Ownership-404,
Hostname-Freigabe für Neuanträge, die Admin-Guards gegen 'deleted' und die
Ausnahme: eine GESPERRT gelöschte Instanz behält ihre Adresse, bis der Admin
sie freigibt.
"""

from __future__ import annotations

import secrets

import pytest
import pytest_asyncio
from dcc_auth.models import AdminAuditLog, User
from dcc_auth.models_instances import RegisteredInstance, SuspendedInstance
from dcc_auth.verbinden_eintrag import InstanzGesperrt, instanz_verbinden
from sqlalchemy import select

# ---------------------------------------------------------------------------
# Shared test credentials
# ---------------------------------------------------------------------------

_REG_OWNER = {
    "username": "del_owner",
    "email": "del_owner@dcc-test.example.com",
    "password": "correct horse battery staple",
    "display_name": "Owner",
}
_REG_OTHER = {
    "username": "del_other",
    "email": "del_other@dcc-test.example.com",
    "password": "correct horse battery staple",
    "display_name": "Other",
}
_LOGIN_OWNER = {"email_or_username": _REG_OWNER["email"], "password": _REG_OWNER["password"]}
_LOGIN_OTHER = {"email_or_username": _REG_OTHER["email"], "password": _REG_OTHER["password"]}

_HOSTNAME = "delete-me.example.com"
_INSTANCE_ID = 10000000000000042
_PLATZHALTER = f"deleted-{_INSTANCE_ID}.invalid"



# ---------------------------------------------------------------------------
# Helpers / fixtures
# ---------------------------------------------------------------------------


async def _reg_and_login(client, reg: dict, login: dict) -> str:
    await client.post("/register", json=reg)
    r = await client.post("/login", json=login)
    assert r.status_code == 200, r.text
    sid = r.cookies.get("pulse_session")
    assert sid, "pulse_session cookie fehlt"
    return f"pulse_session={sid}"


@pytest_asyncio.fixture
async def owner_cookie(client, session_factory) -> str:
    cookie = await _reg_and_login(client, _REG_OWNER, _LOGIN_OWNER)
    r = await client.get("/me", headers={"Cookie": cookie})
    uid = int(r.json()["id"])
    async with session_factory() as s:
        from dcc_auth.models import User
        user = await s.get(User, uid)
        user.self_host_enabled = True
        await s.commit()
    return cookie


@pytest_asyncio.fixture
async def other_cookie(client) -> str:
    return await _reg_and_login(client, _REG_OTHER, _LOGIN_OTHER)


async def _seed_instance(
    session_factory, client, owner_cookie: str, *, status: str = "active"
) -> RegisteredInstance:
    r = await client.get("/me", headers={"Cookie": owner_cookie})
    assert r.status_code == 200, r.text
    owner_id = int(r.json()["id"])

    async with session_factory() as session:
        inst = RegisteredInstance(
            id=_INSTANCE_ID,
            hostname=_HOSTNAME,
            client_id=f"ci_{secrets.token_hex(8)}",
            client_secret="$argon2id$v=19$m=65536,t=3,p=4$fakehash",
            worker_id_chat=100,
            worker_id_voice=101,
            worker_id_media=102,
            status=status,
            registered_by=owner_id,
        )
        session.add(inst)
        await session.commit()
    return inst


@pytest_asyncio.fixture
async def owner_instance(session_factory, client, owner_cookie) -> RegisteredInstance:
    return await _seed_instance(session_factory, client, owner_cookie)


async def _fetch_instance(session_factory) -> RegisteredInstance | None:
    async with session_factory() as session:
        return await session.get(RegisteredInstance, _INSTANCE_ID)


async def _fetch_suspend_rows(session_factory) -> list[SuspendedInstance]:
    async with session_factory() as session:
        rows = await session.execute(
            select(SuspendedInstance).where(SuspendedInstance.instance_id == _INSTANCE_ID)
        )
        return list(rows.scalars().all())


# ---------------------------------------------------------------------------
# Auth + Ownership
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_delete_requires_cookie(client):
    r = await client.delete("/me/instances/12345")
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_delete_404_for_other_user(client, other_cookie, owner_instance, session_factory):
    r = await client.delete(
        f"/me/instances/{owner_instance.id}", headers={"Cookie": other_cookie}
    )
    assert r.status_code == 404
    inst = await _fetch_instance(session_factory)
    assert inst is not None and inst.status == "active"


@pytest.mark.asyncio
async def test_delete_404_nonexistent_and_invalid_id(client, owner_cookie):
    r = await client.delete("/me/instances/999999999", headers={"Cookie": owner_cookie})
    assert r.status_code == 404
    r = await client.delete("/me/instances/not-a-number", headers={"Cookie": owner_cookie})
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_delete_happy_path(client, owner_cookie, owner_instance, session_factory):
    r = await client.delete(
        f"/me/instances/{owner_instance.id}", headers={"Cookie": owner_cookie}
    )
    assert r.status_code == 204, r.text

    # Soft-Delete: Zeile bleibt (Worker-IDs verbrannt), Hostname freigegeben.
    inst = await _fetch_instance(session_factory)
    assert inst is not None
    assert inst.status == "deleted"
    assert inst.hostname == f"deleted-{_INSTANCE_ID}.invalid"

    # Kill-Switch: Eintrag auf der Suspend-Liste.
    suspend_rows = await _fetch_suspend_rows(session_factory)
    assert len(suspend_rows) == 1
    assert suspend_rows[0].reason == "Vom Besitzer gelöscht"

    # Für den Owner unsichtbar.
    r = await client.get("/me/instances", headers={"Cookie": owner_cookie})
    assert r.status_code == 200
    assert r.json() == []

    # Zweites Löschen → 404 (weg ist weg).
    r = await client.delete(
        f"/me/instances/{owner_instance.id}", headers={"Cookie": owner_cookie}
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_delete_appears_in_wellknown_deleted_list(
    client, owner_cookie, owner_instance, session_factory
):
    """Gelöschte Instanz steht in instance_ids UND deleted_instance_ids."""
    r = await client.delete(
        f"/me/instances/{owner_instance.id}", headers={"Cookie": owner_cookie}
    )
    assert r.status_code == 204

    r = await client.get("/.well-known/pulse-suspended-instances")
    assert r.status_code == 200
    # CORS-offen — der Browser-Sweep fetcht auch von Self-Host-Origins.
    assert r.headers.get("access-control-allow-origin") == "*"
    body = r.json()
    assert str(_INSTANCE_ID) in body["instance_ids"]
    assert str(_INSTANCE_ID) in body["deleted_instance_ids"]


@pytest.mark.asyncio
async def test_admin_suspend_not_in_deleted_list(client, owner_cookie, session_factory):
    """Nur admin-suspendiert (reversibel) → instance_ids ja, deleted_instance_ids nein."""
    await _seed_instance(session_factory, client, owner_cookie, status="suspended")
    async with session_factory() as session:
        session.add(SuspendedInstance(instance_id=_INSTANCE_ID, reason="admin"))
        await session.commit()

    r = await client.get("/.well-known/pulse-suspended-instances")
    assert r.status_code == 200
    body = r.json()
    assert str(_INSTANCE_ID) in body["instance_ids"]
    assert str(_INSTANCE_ID) not in body["deleted_instance_ids"]


@pytest.mark.asyncio
async def test_delete_blocks_snippet_and_bootstrap_token(
    client, owner_cookie, owner_instance, session_factory
):
    r = await client.delete(
        f"/me/instances/{owner_instance.id}", headers={"Cookie": owner_cookie}
    )
    assert r.status_code == 204

    r = await client.get(
        f"/me/instances/{owner_instance.id}/docker-compose-snippet",
        headers={"Cookie": owner_cookie},
    )
    assert r.status_code == 404

    r = await client.post(
        f"/me/instances/{owner_instance.id}/bootstrap-token",
        headers={"Cookie": owner_cookie},
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_delete_suspended_instance_keeps_single_suspend_entry(
    client, owner_cookie, session_factory
):
    """Admin-suspendierte Instanz darf der Owner löschen — ohne doppelten Suspend-Eintrag."""
    await _seed_instance(session_factory, client, owner_cookie, status="suspended")
    async with session_factory() as session:
        session.add(SuspendedInstance(instance_id=_INSTANCE_ID, reason="admin"))
        await session.commit()

    r = await client.delete(f"/me/instances/{_INSTANCE_ID}", headers={"Cookie": owner_cookie})
    assert r.status_code == 204

    inst = await _fetch_instance(session_factory)
    assert inst is not None and inst.status == "deleted"
    suspend_rows = await _fetch_suspend_rows(session_factory)
    assert len(suspend_rows) == 1
    assert suspend_rows[0].reason == "admin"


async def _verbinden(session_factory, client, cookie: str):
    """Verbindet ``_HOSTNAME`` für das Konto hinter ``cookie`` über
    ``instanz_verbinden`` — die Stelle, an der sich entscheidet, ob eine Adresse
    zu haben ist (die Gerätecode-Route davor prüft ``test_verbinden_routen.py``)."""
    uid = int((await client.get("/me", headers={"Cookie": cookie})).json()["id"])
    async with session_factory() as s:
        verbunden = await instanz_verbinden(s, await s.get(User, uid), _HOSTNAME)
        await s.commit()
        await s.refresh(verbunden.instanz)
        return verbunden


async def _gesperrte_instanz_saeen(session_factory, client, owner_cookie: str) -> None:
    """Eine vom Admin gesperrte Instanz samt Sperrlisten-Eintrag."""
    await _seed_instance(session_factory, client, owner_cookie, status="suspended")
    async with session_factory() as session:
        session.add(SuspendedInstance(instance_id=_INSTANCE_ID, reason="admin"))
        await session.commit()


@pytest.mark.asyncio
async def test_delete_suspended_instance_keeps_address_blocked(
    client, owner_cookie, session_factory
):
    """Der Besitzer darf eine gesperrte Instanz löschen — die Adresse wird dadurch
    nicht frei, sonst verbände er sich unter ihr sofort neu und die Sperre wäre
    umgangen. Der echte Hostname bleibt stehen, bis der Admin sie freigibt."""
    await _gesperrte_instanz_saeen(session_factory, client, owner_cookie)

    r = await client.delete(f"/me/instances/{_INSTANCE_ID}", headers={"Cookie": owner_cookie})
    assert r.status_code == 204, r.text

    inst = await _fetch_instance(session_factory)
    assert inst is not None and inst.status == "deleted"
    assert inst.hostname == _HOSTNAME
    # Der Sperr-Eintrag des Admins bleibt unverändert die einzige Zeile.
    (sperre,) = await _fetch_suspend_rows(session_factory)
    assert sperre.reason == "admin"

    # Verbinden unter der Adresse wird abgewiesen, auch für den Besitzer selbst.
    with pytest.raises(InstanzGesperrt):
        await _verbinden(session_factory, client, owner_cookie)


# ---------------------------------------------------------------------------
# Admin-Guards gegen 'deleted'
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture
async def admin_token(client, session_factory, owner_cookie) -> str:
    """Eigener Admin-User (Bearer-Token) — owner_cookie zuerst, damit der
    Bootstrap-Admin-Slot (erster User) schon verbraucht ist."""
    await client.post(
        "/register",
        json={
            "username": "del_admin",
            "email": "del_admin@dcc-test.example.com",
            "password": "correct horse battery staple",
        },
    )
    async with session_factory() as s:
        user = (
            await s.execute(select(User).where(User.username == "del_admin"))
        ).scalar_one()
        user.is_admin = True
        await s.commit()
    r = await client.post(
        "/login",
        json={
            "email_or_username": "del_admin",
            "password": "correct horse battery staple",
        },
    )
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


@pytest.mark.asyncio
async def test_admin_actions_409_on_deleted(
    client, owner_cookie, owner_instance, session_factory, admin_token
):
    r = await client.delete(
        f"/me/instances/{owner_instance.id}", headers={"Cookie": owner_cookie}
    )
    assert r.status_code == 204

    headers = {"Authorization": f"Bearer {admin_token}"}
    r = await client.delete(f"/admin/instances/{owner_instance.id}", headers=headers)
    assert r.status_code == 409
    r = await client.post(f"/admin/instances/{owner_instance.id}/unsuspend", headers=headers)
    assert r.status_code == 409
    r = await client.post(
        f"/admin/instances/{owner_instance.id}/rotate-secret", headers=headers
    )
    assert r.status_code == 409


@pytest.mark.asyncio
async def test_delete_cleans_memberships_directory_and_application(
    client, owner_cookie, other_cookie, owner_instance, session_factory
):
    """Löschung räumt ALLE abhängigen Zustände ab (Fund vom Extern-Test 2026-07-10):

    Ohne den Cleanup behielten Mitglieder eine Server-Kachel ohne Server, und
    das Direktpfad-Telefonbuch nannte eine tote Adresse. Der genehmigte
    Ursprungs-Antrag wird geschlossen — die Anträge sind seit Oktober 2026 nur
    noch Historie (Spec E11), und die soll stimmen: eine gelöschte Instanz hat
    keinen „genehmigten" Antrag mehr.
    """
    from dcc_auth.models_instances import (
        InstanceApplication,
        InstanceDirectEndpoint,
        UserInstanceMembership,
    )

    r = await client.get("/me", headers={"Cookie": owner_cookie})
    owner_id = int(r.json()["id"])
    r = await client.get("/me", headers={"Cookie": other_cookie})
    other_id = int(r.json()["id"])

    app_id = 10000000000000077
    async with session_factory() as s:
        s.add(
            InstanceApplication(
                id=app_id,
                applicant_user_id=owner_id,
                hostname=_HOSTNAME,
                purpose="privat",
                expected_users=5,
                contact_email=_REG_OWNER["email"],
                status="approved",
                approved_instance_id=_INSTANCE_ID,
            )
        )
        s.add(UserInstanceMembership(user_id=owner_id, instance_id=_INSTANCE_ID, role="owner"))
        s.add(UserInstanceMembership(user_id=other_id, instance_id=_INSTANCE_ID, role="member"))
        s.add(
            InstanceDirectEndpoint(
                instance_id=_INSTANCE_ID,
                candidates=[{"ip": "203.0.113.7", "port": 7900, "protocol": "udp"}],
                fingerprint="sha-256 AA:BB",
            )
        )
        await s.commit()

    r = await client.delete(
        f"/me/instances/{owner_instance.id}", headers={"Cookie": owner_cookie}
    )
    assert r.status_code == 204, r.text

    async with session_factory() as s:
        memberships = (
            (
                await s.execute(
                    select(UserInstanceMembership).where(
                        UserInstanceMembership.instance_id == _INSTANCE_ID
                    )
                )
            )
            .scalars()
            .all()
        )
        assert memberships == []

        endpoint = await s.get(InstanceDirectEndpoint, _INSTANCE_ID)
        assert endpoint is None

        application = await s.get(InstanceApplication, app_id)
        assert application is not None
        assert application.status == "closed"


@pytest.mark.asyncio
async def test_admin_gibt_die_adresse_einer_gesperrt_geloeschten_instanz_frei(
    client, owner_cookie, session_factory, admin_token
):
    await _gesperrte_instanz_saeen(session_factory, client, owner_cookie)
    r = await client.delete(f"/me/instances/{_INSTANCE_ID}", headers={"Cookie": owner_cookie})
    assert r.status_code == 204, r.text
    headers = {"Authorization": f"Bearer {admin_token}"}

    # Der Admin sieht sie bei den gesperrten — sonst gäbe es keinen Weg zur Freigabe.
    r = await client.get("/admin/instances?status=suspended", headers=headers)
    assert [(i["id"], i["status"], i["hostname"]) for i in r.json()] == [
        (str(_INSTANCE_ID), "deleted", _HOSTNAME)
    ]

    r = await client.post(f"/admin/instances/{_INSTANCE_ID}/unsuspend", headers=headers)
    assert r.status_code == 204, r.text

    # Gelöscht bleibt gelöscht; frei ist nur die Adresse. Der Sperrlisten-Eintrag
    # bleibt, gelöschte Instanzen stehen dauerhaft darauf.
    inst = await _fetch_instance(session_factory)
    assert (inst.status, inst.hostname) == ("deleted", _PLATZHALTER)
    assert len(await _fetch_suspend_rows(session_factory)) == 1
    async with session_factory() as s:
        spur = (
            await s.execute(
                select(AdminAuditLog).where(AdminAuditLog.action == "instance.release_address")
            )
        ).scalar_one()
    assert spur.target_id == _INSTANCE_ID
    assert spur.payload == {"hostname": _HOSTNAME}

    # Sie steht nicht mehr bei den gesperrten, und es ist nichts mehr freizugeben.
    r = await client.get("/admin/instances?status=suspended", headers=headers)
    assert r.json() == []
    r = await client.post(f"/admin/instances/{_INSTANCE_ID}/unsuspend", headers=headers)
    assert r.status_code == 409

    # Die Adresse ist wieder zu haben.
    verbunden = await _verbinden(session_factory, client, owner_cookie)
    assert (verbunden.instanz.hostname, verbunden.instanz.status) == (_HOSTNAME, "active")
