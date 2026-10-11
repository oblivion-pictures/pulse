"""``POST /internal/ketten/stand`` — der Abgleich fragt, welche Ketten zu Ende sind.

Nachtrag zu iOS-Bughunt 2, C2: das Ende einer Kette reist über Redis Pub/Sub
und geht verloren, wenn kein chat-gateway zuhört; eine Kette, die nur abläuft,
meldet niemand. Der chat-gateway gleicht deshalb im Takt ab. Hier: was auth-svc
auf die Frage antwortet — und dass es nie „zu Ende" sagt, wenn es das Konto
nicht kennt.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import jwt
import pytest
from dcc_auth.models import RefreshToken
from dcc_shared.anmeldeketten import STAND_HOECHSTENS, STAND_PFAD, stand_anfrage, stand_lesen
from sqlalchemy import update

_SECRET = "test-internal-secret-ketten"
REG = {
    "username": "stand",
    "email": "stand@dcc-test.example.com",
    "password": "correct horse battery staple",
}
LOGIN = {"email_or_username": REG["email"], "password": REG["password"]}


def _paar(tokens: dict) -> tuple[int, str]:
    claims = jwt.decode(tokens["access_token"], options={"verify_signature": False})
    return int(claims["sub"]), claims["kette"]


@pytest.fixture
def geheimnis(_isolate_settings):
    _isolate_settings.internal_service_secret = _SECRET
    return {"X-Pulse-Internal-Secret": _SECRET}


async def _stand(client, geheimnis, paare):
    r = await client.post(STAND_PFAD, json=stand_anfrage(paare), headers=geheimnis)
    assert r.status_code == 200, r.text
    # Derselbe Leser wie im chat-gateway: die Antwort ist der Vertrag.
    stand = stand_lesen(r.json(), paare)
    assert stand is not None
    return stand


@pytest.mark.asyncio
async def test_lebende_kette_bleibt_abgemeldete_ist_beendet(client, geheimnis):
    erste = (await client.post("/register", json=REG)).json()
    zweite = (await client.post("/login", json=LOGIN)).json()
    # Eine Rotation hält die Kette am Leben — der Vorgänger ist widerrufen.
    await client.post("/refresh", json={"refresh_token": erste["refresh_token"]})
    await client.post("/logout", json={"refresh_token": zweite["refresh_token"]})

    stand = await _stand(client, geheimnis, {_paar(erste), _paar(zweite)})
    assert stand.beendet == {_paar(zweite)}
    assert stand.unbekannt == 0


@pytest.mark.asyncio
async def test_still_abgelaufene_kette_ist_beendet(client, session_factory, geheimnis):
    """Die zweite Lücke: 30 Tage ohne Rotation, niemand meldet etwas."""
    tokens = (await client.post("/register", json=REG)).json()
    async with session_factory() as s:
        await s.execute(
            update(RefreshToken).values(expires_at=datetime.now(UTC) - timedelta(seconds=1))
        )
        await s.commit()
    stand = await _stand(client, geheimnis, {_paar(tokens)})
    assert stand.beendet == {_paar(tokens)}


@pytest.mark.asyncio
async def test_passwortwechsel_loescht_zeilen_und_die_ketten_sind_beendet(client, geheimnis):
    """Der Passwortwechsel LÖSCHT die Refresh-Zeilen, statt sie zu widerrufen.
    Eine Kette ohne jede Zeile ist dort das Ende, kein Rätsel — sonst holte der
    Abgleich gerade das Abmelden der übrigen Geräte nie nach."""
    telefon = (await client.post("/register", json=REG)).json()
    hier = (await client.post("/login", json=LOGIN)).json()
    r = await client.post(
        "/me/password",
        json={"current_password": REG["password"], "new_password": "ein ganz anderes 42"},
        headers={"Authorization": f"Bearer {hier['access_token']}"},
    )
    assert r.status_code == 200, r.text
    neu = r.json()

    stand = await _stand(client, geheimnis, {_paar(telefon), _paar(hier), _paar(neu)})
    assert stand.beendet == {_paar(telefon), _paar(hier)}


@pytest.mark.asyncio
async def test_unbekanntes_konto_loescht_nichts(client, geheimnis):
    """Der Riegel gegen ein falsches oder leeres auth-svc: wer nach Konten
    fragt, die es hier nicht gibt, bekommt keinen Befund."""
    tokens = (await client.post("/register", json=REG)).json()
    uid, kette = _paar(tokens)
    fremd = {(uid + 1, kette), (uid + 2, "keine-uuid")}
    stand = await _stand(client, geheimnis, fremd)
    assert stand.beendet == frozenset()
    assert stand.unbekannt == 2


@pytest.mark.asyncio
async def test_kette_gilt_nur_fuer_ihr_konto(client, geheimnis):
    """Eine lebende Kette hält nur Zeilen IHRES Kontos am Leben."""
    a = (await client.post("/register", json=REG)).json()
    b_reg = {"username": "bob", "email": "bob@dcc-test.example.com", "password": REG["password"]}
    b = (await client.post("/register", json=b_reg)).json()
    uid_b = _paar(b)[0]
    _, kette_a = _paar(a)
    stand = await _stand(client, geheimnis, {_paar(a), (uid_b, kette_a), (uid_b, "keine-uuid")})
    assert stand.beendet == {(uid_b, kette_a), (uid_b, "keine-uuid")}


@pytest.mark.asyncio
async def test_ohne_geheimnis_keine_auskunft(client, geheimnis):
    r = await client.post(STAND_PFAD, json=stand_anfrage([(1, "k")]))
    assert r.status_code == 401
    r = await client.post(
        STAND_PFAD, json=stand_anfrage([(1, "k")]), headers={"X-Pulse-Internal-Secret": "falsch"}
    )
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_zu_viele_paare_werden_abgewiesen(client, geheimnis):
    paare = [(1, f"k{i}") for i in range(STAND_HOECHSTENS + 1)]
    r = await client.post(STAND_PFAD, json=stand_anfrage(paare), headers=geheimnis)
    assert r.status_code == 422
