"""Das Ende einer Anmelde-Kette erreicht den chat-gateway (iOS-Bughunt 2, C2).

Ein verlorenes Telefon, dessen Sitzung widerrufen wurde, zeigte weiter Banner
mit Absendernamen und klingelte, weil seine Gerätetoken beim chat-gateway
stehen blieben. auth-svc stempelt die Kette deshalb ins Zugriffs-Token (der
chat-gateway legt sie neben die Gerätetoken) und meldet jedes Kettenende auf
``dcc_shared.anmeldeketten.KANAL``. Hier: der Stempel und jede Stelle, an der
eine Kette endet.
"""

from __future__ import annotations

import json

import jwt
import pytest
import pytest_asyncio
from dcc_shared.anmeldeketten import KANAL
from sqlalchemy import select

from dcc_auth.models import RefreshToken, User

REG = {
    "username": "kette",
    "email": "kette@dcc-test.example.com",
    "password": "correct horse battery staple",
    "display_name": "Kette",
}
LOGIN = {"email_or_username": REG["email"], "password": REG["password"]}


class _Sammler:
    def __init__(self) -> None:
        self.nachrichten: list[dict] = []

    async def publish(self, kanal: str, nutzlast: str) -> None:
        if kanal == KANAL:
            self.nachrichten.append(json.loads(nutzlast))


@pytest_asyncio.fixture
async def sammler(app):
    s = _Sammler()
    app.state.redis = s
    yield s
    app.state.redis = None


def _claims(tokens: dict) -> dict:
    return jwt.decode(tokens["access_token"], options={"verify_signature": False})


def _kette(tokens: dict) -> str | None:
    return _claims(tokens).get("kette")


def _sub(tokens: dict) -> str:
    return _claims(tokens)["sub"]


def _bearer(tokens: dict) -> dict[str, str]:
    return {"Authorization": f"Bearer {tokens['access_token']}"}


async def _ketten_in_db(session_factory) -> set[str]:
    async with session_factory() as s:
        zeilen = await s.execute(select(RefreshToken.family_id))
        return {str(k) for k in zeilen.scalars() if k is not None}


@pytest.mark.asyncio
async def test_zugriffstoken_traegt_die_kette_und_sie_ueberlebt_die_rotation(
    client, session_factory
):
    erste = (await client.post("/register", json=REG)).json()
    kette = _kette(erste)
    assert kette is not None
    assert await _ketten_in_db(session_factory) == {kette}

    gedreht = (await client.post("/refresh", json={"refresh_token": erste["refresh_token"]})).json()
    assert _kette(gedreht) == kette

    # Eine zweite Anmeldung ist eine eigene Kette.
    zweite = (await client.post("/login", json=LOGIN)).json()
    assert _kette(zweite) not in (None, kette)


@pytest.mark.asyncio
async def test_abmelden_meldet_die_kette(client, sammler):
    erste = (await client.post("/register", json=REG)).json()
    r = await client.post("/logout", json={"refresh_token": erste["refresh_token"]})
    assert r.status_code == 200
    assert sammler.nachrichten == [
        {"user_id": _sub(erste), "ketten": [_kette(erste)], "alle": False}
    ]


@pytest.mark.asyncio
async def test_sitzung_beenden_meldet_genau_diese_kette(client, sammler):
    erste = (await client.post("/register", json=REG)).json()
    zweite = (await client.post("/login", json=LOGIN, headers={"User-Agent": "Telefon"})).json()
    sitzungen = (await client.get("/sessions", headers=_bearer(erste))).json()
    telefon = next(z["id"] for z in sitzungen if z["user_agent"] == "Telefon")

    r = await client.delete(f"/sessions/{telefon}", headers=_bearer(erste))
    assert r.status_code == 204, r.text
    assert sammler.nachrichten == [
        {"user_id": _sub(erste), "ketten": [_kette(zweite)], "alle": False}
    ]


@pytest.mark.asyncio
async def test_wiederverwendung_toetet_kette_und_meldet_sie(client, sammler):
    """Ist der Nachfolger eingelöst, sind zwei Parteien im Umlauf — die Kette
    stirbt, und mit ihr die Gerätetoken."""
    erste = (await client.post("/register", json=REG)).json()
    nachfolger = (
        await client.post("/refresh", json={"refresh_token": erste["refresh_token"]})
    ).json()
    await client.post("/refresh", json={"refresh_token": nachfolger["refresh_token"]})

    r = await client.post("/refresh", json={"refresh_token": erste["refresh_token"]})
    assert r.status_code == 401
    assert sammler.nachrichten == [
        {"user_id": _sub(erste), "ketten": [_kette(erste)], "alle": False}
    ]


@pytest.mark.asyncio
async def test_passwortwechsel_meldet_die_anderen_ketten_nicht_die_eigene(client, sammler):
    erste = (await client.post("/register", json=REG)).json()
    hier = (await client.post("/login", json=LOGIN)).json()
    r = await client.post(
        "/me/password",
        json={"current_password": REG["password"], "new_password": "ein ganz anderes 42"},
        headers=_bearer(hier),
    )
    assert r.status_code == 200, r.text
    assert sammler.nachrichten == [
        {"user_id": _sub(erste), "ketten": [_kette(erste)], "alle": False}
    ]


@pytest.mark.asyncio
async def test_sperre_durch_admin_meldet_alle_ketten(client, session_factory, sammler):
    await client.post("/register", json=REG)  # erstes Konto = Bootstrap-Admin
    admin = (await client.post("/login", json=LOGIN)).json()
    bob_reg = {"username": "bob", "email": "bob@dcc-test.example.com", "password": REG["password"]}
    bob = (await client.post("/register", json=bob_reg)).json()
    async with session_factory() as s:
        bob_id = (await s.execute(select(User.id).where(User.username == "bob"))).scalar_one()

    r = await client.patch(
        f"/admin/users/{bob_id}", json={"disabled": True}, headers=_bearer(admin)
    )
    assert r.status_code == 200, r.text
    assert sammler.nachrichten == [{"user_id": _sub(bob), "ketten": [], "alle": True}]


@pytest.mark.asyncio
async def test_passwort_reset_meldet_alle_ketten(client, monkeypatch, sammler):
    from dcc_auth import routes_recovery

    erste = (await client.post("/register", json=REG)).json()
    gefangen: dict[str, str] = {}
    echt = routes_recovery.compose_password_reset_email

    def _spion(to, url):
        gefangen["url"] = url
        return echt(to, url)

    monkeypatch.setattr(routes_recovery, "compose_password_reset_email", _spion)
    await client.post("/password/forgot", json={"email_or_username": REG["email"]})
    r = await client.post(
        "/password/reset",
        json={"token": gefangen["url"].rsplit("/", 1)[1], "new_password": "ein ganz anderes 42"},
    )
    assert r.status_code == 200, r.text
    assert sammler.nachrichten == [{"user_id": _sub(erste), "ketten": [], "alle": True}]

