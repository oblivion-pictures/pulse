"""Tests for Phase 2.3 Admin-Instance-Management endpoints.

Pattern mirrors test_admin.py: register users via HTTP, promote via SQLAlchemy,
login to get fresh tokens, then exercise the endpoints.

Antrag und Freigabe (``/admin/instance-applications``) sind seit Oktober 2026
entfernt (Spec E11). Die Instanzen dieser Suite entstehen deshalb direkt in
der Datenbank (``_seed_instance``) — so, wie ein Bestandsserver aus der
Freigabe-Zeit dort steht.
"""

from __future__ import annotations

import secrets

import pytest
from sqlalchemy import select

from dcc_auth.models import AdminAuditLog, User
from dcc_auth.models_instances import (
    RegisteredInstance,
    SuspendedInstance,
    UserInstanceMembership,
)
from dcc_auth.security import hash_password, verify_password
from dcc_auth.snowflake import next_id


# --------------------------------------------------------------------------- #
# Helpers                                                                       #
# --------------------------------------------------------------------------- #


async def _register(client, *, username: str, email: str) -> str:
    r = await client.post(
        "/register",
        json={"username": username, "email": email, "password": "correct horse battery staple"},
    )
    assert r.status_code == 201, r.text
    return r.json()["access_token"]


async def _promote(session_factory, username: str) -> None:
    async with session_factory() as s:
        user = (await s.execute(select(User).where(User.username == username))).scalar_one()
        user.is_admin = True
        await s.commit()


async def _login(client, *, username: str) -> str:
    r = await client.post(
        "/login",
        json={"email_or_username": username, "password": "correct horse battery staple"},
    )
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


async def _seed_instance(
    session_factory, *, user_id: int, hostname: str
) -> tuple[str, str]:
    """Aktive VPS-Instanz samt Besitzer-Mitgliedschaft anlegen, wie ein
    Bestandsserver aus der Freigabe-Zeit (mit Worker-IDs, die neue Einträge
    seit Oktober 2026 nicht mehr bekommen).

    Gibt ``(Instanz-ID als String, Klartext-Secret)`` zurück.
    """
    iid = next_id()
    secret = secrets.token_urlsafe(32)
    async with session_factory() as s:
        s.add(
            RegisteredInstance(
                id=iid,
                hostname=hostname,
                client_id=f"ci_{iid}",
                client_secret=hash_password(secret),
                worker_id_chat=900,
                worker_id_voice=901,
                worker_id_media=902,
                status="active",
                registered_by=user_id,
            )
        )
        s.add(UserInstanceMembership(user_id=user_id, instance_id=iid, role="owner"))
        await s.commit()
    return str(iid), secret


async def _get_user_id(session_factory, username: str) -> int:
    async with session_factory() as s:
        user = (await s.execute(select(User).where(User.username == username))).scalar_one()
        return user.id


# --------------------------------------------------------------------------- #
# Fixtures                                                                      #
# --------------------------------------------------------------------------- #


@pytest.fixture
async def admin_token(client, session_factory):
    await _register(client, username="alice", email="alice@dcc-test.example.com")
    await _promote(session_factory, "alice")
    return await _login(client, username="alice")


@pytest.fixture
async def regular_token(client):
    # Burn the bootstrap-admin slot first
    await _register(client, username="bootstrap", email="bootstrap@dcc-test.example.com")
    return await _register(client, username="bob", email="bob@dcc-test.example.com")


@pytest.fixture
async def applicant_user_id(client, session_factory):
    """Register a throwaway user and return their id (for seeding instances)."""
    # bootstrap slot already consumed by now if admin_token fixture ran first;
    # we seed directly so we don't need to worry about order.
    await _register(client, username="operator", email="operator@dcc-test.example.com")
    return await _get_user_id(session_factory, "operator")


