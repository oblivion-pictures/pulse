"""Offline-Meldung mit Schonfrist (Push-Bughunt 2026-10-20).

**Warum.** Schliesst ein Konto seine letzte WebSocket, meldete der chat-gateway
SOFORT ``presence_update(online=False)`` an alle. Am Handy endet die
Verbindung beim Wechsel in eine andere App und wird beim Zurückkommen neu
aufgebaut — die Freunde sahen das Konto bei jedem App-Wechsel offline und
gleich wieder online flackern.

**Wie.** Die Meldung wartet :data:`SCHONFRIST_S`; ist das Konto danach wieder
verbunden, entfällt sie. Eine erneute Trennung in der Wartezeit ersetzt die
wartende Meldung, damit die Frist ab der LETZTEN Trennung läuft. Die
Online-Meldung beim Wiederverbinden (``ws_ready.py``, erster Socket) geht
unverändert hinaus; für die Freunde, die das Konto nie offline sahen, ist sie
eine Wiederholung ohne Wirkung.

**Nur die Meldung wartet.** Alles andere, was an der letzten Verbindung hängt
(Watch-Party, Fernsteuerung, Standplatz-Geräte, Sprachzustand), räumt
``ws_ops.py`` weiter sofort ab — daran ändert diese Datei nichts.

**Grenzen, bewusst:** Die Präsenz lebt in diesem Prozess
(``ConnectionManager._user_conns``), die Schonfrist also auch: verbindet sich
ein Konto in der Wartezeit mit einem ANDEREN Prozess, sieht dieser hier es
nicht und meldet offline — dieselbe Grenze, die die Präsenz ohne Schonfrist
schon hat. Beim Herunterfahren werden wartende Meldungen verworfen
(:func:`alle_abbrechen`); die Konten verbinden sich ohnehin neu. Der
Stale-Reaper (``pubsub.py``) meldet weiter sofort: er greift erst nach 95 s
ohne jedes Lebenszeichen.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

log = logging.getLogger(__name__)

#: So lange darf ein Konto ohne Verbindung sein, bevor die Freunde es offline
#: sehen. Gesetzt, nicht gemessen: ein App-Wechsel samt Rückkehr dauert
#: meist Sekunden.
SCHONFRIST_S = 20.0

#: Je Konto die wartende Meldung — starke Verweise, sonst darf der
#: Ereignis-Loop eine Aufgabe mitten im Lauf einsammeln.
_wartend: dict[int, asyncio.Task[None]] = {}


async def _spaeter_melden(manager: Any, user_id: int) -> None:
    await asyncio.sleep(SCHONFRIST_S)
    if manager.user_socket_count(user_id) > 0:
        return
    try:
        await manager.broadcast_presence_update(str(user_id), online=False)
    except Exception:  # noqa: BLE001 — best effort, wie zuvor im Trennpfad
        log.exception("broadcast_presence_update(online=False) failed for user=%s", user_id)


def offline_melden(manager: Any, user_id: int) -> None:
    """Die Offline-Meldung für ``user_id`` nach :data:`SCHONFRIST_S` einplanen
    (s. Modulkopf). Ersetzt eine noch wartende Meldung desselben Kontos."""
    alt = _wartend.pop(user_id, None)
    if alt is not None and not alt.get_loop().is_closed():
        alt.cancel()
    aufgabe = asyncio.create_task(
        _spaeter_melden(manager, user_id), name=f"presence-offline-{user_id}"
    )
    _wartend[user_id] = aufgabe

    def fertig(t: asyncio.Task[None]) -> None:
        if _wartend.get(user_id) is t:
            del _wartend[user_id]

    aufgabe.add_done_callback(fertig)


async def alle_abbrechen() -> None:
    """Beim Herunterfahren: wartende Meldungen verwerfen. Nur die dieses
    Ereignis-Loops — die Tests fahren mehrere Loops nacheinander."""
    loop = asyncio.get_running_loop()
    offen = [t for t in _wartend.values() if t.get_loop() is loop]
    for uid in [u for u, t in _wartend.items() if t.get_loop() is loop or t.get_loop().is_closed()]:
        del _wartend[uid]
    for aufgabe in offen:
        aufgabe.cancel()
    await asyncio.gather(*offen, return_exceptions=True)


__all__ = ["SCHONFRIST_S", "alle_abbrechen", "offline_melden"]
