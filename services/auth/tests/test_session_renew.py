"""``POST /session/renew`` mit einem Cookie, das nicht mehr lebt.

Vorfall 2026-10-17 (iOS-Hülle): Ein Erneuern löste Sitzung A durch B ab, das
Set-Cookie kam nie im Browser an. Der Klient schickte weiter A, und jedes
weitere Erneuern antwortete 204 OHNE Cookie — an A hingen keine Refresh-Token
mehr, der damalige Riegel aus Bughunt Runde 33 („0 umgehängt → kein Cookie“)
schwieg. Alle cookie-pflichtigen Aufrufe scheiterten danach mit 401.

Die Tests hier halten beide Seiten fest: das tote Cookie heilt (Nachfolger
nachreichen oder frisch anlegen), und das Rennen aus Runde 33 legt weiter
keine zweite Sitzung an. Wege und Begründung: ``dcc_auth/session_renew.py``.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from dcc_auth import session_renew
from dcc_auth.browser_sessions import revoke_all_for_user
from dcc_auth.models import RefreshToken, UserSession
from dcc_auth.session_link import relink_to_new_session, revoke_sessions
from sqlalchemy import func, select

_REG = {
    "username": "renew_user",
    "email": "renew@dcc-test.example.com",
    "password": "correct horse battery staple",
    "display_name": "Renew Tester",
}


async def _anmelden(client) -> tuple[str, str, int]:
    """Registrieren (= erste Anmeldung) → (Cookie A, Zugriffstoken, Konto-ID).

    Genau eine Anmeldung, damit Sitzungs- und Token-Zählungen eindeutig sind.
    """
    reg = await client.post("/register", json=_REG)
    assert reg.status_code == 201, reg.text
    access = reg.json()["access_token"]
    me = await client.get("/me", headers={"Authorization": f"Bearer {access}"})
    return reg.cookies["pulse_session"], access, int(me.json()["id"])


async def _erneuern(client, *, cookie: str | None, bearer: str | None):
    headers: dict[str, str] = {}
    if cookie is not None:
        headers["Cookie"] = f"pulse_session={cookie}"
    if bearer is not None:
        headers["Authorization"] = f"Bearer {bearer}"
    return await client.post("/session/renew", headers=headers)


async def _lebt(client, sid: str) -> bool:
    r = await client.get("/me", headers={"Cookie": f"pulse_session={sid}"})
    assert r.status_code in (200, 401), r.text
    return r.status_code == 200


async def _anzahl_sitzungen(session_factory, user_id: int) -> int:
    async with session_factory() as db:
        stmt = select(func.count()).select_from(UserSession).where(UserSession.user_id == user_id)
        return (await db.execute(stmt)).scalar_one()


async def _token_sitzungen(session_factory, user_id: int) -> set[str]:
    """An welchen Cookies hängen die lebenden Refresh-Token des Kontos?"""
    async with session_factory() as db:
        rows = (
            await db.execute(
                select(RefreshToken.session_id).where(
                    RefreshToken.user_id == user_id, RefreshToken.revoked_at.is_(None)
                )
            )
        ).scalars()
        return {str(s) for s in rows}


@pytest.mark.asyncio
async def test_widerrufenes_cookie_mit_bearer_bekommt_den_nachfolger(client, session_factory):
    """Der Vorfall selbst: A wurde durch B abgelöst, der Browser hält weiter A.

    Mit gültigem Bearer kommt B noch einmal (``nachgereicht``) — eine
    funktionierende Sitzung, und KEINE zusätzliche Zeile.
    """
    a, access, uid = await _anmelden(client)

    erste = await _erneuern(client, cookie=a, bearer=access)
    assert erste.status_code == 204, erste.text
    assert erste.headers["X-Pulse-Sitzung"] == "neu"
    b = erste.cookies["pulse_session"]
    assert b != a
    assert not await _lebt(client, a)
    vorher = await _anzahl_sitzungen(session_factory, uid)

    # Das Set-Cookie von eben kam nie an: der Klient legt wieder A vor.
    zweite = await _erneuern(client, cookie=a, bearer=access)
    assert zweite.status_code == 204, zweite.text
    assert zweite.headers["X-Pulse-Sitzung"] == "nachgereicht"
    assert zweite.cookies["pulse_session"] == b
    assert await _lebt(client, b)
    assert await _anzahl_sitzungen(session_factory, uid) == vorher
    assert await _token_sitzungen(session_factory, uid) == {b}


@pytest.mark.asyncio
async def test_widerrufenes_cookie_ohne_lebenden_nachfolger_legt_frisch_an(
    client, session_factory
):
    """Ist auch B schon abgelaufen, gibt es nichts nachzureichen: dann wie ohne
    Cookie — neue Sitzung, und die verwaisten Refresh-Token hängen an ihr (sonst
    liefe „Sitzung beenden“ für dieses Gerät ins Leere)."""
    a, access, uid = await _anmelden(client)
    b = (await _erneuern(client, cookie=a, bearer=access)).cookies["pulse_session"]
    async with session_factory() as db:
        row = await db.get(UserSession, b)
        assert row is not None
        row.expires_at = datetime.now(UTC) - timedelta(seconds=1)
        await db.commit()

    r = await _erneuern(client, cookie=a, bearer=access)
    assert r.status_code == 204, r.text
    assert r.headers["X-Pulse-Sitzung"] == "neu"
    c = r.cookies["pulse_session"]
    assert c not in (a, b)
    assert await _lebt(client, c)
    assert await _token_sitzungen(session_factory, uid) == {c}


@pytest.mark.asyncio
async def test_unbekanntes_cookie_mit_bearer_wie_ohne_cookie(client):
    """Zeile weggeräumt (Sweeper) oder nie dagewesen: kein Grund zu schweigen."""
    _a, access, _uid = await _anmelden(client)
    r = await _erneuern(client, cookie=str(uuid.uuid4()), bearer=access)
    assert r.status_code == 204, r.text
    assert await _lebt(client, r.cookies["pulse_session"])


@pytest.mark.asyncio
async def test_totes_cookie_allein_belebt_nichts(client):
    """Ohne Bearer ist ein widerrufenes Cookie keine Anmeldung — auch nicht,
    wenn es einen lebenden Nachfolger hat."""
    a, access, _uid = await _anmelden(client)
    assert (await _erneuern(client, cookie=a, bearer=access)).status_code == 204
    r = await _erneuern(client, cookie=a, bearer=None)
    assert r.status_code == 401
    assert "pulse_session" not in r.cookies


@pytest.mark.asyncio
async def test_nach_sicherheitswiderruf_kein_geerbter_mfa_kontext(client, session_factory):
    """Überall abmelden widerruft auch den Nachfolger. Ein danach noch gültiger
    Bearer bekommt, was er ohne Cookie bekäme: eine Sitzung mit ``acr="0"`` —
    nie den Step-up der abgebauten Sitzung."""
    a, access, uid = await _anmelden(client)
    async with session_factory() as db:
        row = await db.get(UserSession, a)
        assert row is not None
        row.acr = "1"
        row.amr = ["pwd", "otp"]
        await db.commit()
    b = (await _erneuern(client, cookie=a, bearer=access)).cookies["pulse_session"]
    async with session_factory() as db:
        assert (await db.get(UserSession, b)).acr == "1"  # Ablösung erbt
        await revoke_all_for_user(db, uid)
        await db.commit()

    r = await _erneuern(client, cookie=a, bearer=access)
    assert r.status_code == 204, r.text
    c = r.cookies["pulse_session"]
    assert c not in (a, b)
    async with session_factory() as db:
        neu = await db.get(UserSession, c)
        assert neu is not None and neu.acr == "0" and list(neu.amr) == ["pwd"]


@pytest.mark.asyncio
async def test_rennen_runde_33_verlierer_bekommt_keine_zweite_sitzung(
    client, session_factory, monkeypatch
):
    """Bughunt Runde 33: zwei Erneuerungen mit demselben lebenden Cookie.

    Nachgestellt wird der härtere Fall: der Verlierer hat A noch lebend
    gelesen, als der Gewinner A ablöste und committete. Sein Widerruf trifft
    dann keine Zeile mehr — er muss seine eigene Sitzung zurückrollen und das
    Cookie des Gewinners nachreichen. (Kommt der Verlierer erst NACH dem
    Gewinner an, ist es der Fall aus dem ersten Test.)
    """
    a, access, uid = await _anmelden(client)
    echt = session_renew.create_session
    gewinner: dict[str, str] = {}

    async def gewinner_kommt_dazwischen(db, **kwargs):
        if not gewinner:
            async with session_factory() as fremd:
                b = str(await echt(fremd, **kwargs))
                assert await revoke_sessions(fremd, [a], user_id=uid, replaced_by=b) == 1
                await relink_to_new_session(
                    fremd, user_id=uid, old_sid=a, new_sid=b, user_agent=None
                )
                await fremd.commit()
                gewinner["sid"] = b
        return await echt(db, **kwargs)

    monkeypatch.setattr(session_renew, "create_session", gewinner_kommt_dazwischen)

    r = await _erneuern(client, cookie=a, bearer=access)
    assert r.status_code == 204, r.text
    assert r.headers["X-Pulse-Sitzung"] == "nachgereicht"
    assert r.cookies["pulse_session"] == gewinner["sid"]
    # A + B, die zurückgerollte Sitzung des Verlierers gibt es nicht.
    assert await _anzahl_sitzungen(session_factory, uid) == 2
    assert await _token_sitzungen(session_factory, uid) == {gewinner["sid"]}
    assert await _lebt(client, gewinner["sid"])


@pytest.mark.asyncio
async def test_lebendes_cookie_wird_weiter_abgeloest(client, session_factory):
    """Normalfall unverändert: lebendes Cookie → neue Sitzung, altes tot,
    Token umgehängt, Ablösung vermerkt."""
    a, access, uid = await _anmelden(client)
    r = await _erneuern(client, cookie=a, bearer=access)
    assert r.status_code == 204, r.text
    b = r.cookies["pulse_session"]
    assert not await _lebt(client, a)
    assert await _lebt(client, b)
    assert await _token_sitzungen(session_factory, uid) == {b}
    async with session_factory() as db:
        alt = await db.get(UserSession, a)
        assert alt is not None and str(alt.replaced_by) == b
