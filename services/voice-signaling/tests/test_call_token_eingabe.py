"""Security-Scan 2026-11-04: ``POST /call/token`` darf keinen fremden Raum ausstellen.

``call_id`` wurde ungeprüft in den Pfad der Mitgliedschafts-Abfrage gesetzt
(``/anrufe/{call_id}/mitgliedschaft``), und httpx löst ``..`` darin auf. Mit
``call_id="../ablage/archiv/abruf?pfad=x"`` landete die Abfrage auf einer
chat-gateway-Route, deren Antwort der Angreifer selbst bestimmt (sein Archiv-
Laufwerk) — und das ``room`` daraus ging ungeprüft ins LiveKit-Token. Jedes
Konto bekam so ein Token für jeden Sprachkanal und jeden Anruf.
"""

from __future__ import annotations

import httpx
import pytest

import dcc_voice_signaling.routes as voice_routes
import dcc_voice_signaling.routes.call_token as call_token_mod


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def gateway(monkeypatch):
    """Zeichnet jeden Pfad auf und antwortet mit dem ``room`` aus ``antwort``."""
    monkeypatch.setattr(voice_routes.get_settings(), "chat_gateway_url", "http://chat-gateway.test")
    aufrufe: list[str] = []
    antwort: dict[str, str] = {}

    async def _req(method, path, *, bearer):
        aufrufe.append(path)
        return httpx.Response(200, json={"room": antwort["room"]})

    monkeypatch.setattr(call_token_mod, "_chat_gateway_request", _req)
    return aufrufe, antwort


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "call_id", ["../ablage/archiv/abruf?pfad=x", "123/../../preferences", "12a", "%2e%2e"]
)
async def test_call_id_muss_eine_zahl_sein(client, auth_signer, gateway, call_id):
    aufrufe, antwort = gateway
    antwort["room"] = "channel-1"
    r = await client.post(
        "/call/token", json={"call_id": call_id}, headers=auth(auth_signer.issue_access(42, "a"))
    )
    assert r.status_code == 422, r.text
    assert aufrufe == []


@pytest.mark.asyncio
async def test_fremder_raum_in_der_antwort_wird_abgewiesen(client, auth_signer, gateway):
    _, antwort = gateway
    antwort["room"] = "channel-987654321"
    r = await client.post(
        "/call/token", json={"call_id": "555"}, headers=auth(auth_signer.issue_access(42, "a"))
    )
    assert r.status_code == 502, r.text


@pytest.mark.asyncio
async def test_eigener_anruf_bekommt_sein_token(client, auth_signer, gateway):
    _, antwort = gateway
    antwort["room"] = "call-555"
    r = await client.post(
        "/call/token", json={"call_id": "555"}, headers=auth(auth_signer.issue_access(42, "a"))
    )
    assert r.status_code == 200, r.text
    assert r.json()["room"] == "call-555"
