"""Gerätetoken einer beendeten Anmelde-Kette löschen (iOS-Bughunt 2, C2).

auth-svc meldet auf ``dcc_shared.anmeldeketten.KANAL``, dass Ketten zu Ende
sind — Abmelden, „Sitzung beenden", Diebstahlsverdacht, Passwortwechsel,
Passwort-Reset, Sperre. Hier fallen daraufhin die FCM- und PushKit-Token, die
unter diesen Ketten angemeldet wurden (``fcm_tokens.kette``/``voip_tokens.kette``,
Migration 0102). Ohne das zeigte ein verlorenes Telefon nach dem Widerruf
weiter Banner mit Absendernamen und klingelte mit dem Namen des Anrufers.

Die Meldung ist flüchtig: was während eines Neustarts kommt, hört hier
niemand, und eine Kette, die nur abläuft, meldet niemand. Beides holt
``geraetetoken_abgleich.py`` nach — mit derselben Löschfunktion wie hier.

Registriert sich beim Import als Kanal-Handler; eingebunden über
``pubsub_channel_handlers`` (Seiteneffekt-Import, wie ``pubsub_channel_guild``).
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from dcc_shared.anmeldeketten import KANAL, KettenEnde, lesen
from sqlalchemy import delete

from dcc_chat_gateway.models import FcmToken, VoipToken
from dcc_chat_gateway.pubsub_channel_registry import register_channel_handler

if TYPE_CHECKING:
    from dcc_chat_gateway.pubsub import ConnectionManager

log = logging.getLogger(__name__)


async def geraetetoken_loeschen(session: Any, ende: KettenEnde) -> int:
    """Die Zeilen löschen, die zu ``ende`` gehören; liefert ihre Anzahl.

    ``alle``: jede Zeile des Kontos, auch die ohne Kettenvermerk (vor
    Migration 0102 angemeldet). Sonst nur Zeilen genau dieser Ketten — eine
    Zeile ohne Vermerk bleibt dann stehen, denn sie könnte dem Gerät gehören,
    das gerade NICHT abgemeldet wird.
    """
    if not ende.alle and not ende.ketten:
        return 0
    anzahl = 0
    for modell in (FcmToken, VoipToken):
        stmt = delete(modell).where(modell.user_id == ende.user_id)
        if not ende.alle:
            stmt = stmt.where(modell.kette.in_(sorted(ende.ketten)))
        anzahl += (await session.execute(stmt)).rowcount or 0
    await session.commit()
    return anzahl


@register_channel_handler(KANAL)
async def handle_ketten_ende(
    manager: "ConnectionManager", channel: str, msg: dict[str, Any]
) -> None:
    ende = lesen(msg.get("data"))
    if ende is None:
        log.warning("ketten_ende_unlesbar")
        return
    fabrik = manager._session_factory
    if fabrik is None:
        from dcc_chat_gateway.db import SessionLocal

        fabrik = SessionLocal
    async with fabrik() as session:
        anzahl = await geraetetoken_loeschen(session, ende)
    if anzahl:
        # `warning`: die Cloud-Vorgabe für PULSE_LOG_LEVEL (logging_setup.py).
        log.warning("geraetetoken_mit_kette_beendet user=%s anzahl=%d", ende.user_id, anzahl)


__all__ = ["geraetetoken_loeschen", "handle_ketten_ende"]
