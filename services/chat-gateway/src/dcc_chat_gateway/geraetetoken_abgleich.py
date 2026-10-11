"""Gerätetoken gegen die Anmelde-Ketten am auth-svc abgleichen (Nachtrag zu C2).

**Warum es diesen Lauf gibt.** FCM- und PushKit-Token tragen die Kette, unter
der sie angemeldet wurden (Migration 0102), und fallen, wenn auth-svc deren
Ende meldet (``push_widerruf.py``). Die Meldung reist über Redis Pub/Sub und
hat zwei Lücken: Ein Ende, das während eines Neustarts dieses Dienstes kommt,
hört niemand — das verlorene Telefon klingelte weiter. Und eine Kette, die nur
abläuft (30 Tage ohne Rotation), meldet niemand.

**Wie.** Kurz nach dem Start (``ERSTER_LAUF_S`` — genau dann fehlen die
Meldungen aus dem Neustart) und danach alle ``TAKT_S`` sammelt der Lauf jedes
Paar ``(user_id, kette)`` aus beiden Tabellen, fragt auth-svc, welche davon zu
Ende sind (``dcc_shared.anmeldeketten.STAND_PFAD``), und löscht deren Zeilen
über ``geraetetoken_loeschen`` — denselben Weg wie die Meldung. Der Lauf merkt
sich nichts; auth-svc bleibt die einzige Quelle, und jedes Ende, das die
Meldung verpasst, holt der nächste Lauf nach, auch eines an einer Stelle, die
das Melden vergisst.

**Fail-open, und zwar so herum:** Ist auth-svc nicht erreichbar, antwortet es
nicht mit 200 oder unlesbar, bleibt jede Zeile stehen. Gelöscht wird nur, was
auth-svc ausdrücklich als beendet nennt — und das tut es nur für Konten, die
es kennt (Begründung in ``dcc_shared.anmeldeketten``).

**Zeilen ohne Kette** (vor Migration 0102 angemeldet) fasst der Lauf nicht an;
er fragt gar nicht nach ihnen. Sie bekommen ihre Kette beim nächsten
App-Start.

**Self-Host.** Die App meldet ihre Gerätetoken an die Cloud
(``platform/fcm.ts``/``voipToken.ts``: ``cloud()``) — auf einem Self-Host gibt
es im Regelfall keine Zeile mit Kette, und der Lauf fragt nichts. Kommt doch
eine vor, stammt die Kette aus einem Zugriffs-Token, das dieser Dienst gegen
die JWKS SEINES auth-svc geprüft hat (``AUTH_JWKS_URL``), und genau das fragt
er (``AUTH_SVC_URL``). Die Sitzungs-Token des Self-Hosts tragen keine Kette.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections import defaultdict
from collections.abc import Callable
from typing import Any

import httpx
from dcc_shared.anmeldeketten import (
    STAND_HOECHSTENS,
    STAND_PFAD,
    KettenEnde,
    KettenStand,
    Paar,
    stand_anfrage,
    stand_lesen,
)
from sqlalchemy import select

from dcc_chat_gateway import config as _config
from dcc_chat_gateway.models import FcmToken, VoipToken
from dcc_chat_gateway.push_widerruf import geraetetoken_loeschen

log = logging.getLogger(__name__)

#: Abstand zwischen zwei Läufen. Für das Ablaufen genügte ein Tag; der Takt
#: bemisst sich an einer verlorenen Meldung ausserhalb eines Neustarts
#: (Aussetzer der Redis-Verbindung) — so lange klingelt ein widerrufenes
#: Telefon höchstens weiter. Ein Lauf kostet zwei Abfragen auf kleinen
#: Tabellen und eine Anfrage je ``STAND_HOECHSTENS`` Ketten.
TAKT_S = 15 * 60

#: Erster Lauf nach dem Start. Nicht sofort: beim Ausrollen startet auth-svc
#: meist im selben Zug neu, und ein Lauf gegen ein noch fehlendes auth-svc
#: verschöbe das Nachholen um einen ganzen Takt.
ERSTER_LAUF_S = 60

_ZEITLIMIT_S = 10.0


async def _paare(session: Any) -> list[Paar]:
    paare: set[Paar] = set()
    for modell in (FcmToken, VoipToken):
        zeilen = await session.execute(
            select(modell.user_id, modell.kette).where(modell.kette.is_not(None)).distinct()
        )
        paare.update(zeilen.tuples().all())
    return sorted(paare)


async def _frage(
    klient: httpx.AsyncClient, url: str, secret: str, stueck: list[Paar]
) -> KettenStand | None:
    """Ein Stück erfragen; ``None`` heisst: für dieses Stück nichts löschen.

    `warning`: die Cloud-Vorgabe für PULSE_LOG_LEVEL (logging_setup.py). Ein
    Lauf, der dauerhaft scheitert, lässt beide Lücken wieder offen.
    """
    try:
        r = await klient.post(
            url, json=stand_anfrage(stueck), headers={"X-Pulse-Internal-Secret": secret}
        )
    except httpx.HTTPError as exc:
        log.warning("geraetetoken_abgleich_fehlgeschlagen grund=%s", type(exc).__name__)
        return None
    if r.status_code != 200:
        log.warning("geraetetoken_abgleich_fehlgeschlagen status=%d", r.status_code)
        return None
    try:
        daten = r.json()
    except ValueError:
        daten = None
    stand = stand_lesen(daten, stueck)
    if stand is None:
        log.warning("geraetetoken_abgleich_fehlgeschlagen grund=antwort_unlesbar")
    return stand


async def abgleich_einmal(
    fabrik: Callable[[], Any], *, http: httpx.AsyncClient | None = None
) -> int:
    """Ein Durchgang; liefert die Zahl gelöschter Zeilen."""
    settings = _config.get_settings()
    secret = settings.internal_service_secret
    if not secret:
        return 0
    async with fabrik() as session:
        paare = await _paare(session)
    if not paare:
        return 0
    url = settings.auth_svc_url.rstrip("/") + STAND_PFAD
    beendet: dict[int, set[str]] = defaultdict(set)
    unbekannt = 0
    if http is None:
        klient_kontext = httpx.AsyncClient(timeout=_ZEITLIMIT_S)
    else:
        klient_kontext = contextlib.nullcontext(http)
    async with klient_kontext as klient:
        for i in range(0, len(paare), STAND_HOECHSTENS):
            stand = await _frage(klient, url, secret, paare[i : i + STAND_HOECHSTENS])
            if stand is None:
                continue
            unbekannt += stand.unbekannt
            for uid, kette in stand.beendet:
                beendet[uid].add(kette)
    if unbekannt:
        # Konto bei auth-svc unbekannt: ein Löschen des Kontos, dessen Abräumen
        # hier nicht ankam (``user_purge.py``), oder ein falsches AUTH_SVC_URL.
        log.warning("geraetetoken_abgleich_unbekannt ketten=%d", unbekannt)
    geloescht = 0
    async with fabrik() as session:
        for uid, ketten in sorted(beendet.items()):
            anzahl = await geraetetoken_loeschen(session, KettenEnde(uid, frozenset(ketten)))
            if anzahl:
                # Ein Ende, das die Meldung verpasst hat oder das nie gemeldet
                # wird (Ablauf) — der Name trennt es von ``push_widerruf``.
                log.warning("geraetetoken_abgleich_beendet user=%s anzahl=%d", uid, anzahl)
            geloescht += anzahl
    return geloescht


async def abgleich_loop(fabrik: Callable[[], Any]) -> None:
    """Läuft bis zum Abbruch; ohne ``INTERNAL_SERVICE_SECRET`` gar nicht."""
    if not _config.get_settings().internal_service_secret:
        log.warning("geraetetoken_abgleich_aus grund=internal_service_secret_fehlt")
        return
    await asyncio.sleep(ERSTER_LAUF_S)
    while True:
        try:
            await abgleich_einmal(fabrik)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 — der nächste Takt versucht es wieder
            log.exception("geraetetoken_abgleich_abgebrochen")
        await asyncio.sleep(TAKT_S)


__all__ = ["ERSTER_LAUF_S", "TAKT_S", "abgleich_einmal", "abgleich_loop"]
