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
from sqlalchemy import func, select, update

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
async def test_nach_sicherheitswiderruf_holt_altes_token_keine_sitzung(client, session_factory):
    """„Überall sonst abmelden“ von Gerät 2: Gerät 1 hält weiter ein gültiges
    Zugriffstoken (15 Minuten). Bis 2026-10-17 holte es sich damit über Weg 3
    eine frische Sitzung — und mit ihr Self-Host-Tickets. Heute endet mit der
    Anmelde-Kette auch das Token am auth-svc (``widerruf.py``): 401, kein
    Cookie, keine Zeile. Gerät 2, dessen Token genauso alt ist, erneuert
    weiter — der Widerruf trifft Ketten, nicht das Konto."""
    a, access, uid = await _anmelden(client)
    await _setze_mfa(session_factory, a)
    b = (await _erneuern(client, cookie=a, bearer=access)).cookies["pulse_session"]

    zweites = await client.post(
        "/login",
        json={"email_or_username": _REG["email"], "password": _REG["password"]},
        headers={"User-Agent": "Geraet/2"},
    )
    assert zweites.status_code == 200, zweites.text
    access2 = zweites.json()["access_token"]
    weg = await client.delete(
        "/sessions", headers={"Authorization": f"Bearer {access2}", "User-Agent": "Geraet/2"}
    )
    assert weg.status_code == 200 and weg.json()["revoked_count"] == 1, weg.text
    assert not await _lebt(client, b)

    vorher = await _anzahl_sitzungen(session_factory, uid)
    for cookie in (a, b, None):
        await _abgewiesen(client, await _erneuern(client, cookie=cookie, bearer=access))
    me = await client.get("/me", headers={"Authorization": f"Bearer {access}"})
    assert me.status_code == 401
    assert await _anzahl_sitzungen(session_factory, uid) == vorher

    eigenes = await _erneuern(client, cookie=None, bearer=access2)
    assert eigenes.status_code == 204, eigenes.text
    assert await _lebt(client, eigenes.cookies["pulse_session"])


@pytest.mark.asyncio
@pytest.mark.parametrize("mit_cookie", [False, True])
async def test_widerruf_waehrend_der_kontosperre_zaehlt(
    client, session_factory, monkeypatch, mit_cookie
):
    """Das Rennen aus der Gegenprüfung 2026-10-17: Erneuern und Widerruf
    gleichzeitig. Auf Postgres wartet das Erneuern an der Kontosperre, bis der
    Widerruf festgeschrieben ist (``widerruf.konto_sperren``); SQLite sperrt
    nichts, deshalb wird das Warten hier nachgestellt — der Widerruf
    committet IN der Sperre. Danach darf nichts mehr entstehen: die Kette
    wird nach der Sperre noch einmal geprüft, das Cookie frisch gelesen.
    (Der Nachweis gegen echtes Postgres steht nicht hier, er braucht zwei
    echte Verbindungen.)"""
    a, access, uid = await _anmelden(client)
    echt = session_renew.konto_sperren
    gewartet: list[int] = []

    async def widerruf_kommt_in_der_sperre_an(db, user_id):
        if not gewartet:
            gewartet.append(user_id)
            async with session_factory() as fremd:
                await fremd.execute(
                    update(RefreshToken)
                    .where(RefreshToken.user_id == uid)
                    .values(revoked_at=datetime.now(UTC))
                )
                await revoke_all_for_user(fremd, uid)
                await fremd.commit()
        await echt(db, user_id)

    monkeypatch.setattr(session_renew, "konto_sperren", widerruf_kommt_in_der_sperre_an)
    vorher = await _anzahl_sitzungen(session_factory, uid)
    r = await _erneuern(client, cookie=a if mit_cookie else None, bearer=access)
    assert gewartet == [uid]
    await _abgewiesen(client, r)
    assert await _anzahl_sitzungen(session_factory, uid) == vorher


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


# ---- Grenzen des Nachreichens (Gegenprüfung 2026-10-17) -----------------
#
# Ein abgelöstes Cookie ist nicht wertlos, nur weil es widerrufen ist: Weg 2
# reicht eine bestehende Sitzung samt ``acr`` heraus, und das ``acr`` reist ins
# Self-Host-Ticket. Deshalb nur ein Glied, nur zehn Minuten, nur ein lebender
# Nachfolger desselben Kontos — sonst Weg 3 (frisch, ``acr="0"``) bzw. 401.


