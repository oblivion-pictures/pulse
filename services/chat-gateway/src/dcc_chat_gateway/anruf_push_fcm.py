"""Anruf-Push an Android-Geräte — ein FCM-Datenpush (Push-Bughunt 2026-10-20).

Gegenstück zum VoIP-Push der iOS-Geräte (``apns_voip``); wann wer einen
bekommt, entscheidet :mod:`dcc_chat_gateway.anruf_push` für beide gleich.

**Nur an Geräte mit der Fähigkeit ``anruf_push``** (``fcm_empfaenger``): ein
älterer Android-Bau kennt die Nutzlast nicht. Sie ist ein reiner Datenpush —
kein ``notification``-Block, also zeigt das System selbst nichts an; was
klingelt, entscheidet die App. Priorität ``high`` (weckt ein Gerät im Doze),
Lebensdauer :data:`ANRUF_TTL_S`: ein Klingeln, das später ankäme, wäre keins
mehr.

Die Felder sind dieselben wie in der VoIP-Nutzlast (``anruf_push.klingeln``),
alle als Zeichenketten, dazu ``type: "anruf"``:

* Klingeln: ``art: "klingelt"``, ``call_id``, ``anruf_art`` (``dm``/``gruppe``),
  ``channel_id``, ``einleiter_id``, ``einleiter_name``;
* Abbruch: ``art: "abbruch"``, ``call_id``.

Tote Tokens fallen wie im DM-Weg (``fcm.tote_tokens_loeschen``).
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from sqlalchemy import select

from dcc_chat_gateway import fcm, fcm_nachricht
from dcc_chat_gateway.fcm_empfaenger import ANRUF_PUSH, android_faehigkeiten
from dcc_chat_gateway.models import FcmToken

log = logging.getLogger("dcc_chat_gateway.anruf_push")

#: So lange hält FCM einen Anruf-Push zu, so lange klingelt auch der Klient
#: (sein 45-s-Wecker).
ANRUF_TTL_S = 45


def verfuegbar() -> bool:
    """Ob FCM eingerichtet ist — ohne Schlüssel geht kein Android-Anruf-Push
    hinaus (auf einem Self-Host nie)."""
    return fcm.ensure_fcm() is not None


async def geraete(session: Any, redis: Any, konten: set[int]) -> list[tuple[int, str, str]]:
    """``(user_id, geraet_id, token)`` der FCM-Zeilen dieser Konten, deren Bau
    ``anruf_push`` gemeldet hat. Wirft bei einem Datenbankfehler weiter."""
    if not konten:
        return []
    treffer = await session.execute(
        select(FcmToken.user_id, FcmToken.geraet_id, FcmToken.token).where(
            FcmToken.user_id.in_(sorted(konten))
        )
    )
    zeilen = treffer.all()
    faehig = await android_faehigkeiten(redis, [(uid, gid) for uid, gid, _t in zeilen])
    return [
        (uid, gid, token)
        for uid, gid, token in zeilen
        if ANRUF_PUSH in faehig.get((uid, gid), frozenset())
    ]


def _send_one(*, token: str, daten: dict[str, str]) -> str:
    """Ein Sendeversuch (synchron, s. :func:`fcm_nachricht.senden`)."""
    return fcm_nachricht.senden(
        fcm_nachricht.daten_nachricht(token=token, daten=daten, ttl_s=ANRUF_TTL_S)
    )


async def senden(tokens: list[str], nutzlast: dict[str, str], session_factory: Any) -> None:
    """``nutzlast`` (die VoIP-Felder, s. Modulkopf) an alle ``tokens`` senden;
    Tokens, die Firebase als abgemeldet meldet, löschen."""
    if not tokens or not verfuegbar():
        return
    daten = {"type": "anruf", **{k: str(v) for k, v in nutzlast.items()}}
    ergebnisse = await asyncio.gather(
        *(asyncio.to_thread(_send_one, token=t, daten=daten) for t in tokens),
        return_exceptions=True,
    )
    tote = [t for t, ausgang in zip(tokens, ergebnisse, strict=True) if ausgang == "dead"]
    if not tote or session_factory is None:
        return
    async with session_factory() as session:
        await fcm.tote_tokens_loeschen(session, tote)


__all__ = ["ANRUF_TTL_S", "geraete", "senden", "verfuegbar"]
