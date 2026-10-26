"""``POST /me/agb-zustimmung`` — ein Bestandskonto stimmt den AGB nachträglich zu.

Gegenstück zum Häkchen bei ``/register`` (Begründung in ``agb.py``). Die
Oberfläche zeigt den Dialog, solange ``GET /me`` ``agb_zustimmung_noetig``
meldet, und schickt dabei die Fassung zurück, die sie von dort hat
(``agb_fassung_aktuell``). Ändern sich die AGB zwischen Anzeige und Klick,
passt die Fassung nicht mehr: 409 statt einer Zustimmung zu einem Text, den das
Konto nie gesehen hat.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, ConfigDict, Field

from dcc_auth.agb import AGB_FASSUNG, agb_pflicht
from dcc_auth.config import get_settings
from dcc_auth.db import SessionDep
from dcc_auth.models import User
from dcc_auth.routes import _get_current_user

router = APIRouter()


class AgbZustimmungIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    fassung: Annotated[str, Field(min_length=1, max_length=16)]


@router.post("/me/agb-zustimmung", status_code=status.HTTP_204_NO_CONTENT)
async def agb_zustimmen(
    payload: AgbZustimmungIn,
    session: SessionDep,
    current: User = Depends(_get_current_user),
) -> Response:
    if not agb_pflicht(get_settings()):
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="agb not applicable")
    if payload.fassung != AGB_FASSUNG:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={"error": "agb_fassung_veraltet", "aktuell": AGB_FASSUNG},
        )
    current.agb_fassung = AGB_FASSUNG
    current.agb_akzeptiert_am = datetime.now(UTC)
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
