"""Der ``activity``-Op: Lebenszeichen verbuchen, automatisches idle aufheben.

Ausgelagert aus ``routes/ws_ops_handlers.py`` (Größen-Policy).

Welches ``idle`` darf eine Mausbewegung aufheben?
-------------------------------------------------
In Redis steht für beide Fälle dasselbe Wort ``idle``: einmal vom Sweeper nach
``IDLE_AFTER_MS`` ohne Lebenszeichen gesetzt, einmal vom Nutzer selbst gewählt
(``PUT /me/presence-status``). Nur das erste hebt ``activity`` auf. Woran man
das zweite erkennt: Eine eigene Wahl spiegelt die REST-Route IMMER zusätzlich
dauerhaft nach ``user_preferences`` (``persist_durable_status``), der Sweeper
nie. Steht dort ``idle``, war es die eigene Wahl — sie bleibt, bis der Nutzer
etwas anderes wählt (Meldung 2026-11-07: selbst gesetztes „abwesend" sprang
bei der nächsten Mausbewegung zurück auf „online").

Die DB-Abfrage fällt nur an, wenn der Live-Status gerade ``idle`` ist — im
Normalfall (``online``) bleibt der Op bei zwei Redis-Aufrufen.
"""

from __future__ import annotations

from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from dcc_chat_gateway.presence_status import (
    STATUS_IDLE,
    STATUS_ONLINE,
    broadcast_presence_status_changed,
    get_presence_status,
    load_durable_status,
    set_presence_status,
    update_activity,
)


async def aktivitaet_verbuchen(
    manager,  # ConnectionManager — ohne Annotation wie in presence_status (Zirkel-Import)
    redis: Redis,
    user_id: int | str,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Lebenszeichen festhalten; automatisches ``idle`` → ``online``.

    ``dnd``/``invisible`` und ein selbst gewähltes ``idle`` bleiben stehen.
    ``session_factory`` reicht der Aufrufer herein (sein ``SessionLocal``),
    damit die Test-Fixtures es an der gewohnten Stelle austauschen.
    """
    await update_activity(redis, user_id)
    if await get_presence_status(redis, user_id) != STATUS_IDLE:
        return
    async with session_factory() as session:
        if await load_durable_status(session, user_id) == STATUS_IDLE:
            return  # selbst gewählt — nicht überschreiben
    await set_presence_status(redis, user_id, STATUS_ONLINE)
    await broadcast_presence_status_changed(manager, redis, user_id, STATUS_ONLINE)


__all__ = ["aktivitaet_verbuchen"]