async def _setze_mfa(session_factory, sid: str) -> None:
    async with session_factory() as db:
        row = await db.get(UserSession, sid)
        assert row is not None
        row.acr = "1"
        row.amr = ["pwd", "otp"]
        await db.commit()


async def _abgewiesen(client, r) -> None:
    """401 und kein Cookie: das Token wurde vor einem Widerruf ausgestellt."""
    assert r.status_code == 401, r.text
    assert "pulse_session" not in r.cookies


async def _frisch_ohne_mfa(session_factory, r, *nicht: str) -> str:
    """Die Antwort hat eine NEUE Sitzung mit Passwort-Standard gesetzt."""
    assert r.status_code == 204, r.text
    assert r.headers["X-Pulse-Sitzung"] == "neu"
    sid = r.cookies["pulse_session"]
    assert sid not in nicht
    async with session_factory() as db:
        row = await db.get(UserSession, sid)
        assert row is not None and row.acr == "0" and list(row.amr) == ["pwd"]
    return sid


@pytest.mark.asyncio
async def test_fremder_bearer_bekommt_den_nachfolger_nicht(client, session_factory):
    """(a) Bearer von Konto V + abgelöstes Cookie von U → nie U's Sitzung."""
    a, access_u, uid = await _anmelden(client)
    b = (await _erneuern(client, cookie=a, bearer=access_u)).cookies["pulse_session"]

    v = await client.post(
        "/register",
        json={
            "username": "renew_fremd",
            "email": "renew-fremd@dcc-test.example.com",
            "password": "correct horse battery staple",
            "display_name": "Fremd",
        },
    )
    assert v.status_code == 201, v.text
    r = await _erneuern(client, cookie=a, bearer=v.json()["access_token"])
    c = await _frisch_ohne_mfa(session_factory, r, a, b)
    async with session_factory() as db:
        assert (await db.get(UserSession, c)).user_id != uid
    assert await _lebt(client, b), "U's Sitzung bleibt unberührt"


@pytest.mark.asyncio
async def test_zwei_glieder_kein_nachreichen(client, session_factory):
    """(b) A → B → C: wer A vorlegt, bekommt nicht C, sondern frisch ``acr="0"``."""
    a, access, _uid = await _anmelden(client)
    await _setze_mfa(session_factory, a)
    b = (await _erneuern(client, cookie=a, bearer=access)).cookies["pulse_session"]
    c = (await _erneuern(client, cookie=b, bearer=access)).cookies["pulse_session"]
    assert await _lebt(client, c)

    r = await _erneuern(client, cookie=a, bearer=access)
    await _frisch_ohne_mfa(session_factory, r, a, b, c)


@pytest.mark.asyncio
async def test_nachfolger_aelter_als_zehn_minuten_kein_nachreichen(client, session_factory):
    """(c) Außerhalb des Fensters fällt der Aufruf auf Weg 3."""
    a, access, _uid = await _anmelden(client)
    await _setze_mfa(session_factory, a)
    b = (await _erneuern(client, cookie=a, bearer=access)).cookies["pulse_session"]
    async with session_factory() as db:
        row = await db.get(UserSession, b)
        row.created_at = datetime.now(UTC) - session_renew.NACHREICH_FENSTER - timedelta(seconds=1)
        await db.commit()

    r = await _erneuern(client, cookie=a, bearer=access)
    await _frisch_ohne_mfa(session_factory, r, a, b)


@pytest.mark.asyncio
async def test_widerrufener_nachfolger_kein_nachreichen_und_keine_verlaengerung(
    client, session_factory
):
    """(d) Nachfolger selbst widerrufen → kein Nachreichen; und Nachreichen
    schreibt nichts (``expires_at`` unverändert)."""
    a, access, uid = await _anmelden(client)
    b = (await _erneuern(client, cookie=a, bearer=access)).cookies["pulse_session"]
    async with session_factory() as db:
        vorher = (await db.get(UserSession, b)).expires_at
    nachgereicht = await _erneuern(client, cookie=a, bearer=access)
    assert nachgereicht.headers["X-Pulse-Sitzung"] == "nachgereicht"
    async with session_factory() as db:
        assert (await db.get(UserSession, b)).expires_at == vorher, "Nachreichen verlängert"
        assert await revoke_sessions(db, [b], user_id=uid) == 1
        await db.commit()

    r = await _erneuern(client, cookie=a, bearer=access)
    await _frisch_ohne_mfa(session_factory, r, a, b)


