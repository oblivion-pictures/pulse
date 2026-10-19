"""Private Gruppen verwalten (Rollen-Vertrag 2026-10-19): Umbenennen,
Aufloesen, Stumm, Anheften, Rollen und Besitz-Uebergabe.

Aus ``routes/private_gruppen.py`` ausgelagert (Groessen-Policy, PLAN.md
§12.1); dieselben Router-Riegel (``CloudOnly`` + Schalter) wie dort.

**Rollen**: „owner" ist, wer in ``ersteller_id`` steht — alle Rechte,
genau einer je Gruppe. „admin" laedt ein und wirft einfache Mitglieder
raus, „mitglied" chattet. Die Spalte ``private_group_members.rolle``
spiegelt den Owner nur (``private_gruppen_atomar.owner_zeile_nachziehen``);
die Rechnung steht in ``routes/private_gruppen.py::_rolle``.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import delete as sa_delete
from sqlalchemy import exists, select
from sqlalchemy import update as sa_update

from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.haekchen import kanaele_loeschen
from dcc_chat_gateway.models import PrivateGroupChannel, PrivateGroupMember
from dcc_chat_gateway.private_gruppen_atomar import owner_zeile_nachziehen
from dcc_chat_gateway.routes._deps import CloudOnly
from dcc_chat_gateway.routes._dropbox_helpers import validate_name
from dcc_chat_gateway.routes.gruppen_icons import icon_dateien_loeschen
from dcc_chat_gateway.routes.private_gruppen import (
    _alle_wecken,
    _gruppe_fuer_mitglied_laden,
    _gruppe_neu_publizieren,
    _mitglieder_laden,
    _wire,
    _ziel_zeile,
    require_private_groups_enabled,
)
from dcc_chat_gateway.schemas import (
    PrivateGroupAnheftenIn,
    PrivateGroupBesitzIn,
    PrivateGroupOut,
    PrivateGroupRenameIn,
    PrivateGroupRolleIn,
    PrivateGroupStummIn,
)
from dcc_chat_gateway.security import CurrentUser

log = logging.getLogger(__name__)

router = APIRouter(
    tags=["private-gruppen"],
    dependencies=[CloudOnly, Depends(require_private_groups_enabled)],
)


async def _als_owner_laden(
    session, gruppe_id: int, user_id: int
) -> tuple[PrivateGroupChannel, PrivateGroupMember]:
    """Wie ``_gruppe_fuer_mitglied_laden`` (404 fuer Nichtmitglieder), dazu
    403, wenn ``user_id`` nicht der Owner ist."""
    gruppe, eigene_zeile = await _gruppe_fuer_mitglied_laden(session, gruppe_id, user_id)
    if gruppe.ersteller_id != user_id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="not_allowed")
    return gruppe, eigene_zeile


@router.put("/gruppen/{gruppe_id}/name")
async def gruppe_umbenennen(
    gruppe_id: int,
    body: PrivateGroupRenameIn,
    session: SessionDep,
    user: CurrentUser,
    request: Request,
) -> PrivateGroupOut:
    """Gruppe umbenennen — OWNER allein (der Owner hat alle Rechte, Admins
    nur Einladen + Rauswerfen)."""
    gruppe, _ = await _als_owner_laden(session, gruppe_id, user.id)
    try:
        clean_name = validate_name(body.name, max_len=64)
    except ValueError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc
    gruppe.name = clean_name
    await session.commit()
    mitglieder = await _alle_wecken(request, session, gruppe.id)
    return _wire(gruppe, mitglieder, user.id)


@router.delete("/gruppen/{gruppe_id}", status_code=status.HTTP_204_NO_CONTENT)
async def gruppe_aufloesen(
    gruppe_id: int, session: SessionDep, user: CurrentUser, request: Request
) -> None:
    """Gruppe AUFLÖSEN — Owner allein. Anders als das Verlassen räumt das
    die Gruppe für ALLE ab: Mitglieder-Zeilen und Kanal-Zeile verschwinden,
    ``gruppe_neu`` an die (Ehemaligen-)Mitglieder lässt ihre Klienten die
    Gruppe aus den Listen nehmen."""
    gruppe, _ = await _als_owner_laden(session, gruppe_id, user.id)
    empfaenger = [m.user_id for m in await _mitglieder_laden(session, gruppe.id)]
    await session.execute(
        sa_delete(PrivateGroupMember).where(PrivateGroupMember.gruppe_id == gruppe_id)
    )
    await session.delete(gruppe)
    # Dieselbe Aufraeumung wie ``gruppe_loeschen_wenn_leer``: die
    # Zustellstaende haben keinen Fremdschluessel (``haekchen.py``),
    # ``gruppen_lesestand`` geht per ``ON DELETE CASCADE`` (Migration 0099).
    await kanaele_loeschen(session, [gruppe_id])
    await session.commit()
    icon_dateien_loeschen(gruppe_id)
    await _gruppe_neu_publizieren(request, empfaenger, gruppe_id)
    log.info("gruppe_aufgeloest gruppe_id=%s user_id=%s", gruppe_id, user.id)


@router.put(
    "/gruppen/{gruppe_id}/mitglieder/{user_id}/rolle",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def rolle_setzen(
    gruppe_id: int,
    user_id: int,
    body: PrivateGroupRolleIn,
    session: SessionDep,
    user: CurrentUser,
    request: Request,
) -> None:
    """Ein Mitglied zum Admin machen oder zurückstufen — Owner allein. Die
    Owner-Rolle selbst ist hier nicht wählbar (``PrivateGroupRolleIn``) und
    nicht entziehbar: Besitz wechselt nur über ``POST .../besitz``."""
    gruppe, _ = await _als_owner_laden(session, gruppe_id, user.id)
    ziel = await _ziel_zeile(session, gruppe_id, user_id)
    if ziel.user_id == gruppe.ersteller_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="owner_rolle_fest")
    ziel.rolle = body.rolle
    await session.commit()
    await _alle_wecken(request, session, gruppe_id)


@router.post("/gruppen/{gruppe_id}/besitz", status_code=status.HTTP_204_NO_CONTENT)
async def besitz_uebergeben(
    gruppe_id: int,
    body: PrivateGroupBesitzIn,
    session: SessionDep,
    user: CurrentUser,
    request: Request,
) -> None:
    """Besitz an ein anderes Mitglied übergeben — Owner allein. Das Ziel
    wird Owner, der bisherige Owner Admin (er bleibt in der Gruppe)."""
    _, eigene_zeile = await _als_owner_laden(session, gruppe_id, user.id)
    ziel_id = int(body.user_id)
    if ziel_id == user.id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="bereits_owner")
    await _ziel_zeile(session, gruppe_id, ziel_id)
    # Compare-and-Swap wie ``ersteller_erbe_uebertragen``: Besitzer und
    # Ziel-Mitgliedschaft werden im selben Statement geprueft wie geschrieben.
    # Hat eine gleichzeitige Anfrage den Besitz schon bewegt oder ist das Ziel
    # inzwischen gegangen, aendert sich nichts.
    ergebnis = await session.execute(
        sa_update(PrivateGroupChannel)
        .where(
            PrivateGroupChannel.id == gruppe_id,
            PrivateGroupChannel.ersteller_id == user.id,
            exists(
                select(PrivateGroupMember.id).where(
                    PrivateGroupMember.gruppe_id == gruppe_id,
                    PrivateGroupMember.user_id == ziel_id,
                )
            ),
        )
        .values(ersteller_id=ziel_id)
        .execution_options(synchronize_session=False)
    )
    if not ergebnis.rowcount:
        await session.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, detail="besitz_geaendert")
    eigene_zeile.rolle = "admin"
    await owner_zeile_nachziehen(session, gruppe_id)
    await session.commit()
    await _alle_wecken(request, session, gruppe_id)


@router.post("/gruppen/{gruppe_id}/stumm", status_code=status.HTTP_204_NO_CONTENT)
async def stumm_setzen(
    gruppe_id: int,
    body: PrivateGroupStummIn,
    session: SessionDep,
    user: CurrentUser,
    request: Request,
) -> None:
    """Persönliche Stummschaltung — jedes Mitglied schaltet nur für SICH;
    Handy- und Web-Push prüfen den Merker zur Sendezeit (``fcm_stumm``).
    Geweckt werden nur die eigenen Geräte: die anderen sehen das Flag nicht
    (``_wire``)."""
    gruppe, eigene_zeile = await _gruppe_fuer_mitglied_laden(session, gruppe_id, user.id)
    eigene_zeile.stumm = body.stumm
    await session.commit()
    await _gruppe_neu_publizieren(request, [user.id], gruppe.id)


@router.post("/gruppen/{gruppe_id}/anheften")
async def anheften(
    gruppe_id: int,
    body: PrivateGroupAnheftenIn,
    session: SessionDep,
    user: CurrentUser,
    request: Request,
) -> PrivateGroupOut:
    """Nachricht anpinnen — jedes Mitglied (Inhalts-Feature, wie das
    Gruppenbild). Der Anker ist die kanonische ID der Nachricht (E2E: nur
    die Zeichenkette, nie der Inhalt)."""
    gruppe, _ = await _gruppe_fuer_mitglied_laden(session, gruppe_id, user.id)
    anker = body.anker.strip()
    if not anker or len(anker) > 64:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail="ungueltiger_anker")
    gruppe.angeheftet_id = anker
    await session.commit()
    mitglieder = await _alle_wecken(request, session, gruppe.id)
    return _wire(gruppe, mitglieder, user.id)


@router.delete("/gruppen/{gruppe_id}/anheften")
async def anheften_loesen(
    gruppe_id: int, session: SessionDep, user: CurrentUser, request: Request
) -> PrivateGroupOut:
    gruppe, _ = await _gruppe_fuer_mitglied_laden(session, gruppe_id, user.id)
    gruppe.angeheftet_id = None
    await session.commit()
    mitglieder = await _alle_wecken(request, session, gruppe.id)
    return _wire(gruppe, mitglieder, user.id)
