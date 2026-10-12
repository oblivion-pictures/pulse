"""Tests für das Flag ``self_host_enabled``: Admin-Schalter und ``/me``.

Bis Oktober 2026 gab es dazu ein Gate am ``.env``-Download; der Download ist
entfernt (Spec E11), das Flag bleibt für den Server-App-Weg (Spec E8).
"""

from __future__ import annotations

import pytest
import pytest_asyncio

from dcc_auth.models import User

_REG_CAROL = {
    "username": "gate_carol",
    "email": "gate_carol@dcc-test.example.com",
    "password": "correct horse battery staple",
    "display_name": "Carol",
}
_REG_ADMIN = {
    "username": "gate_admin",
    "email": "gate_admin@dcc-test.example.com",
    "password": "correct horse battery staple",
    "display_name": "GateAdmin",
}


async def _reg_and_login(client, reg: dict) -> tuple[str, str]:
    """Register + login → (cookie-header, user_id)."""
    await client.post("/register", json=reg)
    r = await client.post(
        "/login", json={"email_or_username": reg["email"], "password": reg["password"]}
    )
    assert r.status_code == 200, r.text
    sid = r.cookies.get("pulse_session")
    me = await client.get("/me", headers={"Cookie": f"pulse_session={sid}"})
    return f"pulse_session={sid}", me.json()["id"]


@pytest_asyncio.fixture
async def carol(client, session_factory):
    cookie, uid = await _reg_and_login(client, _REG_CAROL)
    return {"cookie": cookie, "id": uid}


@pytest_asyncio.fixture
async def admin_user(client, session_factory):
    cookie, uid = await _reg_and_login(client, _REG_ADMIN)
    async with session_factory() as s:
        user = await s.get(User, int(uid))
        user.is_admin = True
        await s.commit()
    # Re-login to get an admin-token (JWT carries the claim at mint time).
    r = await client.post(
        "/login",
        json={"email_or_username": _REG_ADMIN["email"], "password": _REG_ADMIN["password"]},
    )
    assert r.status_code == 200, r.text
    token = r.json()["access_token"]
    return {"token": token, "id": uid}


# --------------------------------------------------------------------------- #
# Admin PATCH toggle                                                            #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_admin_patch_toggles_self_host(client, admin_user, carol, session_factory):
    """PATCH /admin/users/{id} with self_host_enabled=true → 200, flag set."""
    r = await client.patch(
        f"/admin/users/{carol['id']}",
        json={"self_host_enabled": True},
        headers={"Authorization": f"Bearer {admin_user['token']}"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["self_host_enabled"] is True

    # Verify DB column was actually updated.
    async with session_factory() as s:
        user = await s.get(User, int(carol["id"]))
        assert user.self_host_enabled is True


# --------------------------------------------------------------------------- #
# /me exposes the flag                                                          #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_me_exposes_self_host_enabled(client, carol):
    """GET /me must include self_host_enabled (default false for a new user)."""
    r = await client.get("/me", headers={"Cookie": carol["cookie"]})
    assert r.status_code == 200, r.text
    data = r.json()
    assert "self_host_enabled" in data
    assert data["self_host_enabled"] is False
