"""``POST /internal/ketten/stand`` — welche dieser Anmelde-Ketten sind zu Ende?

Gegenstück zum Abgleich im chat-gateway (``geraetetoken_abgleich.py``,
Nachtrag zu iOS-Bughunt 2, C2). Der chat-gateway hält FCM- und PushKit-Token
mit der Kette, unter der sie angemeldet wurden; das Ende einer Kette meldet
auth-svc über Redis (``ketten_ende.py``). Diese Route holt nach, was dort
verloren geht oder nie gemeldet wird: ein Ereignis während eines
Gateway-Neustarts und eine Kette, die nur abläuft. Was „zu Ende" heisst und
warum ein unbekanntes Konto nichts löscht, steht in ``dcc_shared.anmeldeketten``.

Aufrufer ist ausschliesslich der chat-gateway (``INTERNAL_SERVICE_SECRET``,
gedrosselt wie die übrigen ``/internal``-Routen). Die Route liest nur.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Annotated

from dcc_shared.anmeldeketten import STAND_HOECHSTENS, STAND_PFAD, Paar
from fastapi import APIRouter, Header, Request
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_auth.db import SessionDep
from dcc_auth.models import RefreshToken, User
from dcc_auth.routes_gast_ticket import _check_internal_secret

router = APIRouter()


class KettenPaar(BaseModel):
    model_config = ConfigDict(extra="forbid")

    user_id: Annotated[str, Field(min_length=1, max_length=20, pattern=r"^\d+$")]
    kette: Annotated[str, Field(min_length=1, max_length=64)]


class KettenStandIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ketten: Annotated[list[KettenPaar], Field(max_length=STAND_HOECHSTENS)]


class KettenStandOut(BaseModel):
    beendet: list[KettenPaar]
    unbekannt: int


async def stand_ermitteln(
    session: AsyncSession, paare: set[Paar], *, jetzt: datetime
) -> tuple[set[Paar], int]:
    """``(beendet, unbekannt)`` für die gefragten Paare.

    Lebend ist ein Paar, solange ein Refresh-Token derselben Kette UND desselben
    Kontos weder widerrufen noch abgelaufen ist. Die Abfrage trifft den
    Teilindex ``ix_refresh_tokens_family_active``; Konten werden nur für die
    Paare nachgeschlagen, die nicht leben — im Regelfall keine.

    Eine Kette, die keine UUID ist, kann nicht von hier stammen und lebt
    deshalb nicht. Sie zählt wie jede andere: beendet, wenn das Konto bekannt ist.
    """
    kennungen: dict[Paar, uuid.UUID] = {}
    for paar in paare:
        try:
            kennungen[paar] = uuid.UUID(paar[1])
        except ValueError:
            pass
    lebend: set[tuple[int, uuid.UUID]] = set()
    if kennungen:
        zeilen = await session.execute(
            select(RefreshToken.user_id, RefreshToken.family_id)
            .where(
                RefreshToken.family_id.in_(set(kennungen.values())),
                RefreshToken.revoked_at.is_(None),
                RefreshToken.expires_at > jetzt,
            )
            .distinct()
        )
        lebend = {(uid, fid) for uid, fid in zeilen.all()}
    offen = {p for p in paare if p not in kennungen or (p[0], kennungen[p]) not in lebend}
    if not offen:
        return set(), 0
    konten = await session.execute(select(User.id).where(User.id.in_({uid for uid, _ in offen})))
    bekannt = set(konten.scalars())
    beendet = {p for p in offen if p[0] in bekannt}
    return beendet, len(offen) - len(beendet)


@router.post(STAND_PFAD, response_model=KettenStandOut)
async def ketten_stand(
    payload: KettenStandIn,
    request: Request,
    session: SessionDep,
    x_pulse_internal_secret: Annotated[str | None, Header()] = None,
) -> KettenStandOut:
    await _check_internal_secret(request, x_pulse_internal_secret)
    paare = {(int(p.user_id), p.kette) for p in payload.ketten}
    beendet, unbekannt = await stand_ermitteln(session, paare, jetzt=datetime.now(UTC))
    return KettenStandOut(
        beendet=[KettenPaar(user_id=str(u), kette=k) for u, k in sorted(beendet)],
        unbekannt=unbekannt,
    )


__all__ = ["router", "stand_ermitteln"]
