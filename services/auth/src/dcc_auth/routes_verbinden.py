"""Verbinden per Gerätecode — die vier Routen.

Ein Self-Host verbindet sich am Ende seiner Installation mit dem Konto seines
Betreibers (Spec
``docs/superpowers/specs/2026-10-09-selfhost-ohne-freigabe-design.md``, E1):

1. ``POST /selfhost/verbinden/start`` — anonym, vom Server (``pulse-connect``).
2. ``POST /me/selfhost/verbinden/vorgang`` — angemeldet, die Bestätigungsseite.
3. ``POST /me/selfhost/verbinden/entscheidung`` — angemeldet, „Verbinden“/„Abbrechen“.
4. ``POST /selfhost/verbinden/abholen`` — anonym, vom Server, bis 200/403/410.

Die beiden anonymen Routen vertrauen dem Aufrufer nichts an, was er nicht
schon hat: Der Start verlangt die Abholkennung (die Cloud prüft ihren Hash
unter der Adresse), das Abholen liefert nur dem, der dieselbe Kennung kennt.
Kennung, Code und Secret werden nie geloggt — und der Code steht in keinem
Pfad, auch bei den angemeldeten Routen nicht: Pfade landen in
Zugriffsprotokollen (``web-nginx.conf`` loggt ``$uri``), und wer dort einen
offenen Code liest, könnte ihn mit seinem Konto bestätigen.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from time import monotonic
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError

from dcc_shared.hostname import normalisiere_hostname

from dcc_auth.config import get_settings
from dcc_auth.db import SessionDep
from dcc_auth.models import User
from dcc_auth.models_instances import RegisteredInstance
from dcc_auth.routes import _check_rate, _consume_token, _parse_rule
from dcc_auth.routes_admin_instances import _require_cloud
from dcc_auth.routes_instance_applications import _require_user
from dcc_auth.routes_suspended_instances import _get_redis, suspended_list_add
from dcc_auth.verbinden import (
    ABSTAND_S,
    GUELTIG_S,
    Vorgang,
    VorgangLaeuft,
    code_anzeigen,
    code_normalisieren,
    nachweis_aus_kennung,
    vorgang_anlegen,
    vorgang_entnehmen,
    vorgang_entscheiden,
    vorgang_per_code,
    vorgang_per_nachweis,
)
from dcc_auth.verbinden_eintrag import (
    InstanzGesperrt,
    ZuVieleServer,
    adresse_gesperrt,
    instanz_verbinden,
)
from dcc_auth.verbinden_nachweis import nachweis_pruefen
from dcc_auth.zugangsdaten import ZugangsdatenOut, zugangsdaten_ausgeben

log = logging.getLogger(__name__)

router = APIRouter(tags=["self-host"], dependencies=[Depends(_require_cloud)])


class StartEin(BaseModel):
    hostname: str = Field(..., min_length=1, max_length=253)
    #: Die geheime Abholkennung des Servers. Die Cloud bildet daraus den
    #: Nachweis und vergisst sie wieder — gespeichert wird nur der Hash.
    kennung: str = Field(..., min_length=32, max_length=128)


class StartAus(BaseModel):
    code: str
    link: str
    gueltig_s: int
    abstand_s: int


class AbholenEin(BaseModel):
    kennung: str = Field(..., min_length=32, max_length=128)


class VerbindenZugangOut(ZugangsdatenOut):
    #: Der Name, den ``pulse-connect`` im Terminal nennt („Connected to …“) —
    #: so sieht der Betreiber, wessen Klick den Server bekommen hat.
    owner_name: str


class VorgangAus(BaseModel):
    hostname: str
    gueltig_bis: str


class VorgangEin(BaseModel):
    #: Wie getippt oder aus dem Link übernommen; ``code_normalisieren`` macht
    #: daraus die Speicherform.
    code: str = Field(..., min_length=1, max_length=32)


class EntscheidungEin(VorgangEin):
    aktion: Literal["verbinden", "ablehnen"]


class EntscheidungAus(BaseModel):
    status: Literal["verbunden", "abgelehnt"]
    hostname: str | None = None
    instance_id: str | None = None


async def _redis(request: Request):
    """Ohne Redis kein Vorgang — anders als Sperrlisten-Cache und
    Admin-Ereignisse gibt es hier nichts, worauf man zurückfallen könnte."""
    redis = await _get_redis(request)
    if redis is None:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, detail="verbinden_nicht_verfuegbar"
        )
    return redis


def _bremse_je_konto(request: Request, user_id: int) -> None:
    """Je Konto statt je IP: ``_check_rate`` kennt pro Konto nur das
    allgemeine Login-Budget (``rate_limit_per_account``), und das ist für
    eine Seite, die man einmal pro Server öffnet, zu weit."""
    regel = get_settings().rate_limit_verbinden_bestaetigen
    anzahl, sekunden = _parse_rule(regel)
    _consume_token(
        request.app, "verbinden_bestaetigen", str(user_id), anzahl, sekunden, monotonic(), regel
    )


async def _offener_vorgang(redis, roh: str) -> tuple[str, Vorgang]:
    """Unbekannt, abgelaufen und schon entschieden sehen gleich aus."""
    code = code_normalisieren(roh)
    treffer = await vorgang_per_code(redis, code) if code else None
    if treffer is None or treffer[1].status != "wartet":
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="unbekannt")
    return treffer


def _nachweis_fehlt(befund: str) -> HTTPException:
    return HTTPException(
        status.HTTP_409_CONFLICT, detail={"code": "nachweis_fehlt", "befund": befund}
    )


@router.post(
    "/selfhost/verbinden/start", response_model=StartAus, status_code=status.HTTP_201_CREATED
)
async def verbinden_start(payload: StartEin, request: Request) -> StartAus:
    settings = get_settings()
    await _check_rate(request, "verbinden_start", settings.rate_limit_verbinden_start)

    hostname = normalisiere_hostname(payload.hostname)
    if hostname is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="adresse_ungueltig")
    if adresse_gesperrt(hostname, settings):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="adresse_gesperrt")
    redis = await _redis(request)

    nachweis = nachweis_aus_kennung(payload.kennung)
    # Schon hier und nicht erst beim Bestätigen: ein Server, den die Cloud
    # nicht erreicht, soll keinen Code verbrauchen, den der Betreiber dann
    # vergeblich bestätigt.
    befund = await nachweis_pruefen(hostname, nachweis)
    if befund is not None:
        raise _nachweis_fehlt(befund)
    try:
        vorgang = await vorgang_anlegen(redis, hostname, nachweis)
    except VorgangLaeuft:
        raise HTTPException(status.HTTP_409_CONFLICT, detail="vorgang_laeuft") from None

    anzeige = code_anzeigen(vorgang.code)
    basis = (settings.app_base_url or settings.pulse_oidc_issuer).rstrip("/")
    return StartAus(
        code=anzeige,
        # Der Code steht hinter ``#``: der Browser schickt ihn nie an einen
        # Server, er landet in keinem Zugriffsprotokoll (E5).
        link=f"{basis}/verbinden#{anzeige}",
        gueltig_s=GUELTIG_S,
        abstand_s=ABSTAND_S,
    )


@router.post("/me/selfhost/verbinden/vorgang", response_model=VorgangAus)
async def verbinden_ansehen(payload: VorgangEin, request: Request, db: SessionDep) -> VorgangAus:
    user = await _require_user(request, db)
    _bremse_je_konto(request, user.id)
    _, vorgang = await _offener_vorgang(await _redis(request), payload.code)
    return VorgangAus(hostname=vorgang.hostname, gueltig_bis=vorgang.gueltig_bis)


@router.post(
    "/me/selfhost/verbinden/entscheidung",
    response_model=EntscheidungAus,
    # „abgelehnt“ antwortet nur mit dem Status, wie im Vertrag.
    response_model_exclude_none=True,
)
async def verbinden_entscheiden(
    payload: EntscheidungEin, request: Request, db: SessionDep
) -> EntscheidungAus:
    user = await _require_user(request, db)
    _bremse_je_konto(request, user.id)
    redis = await _redis(request)
    nachweis, vorgang = await _offener_vorgang(redis, payload.code)

    if payload.aktion == "ablehnen":
        if not await vorgang_entscheiden(
            redis, nachweis, "abgelehnt", instance_id=None, user_id=str(user.id)
        ):
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail="unbekannt")
        return EntscheidungAus(status="abgelehnt")

    if user.server_verbinden_gesperrt:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="verbinden_gesperrt")
    # Zweite Prüfung: zwischen Anfrage und Klick können Minuten liegen. Erst
    # sie macht die Übernahme einer eingetragenen Adresse vertretbar (E2).
    befund = await nachweis_pruefen(vorgang.hostname, nachweis)
    if befund is not None:
        raise _nachweis_fehlt(befund)

    try:
        verbunden = await instanz_verbinden(db, user, vorgang.hostname)
    except ZuVieleServer:
        raise HTTPException(status.HTTP_409_CONFLICT, detail="zu_viele_server") from None
    except InstanzGesperrt:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="instance_suspended") from None
    except IntegrityError:
        # Ein gleichzeitiger Klick auf denselben Code hat die Adresse schon
        # eingetragen und gewinnt.
        await db.rollback()
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="unbekannt") from None

    instanz_id = str(verbunden.instanz.id)
    if not await vorgang_entscheiden(
        redis, nachweis, "bestaetigt", instance_id=instanz_id, user_id=str(user.id)
    ):
        await db.rollback()
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="unbekannt")
    await db.commit()

    if verbunden.abgeloest is not None:
        await suspended_list_add(redis, verbunden.abgeloest)
        # warning, weil ``info`` in der Cloud unsichtbar ist (logging_setup.py):
        # wer später fragt, warum sein Server stillsteht, findet es hier.
        log.warning(
            "verbinden_uebernahme hostname=%s alt=%s neu=%s",
            vorgang.hostname,
            verbunden.abgeloest,
            instanz_id,
        )
    return EntscheidungAus(status="verbunden", hostname=vorgang.hostname, instance_id=instanz_id)


@router.post(
    "/selfhost/verbinden/abholen",
    response_model=VerbindenZugangOut,
    responses={202: {"description": "noch nicht entschieden"}},
)
async def verbinden_abholen(payload: AbholenEin, request: Request, db: SessionDep):
    settings = get_settings()
    await _check_rate(request, "verbinden_abholen", settings.rate_limit_verbinden_abholen)
    redis = await _redis(request)
    nachweis = nachweis_aus_kennung(payload.kennung)

    vorgang = await vorgang_per_nachweis(redis, nachweis)
    if vorgang is None:
        raise HTTPException(status.HTTP_410_GONE, detail="abgelaufen")
    if vorgang.status == "wartet":
        return JSONResponse(status_code=status.HTTP_202_ACCEPTED, content={"status": "wartet"})

    # Ab hier genau einmal: wer den Vorgang entnimmt, bekommt das Ergebnis.
    vorgang = await vorgang_entnehmen(redis, nachweis)
    if vorgang is None:
        raise HTTPException(status.HTTP_410_GONE, detail="abgelaufen")
    if vorgang.status == "abgelehnt":
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="abgelehnt")

    instanz = await db.get(RegisteredInstance, int(vorgang.instance_id), with_for_update=True)
    # Zwischen Klick und Abholen gesperrt, gelöscht oder übernommen, oder der
    # Besitzer hat sein Konto gelöscht: nichts mehr auszuhändigen.
    if instanz is None or instanz.status != "active" or instanz.registered_by is None:
        raise HTTPException(status.HTTP_410_GONE, detail="abgelaufen")

    zugang = await zugangsdaten_ausgeben(db, instanz, settings)
    instanz.verbunden_at = datetime.now(UTC)
    besitzer = await db.get(User, instanz.registered_by)
    await db.commit()
    return VerbindenZugangOut(
        **zugang.model_dump(),
        owner_name=besitzer.display_name or besitzer.username,
    )
