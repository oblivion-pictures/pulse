"""Wer bekommt einen DM-Push — die Auswahl der Gerätezeilen (iOS-Bughunt 2, C1).

Eigenes Modul neben :mod:`dcc_chat_gateway.fcm`, weil ``fcm.py`` sonst über
die Größen-Policy gewachsen wäre.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from typing import Any

from sqlalchemy import select

from dcc_chat_gateway.models import VoipToken


def empfangende_geraete(
    zeilen: Iterable[Any],
    *,
    ios_geraete: set[tuple[int, str]],
    wach: Callable[[int], bool],
) -> list[Any]:
    """Welche Gerätezeilen einen DM-Push bekommen.

    **iOS-Geräte immer, Android-Geräte nur, wenn das Konto keine frische
    WebSocket hat** (iOS-Bughunt 2, C1). Ein eben weggestecktes iPhone gilt
    bis zu ``SOCKET_STALE_SEKUNDEN`` (95 s) als wach: seine halboffene
    Verbindung hat gerade noch etwas gesagt, sein JS ist aber schon
    eingefroren und verarbeitet den Weckruf nie. Die Mitteilung war dann
    endgültig verloren — dieselbe Lücke, die der Anruf-Weg schon geschlossen
    hat (``anruf_push.py``, T14).

    Ein Push an ein waches iPhone kostet keinen zweiten Banner: die Hülle
    unterdrückt DM-Mitteilungen, solange die App vorn ist
    (``MitteilungImVordergrund.swift``) — die Oberfläche meldet die Nachricht
    dort selbst. **Folge, die mitgedacht sein muss:** auch wer gerade am
    Rechner liest, bekommt den Banner am iPhone, und die Plakette zählt mit
    (der wache Klient korrigiert sie, ``badgeMelden.ts``).

    Android bleibt beim alten Riegel, bewusst unverändert. Ob dort dieselbe
    Lücke klafft (Doze statt eingefrorener WebView), ist nicht untersucht.
    Ein Push an eine wache Android-App erschiene übrigens nicht doppelt: das
    Plugin reicht eine FCM-Meldung im Vordergrund nur ans Web weiter
    (``MessagingService.onMessageReceived``, @capacitor-firebase/messaging
    8.5.2) und zeigt sie nicht an.

    ``ios_geraete`` sind ``(user_id, geraet_id)``-Paare: wer einen
    PushKit-Token angemeldet hat, IST ein iOS-Gerät (Begründung am Modell
    ``VoipToken``). Ein iOS-Bau ohne VoIP-Anmeldung fällt damit auf den
    Android-Riegel zurück — die vorsichtige Richtung.

    Rein, damit die Regel ohne Datenbank und ohne Firebase prüfbar ist.
    """
    return [
        z for z in zeilen if (z.user_id, z.geraet_id) in ios_geraete or not wach(z.user_id)
    ]


async def ios_geraete(session: Any, user_ids: set[int]) -> set[tuple[int, str]]:
    """Die ``(user_id, geraet_id)``-Paare dieser Konten mit PushKit-Token."""
    if not user_ids:
        return set()
    treffer = await session.execute(
        select(VoipToken.user_id, VoipToken.geraet_id).where(
            VoipToken.user_id.in_(list(user_ids))
        )
    )
    return {(uid, gid) for uid, gid in treffer.all()}


__all__ = ["empfangende_geraete", "ios_geraete"]
