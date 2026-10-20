"""Wer bekommt einen Push ans Handy — die Auswahl der Gerätezeilen und was die
Geräte von sich sagen (iOS-Bughunt 2, C1; Push-Bughunt 2026-10-20).

Eigenes Modul neben :mod:`dcc_chat_gateway.fcm`, weil ``fcm.py`` sonst über
die Größen-Policy gewachsen wäre.

**iOS oder Android.** Eine FCM-Zeile verrät ihre Plattform nicht. Wer
zusätzlich einen PushKit-Token unter derselben Geräte-Kennung angemeldet hat
(``voip_tokens``), IST ein iOS-Gerät (Begründung am Modell ``VoipToken``);
jede andere FCM-Zeile gilt hier als Android-Gerät.

**Die Fähigkeit ``dm_vordergrund``** (iOS, Nachprüfung der Fix-Runden, S2).
Ein DM-Push an ein waches iPhone kostet nur dann keinen zweiten Banner, wenn
die Hülle ihn im Vordergrund unterdrückt (``MitteilungImVordergrund.swift``).
Die iOS-Bauten vom 08. bis 11.10. melden einen PushKit-Token, können das aber
noch nicht. Ein Bau sagt deshalb mit seiner Token-Anmeldung, ob er es kann
(``POST /voip/token``, Feld ``faehigkeiten``); wer nichts sagt, bleibt beim
alten Riegel (:func:`empfangende_geraete`).

**Die Fähigkeiten eines Android-Geräts** (``POST /fcm/token``, Feld
``faehigkeiten``): ``anruf_push`` — der Bau verarbeitet den Anruf-Datenpush
(``anruf_push_fcm``); ``texte_lokal`` — er trägt die Text-Ressourcen aus
``fcm_texte.ANDROID_RESSOURCEN``. Ein Bau ohne das Feld kann keins von beiden.

**Warum Redis und keine Spalte.** Die Zusage gehört zum Bau, nicht zur Zeile:
sie wird bei JEDER Anmeldung neu gesetzt oder gelöscht (jeder App-Start meldet
an), und ein verlorener Merker fällt in die vorsichtige Richtung — bis zur
nächsten Anmeldung gilt, was ein Bau ohne Zusage bekommt. Eine Migration wäre
dafür mehr Gewicht als Nutzen. Ein Merker ohne Token-Zeile ist wirkungslos:
gefragt wird nur für Paare, die eine haben.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Any

from sqlalchemy import select

from dcc_chat_gateway.models import PrivateGroupMember, VoipToken

log = logging.getLogger(__name__)

Paar = tuple[int, str]

#: iOS: die Hülle unterdrückt DM-Banner, solange die App vorn ist.
DM_VORDERGRUND = "dm_vordergrund"
#: Android: der Bau verarbeitet den Anruf-Datenpush.
ANRUF_PUSH = "anruf_push"
#: Android: der Bau trägt die Text-Ressourcen (``fcm_texte``).
TEXTE_LOKAL = "texte_lokal"
#: Was ein Android-Bau melden kann; alles andere wird nicht gemerkt.
ANDROID_FAEHIGKEITEN = frozenset({ANRUF_PUSH, TEXTE_LOKAL})

#: Redis-Schlüssel je iOS-Gerät: ``…:<user_id>:<geraet_id>``.
FAEHIG_PRAEFIX = "voip:faehig:dm_vordergrund:"
#: Redis-Schlüssel je Android-Gerät: ``…:<user_id>:<geraet_id>``, Wert = die
#: gemeldeten Fähigkeiten, kommagetrennt.
ANDROID_FAEHIG_PRAEFIX = "fcm:faehig:"

#: So lange hält ein Merker ohne neue Anmeldung — weit länger, als ein
#: Telefon ohne App-Start bleibt; jede Anmeldung setzt ihn neu.
FAEHIG_HALTBARKEIT_S = 400 * 24 * 60 * 60


def _faehig_schluessel(user_id: int, geraet_id: str) -> str:
    return f"{FAEHIG_PRAEFIX}{user_id}:{geraet_id}"


def _android_schluessel(user_id: int, geraet_id: str) -> str:
    return f"{ANDROID_FAEHIG_PRAEFIX}{user_id}:{geraet_id}"


async def faehigkeiten_merken(
    redis: Any, *, user_id: int, geraet_id: str, faehigkeiten: list[str] | None
) -> None:
    """Was ein iOS-Gerät bei dieser VoIP-Anmeldung von sich sagt, festhalten.

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


