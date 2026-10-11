"""Schemas und Hilfen der Anruf-Routen (``anrufe.py``, ``anruf_quittung.py``):
Mitgliedschaft, handelndes Gerät, Push-Umfeld, Ereignisse, Beenden."""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Annotated, Any, Literal

from dcc_shared.events import CallEndeEvent
from fastapi import Body, HTTPException, Request, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select

from dcc_chat_gateway import anruf_push
from dcc_chat_gateway.db import SessionLocal
from dcc_chat_gateway.models import (
    ART_DM,
    GRUND_ABGELEHNT,
    GRUND_AUFGELEGT,
    GRUND_VERPASST,
    ZUSTAND_BEENDET,
    Anruf,
    DirectMessageChannel,
    PrivateGroupMember,
)

# Logger-Name von ``anrufe.py`` beibehalten: die Zeilen tragen ihn, wer im Log
# danach sucht, findet sie weiter.
log = logging.getLogger("dcc_chat_gateway.routes.anrufe")

GRUND_NAMEN = {
    GRUND_AUFGELEGT: "aufgelegt",
    GRUND_ABGELEHNT: "abgelehnt",
    GRUND_VERPASST: "verpasst",
}


class AnrufIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    art: Literal["dm", "gruppe"]
    channel_id: int


class AnrufOut(BaseModel):
    id: str


class AnrufAktionIn(BaseModel):
    """Optionaler Rumpf von annehmen/ablehnen/auflegen und ende-gesehen.

    ``geraet_id`` ist die Push-Kennung des HANDELNDEN Geräts (dieselbe, mit
    der es seinen VoIP-Token angemeldet hat). Dort ist der Anruf schon zu —
    ein Abbruch-Push dorthin fände keinen Anruf, den die Hülle melden könnte,
    und das ist genau der Push, der iOS dazu bringt, die App zu beenden
    (Bughunt 2026-10-11, K3; Begründung in ``anruf_push.py``). Ältere Klienten
    schicken keinen Rumpf; dann geht der Abbruch an alle geklingelten Geräte,
    wie zuvor.
    """

    model_config = ConfigDict(extra="forbid")

    geraet_id: str | None = Field(default=None, min_length=1, max_length=128)


AktionDep = Annotated[AnrufAktionIn | None, Body()]


def _handelndes_geraet(user_id: int, aktion: AnrufAktionIn | None) -> tuple[int, str] | None:
    if aktion is None or aktion.geraet_id is None:
        return None
    return (user_id, aktion.geraet_id)


def _push_umfeld(request: Request) -> dict[str, Any]:
    """Redis und Sitzungsfabrik für den Push-Weg. Die Fabrik des Managers, wo
    es einen gibt — sonst sähen die Tests eine andere Datenbank als die Route
    (Muster: ``manager._session_factory``, s. CLAUDE.md, Plugin-Abschnitt)."""
    manager = getattr(request.app.state, "connection_manager", None)
    return {
        "redis": getattr(request.app.state, "redis", None) or getattr(manager, "redis", None),
        "session_factory": getattr(manager, "_session_factory", None) or SessionLocal,
    }


async def _teilnehmer(session, anruf: Anruf) -> list[int]:
    """Alle Teilnehmerkonten des Anrufs (Initiator inklusive)."""
    if anruf.art == ART_DM:
        dm = await session.get(DirectMessageChannel, anruf.channel_id)
        if dm is None:
            return []
        return [dm.user_a_id, dm.user_b_id]
    rows = await session.execute(
        select(PrivateGroupMember.user_id).where(PrivateGroupMember.gruppe_id == anruf.channel_id)
    )
    return [r for r in rows.scalars().all()]


async def _anruf_als_mitglied(session, anruf_id: int, user_id: int) -> Anruf:
    """Lädt den Anruf nur, wenn der Aufrufer Teilnehmer ist (beide Arten)."""
    anruf = await session.get(Anruf, anruf_id)
    if anruf is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="anruf_not_found")
    if user_id not in await _teilnehmer(session, anruf):
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="anruf_not_found")
    return anruf


async def _publish(request: Request, konten: list[int], ereignis) -> None:
    """Best-effort an alle Teilnehmerkonten — Muster wie postfach/lesestand."""
    manager = getattr(request.app.state, "connection_manager", None)
    if manager is None:
        return
    for konto in set(konten):
        try:
            await manager.publish_user_event(konto, ereignis)
        except Exception:
            log.exception("call event publish failed for user %s", konto)


async def _beenden(
    session,
    request: Request,
    anruf: Anruf,
    grund: int,
    *,
    dauer_sek: int,
    ausser: tuple[int, str] | None,
) -> None:
    """Finalisiert den Anruf und meldet das Ende an alle Teilnehmer."""
    anruf.zustand = ZUSTAND_BEENDET
    anruf.grund = grund
    anruf.beendet_at = datetime.now(tz=timezone.utc)
    await session.commit()
    teilnehmer = await _teilnehmer(session, anruf)
    await _publish(
        request,
        teilnehmer,
        CallEndeEvent(call_id=str(anruf.id), grund=GRUND_NAMEN[grund], dauer_sek=dauer_sek),
    )
    # Abbruch-Push: ohne ihn klingelt ein iPhone mit eingefrorener Oberfläche
    # ins Leere. Nur an Geräte, die noch klingeln (s. ``anruf_push.abbrechen``)
    # — nicht an den Anrufer, nicht an das handelnde Gerät.
    await anruf_push.abbrechen(**_push_umfeld(request), call_id=str(anruf.id), ausser=ausser)
