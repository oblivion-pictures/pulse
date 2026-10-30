"""Tests für ``POST /call/token`` (Anruf-Token via chat-gateway-Mitgliedschaft).

Security-Scan 24.10. #1: ``call_id`` war nur über min/max-Länge gebunden —
``/``, ``?`` und ``%`` wurden damit Bestandteil des zum chat-gateway
gebauten Request-Pfads (httpx normalisiert zudem ``..``-Segmente), und ein
200-Antwortkörper ohne ``room`` schlug als KeyError mit 500 durch."""

from __future__ import annotations

import httpx
import jwt
import pytest

import dcc_voice_signaling.routes as voice_routes
from dcc_voice_signaling.routes import call_token as call_token_mod


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _gateway(room: str | None, *, status_code: int = 200):
    """chat-gateway-Mock: antwortet auf die Mitgliedschafts-Anfrage mit
    ``{"room": room}`` — bei ``room=None`` fehlt der Schlüssel (Schema-Drift)."""

    async def _mock(method, path, *, bearer):
        body = {} if room is None else {"room": room}
        return httpx.Response(status_code, json=body)

    return _mock


@pytest.mark.asyncio
async def test_call_token_happy_path(client, auth_signer, monkeypatch):
    """Legitime Snowflake-ID → Token mit dem Raum aus der Gateway-Antwort."""
    monkeypatch.setattr(voice_routes.get_settings(), "chat_gateway_url", "http://chat-gateway.test")
    monkeypatch.setattr(call_token_mod, "_chat_gateway_request", _gateway("call-987654321"))
    access = auth_signer.issue_access(42, "alice")
    r = await client.post(
        "/call/token",
        json={"call_id": "987654321"},
        headers=auth(access),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["room"] == "call-987654321"
    assert body["ws_url"] == "ws://livekit.test:7880"
    assert body["token"].count(".") == 2
    grants = jwt.decode(
        body["token"],
        "testsecrettestsecrettestsecrettestsecret",
        algorithms=["HS256"],
        options={"verify_aud": False},
    )
    assert grants["video"]["room"] == "call-987654321"
    assert grants["sub"].startswith("user-42~")


@pytest.mark.parametrize(
    "call_id",
    [
        "../../users",  # httpx normalisiert ..-Segmente → Pfad-Injektion
        "987/654",  # Slash trennt Pfadsegmente
        "987?x=1",  # Query-Anhang
        "98%32%31",  # percent-kodiertes Digit-Suffix
        "call-987654321",  # kein Snowflake
        "№123",  # Unicode-Digit, kein ASCII-Snowflake
        "-42",  # Vorzeichen ist keine Snowflake-Form
    ],
)
@pytest.mark.asyncio
async def test_call_token_rejects_nicht_snowflake(client, auth_signer, monkeypatch, call_id):
    """Nur ASCII-Ziffern sind zulässig (wie channel_id in token.py /
    internal.py) — alles andere 422 VOR dem Gateway-Ruf."""
    monkeypatch.setattr(voice_routes.get_settings(), "chat_gateway_url", "http://chat-gateway.test")

    async def _nie_aufgerufen(method, path, *, bearer):
        raise AssertionError(f"chat-gateway dürfte für {call_id!r} nie angerufen werden")

    monkeypatch.setattr(call_token_mod, "_chat_gateway_request", _nie_aufgerufen)
    access = auth_signer.issue_access(42, "alice")
    r = await client.post(
        "/call/token",
        json={"call_id": call_id},
        headers=auth(access),
    )
    assert r.status_code == 422, r.text


@pytest.mark.asyncio
async def test_call_token_200_ohne_room_wird_502(client, auth_signer, monkeypatch):
    """Schema-Drift: chat-gateway antwortet 200 OHNE ``room`` — sauber 502
    statt KeyError/500 (Security-Scan 24.10.)."""
    monkeypatch.setattr(voice_routes.get_settings(), "chat_gateway_url", "http://chat-gateway.test")
    monkeypatch.setattr(call_token_mod, "_chat_gateway_request", _gateway(None))
    access = auth_signer.issue_access(42, "alice")
    r = await client.post(
        "/call/token",
        json={"call_id": "987654321"},
        headers=auth(access),
    )
    assert r.status_code == 502, r.text
