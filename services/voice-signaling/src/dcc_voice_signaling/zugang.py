"""Beitritts-Prüfung: wer mit einem noch gültigen, aber überholten Token in
einen Raum kommt, fliegt gleich wieder hinaus.

**Warum** (Gegenprüfung des Security-Audits, 2026-11-05, M7): Ein LiveKit-
Token gilt 4 h (``livekit_token_ttl_seconds``), und LiveKit kennt keine
Sperrliste. Bann, Rauswurf, Rechteentzug oder das Verlassen einer Gruppe
beenden die laufende Verbindung (chat-gateway ``voice_evict.py``), das Token
aber trug bis zum Ablauf wieder hinein. Für Gäste gibt es die Redis-Sperre
(``webhook.py``, ``reconcile.py``); für Mitglieder fehlte jede Prüfung.

Jetzt fragt der Webhook bei jedem ``participant_joined`` eines Mitglieds
chat-gateway (``GET /internal/livekit-zugang``), ob es in den Raum darf, und
entfernt bei einem klaren Nein genau diese Verbindung.

**Fail-open:** Nur ein ausdrückliches ``erlaubt: false`` wirft hinaus. Ist
chat-gateway nicht erreichbar, nicht eingerichtet oder drosselt, bleibt die
Verbindung — das Token wurde beim Ausstellen ja geprüft, und ein Ausfall des
chat-gateway soll nicht jeden Sprachkanal leeren.
"""

from __future__ import annotations

import logging

from fastapi import Request
from livekit import api as lk

log = logging.getLogger(__name__)


async def _darf_beitreten(raum: str, user_id: str) -> bool:
    # Spät importiert: ``routes`` lädt den Webhook (Ladezyklus wie dort).
    from dcc_voice_signaling import routes as voice_routes  # noqa: PLC0415
    from dcc_voice_signaling.routes import chat_gateway  # noqa: PLC0415

    settings = voice_routes.get_settings()
    secret = settings.internal_service_secret
    # Über das Modul, nicht den Re-Export: dort lebt das mutierte Global
    # (s. ``token_gast._voice_limit``).
    client = chat_gateway._http_client
    if not secret or not settings.chat_gateway_url or client is None:
        return True
    try:
        resp = await client.get(
            settings.chat_gateway_url.rstrip("/") + "/internal/livekit-zugang",
            params={"raum": raum, "nutzer": user_id},
            headers={"X-Pulse-Internal-Secret": secret},
        )
        if resp.status_code != 200:
            log.warning("livekit-zugang: chat-gateway antwortet %s", resp.status_code)
            return True
        return resp.json().get("erlaubt") is not False
    except Exception:  # noqa: BLE001 — fail-open, s. Modulkopf
        log.warning("livekit-zugang: Nachfrage gescheitert", exc_info=True)
        return True


async def _entfernen(request: Request, raum: str, identity: str) -> None:
    from dcc_voice_signaling.routes.livekit_client import _borrowed_client  # noqa: PLC0415

    async with _borrowed_client(getattr(request.app.state, "livekit_api", None)) as client:
        if client is None:
            return
        try:
            await client.room.remove_participant(
                lk.RoomParticipantIdentity(room=raum, identity=identity)
            )
        except Exception:  # noqa: BLE001 — schon weg / LiveKit nicht erreichbar
            log.warning("livekit-zugang: Entfernen gescheitert (raum=%s)", raum, exc_info=True)


async def beitritt_pruefen(request: Request, raum: str, identity: str) -> bool:
    """``True``, wenn die Verbindung bleiben darf. Gäste (``gast-…``) prüft
    der Webhook selbst über die Sperre; andere Identitäten gibt es nicht."""
    # Spät importiert: ``webhook`` lädt dieses Modul beim eigenen Import.
    from dcc_voice_signaling.webhook import user_id_from_identity  # noqa: PLC0415

    # Gast-Kennungen behalten ihr ``gast-``-Präfix und fallen an ``isdigit``.
    user_id = user_id_from_identity(identity)
    if user_id is None or not user_id.isdigit() or await _darf_beitreten(raum, user_id):
        return True
    log.info("livekit-zugang: Beitritt abgewiesen (raum=%s user=%s)", raum, user_id)
    await _entfernen(request, raum, identity)
    return False