async def android_faehigkeiten_merken(
    redis: Any, *, user_id: int, geraet_id: str, faehigkeiten: list[str] | None
) -> None:
    """Was ein Gerät bei dieser FCM-Anmeldung von sich sagt, festhalten — nur
    die bekannten Werte (:data:`ANDROID_FAEHIGKEITEN`). Keine davon (Feld
    fehlt, Liste leer) LÖSCHT den Merker, aus demselben Grund wie bei
    :func:`faehigkeiten_merken`. Löst nie aus."""
    if redis is None:
        return
    bekannt = sorted(set(faehigkeiten or ()) & ANDROID_FAEHIGKEITEN)
    schluessel = _android_schluessel(user_id, geraet_id)
    try:
        if bekannt:
            await redis.set(schluessel, ",".join(bekannt).encode(), ex=FAEHIG_HALTBARKEIT_S)
        else:
            await redis.delete(schluessel)
    except Exception:  # noqa: BLE001 — fail-open in die vorsichtige Richtung
        log.warning("fcm_faehigkeit_merken_fehlgeschlagen")


async def android_faehigkeiten(redis: Any, paare: Iterable[Paar]) -> dict[Paar, frozenset[str]]:
    """Die gemerkten Fähigkeiten je Gerät. Ohne Redis, oder wenn es nicht
    antwortet: keine — die vorsichtige Richtung."""
    liste = sorted(set(paare))
    if not liste or redis is None:
        return {}
    try:
        werte = await redis.mget([_android_schluessel(uid, gid) for uid, gid in liste])
    except Exception:  # noqa: BLE001
        log.warning("fcm_faehigkeit_lesen_fehlgeschlagen")
        return {}
    ergebnis: dict[Paar, frozenset[str]] = {}
    for paar, wert in zip(liste, werte, strict=True):
        if wert is None:
            continue
        text = wert.decode() if isinstance(wert, bytes) else str(wert)
        ergebnis[paar] = frozenset(text.split(",")) & ANDROID_FAEHIGKEITEN
    return ergebnis


@dataclass(frozen=True)
class Geraetearten:
    """Was die Auswahl über die Gerätezeilen wissen muss.

    ``riegel``: iOS-Geräte OHNE die Zusage ``dm_vordergrund`` — sie bekommen
    einen DM-Push nur ohne wache Verbindung des Kontos.
    ``texte_lokal``: Geräte, die Schlüssel statt des deutschen Textes
    bekommen (iOS mit ``dm_vordergrund``, Android mit ``texte_lokal``)."""

    riegel: frozenset[Paar] = frozenset()
    texte_lokal: frozenset[Paar] = frozenset()


async def geraetearten(session: Any, zeilen: Iterable[Any], redis: Any) -> Geraetearten:
    """:class:`Geraetearten` zu diesen FCM-Zeilen. Die iOS-Erkennung kommt aus
    der Datenbank, die Zusagen aus Redis; ohne Redis (oder wenn es nicht
    antwortet) gilt keine Zusage — jedes iOS-Gerät hängt dann am Riegel, und
    niemand bekommt Schlüssel. Wirft bei einem Datenbankfehler weiter."""
    paare = {(z.user_id, z.geraet_id) for z in zeilen}
    if not paare:
        return Geraetearten()
    treffer = await session.execute(
        select(VoipToken.user_id, VoipToken.geraet_id).where(
            VoipToken.user_id.in_(sorted({uid for uid, _ in paare}))
        )
    )
    ios = {(uid, gid) for uid, gid in treffer.all()} & paare
    zusage: set[Paar] = set()
    if ios and redis is not None:
        liste = sorted(ios)
        try:
            merker = await redis.mget([_faehig_schluessel(uid, gid) for uid, gid in liste])
            zusage = {p for p, wert in zip(liste, merker, strict=True) if wert is not None}
        except Exception:  # noqa: BLE001
            log.warning("voip_faehigkeit_lesen_fehlgeschlagen")
    android = await android_faehigkeiten(redis, paare - ios)
    android_lokal = {p for p, f in android.items() if TEXTE_LOKAL in f}
    return Geraetearten(riegel=frozenset(ios - zusage), texte_lokal=frozenset(zusage | android_lokal))


