"""Der Abgleich holt nach, was die Meldung ``auth:ketten_ende`` verpasst.

Nachtrag zu iOS-Bughunt 2, C2: ein Ende, das während eines Neustarts kommt,
hört niemand, und eine Kette, die nur abläuft, meldet niemand — das verlorene
Telefon klingelte weiter. Hier: welche Zeilen der Abgleich löscht, und vor
allem, welche er stehen lässt — bei jedem Ausfall von auth-svc alle.
"""

from __future__ import annotations

import asyncio
import json
import random

import httpx
import pytest
from dcc_chat_gateway import geraetetoken_abgleich as abgleich
from dcc_chat_gateway.models import FcmToken, VoipToken
from dcc_shared.anmeldeketten import STAND_PFAD
from sqlalchemy import select

_SECRET = "test-internal-secret-abgleich"


@pytest.fixture
def mit_geheimnis(_isolate_chat_settings, monkeypatch):
    monkeypatch.setattr(_isolate_chat_settings, "internal_service_secret", _SECRET)
    monkeypatch.setattr(_isolate_chat_settings, "auth_svc_url", "http://auth.stub/")
    return _isolate_chat_settings


class _AuthStub:
    """Spielt auth-svc: merkt sich jede Anfrage, antwortet mit ``antwort``."""

    def __init__(self, antwort) -> None:
        self.antwort = antwort
        #: Je Anfrage die gefragten Paare.
        self.anfragen: list[set[tuple[int, str]]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        assert request.url.path == STAND_PFAD
        assert request.headers["X-Pulse-Internal-Secret"] == _SECRET
        ketten = json.loads(request.content)["ketten"]
        gefragt = {(int(p["user_id"]), p["kette"]) for p in ketten}
        self.anfragen.append(gefragt)
        return self.antwort(gefragt) if callable(self.antwort) else self.antwort

    def klient(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.MockTransport(self))

    def gefragt(self) -> set[tuple[int, str]]:
        return set().union(*self.anfragen)


def _beendet(*paare: tuple[int, str], unbekannt: int = 0) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "beendet": [{"user_id": str(u), "kette": k} for u, k in paare],
            "unbekannt": unbekannt,
        },
    )


async def _anmelden(client, _auth_signer, uid: int, geraet: str, kette: str | None) -> None:
    token = _auth_signer.issue_access(uid, f"u{uid}", kette=kette)
    for weg in ("fcm", "voip"):
        r = await client.post(
            f"/{weg}/token",
            json={"token": f"{weg}-{uid}-{geraet}", "geraet_id": geraet},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert r.status_code == 204, r.text


async def _zeilen(session_factory, uid: int) -> dict[str, list[str]]:
    async with session_factory() as s:
        ergebnis: dict[str, list[str]] = {}
        for modell in (FcmToken, VoipToken):
            zeilen = await s.execute(
                select(modell.geraet_id, modell.kette)
                .where(modell.user_id == uid)
                .order_by(modell.geraet_id)
            )
            ergebnis[modell.__tablename__] = [f"{g}:{k}" for g, k in zeilen.all()]
        return ergebnis


@pytest.mark.asyncio
async def test_beendete_kette_faellt_lebende_und_vermerklose_bleiben(
    client, session_factory, _auth_signer, mit_geheimnis
):
    uid = random.randint(60_000_000, 70_000_000)
    await _anmelden(client, _auth_signer, uid, "verloren", "kette-weg")
    await _anmelden(client, _auth_signer, uid, "behalten", "kette-lebt")
    await _anmelden(client, _auth_signer, uid, "alt", None)
    auth = _AuthStub(_beendet((uid, "kette-weg")))

    async with auth.klient() as http:
        geloescht = await abgleich.abgleich_einmal(session_factory, http=http)

    assert geloescht == 2
    # Nach Zeilen ohne Kette wird gar nicht erst gefragt.
    assert auth.gefragt() == {(uid, "kette-weg"), (uid, "kette-lebt")}
    assert await _zeilen(session_factory, uid) == {
        "fcm_tokens": ["alt:None", "behalten:kette-lebt"],
        "voip_tokens": ["alt:None", "behalten:kette-lebt"],
    }


def _netz_weg(_gefragt):
    raise httpx.ConnectError("auth-svc startet gerade neu")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "antwort",
    [
        _netz_weg,
        httpx.Response(503, json={"detail": "starting"}),
        httpx.Response(401, json={"detail": "invalid internal secret"}),
        httpx.Response(200, text="kein json"),
        httpx.Response(200, json={"beendet": [{"user_id": "x", "kette": "k"}], "unbekannt": 0}),
        httpx.Response(200, json={"lebend": []}),
    ],
    ids=["netz", "503", "401", "kein_json", "eintrag_unlesbar", "falsche_form"],
)
async def test_jeder_ausfall_von_auth_svc_loescht_nichts(
    client, session_factory, _auth_signer, mit_geheimnis, antwort
):
    """Fail-open richtig herum: was auth-svc nicht ausdrücklich beendet
    nennt, bleibt — auch wenn es gar nicht antwortet."""
    uid = random.randint(70_000_001, 80_000_000)
    await _anmelden(client, _auth_signer, uid, "handy", "kette-x")
    vorher = await _zeilen(session_factory, uid)

    async with _AuthStub(antwort).klient() as http:
        assert await abgleich.abgleich_einmal(session_factory, http=http) == 0

    assert await _zeilen(session_factory, uid) == vorher


