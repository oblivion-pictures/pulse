"""Plugin-Start der Lifespan: Allowlist lesen, erlaubte Plugins laden, Kanäle nachreichen."""

from __future__ import annotations

import logging
from collections.abc import Callable

from fastapi import FastAPI

from dcc_chat_gateway.plugins import (
    ensure_hello_in_allowlist,
    list_allowed_names,
    load_all_with_allowlist,
)
from dcc_chat_gateway.pubsub import ConnectionManager

# Logger-Name von ``app.py`` beibehalten: jede Zeile trägt ihn (``%(name)s`` im
# Format von ``dcc_shared.logging_setup``), wer danach sucht, findet sie weiter.
log = logging.getLogger("dcc_chat_gateway.app")


async def plugins_laden(
    app: FastAPI, manager: ConnectionManager | None, session_factory: Callable
) -> None:
    """Plugin-System: Allowlist-gegateter Load.

    1. Self-Heal: ``hello`` muss immer in der Allowlist sein.
    2. Allowlist-Snapshot aus der DB lesen.
    3. Plugin-Loader mit Snapshot aufrufen — nur erlaubte Plugins
       werden aktiviert; entdeckte aber nicht-erlaubte bleiben für
       die Admin-API sichtbar.

    Snapshot landet auf ``app.state.plugin_allowlist`` (frozenset),
    damit der WS-Op-Gate ohne DB-Hit pro Op prüfen kann.
    Errors pro Plugin werden geloggt; die Lifespan startet auch
    bei Plugin-Fehlern durch. Mode für den Permission-Gate (intern):
    ``$PULSE_PLUGIN_PERMISSIONS`` — siehe ``plugins.permissions``.

    ``session_factory`` muss derselbe SessionLocal sein, den der WS-Op-Pfad
    nutzt. Tests patchen ``routes.ws_ops.SessionLocal`` auf eine file-backed
    DB; der direkte Import ``dcc_chat_gateway.db.SessionLocal`` würde die
    Memory-DB-Factory einsammeln (die nie gepatched wird) — Lifespan würde
    scheitern und die Allowlist bliebe leer. Same indirection as
    ``manager.set_session_factory`` in der Lifespan.
    """
    try:
        async with session_factory() as session:
            await ensure_hello_in_allowlist(session)
            allowed = await list_allowed_names(session)
        app.state.plugin_allowlist = frozenset(allowed)
        result = load_all_with_allowlist(allowed)
        # Plugin-System PR3: Plugins können eigene Pub/Sub-Channels
        # deklarieren (``[plugin.uses].channels`` im Manifest).
        # ConnectionManager subscribt seine Built-ins bei ``start()`` —
        # die Plugin-Channels werden hier nachgereicht, damit der
        # ``_listen``-Loop sie auch empfängt.
        extra_channels: list[str] = []
        for manifest in result.loaded:
            extra_channels.extend(manifest.uses.channels)
        if extra_channels and manager is not None:
            try:
                await manager.subscribe_plugin_channels(list(dict.fromkeys(extra_channels)))
            except Exception:  # noqa: BLE001
                log.exception("plugin channel subscribe failed; broadcasts may not reach clients")
    except Exception:  # noqa: BLE001
        log.exception("plugin loader failed; continuing without plugins")
        app.state.plugin_allowlist = frozenset()
