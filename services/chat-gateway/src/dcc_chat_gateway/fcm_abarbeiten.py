"""Der Abarbeiter der zurückgehaltenen DM-Pushes — wer was wann sendet.

Die Ablage (Schlüssel, Vormerken, atomare Übernahme) steht in
:mod:`dcc_chat_gateway.fcm_warteschlange`, die Frage „schon gelesen?" in
:mod:`dcc_chat_gateway.fcm_gelesen`. Hier: die Schleife im Lifespan und der
Weg eines übernommenen Eintrags bis zum Versand oder Verwerfen.

**Jeder Eintrag läuft als eigene Aufgabe** (höchstens :data:`GLEICHZEITIG`).
Die erste Fassung wartete den ganzen Stapel ab, bevor sie neu übernahm: ein
einziger hängender FCM-Aufruf (firebase_admin wartet ohne Vorgabe 120 s und
wiederholt selbst) hielt so die Mitteilungen ALLER Nutzer an — gemessen in
der Gegenprüfung vom 2026-10-17: ein Eintrag, fällig nach 0,5 s, ging erst
nach 3,5 s hinaus, weil ein anderer 3 s hing. Vorher lief jeder Versand
unabhängig im eigenen Request.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

import dcc_chat_gateway.config as chat_config
from dcc_chat_gateway import fcm, fcm_gelesen
from dcc_chat_gateway import fcm_warteschlange as ablage

log = logging.getLogger(__name__)

#: So viele Einträge sendet ein Prozess gleichzeitig. Eine Grenze, damit ein
#: Rückstau nach einer Störung nicht auf einmal Hunderte Threads (der
#: Firebase-Versand ist synchron, ``asyncio.to_thread``) und
#: Datenbankverbindungen aufmacht.
GLEICHZEITIG = 20
#: Abstand der Abfragen.
TAKT_S = 0.5
#: Pause nach einer Redis-Störung.
STOERUNG_PAUSE_S = 5.0
#: So lange wartet ein abgebrochener Eintrag auf seinen schon laufenden
#: Versand, bevor er die Pacht zurückgibt — unter den 5 s, die der Lifespan
#: einer Hintergrundaufgabe beim Herunterfahren lässt (``app.py``).
ABBRUCH_FRIST_S = 3.0


async def abarbeiten(manager: Any, arbeit: str) -> None:
    """Einen übernommenen Eintrag senden oder verwerfen, danach löschen.

    Ein gestörter Versand wird mit Rückoff neu eingeplant
    (``ablage.erneut_einplanen``). Wirft nur bei einer Redis-Störung; der
    Eintrag bleibt dann in Pacht und wird nach ihrem Ablauf neu versucht."""
    redis = manager.redis
    try:
        mitglied = arbeit.partition("|")[0]
        uid_text, _, kanal_text = mitglied.partition(":")
        uid, kanal = int(uid_text), int(kanal_text)
    except ValueError:
        log.warning("fcm_warteschlange_eintrag_unlesbar")
        await ablage.abschliessen(redis, arbeit)
        return
    if await redis.exists(ablage.erledigt_marke(arbeit)):
        # Schon gesendet, nur das Abschliessen fehlte (Absturz, Redis-Störung).
        await ablage.abschliessen(redis, arbeit)
        return
    teile: list[dict[str, Any]] = []
    for roh in await redis.lrange(ablage.arbeitsliste(arbeit), 0, -1):
        try:
            teile.append(json.loads(roh))
        except (TypeError, ValueError):
            log.warning("fcm_warteschlange_teil_unlesbar")
    offen = await fcm_gelesen.ungelesene(
        redis, fcm.SessionLocal, user_id=uid, channel_id=kanal, teile=teile
    )
    if not offen:
        await ablage.abschliessen(redis, arbeit)
        return
    neuester = offen[-1]
    # Der Versand läuft abgeschirmt: ``asyncio.to_thread`` lässt sich nicht
    # abbrechen, der Push ginge beim Herunterfahren also trotzdem hinaus —
    # und der nächste Prozess sendete ihn ein zweites Mal (Gegenprüfung P5).
    versand_aufgabe = asyncio.ensure_future(
        fcm.dm_push_senden(
            recipient_ids={uid},
            author_name=neuester.get("autor") or "",
            channel_id=kanal,
            manager=manager,
            hat_anhang=bool(neuester.get("anhang")),
            anzahl=len(offen),
            plakette_marke=ablage.plakette_marke(arbeit),
        )
    )
    try:
        versand = await asyncio.shield(versand_aufgabe)
    except asyncio.CancelledError:
        fertig, _ = await asyncio.wait({versand_aufgabe}, timeout=ABBRUCH_FRIST_S)
        if fertig and not versand_aufgabe.cancelled():
            await _nach_versand(redis, arbeit, versand_aufgabe.result())
        raise
    await _nach_versand(redis, arbeit, versand)


async def _nach_versand(redis: Any, arbeit: str, versand: fcm.Versand) -> None:
    if versand.stoerung:
        # Nicht als erledigt löschen (Gegenprüfung P4): die Warteschlange hat
        # alles für einen neuen Versuch. Er prüft auch das Lesen neu, und die
        # Plakette zählt er dank der Marke nicht noch einmal.
        if await ablage.erneut_einplanen(redis, arbeit):
            return
        log.warning("fcm_push_nach_stoerungen_aufgegeben")
    else:
        await redis.set(ablage.erledigt_marke(arbeit), b"1", ex=ablage.MARKE_HALTBARKEIT_S)
    await ablage.abschliessen(redis, arbeit)


async def _einer(manager: Any, arbeit: str) -> None:
    try:
        await abarbeiten(manager, arbeit)
    except asyncio.CancelledError:
        await ablage.zurueckgeben(manager.redis, arbeit)
        raise
    except Exception:  # noqa: BLE001 — Pacht läuft ab, dann neuer Versuch
        log.warning("fcm_warteschlange_eintrag_fehlgeschlagen")


async def abarbeiter_loop(manager: Any) -> None:
    """Hintergrundaufgabe im Lifespan: übernimmt fällige Einträge und startet
    je Eintrag eine Aufgabe. Läuft in jeder Instanz; die Übernahme ist
    exklusiv.

    Ohne FCM-Schlüssel kann nie ein Eintrag entstehen (``vormerken`` kehrt
    vorher um) — dann endet die Aufgabe sofort, statt Redis im Takt zu
    befragen. Die Wartezeit spielt hier bewusst KEINE Rolle: wer sie auf 0
    stellt und neu startet, dessen alte Einträge müssen trotzdem hinaus.

    Beim Abbruch (Herunterfahren) bricht sie ihre laufenden Aufgaben mit ab;
    jede gibt dabei ihre Pacht zurück (``_einer``)."""
    if not chat_config.get_settings().firebase_service_account_key:
        return
    laufend: dict[str, asyncio.Task[None]] = {}
    gestoert = False
    try:
        while True:
            frei = GLEICHZEITIG - len(laufend)
            if frei > 0:
                try:
                    arbeiten = await ablage.uebernehmen(manager.redis, grenze=frei)
                except asyncio.CancelledError:
                    raise
                except Exception:  # noqa: BLE001
                    if not gestoert:
                        log.warning("fcm_warteschlange_redis_gestoert")
                        gestoert = True
                    await asyncio.sleep(STOERUNG_PAUSE_S)
                    continue
                gestoert = False
                for arbeit in arbeiten:
                    # Lief die Pacht ab, während die Aufgabe hier noch läuft,
                    # hat die Übernahme sie nur verlängert — nicht doppelt starten.
                    if arbeit in laufend:
                        continue
                    aufgabe = asyncio.create_task(_einer(manager, arbeit))
                    laufend[arbeit] = aufgabe
                    aufgabe.add_done_callback(lambda _t, a=arbeit: laufend.pop(a, None))
            await asyncio.sleep(TAKT_S)
    finally:
        for aufgabe in list(laufend.values()):
            aufgabe.cancel()
        await asyncio.gather(*laufend.values(), return_exceptions=True)


__all__ = ["GLEICHZEITIG", "abarbeiten", "abarbeiter_loop"]
