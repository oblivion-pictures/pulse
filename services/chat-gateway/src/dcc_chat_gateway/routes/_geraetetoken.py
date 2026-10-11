"""Gemeinsamer Upsert für Gerätetoken-Tabellen (FCM und VoIP).

**Warum geteilt und nicht kopiert.** Beide Tabellen haben dieselbe Form
(``user_id`` + ``geraet_id`` als Schlüssel, ``token`` zusätzlich UNIQUE) und
damit dieselben zwei Rennen:

1. **Zwei Start-Aufrufe desselben Geräts.** Beide sehen keine Zeile, beide
   legen an, einer verliert mit ``IntegrityError``. Der Verlierer darf nicht
   still 204 liefern — dann käme sein frischer Token nie an (Befund
   03.10.2026, deshalb der zweite Durchgang unten).
2. **Derselbe Token taucht unter einem anderen Schlüssel auf.** Der Token
   ist UNIQUE und gehört physisch zu genau einem Gerät; jede andere Zeile mit
   ihm wird vorher entfernt, sonst scheitert der Upsert an der Eindeutigkeit.
   Das ist zum einen das Gerät, das zu einem anderen KONTO wandert, zum
   anderen dasselbe Konto mit einer NEUEN Geräte-Kennung — die Kennung lebt
   im `localStorage` der WebView und ist nach dem Löschen der Website-Daten
   neu, der Token des Systems nicht. Bis zum 2026-10-11 wurde nur der erste
   Fall abgeräumt; der zweite scheiterte an der Eindeutigkeit, fand im zweiten
   Durchgang keine Zeile und antwortete DAUERHAFT 409 — der Token kam nie
   wieder an (Bughunt 2026-10-11).

Diese Rechnung einmal zu haben ist der ganze Zweck: eine Kopie für den
VoIP-Token hätte beim nächsten Fund genau eine der beiden Stellen geheilt.

Seit dem 2026-10-11 tragen beide Tabellen zusätzlich ``kette`` (Migration
0102, iOS-Bughunt 2, C2): die Anmelde-Kette, deren Ende die Zeile löscht.
"""

from __future__ import annotations

from typing import Any

from dcc_shared.anmeldeketten import CLAIM as ANMELDEKETTE_CLAIM
from fastapi import HTTPException, status
from sqlalchemy import delete, or_, select
from sqlalchemy.exc import IntegrityError

# ``modell`` ist nur ``type[Any]``, und das ist kein Versehen: die geforderte
# Form (``user_id``, ``geraet_id``, ``token``, ``kette`` und ein Keyword-Konstruktor
# über alle vier) steht im Modulkopf. Ein ``Protocol`` dafür wäre hier eine
# Zusicherung ohne Prüfung — der Dienst fährt nur Ruff, keinen Typprüfer, und
# der Keyword-Konstruktor eines SQLAlchemy-Modells lässt sich im Protocol
# ohnehin nicht ausdrücken.


def kette_des_aufrufers(payload: dict[str, Any]) -> str | None:
    """Die Anmelde-Kette aus dem Zugriffs-Token (iOS-Bughunt 2, C2) — oder
    ``None``, wenn das Token keine trägt (vor der Änderung ausgestellt, oder
    eine Self-Host-Sitzung). Begründung in ``dcc_shared.anmeldeketten``."""
    kette = payload.get(ANMELDEKETTE_CLAIM)
    return kette if isinstance(kette, str) and 0 < len(kette) <= 64 else None


async def _zeile_des_geraets(
    session: Any, modell: type[Any], user_id: int, geraet_id: str
) -> Any | None:
    treffer = await session.execute(
        select(modell).where(modell.user_id == user_id, modell.geraet_id == geraet_id)
    )
    return treffer.scalar_one_or_none()


async def upsert(
    *,
    session: Any,
    modell: type[Any],
    user_id: int,
    geraet_id: str,
    token: str,
    konflikt_detail: str,
    kette: str | None = None,
) -> None:
    """Token dieses Geräts speichern oder auffrischen.

    ``konflikt_detail`` ist der ``detail``-Text eines 409 — er bleibt je
    Tabelle eigen, damit ein Klient am Fehler erkennt, WELCHE Registrierung
    belegt ist.

    ``kette``: die Anmelde-Kette dieser Anmeldung (:func:`kette_des_aufrufers`).
    Die jüngste Anmeldung gewinnt — ein Gerät, das sich neu anmeldet, hängt
    seine Token damit an die neue Kette.
    """
    await session.execute(
        delete(modell).where(
            modell.token == token,
            or_(modell.user_id != user_id, modell.geraet_id != geraet_id),
        )
    )
    vorhanden = await _zeile_des_geraets(session, modell, user_id, geraet_id)
    if vorhanden is not None:
        vorhanden.token = token
        vorhanden.kette = kette
    else:
        session.add(modell(user_id=user_id, geraet_id=geraet_id, token=token, kette=kette))
    try:
        await session.commit()
        return
    except IntegrityError:
        await session.rollback()

    # Zweiter Durchgang: der andere Aufruf hat die Zeile gewonnen. Den
    # Überlebenden explizit auf DEN hier angekommenen Token ziehen.
    uebrig = await _zeile_des_geraets(session, modell, user_id, geraet_id)
    if uebrig is None:
        # Kein Rennen um die Zeile — ein anderer Grund (etwa die
        # Token-Eindeutigkeit gegen ein parallel wanderndes Gerät). Ehrlich
        # scheitern statt Erfolg behaupten; der App-Start wiederholt.
        raise HTTPException(status.HTTP_409_CONFLICT, detail=konflikt_detail) from None
    uebrig.token = token
    uebrig.kette = kette
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, detail=konflikt_detail) from None


async def entfernen(
    *, session: Any, modell: type[Any], user_id: int, token: str
) -> None:
    """Die Zeile dieses Tokens entfernen — nur die des eigenen Kontos.

    Ohne die ``user_id``-Bedingung könnte ein Konto die Registrierung eines
    fremden Geräts löschen, indem es dessen Token vorlegt.
    """
    await session.execute(
        delete(modell).where(modell.token == token, modell.user_id == user_id)
    )
    await session.commit()
