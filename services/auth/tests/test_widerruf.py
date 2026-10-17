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


# ---- „Überall sonst abmelden“ erkennt das eigene Gerät an der Kette ---------
#
# Bis 2026-10-17 nur an IP-Hash + UA: wechselte die IP seit der letzten Rotation
# (Mobilfunk-CGNAT, IPv4/IPv6), traf ``DELETE /sessions`` auch die eigene Kette
# und meldete den Aufrufer sofort ab. Die Test-Gegenstelle ist 127.0.0.1, also
# ein vertrauter Proxy — ``X-Forwarded-For`` setzt die Adresse.


def _von(ip: str, ua: str = "Handy/1") -> dict[str, str]:
    return {"X-Forwarded-For": ip, "User-Agent": ua}


async def _zwei_geraete(client) -> tuple:
    """Gerät 1 (rotiert zuletzt von 10.0.0.1), Gerät 2 (Laptop)."""
    r1 = await client.post("/register", json=_NUTZER, headers=_von("10.0.0.1"))
    assert r1.status_code == 201, r1.text
    rot = await client.post(
        "/refresh", json={"refresh_token": r1.json()["refresh_token"]}, headers=_von("10.0.0.1")
    )
    assert rot.status_code == 200, rot.text
    r2 = await client.post(
        "/login",
        json={"email_or_username": _NUTZER["email"], "password": _NUTZER["password"]},
        headers=_von("10.0.0.2", "Laptop/1"),
    )
    assert r2.status_code == 200, r2.text
    return r1, rot.json(), r2.json()


async def _eigenes_lebt_fremdes_nicht(client, eigen: dict, fremd: dict) -> None:
    assert (await client.get("/me", headers=_bearer(eigen["access_token"]))).status_code == 200
    weiter = await client.post("/refresh", json={"refresh_token": eigen["refresh_token"]})
    assert weiter.status_code == 200, "eigene Kette wurde mit beendet"
    assert (await client.get("/me", headers=_bearer(fremd["access_token"]))).status_code == 401


@pytest.mark.asyncio
async def test_andere_abmelden_per_bearer_von_neuer_ip_behaelt_die_eigene_kette(client):
    _reg, eigen, fremd = await _zwei_geraete(client)
    r = await client.delete(
        "/sessions", headers={**_bearer(eigen["access_token"]), **_von("10.0.0.99")}
    )
    assert r.status_code == 200 and r.json()["revoked_count"] == 1, r.text
    await _eigenes_lebt_fremdes_nicht(client, eigen, fremd)


@pytest.mark.asyncio
async def test_andere_abmelden_per_cookie_von_neuer_ip_behaelt_die_eigene_kette(client):
    reg, eigen, fremd = await _zwei_geraete(client)
    cookie = reg.cookies["pulse_session"]
    r = await client.delete(
        "/sessions", headers={"Cookie": f"pulse_session={cookie}", **_von("10.0.0.99")}
    )
    assert r.status_code == 200 and r.json()["revoked_count"] == 1, r.text
    me = await client.get("/me", headers={"Cookie": f"pulse_session={cookie}"})
    assert me.status_code == 200, "eigenes Cookie wurde mit beendet"
    await _eigenes_lebt_fremdes_nicht(client, eigen, fremd)


@pytest.mark.asyncio
async def test_refresh_sperrt_das_konto_vor_dem_lesen_der_zeile(client, session_factory, monkeypatch):
    """Rotation gegen Passwortwechsel (auf Postgres gemessen: ohne Sperre
    überlebte die neue Zeile das DELETE des Wechsels). SQLite sperrt nichts;
    nachgestellt wird das Warten: der Wechsel committet IN der Kontosperre.
    Kommt die Sperre nicht vor dem Lesen der Zeile, entsteht trotzdem eine
    neue — und dieser Test wird rot."""
    from dcc_auth import routes
    from dcc_auth.browser_sessions import revoke_all_for_user
    from dcc_auth.models import RefreshToken
    from sqlalchemy import delete, select

    _access, refresh, uid = await _registrieren(client, _NUTZER)
    echt = routes.konto_sperren
    gewartet: list[int] = []

    async def wechsel_kommt_in_der_sperre_an(db, user_id):
        if not gewartet:
            gewartet.append(user_id)
            async with session_factory() as fremd:
                await fremd.execute(delete(RefreshToken).where(RefreshToken.user_id == uid))
                await revoke_all_for_user(fremd, uid)
                await fremd.commit()
        await echt(db, user_id)

    monkeypatch.setattr(routes, "konto_sperren", wechsel_kommt_in_der_sperre_an)
    r = await client.post("/refresh", json={"refresh_token": refresh})
    assert gewartet == [uid]
    assert r.status_code == 401, r.text
    async with session_factory() as db:
        rest = (await db.execute(select(RefreshToken).where(RefreshToken.user_id == uid))).all()
    assert rest == []
