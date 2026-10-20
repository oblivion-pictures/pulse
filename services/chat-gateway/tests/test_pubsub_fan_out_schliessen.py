"""Ein beim Auffaechern verworfener Socket wird auch geschlossen.

Bis zum Push-Bughunt (Befund 4) nahm ``_fan_out`` einen Socket nach
Sende-Zeitueberschreitung oder Ausnahme nur aus den Tabellen. Die Op-Schleife
lief weiter und beantwortete Pings — der Klient hielt die Verbindung fuer
gesund und bekam nie wieder ein Ereignis, waehrend ``user_socket_count`` 0
sagte und der Server pushte, obwohl die App offen war. Jetzt geht der Socket
zu, der Klient verbindet neu und holt nach.
"""

from __future__ import annotations

import asyncio
import logging

import pytest

from dcc_chat_gateway.pubsub_listener import FAN_OUT_SCHLIESSCODE
from dcc_chat_gateway.security import AuthenticatedUser


class _Socket:
    def __init__(self, *, haengt: bool = False, wirft: bool = False) -> None:
        self.haengt = haengt
        self.wirft = wirft
        self.texte: list[str] = []
        self.geschlossen: list[tuple[int, str]] = []

    async def send_text(self, text: str) -> None:
        if self.wirft:
            raise RuntimeError("socket kaputt")
        if self.haengt:
            await asyncio.sleep(3600)
        self.texte.append(text)

    async def close(self, code: int = 1000, reason: str | None = None) -> None:
        self.geschlossen.append((code, reason or ""))


async def _schliessen_abwarten() -> None:
    """Das Schliessen laeuft als eigene Aufgabe (der Listener darf nicht
    warten) — ein paar Runden der Schleife reichen fuer den Stub."""
    for _ in range(5):
        await asyncio.sleep(0)


async def _anmelden(manager, ws, uid: int) -> None:
    user = AuthenticatedUser(id=uid, username=f"u{uid}", is_admin=False, payload={})
    ok, _ = await manager.register(ws, user)  # type: ignore[arg-type]
    assert ok


@pytest.mark.asyncio
async def test_werfender_socket_wird_geschlossen(app, caplog):
    manager = app.state.connection_manager
    gesund, kaputt = _Socket(), _Socket(wirft=True)
    await _anmelden(manager, gesund, 71_001)
    await _anmelden(manager, kaputt, 71_002)

    with caplog.at_level(logging.WARNING, logger="dcc_chat_gateway.pubsub_listener"):
        await manager._fan_out([gesund, kaputt], {"op": "message", "data": {"x": 1}})
    await _schliessen_abwarten()

    assert gesund.texte and not gesund.geschlossen
    assert kaputt.geschlossen == [(FAN_OUT_SCHLIESSCODE, "fan-out failed")]
    assert kaputt not in manager._ws_user
    assert manager.user_socket_count(71_002) == 0
    # Eine Spur, aber ohne Nutzdaten.
    meldungen = [r.getMessage() for r in caplog.records]
    assert any("fan_out_socket_geschlossen" in m for m in meldungen)
    assert not any('"x"' in m for m in meldungen)


@pytest.mark.asyncio
async def test_haengender_socket_wird_geschlossen(app, monkeypatch):
    manager = app.state.connection_manager
    monkeypatch.setattr(type(manager), "_SEND_TIMEOUT_SECONDS", 0.05)
    haengt = _Socket(haengt=True)
    await _anmelden(manager, haengt, 71_003)

    await manager._fan_out([haengt], {"op": "message", "data": {}})
    await _schliessen_abwarten()

    assert haengt.geschlossen == [(FAN_OUT_SCHLIESSCODE, "fan-out failed")]
    assert haengt not in manager._ws_user


@pytest.mark.asyncio
async def test_schliessen_eines_schon_toten_sockets_bricht_nichts(app):
    manager = app.state.connection_manager

    class _Tot(_Socket):
        async def close(self, code: int = 1000, reason: str | None = None) -> None:
            raise RuntimeError("schon zu")

    tot = _Tot(wirft=True)
    await _anmelden(manager, tot, 71_004)
    await manager._fan_out([tot], {"op": "message", "data": {}})
    await _schliessen_abwarten()
    assert tot not in manager._ws_user
