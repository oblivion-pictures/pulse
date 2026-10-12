"""Wenn „Verbinden“ im Browser nicht zu einem schlichten Eintrag führt.

Die Entscheidungs-Route (``routes_verbinden.py``) fragt vor dem Eintragen
``uebernahme_pruefen`` (``verbinden_uebernahme.py``, Widerspruchsfrist nach
Spec 2026-10-09 E2, Nachtrag 2026-10-11). Gehört die Adresse einem anderen
Konto, kommt statt eines Eintrags einer von zwei Bescheiden: ein Antrag mit
Fristende oder eine Sperre. Dazu kommt die endgültige Ablehnung der Cloud
selbst (Konto oder Eintrag gesperrt). Alle drei beenden den Vorgang in Redis,
damit ``pulse-connect`` es beim Abholen erfährt (``abholen_ausnahme``).
Ausserdem hier: was nach dem Commit einer vollzogenen Übernahme folgt.

Aus ``routes_verbinden.py`` ausgelagert, damit die Routen-Datei unter der
Größengrenze bleibt.
"""

from __future__ import annotations

import logging
from datetime import datetime

from fastapi import HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_auth.email_verbinden import (
    compose_uebernahme_beantragt,
    compose_verbinden_uebernahme,
    hinweis_mail,
)
from dcc_auth.models import User
from dcc_auth.models_instances import RegisteredInstance
from dcc_auth.routes_suspended_instances import suspended_list_add
from dcc_auth.verbinden import Vorgang, vorgang_entscheiden
from dcc_auth.verbinden_schemas import EntscheidungAus
from dcc_auth.verbinden_uebernahme import UebernahmeBeantragt

log = logging.getLogger(__name__)


async def antrag_gestellt(
    db: AsyncSession,
    redis,
    nachweis: str,
    user_id: int,
    hostname: str,
    antrag: UebernahmeBeantragt,
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
    db: AsyncSession, redis, nachweis: str, user_id: int, hostname: str, bis: datetime
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


async def endgueltig_abgelehnt(
    redis, nachweis: str, user_id: int, hostname: str, grund: str
) -> HTTPException:
    """Eine Ablehnung, an der ein zweiter Klick nichts ändert
    (``verbinden_gesperrt``, ``instance_suspended``) — die Ausnahme, die die
    Route wirft.

    Die Cloud entscheidet den Vorgang dabei selbst auf ``abgelehnt`` und
    nennt den Grund: ``pulse-connect`` erfährt es beim nächsten Abholen,
    statt 15 Minuten lang auf ein Bestätigen zu warten, das nie mehr
    gelingt. Der Browser bekommt dieselbe 403 wie ohne diesen Schritt. Lief
    vorher Datenbank-Arbeit, rollt der Aufrufer sie zurück, bevor er hier
    aufruft (wie bei ``uebernahme_gesperrt``).
    """
    if not await vorgang_entscheiden(
        redis, nachweis, "abgelehnt", instance_id=None, user_id=str(user_id), grund=grund
    ):
        # Ein anderer Tab hat den Code schon entschieden.
        return HTTPException(status.HTTP_404_NOT_FOUND, detail="unbekannt")
    log.warning("verbinden_abgelehnt grund=%s hostname=%s konto=%s", grund, hostname, user_id)
    return HTTPException(status.HTTP_403_FORBIDDEN, detail=grund)


async def uebernahme_nachbereiten(
    db: AsyncSession,
    redis,
    hostname: str,
    alte_instanz_id: int,
    neue_instanz_id: str,
    jetzt: datetime,
) -> None:
    """Nach dem Commit einer Übernahme: Sperrliste, Log, Hinweis an den
    bisherigen Besitzer."""
    await suspended_list_add(redis, alte_instanz_id)
    # warning, weil ``info`` in der Cloud unsichtbar ist (logging_setup.py):
    # wer später fragt, warum sein Server stillsteht, findet es hier.
    log.warning(
        "verbinden_uebernahme hostname=%s alt=%s neu=%s",
        hostname,
        alte_instanz_id,
        neue_instanz_id,
    )
    # Der Soft-Delete lässt ``registered_by`` stehen: der bisherige Besitzer
    # ist bekannt, solange er sein Konto nicht gelöscht hat.
    alt = await db.get(RegisteredInstance, alte_instanz_id)
    vorbesitzer = await db.get(User, alt.registered_by) if alt.registered_by else None
    if vorbesitzer is not None:
        await hinweis_mail(db, vorbesitzer, compose_verbinden_uebernahme(hostname, jetzt))


def abholen_ausnahme(vorgang: Vorgang) -> HTTPException | None:
    """Was ``abholen`` einem entnommenen Vorgang antwortet, der keine
    Zugangsdaten hat — die Ausnahme, oder ``None`` (bestätigt: es gibt
    etwas auszuhändigen).

    ``abgelehnt`` mit Grund heisst: die Cloud hat selbst abgelehnt (Konto oder
    Eintrag gesperrt, ``endgueltig_abgelehnt``) und nennt ihn als ``code``.
    Ohne Grund hat der Mensch im Browser abgelehnt: das schlichte „abgelehnt“,
    das jeder Stand von ``pulse-connect`` versteht. Ein Stand, der den Namen im
    ``code`` nicht kennt, deutet jedes 403 ebenso.
    """
    if vorgang.status == "uebernahme_beantragt":
        return HTTPException(
            status.HTTP_409_CONFLICT,
            detail={"code": "uebernahme_beantragt", "frist_bis": vorgang.frist_bis},
        )
    if vorgang.status == "uebernahme_gesperrt":
        return HTTPException(
            status.HTTP_403_FORBIDDEN,
            detail={"code": "uebernahme_gesperrt", "bis": vorgang.frist_bis},
        )
    if vorgang.status == "abgelehnt":
        detail = {"code": vorgang.grund} if vorgang.grund else "abgelehnt"
        return HTTPException(status.HTTP_403_FORBIDDEN, detail=detail)
    return None
