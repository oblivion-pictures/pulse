"""Ein Self-Host startet auch unverbunden (Spec 2026-10-09, E4).

Bis 2026-10 brach der Lifespan ohne ``PULSE_INSTANCE_ID`` mit ``RuntimeError``
ab — ein frisch installierter Server hätte dann nicht einmal den Nachweis
ausliefern können, den die Cloud zum Verbinden braucht.
"""

from __future__ import annotations

import asyncio
import logging
from types import SimpleNamespace

import pytest
from starlette.testclient import TestClient

import dcc_chat_gateway.app as chat_app
from dcc_chat_gateway.verbindung import NICHT_VERBUNDEN_HINWEIS, melde_verbindungsstand

_MODUL = "dcc_chat_gateway.verbindung"


@pytest.mark.asyncio
async def test_lifespan_startet_ohne_instanz_nummer(
    ws_app, _isolate_chat_settings, monkeypatch, caplog
):
    # app.py bindet ``get_settings`` beim Import an einen eigenen Namen — der
    # Austausch im conftest erreicht den Lifespan deshalb nicht; hier gezielt.
    _isolate_chat_settings.pulse_instance_id = 0
    monkeypatch.setattr(chat_app, "get_settings", lambda: _isolate_chat_settings)

    def _lauf() -> None:
        with TestClient(ws_app):
            pass  # starten und gleich wieder herunterfahren

    with caplog.at_level(logging.WARNING):
        await asyncio.wait_for(asyncio.to_thread(_lauf), timeout=20)
    assert any(r.getMessage() == NICHT_VERBUNDEN_HINWEIS for r in caplog.records)


def _einstellungen(*, modus: str = "self-host", instanz: int = 0, besitzer: int = 0):
    return SimpleNamespace(
        pulse_instance_mode=modus, pulse_instance_id=instanz, pulse_instance_owner_id=besitzer
    )


def test_unverbunden_nennt_pulse_connect(caplog):
    with caplog.at_level(logging.INFO, logger=_MODUL):
        melde_verbindungsstand(_einstellungen())
    eigene = [r for r in caplog.records if r.name == _MODUL]
    assert [r.getMessage() for r in eigene] == [NICHT_VERBUNDEN_HINWEIS]
    # WARNING: die Cloud-Vorgabe für PULSE_LOG_LEVEL ist warning, info wäre dort
    # unsichtbar (logging_setup.py).
    assert eigene[0].levelno == logging.WARNING


def test_verbunden_nennt_den_besitzer(caplog):
    with caplog.at_level(logging.INFO, logger="dcc_chat_gateway.owner_admin_log"):
        melde_verbindungsstand(_einstellungen(instanz=5, besitzer=4711))
    assert "4711" in caplog.text
    assert NICHT_VERBUNDEN_HINWEIS not in caplog.text


def test_in_der_cloud_kein_hinweis(caplog):
    with caplog.at_level(logging.INFO):
        melde_verbindungsstand(_einstellungen(modus="cloud"))
    assert NICHT_VERBUNDEN_HINWEIS not in caplog.text
