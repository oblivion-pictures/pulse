"""Verbinden per Gerätecode — die vier Routen.

Ein Self-Host verbindet sich am Ende seiner Installation mit dem Konto seines
Betreibers (Spec
``docs/superpowers/specs/2026-10-09-selfhost-ohne-freigabe-design.md``, E1):

1. ``POST /selfhost/verbinden/start`` — anonym, vom Server (``pulse-connect``).
2. ``POST /me/selfhost/verbinden/vorgang`` — angemeldet, die Bestätigungsseite.
3. ``POST /me/selfhost/verbinden/entscheidung`` — angemeldet, „Verbinden“/„Abbrechen“.
4. ``POST /selfhost/verbinden/abholen`` — anonym, vom Server: 202 bis zur Entscheidung,
   dann 200/403/409/410.

Die beiden anonymen Routen vertrauen dem Aufrufer nichts an, was er nicht
schon hat: Der Start verlangt die Abholkennung (die Cloud prüft ihren Hash
unter der Adresse), das Abholen liefert nur dem, der dieselbe Kennung kennt.
Kennung, Code und Secret werden nie geloggt — und der Code steht in keinem
Pfad, auch bei den angemeldeten Routen nicht: Pfade landen in
Zugriffsprotokollen (``web-nginx.conf`` loggt ``$uri``), und wer dort einen
offenen Code liest, könnte ihn mit seinem Konto bestätigen.

Gehört die Adresse schon einem anderen Konto, entsteht beim Verbinden erst
ein Übernahme-Antrag (Widerspruchsfrist, ``verbinden_uebernahme.py`` und
``verbinden_antrag.py``).
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from time import monotonic

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import JSONResponse
from sqlalchemy.exc import IntegrityError

from dcc_shared.hostname import normalisiere_hostname

from dcc_auth.admin_events import publish_instanz_verbunden
from dcc_auth.config import get_settings
from dcc_auth.db import SessionDep
from dcc_auth.dns_ausfuehrer import Ausgelastet
from dcc_auth.email_verbinden import compose_verbinden_hinweis, hinweis_mail
from dcc_auth.models import User
from dcc_auth.models_instances import RegisteredInstance
from dcc_auth.routes import _check_rate, _consume_token, _parse_rule
from dcc_auth.routes_admin_instances import _require_cloud
from dcc_auth.routes_instance_applications import _require_user
from dcc_auth.routes_suspended_instances import _get_redis
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
    vorgang_hinweis_setzen,
    vorgang_per_code,
    vorgang_per_nachweis,
)
from dcc_auth.verbinden_antrag import (
    abholen_ausnahme,
    antrag_gestellt,
    endgueltig_abgelehnt,
    uebernahme_gesperrt,
    uebernahme_nachbereiten,
)
from dcc_auth.verbinden_eintrag import (
    InstanzGesperrt,
    ZuVieleServer,
    adresse_gesperrt,
    instanz_verbinden,
)
from dcc_auth.verbinden_nachweis import nachweis_pruefen
from dcc_auth.verbinden_schemas import (
    AbholenEin,
    EntscheidungAus,
    EntscheidungEin,
    StartAus,
    StartEin,
    VerbindenZugangOut,
    VorgangAus,
    VorgangEin,
)
from dcc_auth.verbinden_uebernahme import (
    UebernahmeBeantragt,
    UebernahmeGesperrt,
    adresse_vergeben,
    uebernahme_pruefen,
    uebernahme_vollzogen,
)
from dcc_auth.zugangsdaten import zugangsdaten_ausgeben

log = logging.getLogger(__name__)

router = APIRouter(tags=["self-host"], dependencies=[Depends(_require_cloud)])


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


def verbinden_ausgelastet() -> HTTPException:
    """Der Auflösungs-Pool der Prüfungen von aussen ist voll
    (``dns_ausfuehrer.py``) — kein Befund über die Adresse, später noch einmal."""
    return HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, detail="verbinden_ausgelastet")


async def _nachweis_verlangen(hostname: str, nachweis: str, redis=None) -> None:
    """Die Prüfung von aussen; jeder Befund ausser „in Ordnung“ ist ein 409.

    Mit ``redis`` (beim Bestätigen) merkt sich der wartende Vorgang den
    Befund; der Start hat noch keinen."""
    try:
        befund = await nachweis_pruefen(hostname, nachweis)
    except Ausgelastet:
        raise verbinden_ausgelastet() from None
    if befund is not None:
        if redis is not None:
            await vorgang_hinweis_setzen(redis, nachweis, "nachweis_fehlt")
        raise _nachweis_fehlt(befund)


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
    await _nachweis_verlangen(hostname, nachweis)
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
    return VorgangAus(
        hostname=vorgang.hostname,
        gueltig_bis=vorgang.gueltig_bis,
        adresse_vergeben=await adresse_vergeben(db, vorgang.hostname, user.id),
    )


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
    # Nach einem Zurückrollen sind geladene Objekte abgelaufen; die Nummer
    # bleibt lesbar.
    user_id = user.id
    _bremse_je_konto(request, user_id)
    redis = await _redis(request)
    nachweis, vorgang = await _offener_vorgang(redis, payload.code)

    if payload.aktion == "ablehnen":
        if not await vorgang_entscheiden(
            redis, nachweis, "abgelehnt", instance_id=None, user_id=str(user_id)
        ):
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail="unbekannt")
        return EntscheidungAus(status="abgelehnt")

    if user.server_verbinden_gesperrt:
        # Endgültig: ein zweiter Klick ändert daran nichts.
        raise await endgueltig_abgelehnt(
            redis, nachweis, user_id, vorgang.hostname, "verbinden_gesperrt"
        )
    # Zweite Prüfung: zwischen Anfrage und Klick können Minuten liegen. Erst
    # sie macht die Übernahme einer eingetragenen Adresse vertretbar (E2).
    await _nachweis_verlangen(vorgang.hostname, nachweis, redis)

    try:
        # Eine fremde Adresse erst nach der Widerspruchsfrist
        # (verbinden_uebernahme.py); bis dahin nur ein Antrag.
        await uebernahme_pruefen(db, user, vorgang.hostname, get_settings())
        verbunden = await instanz_verbinden(db, user, vorgang.hostname)
    except UebernahmeBeantragt as antrag:
        return await antrag_gestellt(db, redis, nachweis, user_id, vorgang.hostname, antrag)
    except UebernahmeGesperrt as sperre:
        raise await uebernahme_gesperrt(
            db, redis, nachweis, user_id, vorgang.hostname, sperre.bis
        ) from None
    except ZuVieleServer:
        # Wiederholbar (ein gelöschter Server genügt): der Vorgang bleibt offen.
        await vorgang_hinweis_setzen(redis, nachweis, "zu_viele_server")
        raise HTTPException(status.HTTP_409_CONFLICT, detail="zu_viele_server") from None
    except InstanzGesperrt:
        await db.rollback()
        raise await endgueltig_abgelehnt(
            redis, nachweis, user_id, vorgang.hostname, "instance_suspended"
        ) from None
    except IntegrityError:
        # Ein gleichzeitiger Klick auf denselben Code hat die Adresse schon
        # eingetragen und gewinnt; ebenso ein Antrags-``flush`` aus
        # ``uebernahme_pruefen``, der auch im letzten Versuch scheitert.
        await db.rollback()
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="unbekannt") from None

    if verbunden.abgeloest is not None:
        await uebernahme_vollzogen(db, verbunden.abgeloest)
    instanz_id = str(verbunden.instanz.id)
    if not await vorgang_entscheiden(
        redis, nachweis, "bestaetigt", instance_id=instanz_id, user_id=str(user_id)
    ):
        await db.rollback()
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="unbekannt")
    await db.commit()

    jetzt = datetime.now(UTC)
    if verbunden.abgeloest is not None:
        await uebernahme_nachbereiten(
            db, redis, vorgang.hostname, verbunden.abgeloest, instanz_id, jetzt
        )
    await hinweis_mail(db, user, compose_verbinden_hinweis(vorgang.hostname, jetzt))
    return EntscheidungAus(status="verbunden", hostname=vorgang.hostname, instance_id=instanz_id)


@router.post(
    "/selfhost/verbinden/abholen",
    response_model=VerbindenZugangOut,
    responses={202: {"description": "noch nicht entschieden"}},
)
async def verbinden_abholen(
    payload: AbholenEin, request: Request, db: SessionDep
) -> VerbindenZugangOut | JSONResponse:
    settings = get_settings()
    await _check_rate(request, "verbinden_abholen", settings.rate_limit_verbinden_abholen)
    redis = await _redis(request)
    nachweis = nachweis_aus_kennung(payload.kennung)

    vorgang = await vorgang_per_nachweis(redis, nachweis)
    if vorgang is None:
        raise HTTPException(status.HTTP_410_GONE, detail="abgelaufen")
    if vorgang.status == "wartet":
        inhalt = {"status": "wartet"}
        if vorgang.hinweis:  # warum das Bestätigen zuletzt scheiterte; Vorgang bleibt offen
            inhalt["hinweis"] = vorgang.hinweis
        return JSONResponse(status_code=status.HTTP_202_ACCEPTED, content=inhalt)

    # Ab hier genau einmal: wer den Vorgang entnimmt, bekommt das Ergebnis.
    vorgang = await vorgang_entnehmen(redis, nachweis)
    if vorgang is None:
        raise HTTPException(status.HTTP_410_GONE, detail="abgelaufen")
    ausnahme = abholen_ausnahme(vorgang)
    if ausnahme is not None:
        raise ausnahme
    # Zwischen Lesen und Entnehmen kann der entschiedene Vorgang abgelaufen
    # sein und ein neuer Start mit derselben Kennung einen frischen angelegt
    # haben: der wartet noch und hat keine Instanz.
    if vorgang.status != "bestaetigt" or vorgang.instance_id is None:
        raise HTTPException(status.HTTP_410_GONE, detail="abgelaufen")

    instanz = await db.get(RegisteredInstance, int(vorgang.instance_id), with_for_update=True)
    # Zwischen Klick und Abholen gesperrt, gelöscht oder übernommen, oder der
    # Besitzer hat sein Konto gelöscht: nichts mehr auszuhändigen.
    if instanz is None or instanz.status != "active" or instanz.registered_by is None:
        raise HTTPException(status.HTTP_410_GONE, detail="abgelaufen")

    zugang = await zugangsdaten_ausgeben(db, instanz, settings)
    instanz.verbunden_at = datetime.now(UTC)
    besitzer = await db.get(User, instanz.registered_by)
    await db.commit()
    await publish_instanz_verbunden(request, user_id=instanz.registered_by, instance_id=instanz.id)
    return VerbindenZugangOut(
        **zugang.model_dump(),
        owner_name=besitzer.display_name or besitzer.username,
    )
