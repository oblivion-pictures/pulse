"""Wann klingelt wessen Telefon — der Push-Teil des Anruf-Wegs (Punkt 40).

Getrennt von :mod:`dcc_chat_gateway.apns_voip`, und die Naht ist inhaltlich:
dort steht, WIE man mit APNs spricht (JWT, Kopfzeilen, Statusdeutung), hier,
WANN wer einen Push bekommt.

**Alles fail-open.** Fehlender Schlüssel, toter Token, Störung bei Apple oder
Redis: der Anruf läuft wie bisher über die WebSocket weiter. Ein Push ist die
Zugabe für den, der gerade keine offene Verbindung hat.

**Die eine Regel von Apple, an der hier alles hängt:** jeder VoIP-Push
verpflichtet die App, einen Anruf an CallKit zu melden. Tut sie das nicht,
beendet iOS sie, und bei Wiederholung stellt es die VoIP-Pushes für die App
ganz ab — dann klingelt bei geschlossener App gar nichts mehr. Ein Push, auf
den die Hülle keinen Anruf melden kann, ist deshalb nicht harmlos, sondern
der teuerste Push überhaupt. Bis zum 2026-10-11 ging der Abbruch an JEDEN
Teilnehmer — auch an den Anrufer, dessen Telefon nie geklingelt hatte, und
an das Gerät, das gerade selbst aufgelegt hatte (Bughunt 2026-10-11, K3).

Daraus folgen die zwei Hälften dieses Moduls:

* **Klingeln geht an JEDES iOS-Gerät der Gerufenen** — ohne Frische-Prüfung
  der WebSocket. Bis zum 2026-10-11 wurde ein Telefon mit einer Verbindung,
  die in den letzten 40 s etwas gesagt hatte, übersprungen; ein eben
  weggestecktes Telefon galt damit als wach, sein eingefrorenes JS verarbeitete
  das ``call_klingelt`` aber nie, und der Anruf war verpasst (T14). Ein
  zusätzlicher Push an ein waches Telefon kostet nichts: die Hülle kennt den
  Anruf dann schon (die WebSocket hat ihn über ``ankommen`` gemeldet) und
  meldet ihn mit derselben UUID noch einmal — CallKit antwortet
  ``callUUIDAlreadyExists``, das erfüllt Apples Regel, und es entsteht kein
  zweiter Bildschirm (``AnrufPushAusgang.swift``). Bis zum 2026-10-11 meldete
  die Hülle in diesem Fall gar nichts, und der Push war ein Verstoss.
* **Der Abbruch geht nur an Geräte, die per Push geklingelt haben** — und an
  keins davon zweimal. Welche das waren, steht je Anruf in Redis
  (:func:`klingeln` schreibt, :func:`abbrechen` liest und trägt aus). Wer
  nicht geklingelt hat, bekommt keinen Abbruch; wer selbst gehandelt hat
  (``ausser``), auch nicht — sein Anruf ist dort schon zu. **Wer das Ende
  quittiert hat, ebenso nicht** (:func:`ende_gesehen`, iOS-Bughunt 2, A6): die
  wache Oberfläche hört es über die WebSocket und schliesst CallKit selbst;
  der Push fand dort keinen Anruf mehr, musste nach Apples Regel als neuer
  gemeldet und sofort beendet werden, und ein zweiter Anrufbildschirm
  blitzte auf (auf Hüllen vor ``9184816d`` ein Verstoss).

**Android** (Push-Bughunt 2026-10-20): dieselben zwei Hälften gelten für
Android-Geräte, die ``anruf_push`` gemeldet haben — sie bekommen einen
FCM-Datenpush statt eines VoIP-Pushes (:mod:`dcc_chat_gateway.anruf_push_fcm`).
Ältere Android-Bauten bekommen keinen. Apples Regel gilt dort nicht; der
Abbruch folgt trotzdem derselben Auswahl, damit beide Plattformen dasselbe
erleben. Der Merker hält beide Arten auseinander (``anruf_push_merker``).

**Wer sich nicht stören lässt, bei dem klingelt per Push nichts**
(Eigentümer-Entscheid 2026-10-20): „Nicht stören“ schweigt jeden Anruf, die
stummgeschaltete Gruppe jeden Anruf dieser Gruppe (``fcm_stumm``). Das
``call_klingelt`` über die WebSocket geht trotzdem hinaus — die Oberfläche
ist wach, und ob sie klingelt, entscheidet sie. Wer den Anrufer blockiert hat
(oder von ihm blockiert ist), wird in einem Gruppenanruf gar nicht erst
angeklingelt, auf keinem Weg (``routes/anrufe.py``).

**Gesendet wird im Hintergrund** (Bughunt T17): ein APNs-Rundlauf dauert, und
bis zum 2026-10-11 hing er im Anfragepfad von ``POST /anrufe`` — solange
kannte der Anrufer die Anruf-Kennung nicht. Die Klingel- und Abbruch-Sendungen
eines Anrufs laufen dabei der Reihe nach (:func:`_im_hintergrund`), damit ein
schneller Abbruch nicht vor seinem Klingeln bei Apple ankommt.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Coroutine
from typing import Any

from sqlalchemy import delete, select

from dcc_chat_gateway import anruf_push_fcm, apns_voip
from dcc_chat_gateway.anruf_push_merker import (
    ANDROID,
    GEKLINGELT_HALTBARKEIT_S,
    GEKLINGELT_PRAEFIX,
    IOS,
    Geraet,
    schluessel,
)
from dcc_chat_gateway.anruf_push_merker import austragen as _austragen
from dcc_chat_gateway.anruf_push_merker import geklingelt as _geklingelt
from dcc_chat_gateway.anruf_push_merker import merken as _merken
from dcc_chat_gateway.config import get_settings
from dcc_chat_gateway.fcm_stumm import anruf_stumme_konten
from dcc_chat_gateway.models import VoipToken

log = logging.getLogger("dcc_chat_gateway.anruf_push")

#: So lange wartet ein Abbruch auf Quittungen (:func:`ende_gesehen`).
#: **Gesetzt, nicht gemessen** (WebSocket → Oberfläche → POST, ein Rundlauf).
#: Länger klingelt nur ein Telefon, dessen Oberfläche nicht quittiert, also
#: eingefroren ist. Eine verspätete Quittung kostet nur das Aufblitzen.
ABBRUCH_FRIST_S = 2.0


def auswaehlen(
    geklingelt: list[Geraet],
    *,
    nur_konten: set[int] | None = None,
    ausser: tuple[int, str] | None = None,
) -> list[Geraet]:
    """Welche der geklingelten Geräte einen Abbruch bekommen.

    ``nur_konten``: nur Geräte dieser Konten (Gruppenanruf — ein Mitglied, das
    annimmt oder ablehnt, beendet nur das Klingeln SEINER Geräte; die übrigen
    Mitglieder dürfen weiter beitreten). ``ausser``: das handelnde Gerät
    selbst, ``(user_id, geraet_id)`` — dort ist der Anruf schon zu, und ein
    Push dorthin fände keinen Anruf mehr, den die Hülle melden könnte. Ohne
    ``ausser`` gilt kein Gerät als handelnd.

    Rein und ohne Zugriff nach aussen, damit die Regel ohne Redis und ohne
    Apple prüfbar ist.
    """
    return [
        g
        for g in geklingelt
        if (nur_konten is None or g.user_id in nur_konten) and g.kennung != ausser
    ]


# MARK: - Hintergrund

#: Laufende Sendungen je Anruf — die nächste wartet auf die vorige.
_letzte_je_anruf: dict[str, asyncio.Task[None]] = {}
#: Starke Verweise auf alle laufenden Sendungen. Ohne sie darf der
#: Ereignis-Loop eine Aufgabe mitten im Lauf einsammeln.
_laufend: set[asyncio.Task[None]] = set()


def _im_hintergrund(call_id: str, arbeit: Coroutine[Any, Any, None]) -> None:
    """``arbeit`` im Hintergrund starten — erst, wenn die vorige Sendung
    desselben Anrufs durch ist (s. Modulkopf)."""
    vorher = _letzte_je_anruf.get(call_id)

    async def kette() -> None:
        if vorher is not None:
            await asyncio.gather(vorher, return_exceptions=True)
        try:
            await arbeit
        except Exception:  # noqa: BLE001 — Push ist best-effort
            log.exception("anruf_voip_sendung_fehlgeschlagen")

    aufgabe = asyncio.create_task(kette(), name=f"anruf-voip-{call_id}")
    _laufend.add(aufgabe)
    _letzte_je_anruf[call_id] = aufgabe

    def fertig(t: asyncio.Task[None]) -> None:
        _laufend.discard(t)
        if _letzte_je_anruf.get(call_id) is t:
            del _letzte_je_anruf[call_id]

    aufgabe.add_done_callback(fertig)


async def hintergrund_abwarten(frist_s: float = 5.0) -> None:
    """Auf alle laufenden Sendungen warten — beim Herunterfahren, und in Tests,
    die sehen wollen, was hinausging."""
    offen = set(_laufend)
    if offen:
        await asyncio.wait(offen, timeout=frist_s)


async def _senden(
    zugang: apns_voip.ApnsZugang | None, geraete: list[Geraet], nutzlast: dict, session_factory: Any
) -> None:
    """An alle ``geraete`` senden — iOS per VoIP (ohne ``zugang`` nicht),
    Android per FCM; tote Tokens löschen. Eine Plattform reisst die andere
    nicht mit."""
    android = [g.token for g in geraete if g.plattform == ANDROID]
    ios = [g for g in geraete if g.plattform == IOS] if zugang is not None else []
    ausgaenge = await asyncio.gather(
        _voip_senden(zugang, ios, nutzlast, session_factory),
        anruf_push_fcm.senden(android, nutzlast, session_factory),
        return_exceptions=True,
    )
    for ausgang in ausgaenge:
        if isinstance(ausgang, Exception):
            log.error("anruf_push_sendung_fehlgeschlagen grund=%s", type(ausgang).__name__)


async def _voip_senden(
    zugang: apns_voip.ApnsZugang | None, geraete: list[Geraet], nutzlast: dict, session_factory: Any
) -> None:
    """An alle iOS-``geraete`` senden; Tokens, die Apple als tot meldet, löschen."""
    if zugang is None or not geraete:
        return
    ergebnisse = await asyncio.gather(
        *(
            apns_voip.senden(zugang=zugang, geraete_token=g.token, nutzlast=nutzlast)
            for g in geraete
        ),
        return_exceptions=True,
    )
    tote = [g.token for g, ausgang in zip(geraete, ergebnisse, strict=True) if ausgang == "dead"]
    if not tote or session_factory is None:
        return
    async with session_factory() as session:
        await session.execute(delete(VoipToken).where(VoipToken.token.in_(tote)))
        await session.commit()


# MARK: - Die zwei Einstiege


async def klingeln(
    *,
    session: Any,
    redis: Any,
    session_factory: Any,
    empfaenger_ids: set[int],
    call_id: str,
    art: str,
    channel_id: str,
    einleiter_id: str,
    einleiter_name: str,
) -> None:
    """Einen eingehenden Anruf an alle iOS-Geräte der Gerufenen und an ihre
    Android-Geräte mit ``anruf_push`` melden.

    **Der Name reist mit, anders als im WS-Ereignis.** Dort steht nur
    ``einleiter_id``, und der Klient löst den Namen aus seinem Zwischenspeicher
    auf — nativer Code hat keinen. Ohne den Namen stünde im CallKit-Bildschirm
    eine Zahl.

    ``anruf_art`` ist ``dm`` oder ``gruppe`` — die ART DES GESPRÄCHS, nicht
    ob Video läuft. Einen Videoanruf als eigene Art gibt es nicht; die Kamera
    schaltet man im laufenden Anruf zu (Bughunt G3: die Hülle prüfte hier auf
    ``video`` und das Web fiel auf ein ungültiges ``audio`` zurück).

    Kehrt zurück, sobald gemerkt ist, wer klingelt; gesendet wird im
    Hintergrund. Löst nie aus. Wer „Nicht stören“ an oder die Gruppe
    stummgeschaltet hat, bekommt keinen Push (s. Modulkopf).
    """
    if not empfaenger_ids:
        return
    zugang = apns_voip.zugang_aus_einstellungen(get_settings())
    fcm_an = anruf_push_fcm.verfuegbar()
    if zugang is None and not fcm_an:
        return
    try:
        gruppe = int(channel_id) if art == "gruppe" else None
        konten = empfaenger_ids - await anruf_stumme_konten(
            session, redis, empfaenger_ids, gruppe_id=gruppe
        )
        geraete: list[Geraet] = []
        if konten and zugang is not None:
            treffer = await session.execute(
                select(VoipToken).where(VoipToken.user_id.in_(list(konten)))
            )
            geraete += [
                Geraet(user_id=z.user_id, geraet_id=z.geraet_id, token=z.token)
                for z in treffer.scalars().all()
            ]
        if konten and fcm_an:
            geraete += [
                Geraet(user_id=uid, geraet_id=gid, token=token, plattform=ANDROID)
                for uid, gid, token in await anruf_push_fcm.geraete(session, redis, konten)
            ]
    except Exception:  # noqa: BLE001
        log.exception("anruf_voip_geraete_lesen_fehlgeschlagen")
        return
    if not geraete:
        return
    # ZUERST merken, dann senden: ein Abbruch, der sofort danach kommt, muss
    # diese Geräte schon finden.
    await _merken(redis, call_id, geraete)
    nutzlast = {
        "art": "klingelt",
        "call_id": call_id,
        "anruf_art": art,
        "channel_id": channel_id,
        "einleiter_id": einleiter_id,
        "einleiter_name": einleiter_name or "Pulse",
    }
    _im_hintergrund(call_id, _senden(zugang, geraete, nutzlast, session_factory))


async def abbrechen(
    *,
    redis: Any,
    session_factory: Any,
    call_id: str,
    nur_konten: set[int] | None = None,
    ausser: tuple[int, str] | None = None,
) -> None:
    """Den CallKit-Bildschirm (Android: das Klingeln der App) auf den Geräten
    schliessen, die per Push geklingelt haben (Auswahl: :func:`auswaehlen`).

    **Ohne das klingelt das Telefon ins Leere.** Legt der Anrufer auf, bevor
    abgenommen wurde, weiss eine Hülle mit eingefrorener Oberfläche nichts
    davon. Wer einen Abbruch bekommen hat, wird ausgetragen — ein zweiter
    fände keinen Anruf mehr (s. Modulkopf). Das handelnde Gerät wird STILL
    ausgetragen, und zwar sofort: nach einer Annahme läuft dort das Gespräch,
    und ein Abbruch an dessen Ende käme in den häufigsten Fall — beide
    Oberflächen wach, das Ende längst über die WebSocket da — und fände keinen
    Anruf mehr. Ist die Oberfläche dort eingefroren, schliesst die Hülle das
    Gespräch selbst, wenn die Gegenseite den Raum verlässt (``AnrufRaum.swift``).

    **Wer sonst noch klingelt, wird erst nach :data:`ABBRUCH_FRIST_S` gelesen** —
    wer bis dahin quittiert (:func:`ende_gesehen`, A6), bekommt keinen Abbruch.
    """
    zugang = apns_voip.zugang_aus_einstellungen(get_settings())
    if zugang is None and not anruf_push_fcm.verfuegbar():
        return
    if ausser is not None:
        selbst = [g for g in await _geklingelt(redis, call_id) if g.kennung == ausser]
        await _austragen(redis, call_id, selbst)

    async def nach_der_frist() -> None:
        await asyncio.sleep(ABBRUCH_FRIST_S)
        geklingelt = await _geklingelt(redis, call_id)
        gewaehlt = auswaehlen(geklingelt, nur_konten=nur_konten, ausser=ausser)
        await _austragen(redis, call_id, gewaehlt)
        if gewaehlt:
            nutzlast = {"art": "abbruch", "call_id": call_id}
            await _senden(zugang, gewaehlt, nutzlast, session_factory)

    _im_hintergrund(call_id, nach_der_frist())


async def ende_gesehen(*, redis: Any, call_id: str, geraet: tuple[int, str]) -> None:
    """Die Oberfläche dieses Geräts hat das Ende des Anrufs (A6): austragen,
    damit ein Abbruch in seiner Frist es nicht mehr findet. Ein Gerät, das gar
    nicht geklingelt hat, ist kein Fehler. Löst nie aus."""
    geraete = [g for g in await _geklingelt(redis, call_id) if g.kennung == geraet]
    await _austragen(redis, call_id, geraete)


__all__ = [
    "ABBRUCH_FRIST_S",
    "ANDROID",
    "GEKLINGELT_HALTBARKEIT_S",
    "GEKLINGELT_PRAEFIX",
    "Geraet",
    "IOS",
    "abbrechen",
    "auswaehlen",
    "ende_gesehen",
    "hintergrund_abwarten",
    "klingeln",
    "schluessel",
]
