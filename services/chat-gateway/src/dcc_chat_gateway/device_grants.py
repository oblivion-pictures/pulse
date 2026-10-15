"""Auflösung der Freigabeliste eines Geräts.

**Warum das hier steht und nicht im WS-Handler:** die Frage „deckt eine Zeile
diesen Menschen" ist eine reine Rechnung über Zeilen, Zeit und Rollen. Als
Funktion ist sie ohne Datenbank prüfbar; im Handler wäre sie es nur mit einer
offenen WebSocket.

**Die Sichtprüfung ist NICHT Teil dieser Funktion.** Seit dem 2026-10-16 ist
die Liste die einzige Tür zu einem Gerät (wecken und steuern), und die Regel
dazu steht in ``geraete_freigabe.py``: ``VIEW_CHANNEL`` am Standplatz UND
:func:`gedeckt`. ``REMOTE_CONTROL`` zählt für Geräte nicht mehr. Wer
:func:`gedeckt` allein ruft, hat die Sicht deshalb noch nicht geprüft —
``everyone`` deckt hier jeden, gemeint ist aber „jeder, der den Standplatz
sieht".
"""

from __future__ import annotations

from collections.abc import Iterable
from datetime import UTC, datetime

from sqlalchemy import delete, select

from dcc_chat_gateway.models import (
    SUBJECT_EVERYONE,
    SUBJECT_ROLE,
    SUBJECT_USER,
    DeviceGrant,
)


def gedeckt(
    zeilen: Iterable[DeviceGrant], *, anfragender_id: int, rollen: set[int]
) -> bool:
    """Deckt eine der Freigaben diesen Anfragenden gerade ab?

    Reine Rechnung über rohe Zeilen — bewusst ohne Bindung an einen
    DB-Dialekt. ``DateTime(timezone=True)`` liefert unter aiosqlite eine
    NAIVE ``datetime`` zurück (Prod/asyncpg liefert timezone-aware); ein
    Vergleich naiv-gegen-aware wirft ``TypeError``. Ein fehlgeschlagener
    Vergleich darf hier nie zum Absturz des aufrufenden WS-Ops werden —
    deshalb wird ein naiver Wert als UTC gedeutet, bevor verglichen wird.
    """
    jetzt = datetime.now(UTC)
    for z in zeilen:
        ablauf = z.expires_at
        if ablauf is not None and ablauf.tzinfo is None:
            ablauf = ablauf.replace(tzinfo=UTC)
        if ablauf is not None and ablauf <= jetzt:
            continue
        if z.subject_type == SUBJECT_EVERYONE:
            return True
        if z.subject_type == SUBJECT_USER and z.subject_id == anfragender_id:
            return True
        if z.subject_type == SUBJECT_ROLE and z.subject_id in rollen:
            return True
    return False


async def freigaben_lesen(session, device_id: int) -> list[DeviceGrant]:
    treffer = await session.execute(
        select(DeviceGrant).where(DeviceGrant.device_id == device_id)
    )
    return list(treffer.scalars())


async def rollen_freigaben_loeschen(session, device_id: int) -> int:
    """Rollen-Freigaben eines Geräts entfernen und ihre Zahl melden.

    Gerufen beim Community-Wechsel: eine Rolle gehört einer Community, nach dem
    Wechsel zeigen diese Zeilen ins Leere. Sie still weitergelten zu lassen wäre
    die gefährliche Variante — eine Rollenkennung kann in der Zielcommunity
    existieren und dort etwas völlig anderes bedeuten.
    """
    ergebnis = await session.execute(
        delete(DeviceGrant).where(
            DeviceGrant.device_id == device_id,
            DeviceGrant.subject_type == SUBJECT_ROLE,
        )
    )
    return ergebnis.rowcount or 0
