"""Ordnung und Plausibilität der Stände (Lesestand, Zustellstand).

Ein Stand ist eine Nachrichten-ID, und zwar in ZWEI Formen: eine
Server-Snowflake (Klartext, System-DM, Zustellungs-ID) oder die lokale ID
des verschlüsselten Wegs (``krypto/lokaleNachrichtId.ts``: 13 Stellen
``Date.now()`` + 6 Zufallsstellen = 19 Ziffern). Die lokale ID wählt der
ABSENDER, sie fährt im Umschlag mit, und der Empfänger ankert seinen Stand
an ihr (``lesestandAnker``).

Daraus folgten zwei Fehler im Monotonie-Guard, der bis zum 2026-11-05 die
rohen Zahlen verglich (DM-Bughunt 2026-11-02, Server-Punkte):

1. **Rohe Zahlen ordnen die beiden Formen falsch.** Eine lokale ID liegt um
   1,8e18, eine heutige Snowflake um 1e17 — nach einem Stand an einer lokalen
   ID wurde jede spätere Snowflake (System-DM, Klartext-Altfall) für
   „älter" gehalten und nie mehr angenommen. Der Klient vergleicht seit
   jeher über die eingebettete Zeit (``utils/snowflakeZeit.ts``,
   ``vergleicheSnowflakeArtigeId``); hier steht dieselbe Rechnung für SQL.
2. **Der Absender konnte den Stand vergiften.** Eine lokale ID nahe der
   int64-Grenze ist eine gültige Zahl; liest der Empfänger die Nachricht,
   steht sein Stand danach in einer fernen Zukunft, und der Guard lässt nie
   wieder einen echten Stand zu. Deshalb nimmt der Server keinen Stand mehr
   an, dessen Zeit mehr als ``ZUKUNFT_TOLERANZ_MS`` vor der eigenen Uhr liegt.
   Die Toleranz ist bewusst grosszügig: lokale IDs kommen von der Uhr des
   Absendergeräts, und ein falsch gestelltes Gerät soll keine Häkchen
   verlieren. Ein Angreifer kann den Stand damit höchstens so weit vorstellen.
"""

from __future__ import annotations

import time

from sqlalchemy import BigInteger, and_, case, or_
from sqlalchemy.sql.elements import ColumnElement

from dcc_shared.snowflake import DEFAULT_EPOCH_MS, TIME_SHIFT

# Ab hier ist eine Zahl eine lokale ID (19 Ziffern); eine Snowflake erreicht
# diesen Wert erst in rund 13 Jahren. Spiegel von ``LOKALE_ID_LAENGE`` im Klienten.
LOKALE_ID_AB = 10**18
# 19 Ziffern - 13 Zeitstellen = 6 Zufallsstellen.
LOKALE_ID_ZUFALL = 10**6

ZUKUNFT_TOLERANZ_MS = 24 * 60 * 60 * 1000


def zeit_ms(stand: int) -> int:
    """Die eingebettete Zeit einer ID in Millisekunden seit 1970."""
    if stand >= LOKALE_ID_AB:
        return stand // LOKALE_ID_ZUFALL
    return (stand >> TIME_SHIFT) + DEFAULT_EPOCH_MS


def plausibel(stand: int, jetzt_ms: int | None = None) -> bool:
    """Ob ein gemeldeter Stand nicht in der Zukunft liegt (mit Toleranz)."""
    jetzt = int(time.time() * 1000) if jetzt_ms is None else jetzt_ms
    return zeit_ms(stand) <= jetzt + ZUKUNFT_TOLERANZ_MS


def _zeit_sql(spalte: ColumnElement) -> ColumnElement:
    return case(
        (spalte >= LOKALE_ID_AB, spalte // LOKALE_ID_ZUFALL),
        else_=spalte.op(">>", return_type=BigInteger)(TIME_SHIFT) + DEFAULT_EPOCH_MS,
    )


def ist_neuer(neu: ColumnElement, alt: ColumnElement) -> ColumnElement:
    """SQL: ``neu`` liegt zeitlich nach ``alt`` — bei gleicher Millisekunde
    entscheidet die rohe Zahl, wie im Klienten."""
    zn, za = _zeit_sql(neu), _zeit_sql(alt)
    return or_(zn > za, and_(zn == za, neu > alt))
