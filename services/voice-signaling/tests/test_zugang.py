"""Beitritts-Prüfung für Mitglieder mit überholtem Token (``zugang.py``).

Gegenprüfung des Security-Audits (2026-11-05, M7): ein gebanntes Mitglied
trat mit seinem noch gültigen 4-h-LiveKit-Token wieder bei. Der Webhook fragt
jetzt chat-gateway und entfernt die Verbindung bei einem klaren Nein — bei
einem Ausfall bleibt sie (fail-open)."""

from __future__ import annotations

import uuid

import pytest
from dcc_voice_signaling import zugang
from dcc_voice_signaling.routes import chat_gateway as cg
from dcc_voice_signaling.webhook import room_key

from .test_webhook import _event_body, _sign, redis, webhook_app, webhook_client  # noqa: F401


class _Antwort:
    def __init__(self, status_code: int, body: dict | None = None) -> None:
        self.status_code = status_code
        self._body = body or {}

    def json(self) -> dict:
        return self._body


class _Client:
    def __init__(self, antwort: _Antwort | Exception) -> None:
        self.antwort = antwort
        self.aufrufe: list[tuple[str, dict, dict]] = []

    async def get(self, url, params=None, headers=None):
        self.aufrufe.append((url, params or {}, headers or {}))
        if isinstance(self.antwort, Exception):
            raise self.antwort
        return self.antwort


@pytest.fixture
def eingerichtet(_isolate_voice_settings):
    _isolate_voice_settings.chat_gateway_url = "http://chat.test"
    _isolate_voice_settings.internal_service_secret = "s"
    return _isolate_voice_settings


# ---- Nachfrage -------------------------------------------------------------


@pytest.mark.asyncio
async def test_nachfrage_fragt_mit_secret_und_raum(eingerichtet, monkeypatch):
    client = _Client(_Antwort(200, {"erlaubt": False}))
    monkeypatch.setattr(cg, "_http_client", client)
    assert await zugang._darf_beitreten("channel-5", "42") is False
    url, params, headers = client.aufrufe[0]
    assert url == "http://chat.test/internal/livekit-zugang"
    assert params == {"raum": "channel-5", "nutzer": "42"}
    assert headers == {"X-Pulse-Internal-Secret": "s"}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "antwort",
    [_Antwort(500), _Antwort(429), _Antwort(200, {}), RuntimeError("weg")],
)
async def test_nachfrage_ist_fail_open(eingerichtet, monkeypatch, antwort):
    monkeypatch.setattr(cg, "_http_client", _Client(antwort))
    assert await zugang._darf_beitreten("channel-5", "42") is True


@pytest.mark.asyncio
async def test_ohne_einrichtung_keine_nachfrage(_isolate_voice_settings, monkeypatch):
    client = _Client(_Antwort(200, {"erlaubt": False}))
    monkeypatch.setattr(cg, "_http_client", client)
    _isolate_voice_settings.internal_service_secret = ""
    assert await zugang._darf_beitreten("channel-5", "42") is True
    assert client.aufrufe == []


# ---- Webhook ----------------------------------------------------------------


@pytest.fixture
def entscheid(monkeypatch):
    """Ersetzt die Nachfrage und schreibt mit, welche Verbindung fliegt."""
    zustand = {"erlaubt": True, "gefragt": [], "entfernt": []}

    async def _darf(raum, user_id):
        zustand["gefragt"].append((raum, user_id))
        return zustand["erlaubt"]

    async def _entfernen(_request, raum, identity):
        zustand["entfernt"].append((raum, identity))

    monkeypatch.setattr(zugang, "_darf_beitreten", _darf)
    monkeypatch.setattr(zugang, "_entfernen", _entfernen)
    return zustand


async def _beitritt(webhook_client, raum: str, identity: str) -> None:  # noqa: F811
    body = _event_body("participant_joined", raum, identity)
    r = await webhook_client.post("/webhook", content=body, headers={"Authorization": _sign(body)})
    assert r.status_code == 204


@pytest.mark.asyncio
async def test_abgewiesenes_mitglied_fliegt_und_kommt_nicht_in_die_praesenz(
    webhook_client, redis, entscheid  # noqa: F811
):
    raum = f"channel-{uuid.uuid4().int % (1 << 31)}"
    entscheid["erlaubt"] = False
    try:
        await _beitritt(webhook_client, raum, "user-77~ab12")
        assert entscheid["gefragt"] == [(raum, "77")]
        assert entscheid["entfernt"] == [(raum, "user-77~ab12")]
        assert await redis.scard(room_key(raum)) == 0
    finally:
        await redis.delete(room_key(raum))


@pytest.mark.asyncio
async def test_erlaubtes_mitglied_kommt_in_die_praesenz(webhook_client, redis, entscheid):  # noqa: F811
    raum = f"channel-{uuid.uuid4().int % (1 << 31)}"
    try:
        await _beitritt(webhook_client, raum, "user-78~cd34")
        assert entscheid["entfernt"] == []
        assert await redis.smembers(room_key(raum)) == {b"78"}
    finally:
        await redis.delete(room_key(raum))


@pytest.mark.asyncio
async def test_gast_wird_nicht_nachgefragt(webhook_client, redis, entscheid):  # noqa: F811
    raum = f"channel-{uuid.uuid4().int % (1 << 31)}"
    try:
        await _beitritt(webhook_client, raum, "gast-901")
        assert entscheid["gefragt"] == []
    finally:
        await redis.delete(room_key(raum))


@pytest.mark.asyncio
async def test_anruf_raum_wird_geprueft(webhook_client, entscheid):  # noqa: F811
    entscheid["erlaubt"] = False
    await _beitritt(webhook_client, "call-555", "user-79~ef56")
    assert entscheid["gefragt"] == [("call-555", "79")]
    assert entscheid["entfernt"] == [("call-555", "user-79~ef56")]
