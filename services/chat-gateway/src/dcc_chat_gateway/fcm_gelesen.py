"""Ist eine zurückgehaltene DM schon gelesen? — der Beleg für das Verwerfen.

Gegenstück zu :mod:`dcc_chat_gateway.fcm_warteschlange`: dort wartet der
Push, hier fällt die Entscheidung, ob er noch hinaus muss. **Verworfen wird
nur, was belegt gelesen ist; jede fehlende oder unklare Auskunft heisst
senden.** Eine überzählige Mitteilung kostet einen Banner, eine verschluckte
eine Nachricht.

**Warum der Server das nicht einfach nachschlagen kann.** Im verschlüsselten
Weg kennt er die Nachrichten-ID nicht: die kanonische ID (``lesestandAnker``
im Klienten) wählt der Absender, sie fährt verschlüsselt im Umschlag mit.
Der Lesestand des Empfängers (``dm_lesestand`` / ``gruppen_lesestand``) ist
eine solche ID — vergleichbar wird er erst durch die QUITTUNG: mit ihr meldet
das abholende Gerät je (Kanal, Absender) die ID der jüngsten Nachricht, die
es in diesem Zyklus sicher abgelegt hat (``zustellstand.ts``). Quittiert
werden nur geöffnete UND abgelegte Umschläge (``empfangen.ts``), also gilt
für jede in dieser Quittung gelöschte Zustellung: ihre Nachricht ≤ dieser
gemeldeten ID. Genau das hält :func:`belege_merken` je Zustellungs-ID fest.

Die Regel in :func:`ist_gelesen`, alles nur IDs, keine Uhrzeit:

1. Ein Gerät des Empfängers hat ALLE Zustellungen dieser Nachricht an sich
   quittiert (bei einer Gruppe hängen Verteilschlüssel und Nachricht als
   zwei Zustellungen am selben Gerät), und der Lesestand liegt bei oder über
   dem Beleg jeder davon.
2. Der Lesestand ist seit dem Vormerken GEWACHSEN. Dagegen steht ein Fall,
   den Regel 1 allein durchliesse: die IDs stammen aus den Uhren
   verschiedener Geräte, und ein Lesestand, der wegen einer vorgehenden Uhr
   schon vorher über der neuen ID lag, belegt nichts über diese Nachricht.

3. Der Lesestand kam von einem AKTIVEN Nutzer (Gegenprüfung 2026-10-17,
   P1): „sichtbar und fokussiert" allein (``hinschauen.ts``) gilt auch für
   ein Fenster, vor dem niemand sitzt — Pulse steht am Rechner offen, der
   Nutzer ist mit dem Handy weg, und ohne diese Regel verschwände der Banner
   genau dann, wenn er gebraucht wird. Der Klient hängt ``?aktiv=1`` an die
   Lesestand-Meldung, wenn in den letzten 60 s eine echte Eingabe auf der
   Seite war (``web/src/lib/nachrichten/aktivitaet.ts``); der Server merkt
   sich den höchsten so gemeldeten Stand (:func:`aktives_lesen_merken`), und
   verglichen wird mit dem kleineren der beiden Stände. Ein Klient ohne das
   Flag gilt als nicht aktiv — dann geht der Push hinaus.

Im Klartext-Weg kennt der Server die ID (Snowflake) und vergleicht direkt;
Regel 2 und 3 gelten dort genauso.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable, Mapping
from typing import Any

from sqlalchemy import select

import dcc_chat_gateway.config as chat_config
from dcc_chat_gateway.models import DmLesestand, GruppenLesestand

log = logging.getLogger(__name__)

#: Je quittierter Zustellung: die mit ihr gemeldete kanonische ID.
BELEG_PRAEFIX = "push:dm:beleg:"

#: Ein Beleg zählt nur, solange ein Push auf ihn warten kann — die Wartezeit
#: plus die Pacht eines abgestürzten Abarbeiters liegen weit darunter.
BELEG_HALTBARKEIT_S = 15 * 60


#: Je (Konto, Kanal): der höchste Lesestand, den ein AKTIVER Nutzer meldete.
AKTIV_PRAEFIX = "push:dm:aktiv:"

# KEYS[1]; ARGV: Stand, Haltbarkeit. Monotones Maximum — als Text verglichen
# (erst Länge, dann Zeichen): Lua-Zahlen sind Doubles und runden 19-stellige
# IDs, zwei nahe IDs wären sonst gleich.
_AKTIV_MAX = """
local alt = redis.call('GET', KEYS[1])
local neu = ARGV[1]
if (not alt) or #alt < #neu or (#alt == #neu and alt < neu) then
  redis.call('SET', KEYS[1], neu, 'EX', ARGV[2])
