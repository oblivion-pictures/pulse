"""Wer bekommt einen DM-Push — die Auswahl der Gerätezeilen (iOS-Bughunt 2, C1).

Eigenes Modul neben :mod:`dcc_chat_gateway.fcm`, weil ``fcm.py`` sonst über
die Größen-Policy gewachsen wäre.

**Die Fähigkeit ``dm_vordergrund``** (Nachprüfung der Fix-Runden, S2). Ein
DM-Push an ein waches iPhone kostet nur dann keinen zweiten Banner, wenn die
Hülle ihn im Vordergrund unterdrückt (``MitteilungImVordergrund.swift``). Die
iOS-Bauten vom 08. bis 11.10. melden einen PushKit-Token, können das aber
noch nicht: sie bekamen nach C1 jede DM im Vordergrund als Systembanner mit
Ton. Ein Bau sagt deshalb mit seiner Token-Anmeldung, ob er es kann
(``POST /voip/token``, Feld ``faehigkeiten``); nur dann gilt er hier als
iOS-Gerät ohne Frische-Prüfung. Wer nichts sagt, bleibt beim alten Riegel.

**Warum Redis und keine Spalte.** Die Zusage gehört zum Bau, nicht zur Zeile:
sie wird bei JEDER Anmeldung neu gesetzt oder gelöscht (jeder App-Start meldet
an), und ein verlorener Merker fällt in die vorsichtige Richtung — bis zur
nächsten Anmeldung gilt der alte Riegel. Eine Migration wäre dafür mehr
Gewicht als Nutzen. Ein Merker ohne Token-Zeile ist wirkungslos: gefragt wird
nur für Paare, die eine haben (:func:`ios_geraete`).
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Iterable
from typing import Any

from sqlalchemy import select

from dcc_chat_gateway.models import VoipToken

log = logging.getLogger(__name__)

#: Die Hülle unterdrückt DM-Banner, solange die App vorn ist.
DM_VORDERGRUND = "dm_vordergrund"

#: Redis-Schlüssel je Gerät: ``…:<user_id>:<geraet_id>``.
FAEHIG_PRAEFIX = "voip:faehig:dm_vordergrund:"

#: So lange hält der Merker ohne neue Anmeldung — weit länger, als ein
#: Telefon ohne App-Start bleibt; jede Anmeldung setzt ihn neu.
FAEHIG_HALTBARKEIT_S = 400 * 24 * 60 * 60


def _faehig_schluessel(user_id: int, geraet_id: str) -> str:
    return f"{FAEHIG_PRAEFIX}{user_id}:{geraet_id}"


async def faehigkeiten_merken(
    redis: Any, *, user_id: int, geraet_id: str, faehigkeiten: list[str] | None
) -> None:
    """Was das Gerät bei dieser Anmeldung von sich sagt, festhalten.

    ``None`` oder eine Liste ohne :data:`DM_VORDERGRUND` LÖSCHT den Merker:
    derselbe Gerätename kann nach einer Neuinstallation einem älteren Bau
    gehören. Löst nie aus — der Push-Weg ist best-effort.
    """
    if redis is None:
        return
    schluessel = _faehig_schluessel(user_id, geraet_id)
    try:
        if faehigkeiten and DM_VORDERGRUND in faehigkeiten:
            await redis.set(schluessel, b"1", ex=FAEHIG_HALTBARKEIT_S)
        else:
            await redis.delete(schluessel)
    except Exception:  # noqa: BLE001 — fail-open in die vorsichtige Richtung
        log.warning("voip_faehigkeit_merken_fehlgeschlagen")


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
    Rechner liest, bekäme den Banner am iPhone. Seit dem 2026-10-17 hält
    ``fcm_warteschlange.py`` den Push deshalb einige Sekunden zurück und
    verwirft ihn, wenn die Nachricht in der Zeit nachweislich gelesen wurde
    (``fcm_gelesen.py``); ohne diesen Beleg kommt der Banner weiter, und die
    Plakette zählt mit (der wache Klient korrigiert sie, ``badgeMelden.ts``).

    Android bleibt beim alten Riegel, bewusst unverändert. Ob dort dieselbe
    Lücke klafft (Doze statt eingefrorener WebView), ist nicht untersucht.
    Ein Push an eine wache Android-App erschiene übrigens nicht doppelt: das
    Plugin reicht eine FCM-Meldung im Vordergrund nur ans Web weiter
    (``MessagingService.onMessageReceived``, @capacitor-firebase/messaging
    8.5.2) und zeigt sie nicht an.

    ``ios_geraete`` sind ``(user_id, geraet_id)``-Paare: wer einen
    PushKit-Token angemeldet hat UND die Fähigkeit ``dm_vordergrund`` gemeldet
    hat (Modulkopf, S2). Ein iOS-Bau ohne VoIP-Anmeldung oder ohne die
    Fähigkeit fällt damit auf den Android-Riegel zurück — die vorsichtige
    Richtung.

    Rein, damit die Regel ohne Datenbank und ohne Firebase prüfbar ist.
    """
    return [
        z for z in zeilen if (z.user_id, z.geraet_id) in ios_geraete or not wach(z.user_id)
    ]


async def ios_geraete(session: Any, user_ids: set[int], redis: Any) -> set[tuple[int, str]]:
    """Die ``(user_id, geraet_id)``-Paare dieser Konten mit PushKit-Token, deren
    Bau ``dm_vordergrund`` gemeldet hat. Ohne Redis, oder wenn es nicht
    antwortet: keins — dann gilt für alle der alte Riegel."""
    if not user_ids or redis is None:
        return set()
    treffer = await session.execute(
        select(VoipToken.user_id, VoipToken.geraet_id).where(
            VoipToken.user_id.in_(list(user_ids))
        )
    )
    paare = [(uid, gid) for uid, gid in treffer.all()]
    if not paare:
        return set()
    try:
        merker = await redis.mget([_faehig_schluessel(uid, gid) for uid, gid in paare])
    except Exception:  # noqa: BLE001
        log.warning("voip_faehigkeit_lesen_fehlgeschlagen")
        return set()
    return {paar for paar, wert in zip(paare, merker, strict=True) if wert is not None}


__all__ = [
    "DM_VORDERGRUND",
    "FAEHIG_HALTBARKEIT_S",
    "FAEHIG_PRAEFIX",
    "empfangende_geraete",
    "faehigkeiten_merken",
    "ios_geraete",
]