# --------------------------------------------------------------------------- #
# 1. Auth gate — all endpoints must 403 for non-admins                         #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_list_instances_403(client, regular_token):
    r = await client.get(
        "/admin/instances",
        headers={"Authorization": f"Bearer {regular_token}"},
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_suspend_403_for_non_admin(client, regular_token):
    r = await client.delete(
        "/admin/instances/1",
        headers={"Authorization": f"Bearer {regular_token}"},
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_unsuspend_403_for_non_admin(client, regular_token):
    r = await client.post(
        "/admin/instances/1/unsuspend",
        headers={"Authorization": f"Bearer {regular_token}"},
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_rotate_secret_403_for_non_admin(client, regular_token):
    r = await client.post(
        "/admin/instances/1/rotate-secret",
        headers={"Authorization": f"Bearer {regular_token}"},
    )
    assert r.status_code == 403


# --------------------------------------------------------------------------- #
# 2. Antrag und Freigabe sind entfernt                                          #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_antrags_verwaltung_ist_entfernt(client, admin_token):
    """Seit Oktober 2026 gibt es keine Freigabe mehr (Spec E11) — die Routen
    sind weg, auch für Admins. Ein 404 statt 403: es gibt sie schlicht nicht."""
    h = {"Authorization": f"Bearer {admin_token}"}
    assert (await client.get("/admin/instance-applications", headers=h)).status_code == 404
    r = await client.post("/admin/instance-applications/1/approve", headers=h)
    assert r.status_code == 404
    r = await client.post(
        "/admin/instance-applications/1/reject", json={"rejection_reason": "x"}, headers=h
    )
    assert r.status_code == 404


# --------------------------------------------------------------------------- #
# 3. List instances — no client_secret in response                              #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_list_instances_no_secret(client, admin_token, session_factory, applicant_user_id):
    await _seed_instance(
        session_factory, user_id=applicant_user_id, hostname="sec-check.example.com"
    )

    r = await client.get(
        "/admin/instances",
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert r.status_code == 200
    data = r.json()
    assert len(data) >= 1
    for item in data:
        assert "client_secret" not in item


@pytest.mark.asyncio
async def test_list_instances_status_filter(client, admin_token, session_factory, applicant_user_id):
    await _seed_instance(
        session_factory, user_id=applicant_user_id, hostname="filter-test.example.com"
    )

    r_active = await client.get(
        "/admin/instances?status=active",
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert r_active.status_code == 200
    assert len(r_active.json()) >= 1

    r_suspended = await client.get(
        "/admin/instances?status=suspended",
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert r_suspended.status_code == 200
    assert r_suspended.json() == []


# --------------------------------------------------------------------------- #
# 4. Suspend → DB state                                                         #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_suspend_happy(client, admin_token, session_factory, applicant_user_id):
    inst_id, _ = await _seed_instance(
        session_factory, user_id=applicant_user_id, hostname="suspend-me.example.com"
    )
    inst_id_int = int(inst_id)

    r = await client.delete(
        f"/admin/instances/{inst_id}",
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert r.status_code == 204

    async with session_factory() as s:
        inst = await s.get(RegisteredInstance, inst_id_int)
        assert inst.status == "suspended"
        susp = await s.get(SuspendedInstance, inst_id_int)
        assert susp is not None
        assert susp.instance_id == inst_id_int


@pytest.mark.asyncio
async def test_suspend_idempotent(client, admin_token, session_factory, applicant_user_id):
    inst_id, _ = await _seed_instance(
        session_factory, user_id=applicant_user_id, hostname="suspend-idem.example.com"
    )

    r1 = await client.delete(
        f"/admin/instances/{inst_id}", headers={"Authorization": f"Bearer {admin_token}"}
    )
    r2 = await client.delete(
        f"/admin/instances/{inst_id}", headers={"Authorization": f"Bearer {admin_token}"}
    )
    assert r1.status_code == 204
    assert r2.status_code == 204  # idempotent


# --------------------------------------------------------------------------- #
# 5. Unsuspend → row gone, status active                                        #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_unsuspend_happy(client, admin_token, session_factory, applicant_user_id):
    inst_id, _ = await _seed_instance(
        session_factory, user_id=applicant_user_id, hostname="unsuspend-me.example.com"
    )
    inst_id_int = int(inst_id)

    await client.delete(
        f"/admin/instances/{inst_id}", headers={"Authorization": f"Bearer {admin_token}"}
    )

    r = await client.post(
        f"/admin/instances/{inst_id}/unsuspend",
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert r.status_code == 204

    async with session_factory() as s:
        inst = await s.get(RegisteredInstance, inst_id_int)
        assert inst.status == "active"
        susp = await s.get(SuspendedInstance, inst_id_int)
        assert susp is None


@pytest.mark.asyncio
async def test_unsuspend_idempotent(client, admin_token, session_factory, applicant_user_id):
    inst_id, _ = await _seed_instance(
        session_factory, user_id=applicant_user_id, hostname="unsuspend-idem.example.com"
    )

    # Not suspended yet — unsuspend should be a no-op
    r = await client.post(
        f"/admin/instances/{inst_id}/unsuspend",
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert r.status_code == 204


# --------------------------------------------------------------------------- #
# 5b. Gelöschte Instanz, die ihre Adresse noch hält                             #
#     (der Besitzer hat eine GESPERRTE Instanz gelöscht, geloeschte_adresse.py) #
# --------------------------------------------------------------------------- #


async def _seed_instanz(
    session_factory, *, iid: int, hostname: str, status: str, user_id: int
) -> None:
    async with session_factory() as s:
        s.add(
            RegisteredInstance(
                id=iid,
                hostname=hostname,
                client_id=f"adr-{iid}",
                client_secret="$argon2id$v=19$m=65536,t=3,p=4$x",
                status=status,
                origin="vps",
                registered_by=user_id,
            )
        )
        if status != "active":
            s.add(SuspendedInstance(instance_id=iid, reason="test"))
        await s.commit()


async def _liste(client, token: str, status_filter: str) -> list[tuple[str, str]]:
    r = await client.get(
        f"/admin/instances?status={status_filter}", headers={"Authorization": f"Bearer {token}"}
    )
    assert r.status_code == 200, r.text
    return sorted((i["id"], i["status"]) for i in r.json())


@pytest.mark.asyncio
async def test_list_suspended_includes_deleted_with_real_address(
    client, admin_token, session_factory, applicant_user_id
):
    """Ohne diese Zeilen hätte der Admin keinen Weg, die Adresse freizugeben.
    Eine gelöschte Instanz mit Platzhalter ist nichts Gesperrtes mehr."""
    uid = applicant_user_id
    await _seed_instanz(session_factory, iid=970001, hostname="a.example.org",
                        status="suspended", user_id=uid)
    await _seed_instanz(session_factory, iid=970002, hostname="b.example.org",
                        status="deleted", user_id=uid)
    await _seed_instanz(session_factory, iid=970003, hostname="deleted-970003.invalid",
                        status="deleted", user_id=uid)
    await _seed_instanz(session_factory, iid=970004, hostname="d.example.org",
                        status="active", user_id=uid)

    assert await _liste(client, admin_token, "suspended") == [
        ("970001", "suspended"),
        ("970002", "deleted"),
    ]
    # Die anderen Filter bleiben, was sie waren.
    assert await _liste(client, admin_token, "deleted") == [
        ("970002", "deleted"),
        ("970003", "deleted"),
    ]
    assert await _liste(client, admin_token, "active") == [("970004", "active")]


@pytest.mark.asyncio
async def test_unsuspend_releases_address_of_deleted_instance(
    client, admin_token, session_factory, applicant_user_id
):
    await _seed_instanz(session_factory, iid=970010, hostname="frei.example.org",
                        status="deleted", user_id=applicant_user_id)

    r = await client.post(
        "/admin/instances/970010/unsuspend",
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert r.status_code == 204, r.text

    async with session_factory() as s:
        inst = await s.get(RegisteredInstance, 970010)
        sperre = await s.get(SuspendedInstance, 970010)
        spur = (
            await s.execute(
                select(AdminAuditLog).where(AdminAuditLog.action == "instance.release_address")
            )
        ).scalar_one()
    # Nie wieder aktiv, nie wieder von der Sperrliste: nur die Adresse ist frei.
    assert (inst.status, inst.hostname) == ("deleted", "deleted-970010.invalid")
    assert sperre is not None
    assert (spur.target_id, spur.payload) == (970010, {"hostname": "frei.example.org"})


@pytest.mark.asyncio
async def test_unsuspend_409_for_deleted_without_address(
    client, admin_token, session_factory, applicant_user_id
):
    """Normal gelöscht (Platzhalter) oder schon freigegeben: nichts freizugeben."""
    await _seed_instanz(session_factory, iid=970020, hostname="deleted-970020.invalid",
                        status="deleted", user_id=applicant_user_id)
    r = await client.post(
        "/admin/instances/970020/unsuspend",
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert r.status_code == 409
    async with session_factory() as s:
        spuren = (
            await s.execute(
                select(AdminAuditLog).where(AdminAuditLog.action == "instance.release_address")
            )
        ).scalars().all()
    assert spuren == []


# --------------------------------------------------------------------------- #
# 6. Rotate secret                                                               #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_rotate_secret(client, admin_token, session_factory, applicant_user_id):
    inst_id, old_secret_plain = await _seed_instance(
        session_factory, user_id=applicant_user_id, hostname="rotate-me.example.com"
    )
    inst_id_int = int(inst_id)

    async with session_factory() as s:
        inst = await s.get(RegisteredInstance, inst_id_int)
        old_hash = inst.client_secret

    r = await client.post(
        f"/admin/instances/{inst_id}/rotate-secret",
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert "client_secret" in data
    assert len(data["client_secret"]) > 20
    assert data["client_secret"] != old_secret_plain
    assert "warning" in data

    async with session_factory() as s:
        inst = await s.get(RegisteredInstance, inst_id_int)
        new_hash = inst.client_secret
        # Hash changed
        assert new_hash != old_hash
        # Old plaintext no longer verifies
        assert not verify_password(old_secret_plain, new_hash)
        # New plaintext verifies
        assert verify_password(data["client_secret"], new_hash)


# --------------------------------------------------------------------------- #
# Cloud-only gate — the whole surface 403s on a self-host deployment           #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_instance_admin_is_cloud_only(client, admin_token, monkeypatch):
    """Approving/suspending Self-Host instances is cloud-only: on a self-host
    deployment (PULSE_INSTANCE_MODE != cloud) even an admin gets 403."""
    from types import SimpleNamespace

    import dcc_auth.routes_admin_instances as rai

    h = {"Authorization": f"Bearer {admin_token}"}
    # Cloud (test default) → reachable.
    assert (await client.get("/admin/instances", headers=h)).status_code == 200

    # Flip the instance role to self-host → the router-level gate 403s.
    monkeypatch.setattr(
        rai, "get_settings", lambda: SimpleNamespace(pulse_instance_mode="self-host")
    )
    r = await client.get("/admin/instances", headers=h)
    assert r.status_code == 403
    assert "cloud-only" in r.text
