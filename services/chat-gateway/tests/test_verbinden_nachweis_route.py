"""``GET /.well-known/pulse-verbinden`` — der Nachweis beim Verbinden (Spec 2026-10-09, E2)."""

from __future__ import annotations

import pytest

from dcc_chat_gateway.verbindung import NACHWEIS_DATEI

PFAD = "/.well-known/pulse-verbinden"
WERT = "ab" * 32


@pytest.fixture
def verzeichnis(tmp_path, monkeypatch, _isolate_chat_settings):
    monkeypatch.setattr(_isolate_chat_settings, "pulse_verbinden_dir", str(tmp_path))
    return tmp_path


@pytest.mark.asyncio
async def test_liefert_den_abgelegten_nachweis(client, verzeichnis):
    (verzeichnis / NACHWEIS_DATEI).write_text(WERT + "\n", encoding="ascii")
    r = await client.get(PFAD)
    assert r.status_code == 200, r.text
    assert r.json() == {"nachweis": WERT}


@pytest.mark.asyncio
async def test_ohne_datei_404(client, verzeichnis):
    r = await client.get(PFAD)
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_fremder_inhalt_wird_nicht_ausgeliefert(client, verzeichnis):
    """Die Route ist anonym: was nicht genau wie ein Nachweis aussieht, bleibt drin."""
    (verzeichnis / NACHWEIS_DATEI).write_text("PULSE_CLOUD_CLIENT_SECRET=geheim\n")
    r = await client.get(PFAD)
    assert r.status_code == 404
    assert "geheim" not in r.text


@pytest.mark.asyncio
async def test_in_der_cloud_gibt_es_keinen_nachweis(
    client, verzeichnis, monkeypatch, _isolate_chat_settings
):
    (verzeichnis / NACHWEIS_DATEI).write_text(WERT + "\n", encoding="ascii")
    monkeypatch.setattr(_isolate_chat_settings, "pulse_instance_mode", "cloud")
    r = await client.get(PFAD)
    assert r.status_code == 404