def empfangende_geraete(
    zeilen: Iterable[Any],
    *,
    riegel: frozenset[Paar] | set[Paar],
    wach: Callable[[int], bool],
) -> list[Any]:
    """Welche Gerätezeilen einen DM-Push bekommen.

    **Jedes Gerät, ausser einem iOS-Gerät ohne Zusage (``riegel``) bei wacher
    Verbindung des Kontos.** Ob die Mitteilung dann wirklich hinausgeht,
    entscheidet die Warteschlange: ``fcm_warteschlange.py`` hält den Push
    einige Sekunden zurück und verwirft ihn, wenn die Nachricht in der Zeit
    nachweislich gelesen wurde (``fcm_gelesen.py``); ohne diesen Beleg kommt
    der Banner, und die Plakette zählt mit (der wache Klient korrigiert sie,
    ``badgeMelden.ts``).

    *iOS mit Zusage* (iOS-Bughunt 2, C1): ein eben weggestecktes iPhone gilt
    bis zu ``SOCKET_STALE_SEKUNDEN`` (95 s) als wach, sein JS ist aber schon
    eingefroren und verarbeitet den Weckruf nie — ohne Push war die
    Mitteilung verloren. Ein Push an ein wirklich waches iPhone kostet keinen
    zweiten Banner: die Hülle unterdrückt DM-Mitteilungen, solange die App
    vorn ist (``MitteilungImVordergrund.swift``).

    *Android* (Push-Bughunt 2026-10-20): bis dahin bekam ein Android-Gerät
    nur einen Push, wenn das KONTO keine wache Verbindung hatte — ein offener
    Browser-Tab oder der Rechner hielt damit jede Mitteilung am Handy zurück.
    Ein Push an eine wache Android-App erscheint nicht doppelt: das Plugin
    reicht eine FCM-Meldung im Vordergrund nur ans Web weiter
    (``MessagingService.onMessageReceived``, @capacitor-firebase/messaging
    8.5.2) und zeigt sie nicht an.

    *iOS ohne Zusage* (Bauten vom 08. bis 11.10.) bleibt beim alten Riegel:
    sie zeigten jede DM im Vordergrund als Banner mit Ton. Grenze, bewusst: ein
    iOS-Bau, der nie einen PushKit-Token angemeldet hat, ist hier nicht von
    Android zu unterscheiden und bekommt den Push wie ein Android-Gerät.

    Rein, damit die Regel ohne Datenbank und ohne Firebase prüfbar ist.
    """
    return [z for z in zeilen if (z.user_id, z.geraet_id) not in riegel or not wach(z.user_id)]


async def gruppenmitglieder(session: Any, gruppe_id: int, user_ids: set[int]) -> set[int]:
    """Die Konten unter ``user_ids``, die JETZT Mitglied der Gruppe sind — eine
    Abfrage für alle. Eine aufgelöste Gruppe hat keine Mitglieder mehr
    (``ON DELETE CASCADE``), dann ist das Ergebnis leer. Wirft bei einem
    Datenbankfehler weiter."""
    if not user_ids:
        return set()
    zeilen = await session.execute(
        select(PrivateGroupMember.user_id).where(
            PrivateGroupMember.gruppe_id == gruppe_id,
            PrivateGroupMember.user_id.in_(sorted(user_ids)),
        )
    )
    return set(zeilen.scalars())


__all__ = [
    "ANDROID_FAEHIGKEITEN",
    "ANDROID_FAEHIG_PRAEFIX",
    "ANRUF_PUSH",
    "DM_VORDERGRUND",
    "FAEHIG_HALTBARKEIT_S",
    "FAEHIG_PRAEFIX",
    "Geraetearten",
    "TEXTE_LOKAL",
    "android_faehigkeiten",
    "android_faehigkeiten_merken",
    "empfangende_geraete",
    "faehigkeiten_merken",
    "geraetearten",
    "gruppenmitglieder",
]
