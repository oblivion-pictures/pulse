"""Namensauflösung in einem eigenen, kleinen, begrenzten Thread-Pool.

``loop.getaddrinfo`` läuft im Standard-Ausführer des Event-Loops, und dort
rechnet auch das Argon2 beim Login (``asyncio.to_thread``) und versendet die
Mail. Ein anonymer Aufrufer, der die Cloud einen Namen auflösen lässt, dessen
Zone absichtlich langsam antwortet, könnte diesen Pool mit wenigen Quell-IPs
füllen — ``asyncio.timeout`` gibt nur das ``await`` frei, der Thread blockiert
weiter. Dann hinge jede Anmeldung der Cloud.

Darum bekommen die anonym auslösbaren Prüfungen (``verbinden_nachweis.py``)
einen eigenen Pool. Er ist klein, und er ist **gesättigt, sobald alle Plätze
belegt sind**: ein weiterer Aufruf wird sofort abgewiesen (``Ausgelastet``),
statt sich einzureihen. Ein Semaphor um das ``await`` täte das nicht — es gäbe
den Platz nach dem Timeout frei, obwohl der Thread noch blockiert. Hier hängt
der Platz am Thread selbst (Rückruf des ``concurrent.futures.Future``) und wird
erst frei, wenn der Aufruf wirklich zurückgekehrt ist.
"""

from __future__ import annotations

import asyncio
import socket
import threading
from concurrent.futures import Future, ThreadPoolExecutor
from typing import Any, Callable


class Ausgelastet(Exception):
    """Alle Plätze belegt. Bewusst keine ``OSError``/``TimeoutError``: ``pruefe_dns``
    wertet die als „Name unbekannt“, und das wäre hier eine falsche Auskunft."""


def _getaddrinfo(host: str) -> list[tuple[Any, ...]]:
    """Was ``loop.getaddrinfo(host, None, type=SOCK_STREAM)`` im Thread aufruft."""
    return socket.getaddrinfo(host, None, 0, socket.SOCK_STREAM)


class BegrenzterAusfuehrer:
    """``plaetze`` Threads, nie eine Warteschlange."""

    def __init__(self, plaetze: int, name: str) -> None:
        self._pool = ThreadPoolExecutor(max_workers=plaetze, thread_name_prefix=name)
        # Thread-sicher, weil der Platz in einem Worker-Thread frei wird.
        self._frei = threading.BoundedSemaphore(plaetze)

    async def ausfuehren(self, fn: Callable[..., Any], *args: Any) -> Any:
        """Läuft ``fn`` im Pool, oder wirft sofort ``Ausgelastet``."""
        if not self._frei.acquire(blocking=False):
            raise Ausgelastet
        try:
            lauf: Future = self._pool.submit(fn, *args)
        except BaseException:
            self._frei.release()
            raise
        # Auch ein vor dem Start abgebrochener Lauf ruft den Rückruf — der
        # Platz geht nie verloren.
        lauf.add_done_callback(lambda _: self._frei.release())
        return await asyncio.wrap_future(lauf)

    async def getaddrinfo(self, host: str) -> list[tuple[Any, ...]]:
        return await self.ausfuehren(_getaddrinfo, host)
