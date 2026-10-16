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
  schon fällig ist. Wer was wann sendet, steht in ``fcm_abarbeiten.py``;
  diese Datei ist nur die Ablage.

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

import json
import logging
import time
import uuid
from typing import Any

import dcc_chat_gateway.config as chat_config
from dcc_chat_gateway import fcm, fcm_gelesen
from dcc_chat_gateway.fcm_gelesen import zurueckhalten_aktiv

log = logging.getLogger(__name__)

FAELLIG = "push:dm:faellig"
INARBEIT = "push:dm:inarbeit"
TEILE_PRAEFIX = "push:dm:teile:"
#: Unterpräfix der umbenannten Listen in Arbeit (``TEILE_PRAEFIX`` + dies).
IN_ARBEIT = "inarbeit:"

#: Eine Liste, die niemand abholt (kein Abarbeiter läuft), verschwindet
#: spätestens dann — ein Push nach einem Tag wäre keiner mehr.
TEILE_HALTBARKEIT_S = 24 * 60 * 60
#: So lange gehört ein übernommener Eintrag seinem Abarbeiter — die Frist,
#: nach der ein abgestürzter Abarbeiter als tot gilt. Sie muss über dem
#: schlimmsten Versand liegen, sonst übernimmt ein zweiter einen Eintrag, der
#: noch läuft: ``fcm.FCM_HTTP_TIMEOUT_S`` (10 s) je Versuch, und firebase_admin
#: wiederholt selbst (``DEFAULT_RETRY_CONFIG`` in 7.5.0: je 1× Verbindung und
#: Lesen, 4× bei 500/503 mit 0,5er-Rückoff) — zusammen gut eine Minute.
PACHT_S = 180
#: Höchstzahl Einträge je Übernahme (beide Arten zusammen).
STAPEL = 50
#: Wartezeiten vor den Wiederholungen eines gestörten Versands (Firebase oder
#: Datenbank kurz weg): fünf Versuche über gut zehn Minuten. Danach wäre die
#: Mitteilung keine mehr, die man noch braucht — der Eintrag wird mit einer
#: Warnung verworfen. Vor der Warteschlange gab es gar keine Wiederholung.
RUECKOFF_S = (30, 60, 120, 180, 240)
#: Hash Arbeitskennung → Zahl der Wiederholungen.
VERSUCHE = "push:dm:versuche"
#: Präfix der Marken je Eintrag (Plakette gezählt, Versand erledigt).
MARKE_PRAEFIX = "push:dm:marke:"
#: Haltbarkeit der Erledigt-Marke.
MARKE_HALTBARKEIT_S = 24 * 60 * 60

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
local rest = grenze - #out
if rest <= 0 then
  return out
end
for i, m in ipairs(redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', jetzt, 'LIMIT', 0, rest)) do
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


def arbeitsliste(arbeit: str) -> str:
    return f"{TEILE_PRAEFIX}{IN_ARBEIT}{arbeit}"


def _text(wert: Any) -> str:
    return wert.decode() if isinstance(wert, bytes) else str(wert)


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


async def uebernehmen(
    redis: Any, *, grenze: int = STAPEL, jetzt_ms: int | None = None
) -> list[str]:
    """Fällige Einträge (zuerst solche mit abgelaufener Pacht) atomar
    übernehmen, höchstens ``grenze`` Stück."""
    jetzt = _jetzt_ms() if jetzt_ms is None else jetzt_ms
    skript = redis.register_script(_UEBERNEHMEN)
    roh = await skript(
        keys=[FAELLIG, INARBEIT],
        args=[
            jetzt,
            jetzt + PACHT_S * 1000,
            grenze,
            uuid.uuid4().hex,
            TEILE_PRAEFIX,
            TEILE_PRAEFIX + IN_ARBEIT,
        ],
    )
    return [_text(a) for a in roh]


async def abschliessen(redis: Any, arbeit: str) -> None:
    pipe = redis.pipeline(transaction=True)
    pipe.delete(arbeitsliste(arbeit))
    pipe.zrem(INARBEIT, arbeit)
    pipe.hdel(VERSUCHE, arbeit)
    pipe.delete(plakette_marke(arbeit), erledigt_marke(arbeit))
    await pipe.execute()


def plakette_marke(arbeit: str) -> str:
    """Marke, unter der die Plakette eines Eintrags einmal gezählt wird."""
    return f"{MARKE_PRAEFIX}plakette:{arbeit}"


def erledigt_marke(arbeit: str) -> str:
    """Gesetzt nach einem gelungenen Versand, VOR dem Abschliessen: scheitert
    das Abschliessen, sendet die Wiederaufnahme nicht ein zweites Mal."""
    return f"{MARKE_PRAEFIX}erledigt:{arbeit}"


async def erneut_einplanen(redis: Any, arbeit: str, *, jetzt_ms: int | None = None) -> bool:
    """Nach einem gestörten Versand (``fcm.Versand.stoerung``) die Pacht auf
    den nächsten Rückoff-Zeitpunkt legen — nach ihrem Ablauf übernimmt ein
    Abarbeiter den Eintrag wie jeden anderen. ``False``, wenn die Versuche
    aufgebraucht sind; dann schliesst der Aufrufer ab."""
    versuch = int(await redis.hincrby(VERSUCHE, arbeit, 1))
    if versuch > len(RUECKOFF_S):
        return False
    jetzt = _jetzt_ms() if jetzt_ms is None else jetzt_ms
    await redis.zadd(INARBEIT, {arbeit: jetzt + RUECKOFF_S[versuch - 1] * 1000}, xx=True)
    return True


async def zurueckgeben(redis: Any, arbeit: str) -> None:
    """Pacht sofort freigeben — der nächste Abarbeiter (auch nach dem
    Neustart) übernimmt den Eintrag ohne zu warten."""
    try:
        await redis.zadd(INARBEIT, {arbeit: 0}, xx=True)
    except Exception:  # noqa: BLE001 — dann läuft eben die Pacht ab
        log.warning("fcm_warteschlange_rueckgabe_fehlgeschlagen")


__all__ = [
    "FAELLIG",
    "INARBEIT",
    "PACHT_S",
    "TEILE_PRAEFIX",
    "RUECKOFF_S",
    "abschliessen",
    "arbeitsliste",
    "erledigt_marke",
    "erneut_einplanen",
    "plakette_marke",
    "uebernehmen",
    "zurueckgeben",
    "vormerken",
    "zurueckhalten_aktiv",
]
