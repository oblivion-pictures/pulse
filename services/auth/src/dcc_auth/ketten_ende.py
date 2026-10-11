"""Dem chat-gateway melden, dass Anmelde-Ketten zu Ende sind (iOS-Bughunt 2, C2).

Er löscht daraufhin die Gerätetoken (FCM, PushKit), die unter diesen Ketten
angemeldet wurden — Begründung und Nachrichtenform in
:mod:`dcc_shared.anmeldeketten`.

**Erst nach dem Commit rufen.** Vorher könnte der Widerruf noch scheitern,
und ein Telefon verlöre seine Mitteilungen für eine Sitzung, die weiterlebt.

**Best-effort**, wie ``admin_events``: ohne Redis oder bei einem Fehler bleibt
der Widerruf gültig, nur die Gerätetoken bleiben stehen (der Stand von vorher).
"""

from __future__ import annotations

import logging
from collections.abc import Iterable

from dcc_shared.anmeldeketten import KANAL, nachricht
from fastapi import Request

log = logging.getLogger(__name__)


async def melden(
    request: Request, *, user_id: int, ketten: Iterable[object] = (), alle: bool = False
) -> None:
    text = nachricht(user_id=user_id, ketten=ketten, alle=alle)
    redis = getattr(request.app.state, "redis", None)
    if text is None or redis is None:
        return
    try:
        await redis.publish(KANAL, text)
    except Exception:  # noqa: BLE001 — der Widerruf selbst steht schon
        # `warning`: die Cloud-Vorgabe für PULSE_LOG_LEVEL (logging_setup.py).
        log.warning("ketten_ende_nicht_gemeldet user=%s", user_id, exc_info=True)


__all__ = ["melden"]
