"""Zurückgehaltene DM-Pushes ans Handy (Eigentümer-Entscheid 2026-10-17).

Ein DM-Push ans Handy (FCM, iOS wie Android) geht nicht sofort hinaus,
sondern wartet ``fcm_dm_push_verzoegerung_s`` (Vorgabe 5 s, Vorbild
WhatsApp/Signal). Liest der Empfänger die Nachricht in dieser Zeit
nachweislich an einem anderen Gerät, entfällt der Push — was „nachweislich"
heisst, steht in :mod:`dcc_chat_gateway.fcm_gelesen`. Kommen im Fenster
weitere Nachrichten desselben Kanals, wird daraus EIN Push: Absender und
Anhang-Hinweis der neuesten, die Plakette zählt jede ungelesene. Web-Push
(``push.py``) und Anruf-Pushes (``anruf_push.py``, VoIP) laufen an dieser
Datei vorbei — ein Anruf verträgt keine Verzögerung.

**Warum Redis und kein ``asyncio.sleep``.** Die Cloud zieht neue Bilder per
Cron und startet den Container neu; ein Push, der nur als Aufgabe im Prozess
wartet, wäre dabei endgültig weg. Deshalb:

* ``push:dm:faellig`` — Sorted Set, Mitglied ``<uid>:<kanal>``, Wert =
  Fälligkeit in ms (Serveruhr; sie misst nur die eigene Wartezeit, nie den
  Abstand zwischen Nachrichten). ``ZADD NX``: die erste Nachricht setzt die
  Frist, weitere verlängern sie nicht — sonst käme bei Dauerbeschuss nie ein
  Push.
* ``push:dm:teile:<uid>:<kanal>`` — Liste, ein JSON-Teil je Nachricht.
  Anhängen und Eintragen laufen in EINER Transaktion (``MULTI``).
* Besitznahme per Lua (:data:`_UEBERNEHMEN`, atomar): das fällige Mitglied
  verlässt ``faellig``, seine Liste wird unter einer frischen Arbeitskennung
  umbenannt und in ``push:dm:inarbeit`` mit einer Pacht eingetragen. Zwei
  Abarbeiter (mehrere Instanzen) bekommen so nie denselben Eintrag, und eine
  Nachricht, die während der Arbeit ankommt, landet in einer frischen Liste —
  also in einem eigenen, späteren Push statt im Nichts.
* Gelöscht wird die Arbeit erst NACH dem Senden oder Verwerfen. Stirbt der
  Prozess dazwischen, läuft die Pacht ab und ein Abarbeiter übernimmt sie neu:
  schlimmstenfalls ein doppelter Push, nie ein verlorener. Beim geordneten
  Herunterfahren gibt der Abarbeiter seine Pacht sofort zurück (Wert 0), der
  nächste Start sendet ohne weitere Wartezeit — wie alles, was beim Start
  schon fällig ist.

**Fail-open Richtung Zustellung.** Wartezeit 0, kein Redis, oder Redis wirft
beim Vormerken: der Push geht sofort hinaus, wie vor der Änderung.

**Grenzen, bewusst:** Das Lua-Skript bildet Schlüssel zur Laufzeit — das
geht auf einem einzelnen Redis (so betreibt Pulse ihn), nicht im Cluster.
Ob ein Android-Gerät wach ist, prüft weiter ``fan_out_fcm_dm_push`` beim
Senden über die Sockets DIESES Prozesses; liefe der chat-gateway je in
mehreren Prozessen, könnte ein anderer den Eintrag abarbeiten als der, an
dem die Sockets hängen.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from typing import Any

import dcc_chat_gateway.config as chat_config
from dcc_chat_gateway import fcm, fcm_gelesen

log = logging.getLogger(__name__)

FAELLIG = "push:dm:faellig"
INARBEIT = "push:dm:inarbeit"
TEILE_PRAEFIX = "push:dm:teile:"
#: Unterpräfix der umbenannten Listen in Arbeit (``TEILE_PRAEFIX`` + dies).
IN_ARBEIT = "inarbeit:"

#: Eine Liste, die niemand abholt (kein Abarbeiter läuft), verschwindet
#: spätestens dann — ein Push nach einem Tag wäre keiner mehr.
TEILE_HALTBARKEIT_S = 24 * 60 * 60
#: So lange gehört ein übernommener Eintrag seinem Abarbeiter. Ein Versand
#: dauert Sekundenbruchteile; die Pacht ist nur die Frist, nach der ein
#: abgestürzter Abarbeiter als tot gilt.
PACHT_S = 60
#: Höchstzahl Einträge je Übernahme (je Art: neu fällig und Pacht abgelaufen).
STAPEL = 50
#: Abstand der Abfragen, solange nichts fällig ist.
TAKT_S = 0.5
#: Pause nach einer Redis-Störung im Abarbeiter.
STOERUNG_PAUSE_S = 5.0

# KEYS[1]=faellig, KEYS[2]=inarbeit; ARGV: jetzt, pacht_bis, grenze, marke,
# Präfix der Teile-Listen, Präfix der Listen in Arbeit. Liefert die
# übernommenen Arbeitskennungen.
_UEBERNEHMEN = """
local jetzt = ARGV[1]
local pacht = ARGV[2]
local grenze = tonumber(ARGV[3])
local marke = ARGV[4]
local teile = ARGV[5]
local in_arbeit = ARGV[6]
local out = {}
for _, a in ipairs(redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', jetzt, 'LIMIT', 0, grenze)) do
  redis.call('ZADD', KEYS[2], pacht, a)
  out[#out + 1] = a
end
for i, m in ipairs(redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', jetzt, 'LIMIT', 0, grenze)) do
  redis.call('ZREM', KEYS[1], m)
  local quelle = teile .. m
  if redis.call('EXISTS', quelle) == 1 then
    local a = m .. '|' .. marke .. '.' .. i
    redis.call('RENAME', quelle, in_arbeit .. a)
    redis.call('ZADD', KEYS[2], pacht, a)
    out[#out + 1] = a
  end
end
return out
"""


def _jetzt_ms() -> int:
    return int(time.time() * 1000)


def _mitglied(user_id: int, channel_id: int) -> str:
    return f"{user_id}:{channel_id}"


def _arbeitsliste(arbeit: str) -> str:
    return f"{TEILE_PRAEFIX}{IN_ARBEIT}{arbeit}"


def _text(wert: Any) -> str:
    return wert.decode() if isinstance(wert, bytes) else str(wert)


def zurueckhalten_aktiv() -> bool:
    """Ob Pushes überhaupt warten: FCM eingerichtet und Wartezeit > 0. Ohne
    das braucht auch niemand Lesebelege (``routes/postfach_abholen.py``)."""
    settings = chat_config.get_settings()
    return bool(settings.firebase_service_account_key) and settings.fcm_dm_push_verzoegerung_s > 0


async def _sofort(
    empfaenger: set[int], *, author_name: str, channel_id: int, manager: Any, hat_anhang: bool
) -> None:
    await fcm.fan_out_fcm_dm_push(
        recipient_ids=empfaenger,
        author_name=author_name,
        channel_id=channel_id,
        manager=manager,
        hat_anhang=hat_anhang,
    )


async def vormerken(
    *,
    recipient_ids: set[int],
    author_name: str,
    channel_id: int,
    manager: Any | None,
    hat_anhang: bool = False,
    art: str = "dm",
    message_id: int | None = None,
    zustellungen: dict[int, dict[str, list[int]]] | None = None,
) -> None:
    """Den DM-Push ans Handy für ``recipient_ids`` vormerken (oder, wo das
    nicht geht, sofort senden). Löst nie aus.

    ``art`` ist ``dm`` oder ``gruppe`` (welcher Lesestand gilt). Im
    Klartext-Weg trägt ``message_id`` die Snowflake der Nachricht, im
    verschlüsselten Weg ``zustellungen`` je Empfänger die frisch angelegten
    Zustellungs-IDs je Empfängergerät — gegen sie prüft ``fcm_gelesen`` die
    Quittungs-Belege.
    """
    if not recipient_ids:
        return
    # Modul-Zugriff statt ``from … import get_settings``: sonst zur Importzeit
    # gebunden (Muster ``routes/postfach.py``).
    warte_s = chat_config.get_settings().fcm_dm_push_verzoegerung_s
    redis = getattr(manager, "redis", None)
    weiter = {
        "author_name": author_name,
        "channel_id": channel_id,
        "manager": manager,
        "hat_anhang": hat_anhang,
    }
    if warte_s <= 0 or redis is None:
        await _sofort(set(recipient_ids), **weiter)
        return
    if fcm.ensure_fcm() is None:
        return  # Kein FCM eingerichtet: nichts vorzumerken, wie bisher nichts zu senden.

    # Lesestand JETZT — nur ein späteres Wachsen belegt ein Lesen
    # (``fcm_gelesen``, Regel 2). Ohne Auskunft kann der Teil nie verworfen
    # werden.
    try:
        async with fcm.SessionLocal() as session:
            vorher: dict[int, int] | None = await fcm_gelesen.lesestaende(
                session, art, channel_id, recipient_ids
            )
    except Exception:  # noqa: BLE001
        log.warning("fcm_vormerken_lesestand_fehlgeschlagen")
        vorher = None

    faellig = _jetzt_ms() + int(warte_s * 1000)
    try:
        pipe = redis.pipeline(transaction=True)
        for uid in recipient_ids:
            teil = {
                "autor": author_name or "",
                "anhang": bool(hat_anhang),
                "art": art,
                "msg": message_id,
                "geraete": (zustellungen or {}).get(uid, {}),
                "l0": None if vorher is None else vorher.get(uid),
                "l0_fehlt": vorher is None,
            }
            mitglied = _mitglied(uid, channel_id)
            pipe.rpush(TEILE_PRAEFIX + mitglied, json.dumps(teil))
            pipe.expire(TEILE_PRAEFIX + mitglied, TEILE_HALTBARKEIT_S)
            pipe.zadd(FAELLIG, {mitglied: faellig}, nx=True)
        await pipe.execute()
    except Exception:  # noqa: BLE001 — fail-open: lieber sofort als nie
        log.warning("fcm_vormerken_fehlgeschlagen_sofort_gesendet")
        await _sofort(set(recipient_ids), **weiter)


async def uebernehmen(redis: Any, *, jetzt_ms: int | None = None) -> list[str]:
    """Fällige Einträge (und solche mit abgelaufener Pacht) atomar übernehmen."""
    jetzt = _jetzt_ms() if jetzt_ms is None else jetzt_ms
    skript = redis.register_script(_UEBERNEHMEN)
    roh = await skript(
        keys=[FAELLIG, INARBEIT],
        args=[
            jetzt,
            jetzt + PACHT_S * 1000,
            STAPEL,
            uuid.uuid4().hex,
            TEILE_PRAEFIX,
            TEILE_PRAEFIX + IN_ARBEIT,
        ],
    )
    return [_text(a) for a in roh]


async def _abschliessen(redis: Any, arbeit: str) -> None:
    pipe = redis.pipeline(transaction=True)
    pipe.delete(_arbeitsliste(arbeit))
    pipe.zrem(INARBEIT, arbeit)
    await pipe.execute()


async def _zurueckgeben(redis: Any, arbeit: str) -> None:
    """Pacht sofort freigeben — der nächste Abarbeiter (auch nach dem
    Neustart) übernimmt den Eintrag ohne zu warten."""
    try:
        await redis.zadd(INARBEIT, {arbeit: 0}, xx=True)
    except Exception:  # noqa: BLE001 — dann läuft eben die Pacht ab
        log.warning("fcm_warteschlange_rueckgabe_fehlgeschlagen")


async def abarbeiten(manager: Any, arbeit: str) -> None:
    """Einen übernommenen Eintrag senden oder verwerfen, danach löschen.

    Wirft nur bei einer Redis-Störung; der Eintrag bleibt dann in Pacht und
    wird nach ihrem Ablauf neu versucht."""
    redis = manager.redis
    try:
        mitglied = arbeit.partition("|")[0]
        uid_text, _, kanal_text = mitglied.partition(":")
        uid, kanal = int(uid_text), int(kanal_text)
    except ValueError:
        log.warning("fcm_warteschlange_eintrag_unlesbar")
        await _abschliessen(redis, arbeit)
        return
    teile: list[dict[str, Any]] = []
    for roh in await redis.lrange(_arbeitsliste(arbeit), 0, -1):
        try:
            teile.append(json.loads(roh))
        except (TypeError, ValueError):
            log.warning("fcm_warteschlange_teil_unlesbar")
    offen = await fcm_gelesen.ungelesene(
        redis, fcm.SessionLocal, user_id=uid, channel_id=kanal, teile=teile
    )
    if offen:
        neuester = offen[-1]
        await fcm.fan_out_fcm_dm_push(
            recipient_ids={uid},
            author_name=neuester.get("autor") or "",
            channel_id=kanal,
            manager=manager,
            hat_anhang=bool(neuester.get("anhang")),
            anzahl=len(offen),
        )
    await _abschliessen(redis, arbeit)


async def _einer(manager: Any, arbeit: str) -> None:
    try:
        await abarbeiten(manager, arbeit)
    except asyncio.CancelledError:
        await _zurueckgeben(manager.redis, arbeit)
        raise
    except Exception:  # noqa: BLE001 — Pacht läuft ab, dann neuer Versuch
        log.warning("fcm_warteschlange_eintrag_fehlgeschlagen")


async def abarbeiter_loop(manager: Any) -> None:
    """Hintergrundaufgabe im Lifespan: holt fällige Einträge und arbeitet sie
    ab. Läuft in jeder Instanz; die Übernahme ist exklusiv.

    Ohne FCM-Schlüssel kann nie ein Eintrag entstehen (``vormerken`` kehrt
    vorher um) — dann endet die Aufgabe sofort, statt Redis im Takt zu
    befragen. Die Wartezeit spielt hier bewusst KEINE Rolle: wer sie auf 0
    stellt und neu startet, dessen alte Einträge müssen trotzdem hinaus."""
    if not chat_config.get_settings().firebase_service_account_key:
        return
    gestoert = False
    while True:
        try:
            arbeiten = await uebernehmen(manager.redis)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            if not gestoert:
                log.warning("fcm_warteschlange_redis_gestoert")
                gestoert = True
            await asyncio.sleep(STOERUNG_PAUSE_S)
            continue
        gestoert = False
        if arbeiten:
            await asyncio.gather(*(_einer(manager, a) for a in arbeiten))
        if len(arbeiten) < STAPEL:
            await asyncio.sleep(TAKT_S)


__all__ = [
    "FAELLIG",
    "INARBEIT",
    "PACHT_S",
    "TEILE_PRAEFIX",
    "abarbeiten",
    "abarbeiter_loop",
    "uebernehmen",
    "vormerken",
    "zurueckhalten_aktiv",
]
