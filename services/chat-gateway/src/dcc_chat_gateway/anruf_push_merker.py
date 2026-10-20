"""Wer hat zu welchem Anruf per Push geklingelt — der Redis-Merker des
Anruf-Wegs.

Aus :mod:`dcc_chat_gateway.anruf_push` gelöst, als Android-Geräte dazukamen
(Push-Bughunt 2026-10-20) und die Datei sonst über die Größen-Policy
gewachsen wäre. Warum es den Merker gibt (der Abbruch geht nur an Geräte,
die geklingelt haben), steht im Kopf von ``anruf_push.py``.

**Ein Hash je Anruf**, Feld = Token, Wert = ``"<user_id>|<geraet_id>"``. Ein
Android-Gerät steht unter ``"fcm:" + Token``; die Felder der iOS-Geräte sind
dieselben wie vor Android. Ein APNs-Token ist eine Hex-Zeichenkette und kann
das Präfix nicht tragen.

Alles fail-open: eine Redis-Störung wird gewarnt und heisst schlimmstenfalls
„kein Abbruch-Push" — der Anruf läuft über die WebSocket weiter.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

log = logging.getLogger("dcc_chat_gateway.anruf_push")

#: Je Anruf: welches Gerät per Push geklingelt hat.
GEKLINGELT_PRAEFIX = "anruf:voip:geklingelt:"

#: So lange bleibt der Merker stehen. Er muss das GESPRÄCH überdauern, nicht
#: nur das Klingeln: das Gerät, das angenommen hat, bekommt seinen Abbruch erst
#: beim Ende — falls seine Oberfläche dann eingefroren ist, ist das der einzige
#: Weg, der den CallKit-Anruf dort schliesst.
GEKLINGELT_HALTBARKEIT_S = 12 * 60 * 60

IOS = "ios"
ANDROID = "android"
#: Präfix der Hash-Felder von Android-Geräten (s. Modulkopf).
ANDROID_FELD_PRAEFIX = "fcm:"


@dataclass(frozen=True)
class Geraet:
    """Ein Gerät, das einen Anruf-Push bekommen kann: ``ios`` per VoIP über
    APNs (``apns_voip``), ``android`` per FCM-Datenpush (``anruf_push_fcm``)."""

    user_id: int
    geraet_id: str
    token: str
    plattform: str = IOS

    @property
    def kennung(self) -> tuple[int, str]:
        """``(user_id, geraet_id)`` — die Form, in der ``ausser`` ein Gerät nennt."""
        return (self.user_id, self.geraet_id)

    @property
    def feld(self) -> str:
        """Das Hash-Feld im Merker (s. Modulkopf)."""
        return self.token if self.plattform == IOS else ANDROID_FELD_PRAEFIX + self.token


def schluessel(call_id: str) -> str:
    return f"{GEKLINGELT_PRAEFIX}{call_id}"


def _als_text(wert: Any) -> str:
    return wert.decode() if isinstance(wert, bytes) else str(wert)


async def merken(redis: Any, call_id: str, geraete: list[Geraet]) -> None:
    if redis is None or not geraete:
        return
    try:
        key = schluessel(call_id)
        await redis.hset(key, mapping={g.feld: f"{g.user_id}|{g.geraet_id}" for g in geraete})
        await redis.expire(key, GEKLINGELT_HALTBARKEIT_S)
    except Exception:  # noqa: BLE001 — fail-open, s. Modulkopf
        log.warning("anruf_voip_merken_fehlgeschlagen")


async def geklingelt(redis: Any, call_id: str) -> list[Geraet]:
    if redis is None:
        return []
    try:
        roh = await redis.hgetall(schluessel(call_id))
    except Exception:  # noqa: BLE001
        log.warning("anruf_voip_lesen_fehlgeschlagen")
        return []
    geraete: list[Geraet] = []
    for feld, wert in roh.items():
        uid, _, gid = _als_text(wert).partition("|")
        try:
            user_id = int(uid)
        except ValueError:
            continue
        token = _als_text(feld)
        plattform = IOS
        if token.startswith(ANDROID_FELD_PRAEFIX):
            token, plattform = token.removeprefix(ANDROID_FELD_PRAEFIX), ANDROID
        geraete.append(Geraet(user_id=user_id, geraet_id=gid, token=token, plattform=plattform))
    return geraete


async def austragen(redis: Any, call_id: str, geraete: list[Geraet]) -> None:
    if redis is None or not geraete:
        return
    try:
        await redis.hdel(schluessel(call_id), *[g.feld for g in geraete])
    except Exception:  # noqa: BLE001
        log.warning("anruf_voip_austragen_fehlgeschlagen")


__all__ = [
    "ANDROID",
    "GEKLINGELT_HALTBARKEIT_S",
    "GEKLINGELT_PRAEFIX",
    "Geraet",
    "IOS",
    "austragen",
    "geklingelt",
    "merken",
    "schluessel",
]
