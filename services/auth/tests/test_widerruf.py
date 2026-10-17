"""Ein Zugriffstoken gilt am auth-svc nur, solange seine Anmelde-Kette lebt.

Mechanik und Begründung: ``dcc_auth/widerruf.py``. Die Erneuerungs-Wege nach
einem Widerruf stehen in ``test_session_renew.py``, der Passwort-Reset in
``test_recovery.py``; hier die übrigen Widerrufswege und die Grenzfälle.
"""

from __future__ import annotations

import pytest
from dcc_auth.security import get_signer

_ADMIN = {
    "username": "widerruf_admin",
    "email": "widerruf-admin@dcc-test.example.com",
    "password": "correct horse battery staple",
    "display_name": "Admin",
}
_NUTZER = {
    "username": "widerruf_nutzer",
    "email": "widerruf-nutzer@dcc-test.example.com",
    "password": "correct horse battery staple",
    "display_name": "Nutzer",
}


def _bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _registrieren(client, daten: dict) -> tuple[str, str, int]:
    """→ (Zugriffstoken, Refresh-Token, Konto-ID)."""
    r = await client.post("/register", json=daten)
    assert r.status_code == 201, r.text
    access = r.json()["access_token"]
    me = await client.get("/me", headers=_bearer(access))
    assert me.status_code == 200, me.text
    return access, r.json()["refresh_token"], int(me.json()["id"])


async def _abgewiesen(client, access: str) -> None:
    """Weder ``/me`` noch ein neues Cookie."""
    assert (await client.get("/me", headers=_bearer(access))).status_code == 401
    r = await client.post("/session/renew", headers=_bearer(access))
    assert r.status_code == 401, r.text
    assert "pulse_session" not in r.cookies


@pytest.mark.asyncio
async def test_token_ohne_kette_wird_abgewiesen(client):
    """Jedes Token, das der auth-svc ausstellt, trägt seine Kette; eines ohne
    wäre an keinen Widerruf gebunden und kommt deshalb nicht durch."""
    _access, _rt, uid = await _registrieren(client, _NUTZER)
    ohne = get_signer().issue_access(uid, _NUTZER["username"])
    await _abgewiesen(client, ohne)


@pytest.mark.asyncio
async def test_abmelden_beendet_das_zugriffstoken_am_auth_svc(client):
    access, refresh, _uid = await _registrieren(client, _NUTZER)
    r = await client.post("/logout", json={"refresh_token": refresh})
    assert r.status_code == 200, r.text
    await _abgewiesen(client, access)


@pytest.mark.asyncio
async def test_rotation_haelt_die_kette_am_leben(client):
    """Nach ``/refresh`` ist die alte Zeile widerrufen, die Kette lebt in der
    neuen weiter — das noch gültige alte Zugriffstoken bleibt brauchbar."""
    access, refresh, _uid = await _registrieren(client, _NUTZER)
    r = await client.post("/refresh", json={"refresh_token": refresh})
    assert r.status_code == 200, r.text
    assert (await client.get("/me", headers=_bearer(access))).status_code == 200
    assert (await client.get("/me", headers=_bearer(r.json()["access_token"]))).status_code == 200


@pytest.mark.asyncio
async def test_entsperren_belebt_alte_zugriffstoken_nicht(client):
    """Sperren und binnen 15 Minuten entsperren: vorher prüfte der auth-svc nur
    ``disabled``, und das alte Token galt wieder. Die Sperre hat seine Kette
    beendet."""
    admin, _rt, _aid = await _registrieren(client, _ADMIN)
    access, _rt2, uid = await _registrieren(client, _NUTZER)
    for gesperrt in (True, False):
        r = await client.patch(
            f"/admin/users/{uid}", json={"disabled": gesperrt}, headers=_bearer(admin)
        )
        assert r.status_code == 200, r.text
    await _abgewiesen(client, access)
    neu = await client.post(
        "/login",
        json={"email_or_username": _NUTZER["email"], "password": _NUTZER["password"]},
    )
    assert neu.status_code == 200, neu.text
    assert (await client.get("/me", headers=_bearer(neu.json()["access_token"]))).status_code == 200
