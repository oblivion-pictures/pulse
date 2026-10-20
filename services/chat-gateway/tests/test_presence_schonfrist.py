"""Offline-Meldung mit Schonfrist (``presence_schonfrist.py``, Push-Bughunt
2026-10-20): ein App-Wechsel am Handy trennt und verbindet binnen Sekunden
neu — die Freunde sollen das nicht als offline/online-Flackern sehen."""

from __future__ import annotations

import asyncio

import pytest
from dcc_chat_gateway import presence_schonfrist


class _Manager:
    def __init__(self) -> None:
        self.sockets: dict[int, int] = {}
        self.gemeldet: list[tuple[str, bool]] = []

    def user_socket_count(self, user_id: int) -> int:
        return self.sockets.get(user_id, 0)

    async def broadcast_presence_update(self, user_id: str, *, online: bool) -> None:
        self.gemeldet.append((user_id, online))


@pytest.fixture
def kurz(monkeypatch):
    monkeypatch.setattr(presence_schonfrist, "SCHONFRIST_S", 0.1)


@pytest.mark.asyncio
async def test_offline_erst_nach_der_frist(kurz):
    m = _Manager()
    presence_schonfrist.offline_melden(m, 7)
    assert m.gemeldet == []
    await asyncio.sleep(0.2)
    assert m.gemeldet == [("7", False)]


@pytest.mark.asyncio
async def test_wieder_verbunden_in_der_frist_meldet_nichts(kurz):
    m = _Manager()
    presence_schonfrist.offline_melden(m, 7)
    m.sockets[7] = 1
    await asyncio.sleep(0.2)
    assert m.gemeldet == []


@pytest.mark.asyncio
async def test_erneute_trennung_ersetzt_die_wartende_meldung(kurz):
    m = _Manager()
    presence_schonfrist.offline_melden(m, 7)
    await asyncio.sleep(0.05)
    presence_schonfrist.offline_melden(m, 7)
    await asyncio.sleep(0.07)
    assert m.gemeldet == [], "die Frist läuft ab der LETZTEN Trennung"
    await asyncio.sleep(0.1)
    assert m.gemeldet == [("7", False)]


@pytest.mark.asyncio
async def test_herunterfahren_verwirft_wartende_meldungen(kurz):
    m = _Manager()
    presence_schonfrist.offline_melden(m, 7)
    await presence_schonfrist.alle_abbrechen()
    await asyncio.sleep(0.2)
    assert m.gemeldet == []
