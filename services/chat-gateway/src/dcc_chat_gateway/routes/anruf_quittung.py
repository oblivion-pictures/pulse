"""Die Quittung eines Anruf-Endes (iOS-Bughunt 2 vom 2026-10-11, A6).

Eigene Datei, weil ``anrufe.py`` schon über der Grössen-Policy liegt; die
Hilfen (Mitgliedschaft, handelndes Gerät, Push-Umfeld) kommen von dort.
Warum es die Quittung gibt, steht im Kopf von ``anruf_push.py``.
"""

from __future__ import annotations

from fastapi import APIRouter, Request, status

from dcc_chat_gateway import anruf_push
from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.routes._deps import CloudOnly
from dcc_chat_gateway.routes.anrufe import (
    AktionDep,
    _anruf_als_mitglied,
    _handelndes_geraet,
    _push_umfeld,
)
from dcc_chat_gateway.security import CurrentUser

router = APIRouter(dependencies=[CloudOnly])


@router.post("/anrufe/{anruf_id}/ende-gesehen", status_code=status.HTTP_204_NO_CONTENT)
async def anruf_ende_gesehen(
    anruf_id: int,
    session: SessionDep,
    current: CurrentUser,
    request: Request,
    aktion: AktionDep = None,
) -> None:
    """Die Oberfläche dieses Geräts hat das Ende eines Anrufs, der hier noch
    klingelte (``call_ende``, Annahme auf einem Zweitgerät), und hat CallKit
    schon geschlossen: kein Abbruch-Push mehr dorthin
    (:func:`anruf_push.ende_gesehen`). Ohne ``geraet_id`` gibt es nichts
    auszutragen — ältere Klienten quittieren nicht."""
    await _anruf_als_mitglied(session, anruf_id, current.id)
    geraet = _handelndes_geraet(current.id, aktion)
    if geraet is None:
        return
    await anruf_push.ende_gesehen(
        redis=_push_umfeld(request)["redis"], call_id=str(anruf_id), geraet=geraet
    )
