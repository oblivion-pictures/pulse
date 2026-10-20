"""@-Erwähnungen und Freundschaftsanfragen als Push ans Handy (Push-Bughunt
2026-10-20).

Bis dahin gingen beide nur als Web-Push hinaus (``push.py``) — ein Handy
erfuhr nichts davon, solange die App zu war. Jetzt bekommt jedes Handy des
Empfängers (iOS und Android, alle FCM-Zeilen) zusätzlich eine Mitteilung.

**Nur in der Cloud.** Ein Self-Host-Server hat keinen Firebase-Zugang (der
Schlüssel des Firebase-Projekts liegt nur in der Cloud), und die Handy-Apps
melden ihre Token ohnehin nur dort an (``platform/fcm.ts``: ``cloud()``).
Erwähnungen und Freundschaftsanfragen auf einem Self-Host erreichen ein Handy
deshalb weiterhin nicht per Push — das bleibt so.

**Wer keinen bekommt:** wer „Nicht stören“ an hat (``fcm_stumm``). Der
Web-Push lässt das den Service Worker entscheiden; eine Handy-Mitteilung
zeigt das System selbst, also entscheidet hier der Server. Mehr prüft auch
der Web-Push nicht: eine Stummschaltung von Community oder Kanal kennt der
Server nicht (sie lebt im Klienten), und einen Lesestand für Community-Kanäle
führt er nicht — ob der Empfänger den Kanal gerade liest, kann er also nicht
wissen. Wer blockiert ist, ist schon vorher aussortiert
(``mentions.fan_out_mention_events``).

**Inhalt.** Die Erwähnung trägt denselben Ausschnitt wie der Web-Push:
Community-Kanäle sind nicht Ende-zu-Ende-verschlüsselt, der Web-Push trägt
ihn längst. Titel ``<Autor> in #<Kanal> (<Community>)``. Die
Freundschaftsanfrage trägt nur den Namen des Absenders; ihr Text geht an
Geräte mit Zusage als Schlüssel (``fcm_texte``), sonst deutsch.

**Ohne Wartezeit, im Hintergrund.** Die DM-Warteschlange (``fcm_warteschlange``)
hält einen Push zurück, um ein Lesen abzuwarten — dafür fehlt hier der
Lesestand. Gesendet wird in einer eigenen Aufgabe, damit die Antwort auf das
Senden der Nachricht nicht auf Firebase wartet.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Coroutine
from typing import Any

from sqlalchemy import select

import dcc_chat_gateway.config as chat_config
from dcc_chat_gateway import fcm, fcm_nachricht
from dcc_chat_gateway.fcm_empfaenger import geraetearten
from dcc_chat_gateway.fcm_stumm import nicht_stoeren_konten
from dcc_chat_gateway.fcm_texte import SCHLUESSEL_FREUNDSCHAFT, Lokal
from dcc_chat_gateway.models import Channel, FcmToken, Guild

log = logging.getLogger(__name__)

#: iOS-Mitteilungskategorien. Eigene, nicht ``dm``: an ``dm`` hängt in der App
#: die Aktion „Antworten“, die verschlüsselt als DM sendet.
ERWAEHNUNG_KATEGORIE = "erwaehnung"
FREUNDSCHAFT_KATEGORIE = "freundschaft"

#: Starke Verweise auf laufende Sendungen (sonst darf der Ereignis-Loop eine
#: Aufgabe mitten im Lauf einsammeln).
_laufend: set[asyncio.Task[None]] = set()


def _aktiv() -> bool:
    return (
        chat_config.get_settings().pulse_instance_mode == "cloud" and fcm.ensure_fcm() is not None
    )


def _im_hintergrund(arbeit: Coroutine[Any, Any, None]) -> None:
    async def huelle() -> None:
        try:
            await arbeit
        except Exception:  # noqa: BLE001 — Push ist best-effort
            log.exception("fcm_hinweis_fehlgeschlagen")

    aufgabe = asyncio.create_task(huelle(), name="fcm-hinweis")
    _laufend.add(aufgabe)
    aufgabe.add_done_callback(_laufend.discard)


async def hintergrund_abwarten(frist_s: float = 5.0) -> None:
    """Auf laufende Sendungen warten — beim Herunterfahren und in Tests."""
    offen = set(_laufend)
    if offen:
        await asyncio.wait(offen, timeout=frist_s)


def _send_one(
    *, token: str, payload: dict, lokal: Lokal | None, kategorie: str, gruppe: str, tag: str
) -> str:
    """Ein Sendeversuch (synchron, Ausgänge: :func:`fcm_nachricht.senden`)."""
    return fcm_nachricht.senden(
        fcm_nachricht.mitteilung(
            token=token,
            payload=payload,
            lokal=lokal,
            kategorie=kategorie,
            gruppe=gruppe,
            tag=tag,
            zeitkritisch=False,
        )
    )


async def _senden(
    session: Any,
    redis: Any,
    user_ids: set[int],
    payload: dict,
    *,
    kategorie: str,
    gruppe: str,
    tag: str,
    lokal: Lokal | None = None,
) -> int:
    """An alle FCM-Zeilen der Konten ohne „Nicht stören“; ``lokal`` nur an
    Geräte mit Zusage. Liefert die Zahl gelungener Sendungen."""
    konten = user_ids - await nicht_stoeren_konten(session, redis, user_ids)
    if not konten:
        return 0
    treffer = await session.execute(select(FcmToken).where(FcmToken.user_id.in_(sorted(konten))))
    zeilen = treffer.scalars().all()
    if not zeilen:
        return 0
    arten = await geraetearten(session, zeilen, redis)
    ergebnisse = await asyncio.gather(
        *(
            asyncio.to_thread(
                _send_one,
                token=z.token,
                payload=payload,
                lokal=lokal if (z.user_id, z.geraet_id) in arten.texte_lokal else None,
                kategorie=kategorie,
                gruppe=gruppe,
                tag=tag,
            )
            for z in zeilen
        ),
        return_exceptions=True,
    )
    await fcm.tote_tokens_loeschen(
        session, [z.token for z, o in zip(zeilen, ergebnisse, strict=True) if o == "dead"]
    )
    return sum(1 for o in ergebnisse if o == "ok")


async def _namen(session: Any, channel_id: int, guild_id: int) -> tuple[str | None, str | None]:
    kanal = (await session.execute(select(Channel.name).where(Channel.id == channel_id))).scalar()
    community = (await session.execute(select(Guild.name).where(Guild.id == guild_id))).scalar()
    return kanal, community


def erwaehnung_titel(autor: str, kanal: str | None, community: str | None) -> str:
    titel = autor or "Pulse"
    if kanal:
        titel += f" in #{kanal}"
    if community:
        titel += f" ({community})"
    return titel


async def _erwaehnung_senden(
    *,
    user_ids: set[int],
    author_name: str,
    text: str,
    channel_id: int,
    message_id: int,
    guild_id: int,
    redis: Any,
) -> None:
    async with fcm.SessionLocal() as session:
        kanal, community = await _namen(session, channel_id, guild_id)
        payload = {
            "type": "erwaehnung",
            "title": erwaehnung_titel(author_name, kanal, community),
            "body": text,
            "guild_id": str(guild_id),
            "channel_id": str(channel_id),
            "message_id": str(message_id),
        }
        await _senden(
            session,
            redis,
            user_ids,
            payload,
            kategorie=ERWAEHNUNG_KATEGORIE,
            gruppe=str(channel_id),
            tag=str(channel_id),
        )


def erwaehnung(
    *,
    user_ids: set[int],
    author_name: str,
    text: str,
    channel_id: int,
    message_id: int,
    guild_id: int | None,
    redis: Any = None,
) -> None:
    """Die Erwähnung an die Handys von ``user_ids`` (s. Modulkopf); ``text``
    ist der Ausschnitt des Web-Pushes. Nur Community-Kanäle (``guild_id``).
    Kehrt sofort zurück, gesendet wird im Hintergrund; löst nie aus."""
    if not user_ids or guild_id is None or not _aktiv():
        return
    _im_hintergrund(
        _erwaehnung_senden(
            user_ids=set(user_ids),
            author_name=author_name,
            text=text,
            channel_id=channel_id,
            message_id=message_id,
            guild_id=guild_id,
            redis=redis,
        )
    )


async def _freundschaft_senden(
    *, recipient_id: int, actor_id: int, actor_name: str, redis: Any
) -> None:
    titel = actor_name or "Pulse"
    payload = {
        "type": "freundschaft",
        "title": titel,
        "body": SCHLUESSEL_FREUNDSCHAFT,
        "user_id": str(actor_id),
    }
    async with fcm.SessionLocal() as session:
        await _senden(
            session,
            redis,
            {recipient_id},
            payload,
            kategorie=FREUNDSCHAFT_KATEGORIE,
            gruppe="freundschaft",
            tag=f"freundschaft:{actor_id}",
            lokal=Lokal(schluessel=SCHLUESSEL_FREUNDSCHAFT, titel=titel),
        )


def freundschaft(*, recipient_id: int, actor_id: int, actor_name: str, redis: Any = None) -> None:
    """Eine eingehende Freundschaftsanfrage an die Handys des Empfängers
    (s. Modulkopf). Kehrt sofort zurück; löst nie aus."""
    if not _aktiv():
        return
    _im_hintergrund(
        _freundschaft_senden(
            recipient_id=recipient_id, actor_id=actor_id, actor_name=actor_name, redis=redis
        )
    )


__all__ = [
    "ERWAEHNUNG_KATEGORIE",
    "FREUNDSCHAFT_KATEGORIE",
    "erwaehnung",
    "erwaehnung_titel",
    "freundschaft",
    "hintergrund_abwarten",
]