else
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return 1
"""


def zurueckhalten_aktiv() -> bool:
    """Ob Pushes überhaupt warten: FCM eingerichtet und Wartezeit > 0. Ohne
    das braucht auch niemand Lesebelege (``routes/postfach_abholen.py``) oder
    Aktiv-Marken (die Lesestand-Routen)."""
    settings = chat_config.get_settings()
    return bool(settings.firebase_service_account_key) and settings.fcm_dm_push_verzoegerung_s > 0


def _beleg_schluessel(zustellung_id: int | str) -> str:
    return f"{BELEG_PRAEFIX}{zustellung_id}"


def _aktiv_schluessel(user_id: int, channel_id: int) -> str:
    return f"{AKTIV_PRAEFIX}{user_id}:{channel_id}"


async def aktives_lesen_merken(
    redis: Any, *, user_id: int, channel_id: int, bis: int, aktiv: bool
) -> None:
    """Für die Lesestand-Routen (DM und Gruppe): einen Stand, den der Klient
    als AKTIV gelesen meldete, festhalten (Regel 3). Löst nie aus."""
    if not aktiv or redis is None or not zurueckhalten_aktiv():
        return
    try:
        skript = redis.register_script(_AKTIV_MAX)
        await skript(
            keys=[_aktiv_schluessel(user_id, channel_id)], args=[str(bis), BELEG_HALTBARKEIT_S]
        )
    except Exception:  # noqa: BLE001 — fehlt die Marke, geht der Push hinaus
        log.warning("fcm_aktiv_merken_fehlgeschlagen")


async def belege_merken(redis: Any, belege: Mapping[int, int]) -> None:
    """``belege`` = Zustellungs-ID → gemeldete kanonische ID. Löst nie aus: ein
    fehlender Beleg heisst nur, dass der Push hinausgeht."""
    if redis is None or not belege:
        return
    try:
        pipe = redis.pipeline(transaction=False)
        for zid, bis in belege.items():
            pipe.set(_beleg_schluessel(zid), str(bis), ex=BELEG_HALTBARKEIT_S)
        await pipe.execute()
    except Exception:  # noqa: BLE001 — fail-open Richtung Zustellung
        log.warning("fcm_lesebeleg_merken_fehlgeschlagen")


async def lesestaende(
    session: Any, art: str, channel_id: int, user_ids: Iterable[int]
) -> dict[int, int]:
    """Der serverseitige Lesestand je Konto in diesem Kanal (DM oder Gruppe).
    Kein Eintrag = kein Stand bekannt. Wirft bei einer Datenbankstörung —
    der Aufrufer entscheidet, was das heisst."""
    ids = list(set(user_ids))
    if not ids:
        return {}
    if art == "gruppe":
        abfrage = select(GruppenLesestand.user_id, GruppenLesestand.last_read_message_id).where(
            GruppenLesestand.gruppe_id == channel_id, GruppenLesestand.user_id.in_(ids)
        )
    else:
        abfrage = select(DmLesestand.user_id, DmLesestand.last_read_message_id).where(
            DmLesestand.channel_id == channel_id, DmLesestand.user_id.in_(ids)
        )
    return {uid: int(stand) for uid, stand in (await session.execute(abfrage)).all()}


def ist_gelesen(teil: Mapping[str, Any], stand: int | None, belege: Mapping[str, int]) -> bool:
    """Die Regel aus dem Modulkopf, rein (ohne Redis und Datenbank prüfbar).

    ``teil`` ist ein Eintrag der Warteschlange, ``stand`` der Lesestand jetzt,
    ``belege`` Zustellungs-ID (als Text) → gemeldete ID."""
    if stand is None or teil.get("l0_fehlt"):
        return False
    vorher = teil.get("l0")
    if vorher is not None and stand <= int(vorher):
        return False
    if teil.get("msg") is not None:
        return stand >= int(teil["msg"])
    for zids in (teil.get("geraete") or {}).values():
        werte = [belege.get(str(z)) for z in zids]
        if werte and all(w is not None for w in werte) and stand >= max(werte):
            return True
    return False


async def ungelesene(
    redis: Any,
    session_factory: Any,
    *,
    user_id: int,
    channel_id: int,
    teile: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Die Teile, deren Nachricht NICHT belegt gelesen ist. Jede Störung
    (Datenbank, Redis) liefert alle Teile — also: senden."""
    if not teile:
        return []
    try:
        async with session_factory() as session:
            stand = (
                await lesestaende(session, teile[0].get("art", "dm"), channel_id, {user_id})
            ).get(user_id)
    except Exception:  # noqa: BLE001
        log.warning("fcm_lesestand_lesen_fehlgeschlagen")
        return list(teile)
    if stand is None:
        return list(teile)
    try:
        aktiv_roh = await redis.get(_aktiv_schluessel(user_id, channel_id))
        aktiv_bis = None if aktiv_roh is None else int(aktiv_roh)
    except Exception:  # noqa: BLE001
        log.warning("fcm_aktiv_lesen_fehlgeschlagen")
        return list(teile)
    if aktiv_bis is None:
        return list(teile)  # Regel 3: niemand hat aktiv gelesen.
    stand = min(stand, aktiv_bis)
    zids = sorted(
        {str(z) for t in teile for liste in (t.get("geraete") or {}).values() for z in liste}
    )
    belege: dict[str, int] = {}
    if zids:
        try:
            werte = await redis.mget([_beleg_schluessel(z) for z in zids])
        except Exception:  # noqa: BLE001
            log.warning("fcm_lesebeleg_lesen_fehlgeschlagen")
            return list(teile)
        for z, wert in zip(zids, werte, strict=True):
            if wert is None:
                continue
            try:
                belege[z] = int(wert)
            except (TypeError, ValueError):
                continue
    return [t for t in teile if not ist_gelesen(t, stand, belege)]


__all__ = [
    "AKTIV_PRAEFIX",
    "BELEG_HALTBARKEIT_S",
    "BELEG_PRAEFIX",
    "aktives_lesen_merken",
    "belege_merken",
    "ist_gelesen",
    "lesestaende",
    "ungelesene",
    "zurueckhalten_aktiv",
]