@pytest.mark.asyncio
async def test_unbekanntes_konto_bleibt_stehen(
    client, session_factory, _auth_signer, mit_geheimnis, caplog
):
    uid = random.randint(80_000_001, 90_000_000)
    await _anmelden(client, _auth_signer, uid, "handy", "kette-u")
    async with _AuthStub(_beendet(unbekannt=1)).klient() as http:
        assert await abgleich.abgleich_einmal(session_factory, http=http) == 0
    assert (await _zeilen(session_factory, uid))["fcm_tokens"] == ["handy:kette-u"]
    assert "geraetetoken_abgleich_unbekannt ketten=1" in caplog.text


@pytest.mark.asyncio
async def test_stuecke_sind_unabhaengig(
    client, session_factory, _auth_signer, mit_geheimnis, monkeypatch
):
    """Scheitert ein Stück, fällt nur dessen Befund aus — die anderen gelten."""
    monkeypatch.setattr(abgleich, "STAND_HOECHSTENS", 1)
    uid = random.randint(90_000_001, 99_000_000)
    await _anmelden(client, _auth_signer, uid, "a", "kette-a")
    await _anmelden(client, _auth_signer, uid, "b", "kette-b")

    def antwort(gefragt):
        if gefragt == {(uid, "kette-a")}:
            return httpx.Response(503)
        return _beendet(*gefragt)

    auth = _AuthStub(antwort)
    async with auth.klient() as http:
        assert await abgleich.abgleich_einmal(session_factory, http=http) == 2
    assert len(auth.anfragen) == 2
    assert (await _zeilen(session_factory, uid))["fcm_tokens"] == ["a:kette-a"]


@pytest.mark.asyncio
async def test_ohne_dienstgeheimnis_wird_nicht_gefragt(
    client, session_factory, _auth_signer, _isolate_chat_settings, monkeypatch
):
    monkeypatch.setattr(_isolate_chat_settings, "internal_service_secret", "")
    uid = random.randint(100_000_001, 110_000_000)
    await _anmelden(client, _auth_signer, uid, "handy", "kette-y")
    auth = _AuthStub(_beendet((uid, "kette-y")))
    async with auth.klient() as http:
        assert await abgleich.abgleich_einmal(session_factory, http=http) == 0
    assert auth.anfragen == []


@pytest.mark.asyncio
async def test_der_lauf_gleicht_nach_dem_start_ab(
    client, session_factory, _auth_signer, mit_geheimnis, monkeypatch
):
    """Die Schleife selbst: erster Lauf kurz nach dem Start — genau dann
    fehlen die Meldungen, die während des Neustarts kamen."""
    uid = random.randint(110_000_001, 120_000_000)
    await _anmelden(client, _auth_signer, uid, "verloren", "kette-z")
    auth = _AuthStub(_beendet((uid, "kette-z")))
    monkeypatch.setattr(abgleich, "ERSTER_LAUF_S", 0)
    # Der Lauf baut seinen Klienten selbst; vorher gebaut, sonst ruft sich der
    # Ersatz über das gepatchte ``httpx.AsyncClient`` selbst auf.
    stub_klient = auth.klient()
    monkeypatch.setattr(abgleich.httpx, "AsyncClient", lambda **_kw: stub_klient)

    lauf = asyncio.create_task(abgleich.abgleich_loop(session_factory))
    try:
        for _ in range(100):
            if (await _zeilen(session_factory, uid))["fcm_tokens"] == []:
                break
            await asyncio.sleep(0.02)
    finally:
        lauf.cancel()
        await asyncio.gather(lauf, return_exceptions=True)
    assert await _zeilen(session_factory, uid) == {"fcm_tokens": [], "voip_tokens": []}
