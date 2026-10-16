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

Im Klartext-Weg kennt der Server die ID (Snowflake) und vergleicht direkt;
Regel 2 gilt dort genauso.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable, Mapping
from typing import Any

from sqlalchemy import select

from dcc_chat_gateway.models import DmLesestand, GruppenLesestand

log = logging.getLogger(__name__)

#: Je quittierter Zustellung: die mit ihr gemeldete kanonische ID.
BELEG_PRAEFIX = "push:dm:beleg:"

#: Ein Beleg zählt nur, solange ein Push auf ihn warten kann — die Wartezeit
#: plus die Pacht eines abgestürzten Abarbeiters liegen weit darunter.
BELEG_HALTBARKEIT_S = 15 * 60


def _beleg_schluessel(zustellung_id: int | str) -> str:
    return f"{BELEG_PRAEFIX}{zustellung_id}"


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
    "BELEG_HALTBARKEIT_S",
    "BELEG_PRAEFIX",
    "belege_merken",
    "ist_gelesen",
    "lesestaende",
    "ungelesene",
]