@pytest.mark.asyncio
async def test_lebendes_cookie_ohne_bearer_verliert_gegen_widerruf_401(
    client, session_factory, monkeypatch
):
    """(e) Kein Weg greift und kein Bearer: das Cookie lebte beim Prüfen noch,
    wurde währenddessen aber überall abgemeldet → 401, keine Sitzung."""
    a, _access, uid = await _anmelden(client)
    echt = session_renew.create_session

    async def abmelden_kommt_dazwischen(db, **kwargs):
        async with session_factory() as fremd:
            await revoke_all_for_user(fremd, uid)
            await fremd.commit()
        return await echt(db, **kwargs)

    monkeypatch.setattr(session_renew, "create_session", abmelden_kommt_dazwischen)
    vorher = await _anzahl_sitzungen(session_factory, uid)
    r = await _erneuern(client, cookie=a, bearer=None)
    assert r.status_code == 401, r.text
    assert "pulse_session" not in r.cookies
    assert await _anzahl_sitzungen(session_factory, uid) == vorher


@pytest.mark.asyncio
async def test_sitzung_beenden_ueber_die_route_beendet_das_nachreichen(client, session_factory):
    """(f) „Sitzung beenden“ (``DELETE /sessions/{id}``) von einem zweiten Gerät
    trifft das Cookie, an dem die Token jetzt hängen — den Nachfolger."""
    a, access, _uid = await _anmelden(client)
    await _setze_mfa(session_factory, a)
    b = (await _erneuern(client, cookie=a, bearer=access)).cookies["pulse_session"]

    zweites = await client.post(
        "/login",
        json={"email_or_username": _REG["email"], "password": _REG["password"]},
        headers={"User-Agent": "Geraet/2"},
    )
    assert zweites.status_code == 200, zweites.text
    access2 = zweites.json()["access_token"]
    zeilen = (await client.get("/sessions", headers={"Authorization": f"Bearer {access2}"})).json()
    erstes = [z["id"] for z in zeilen if z["user_agent"] != "Geraet/2"]
    assert len(erstes) == 1, zeilen
    beendet = await client.delete(
        f"/sessions/{erstes[0]}", headers={"Authorization": f"Bearer {access2}"}
    )
    assert beendet.status_code == 204, beendet.text
    assert not await _lebt(client, b)

    # Mit der Kette von Gerät 1 endet auch dessen Zugriffstoken (``widerruf.py``).
    await _abgewiesen(client, await _erneuern(client, cookie=a, bearer=access))


@pytest.mark.asyncio
async def test_passwortwechsel_ueber_die_route_beendet_das_nachreichen(client, session_factory):
    """(f) ``POST /me/password`` meldet alle Sitzungen ab, den Nachfolger mit."""
    a, access, _uid = await _anmelden(client)
    await _setze_mfa(session_factory, a)
    b = (await _erneuern(client, cookie=a, bearer=access)).cookies["pulse_session"]

    gewechselt = await client.post(
        "/me/password",
        json={"current_password": _REG["password"], "new_password": "ein ganz neues Passwort 42"},
        headers={"Authorization": f"Bearer {access}"},
    )
    assert gewechselt.status_code == 200, gewechselt.text
    assert not await _lebt(client, b)

    # Das alte Zugriffstoken ist mit seiner Kette tot; das frisch ausgestellte
    # erneuert ohne geerbten Step-up.
    await _abgewiesen(client, await _erneuern(client, cookie=a, bearer=access))
    r = await _erneuern(client, cookie=a, bearer=gewechselt.json()["access_token"])
    await _frisch_ohne_mfa(session_factory, r, a, b, gewechselt.cookies["pulse_session"])
