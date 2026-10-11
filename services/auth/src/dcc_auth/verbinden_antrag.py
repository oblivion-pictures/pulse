"""„Verbinden“ bei einer Adresse, die einem anderen Konto gehört.

Die Entscheidungs-Route (``routes_verbinden.py``) fragt vor dem Eintragen
``uebernahme_pruefen`` (``verbinden_uebernahme.py``, Widerspruchsfrist nach
Spec 2026-10-09 E2, Nachtrag 2026-10-11). Statt eines Eintrags kommt dann
einer von zwei Bescheiden: ein Antrag mit Fristende oder eine Sperre. Beide
beenden den Vorgang in Redis, damit ``pulse-connect`` es beim Abholen erfährt.

Aus ``routes_verbinden.py`` ausgelagert, damit die Routen-Datei unter der
Größengrenze bleibt.
"""

from __future__ import annotations

import logging
from datetime import datetime

from fastapi import HTTPException, status

from dcc_auth.email_verbinden import compose_uebernahme_beantragt, hinweis_mail
from dcc_auth.models import User
from dcc_auth.verbinden import vorgang_entscheiden
from dcc_auth.verbinden_schemas import EntscheidungAus
from dcc_auth.verbinden_uebernahme import UebernahmeBeantragt

log = logging.getLogger(__name__)


async def antrag_gestellt(
    db, redis, nachweis: str, user_id: int, hostname: str, antrag: UebernahmeBeantragt
) -> EntscheidungAus:
    """Statt eines Eintrags steht ein Antrag; committet ihn, wenn genau dieser
    Aufruf den Vorgang entschieden hat (wie beim Verbinden)."""
    frist_bis = antrag.frist_bis.isoformat()
    if not await vorgang_entscheiden(
        redis,
        nachweis,
        "uebernahme_beantragt",
        instance_id=None,
        user_id=str(user_id),
        frist_bis=frist_bis,
    ):
        await db.rollback()
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="unbekannt")
    await db.commit()
    if antrag.neu:
        # warning, weil ``info`` in der Cloud unsichtbar ist (logging_setup.py).
        log.warning(
            "verbinden_uebernahme_beantragt hostname=%s alt=%s konto=%s",
            hostname,
            antrag.alte_instanz_id,
            user_id,
        )
        # Nur an den bisherigen Besitzer. Das antragstellende Konto bekommt den
        # Hinweis erst beim Vollzug, wenn der Server wirklich verbunden wird.
        besitzer = await db.get(User, antrag.besitzer_id) if antrag.besitzer_id else None
        if besitzer is not None:
            await hinweis_mail(
                db, besitzer, compose_uebernahme_beantragt(hostname, antrag.frist_bis)
            )
    return EntscheidungAus(status="uebernahme_beantragt", hostname=hostname, frist_bis=frist_bis)


async def uebernahme_gesperrt(
    db, redis, nachweis: str, user_id: int, hostname: str, bis: datetime
) -> HTTPException:
    """Nach einem Widerspruch oder neben dem lebendigen Antrag eines anderen
    Kontos — die Ausnahme, die die Route wirft.

    Das Zurückrollen verwirft auch verfallene Anträge, die
    ``uebernahme_pruefen`` eben geschlossen hat; der nächste Aufruf schliesst
    sie erneut.
    """
    await db.rollback()
    if not await vorgang_entscheiden(
        redis,
        nachweis,
        "uebernahme_gesperrt",
        instance_id=None,
        user_id=str(user_id),
        frist_bis=bis.isoformat(),
    ):
        # Ein anderer Tab hat den Code schon entschieden.
        return HTTPException(status.HTTP_404_NOT_FOUND, detail="unbekannt")
    log.warning("verbinden_uebernahme_gesperrt hostname=%s konto=%s", hostname, user_id)
    return HTTPException(
        status.HTTP_409_CONFLICT, detail={"code": "uebernahme_gesperrt", "bis": bis.isoformat()}
    )
