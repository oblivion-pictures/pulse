"""``GET /internal/livekit-zugang`` — darf diese Person (noch) in diesen Raum?

**Warum** (Gegenprüfung des Security-Audits, 2026-11-05, M7): Ein LiveKit-
Token gilt 4 h (`voice-signaling/config.py`, ``livekit_token_ttl_seconds``).
Bann, Rauswurf und Rechteentzug werfen die laufende Verbindung zwar sofort
hinaus (`voice_evict.py`), das Token selbst aber bleibt gültig: LiveKit kennt
keine Sperrliste. Wer es aufhob, trat bis zum Ablauf wieder bei — in den
Sprachkanal der Community, aus der er gebannt war, oder in den Anruf einer
Gruppe, die er verlassen hatte.

voice-signaling fragt deshalb bei jedem ``participant_joined`` hier nach und
wirft die Verbindung bei ``erlaubt: false`` wieder hinaus. Die Regeln sind
dieselben wie beim Ausstellen des Tokens: Sprachkanal → VIEW_CHANNEL +
CONNECT (`voice_evict.darf_in_sprachkanal`), Anruf → Teilnehmer
(`anruf_hilfen._teilnehmer`, wie ``GET /anrufe/{id}/mitgliedschaft``).
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Header, Query, Request

from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.models import CHANNEL_TYPE_VOICE, Anruf, Channel
from dcc_chat_gateway.routes.anruf_hilfen import _teilnehmer
from dcc_chat_gateway.routes.internal import _check_internal_secret
from dcc_chat_gateway.voice_evict import darf_in_sprachkanal

router = APIRouter()


@router.get("/internal/livekit-zugang")
async def livekit_zugang(
    raum: Annotated[str, Query(pattern=r"^(channel|call)-\d{1,20}$")],
    nutzer: Annotated[int, Query(ge=1)],
    request: Request,
    session: SessionDep,
    x_pulse_internal_secret: Annotated[str | None, Header()] = None,
) -> dict[str, bool]:
    _check_internal_secret(request, x_pulse_internal_secret)
    art, nummer = raum.split("-", 1)
    if art == "channel":
        channel = await session.get(Channel, int(nummer))
        if channel is None or channel.type != CHANNEL_TYPE_VOICE:
            return {"erlaubt": False}
        return {
            "erlaubt": await darf_in_sprachkanal(session, channel.guild_id, channel.id, nutzer)
        }
    anruf = await session.get(Anruf, int(nummer))
    return {"erlaubt": anruf is not None and nutzer in await _teilnehmer(session, anruf)}
