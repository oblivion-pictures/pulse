"""Gruppen-Lesestand: ``PUT /gruppen/{id}/lesestand``.

Aus ``routes/private_gruppen.py`` ausgelagert (Groessen-Policy, PLAN.md
§12.1) — Pfad, Rumpf und Ereignis unveraendert; dieselben Router-Riegel
(``CloudOnly`` + Schalter) wie dort.
"""

from __future__ import annotations

import logging
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, ConfigDict
from sqlalchemy import func
from sqlalchemy.dialects.postgresql import insert as pg_insert

from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.fcm_gelesen import aktives_lesen_merken
from dcc_chat_gateway.models import GruppenLesestand
from dcc_chat_gateway.routes._deps import CloudOnly
from dcc_chat_gateway.routes.private_gruppen import (
    _gruppe_fuer_mitglied_laden,
    _mitglieder_laden,
    require_private_groups_enabled,
)
from dcc_chat_gateway.schemas import SnowflakeId
from dcc_chat_gateway.security import CurrentUser

log = logging.getLogger(__name__)

router = APIRouter(
    tags=["private-gruppen"],
    dependencies=[CloudOnly, Depends(require_private_groups_enabled)],
)


class GruppenLesestandIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # SnowflakeId statt int: prüft den BIGINT-Bereich (sonst 500 aus dem
    # Treiber statt 422) — dieselbe Naht wie ``DmLesestandIn``.
    last_read_message_id: SnowflakeId


@router.put("/gruppen/{gruppe_id}/lesestand", status_code=status.HTTP_204_NO_CONTENT)
async def gruppen_lesestand_setzen(
    gruppe_id: int,
    body: GruppenLesestandIn,
    session: SessionDep,
    user: CurrentUser,
    request: Request,
    # Abfrage-Parameter, kein Rumpffeld (``extra="forbid"`` oben): ein älterer
    # Server übergeht ihn still (``fcm_gelesen.py``, Regel 3).
    aktiv: Annotated[bool, Query()] = False,
) -> None:
    """Serverseitiger Lesefortschritt des Aufrufers in dieser Gruppe
    (Übergabe 05.10. — Gruppen-Lesebestätigung „Haken wenn alle gelesen").
    Monotoner Upsert wie ``dm_lesestand``: ein veralteter Stand darf nicht
    zurückschieben. Das Ereignis geht an ALLE Mitglieder — die Absender
    rechnen daraus den blauen Haken."""
    from dcc_shared.events import GruppeLesestandEvent

    gruppe, _ = await _gruppe_fuer_mitglied_laden(session, gruppe_id, user.id)
    if gruppe is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="gruppe_not_found")

    stmt = (
        pg_insert(GruppenLesestand)
        .values(
            gruppe_id=gruppe_id,
            user_id=user.id,
            last_read_message_id=body.last_read_message_id,
        )
        .on_conflict_do_update(
            index_elements=[GruppenLesestand.gruppe_id, GruppenLesestand.user_id],
            set_={
                "last_read_message_id": pg_insert(GruppenLesestand).excluded.last_read_message_id,
                "gelesen_am": func.now(),
            },
            where=pg_insert(GruppenLesestand).excluded.last_read_message_id
            > GruppenLesestand.last_read_message_id,
        )
        .returning(GruppenLesestand.last_read_message_id)
    )
    gespeichert = (await session.execute(stmt)).scalar_one_or_none()
    await session.commit()

    mitglieder = await _mitglieder_laden(session, gruppe_id)
    manager = getattr(request.app.state, "connection_manager", None)
    await aktives_lesen_merken(
        getattr(manager, "redis", None), user_id=user.id, channel_id=gruppe_id,
        bis=body.last_read_message_id, aktiv=aktiv,
    )
    if manager is None or gespeichert is None:
        return
    for mitglied in mitglieder:
        try:
            await manager.publish_user_event(
                mitglied.user_id,
                GruppeLesestandEvent(
                    gruppe_id=str(gruppe_id),
                    user_id=str(user.id),
                    last_read_message_id=str(gespeichert),
                ),
            )
        except Exception:
            log.exception("gruppe_lesestand publish failed for user %s", mitglied.user_id)
