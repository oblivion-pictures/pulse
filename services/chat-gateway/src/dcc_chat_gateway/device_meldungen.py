"""Die Form eines Geräts nach aussen — und die Meldungen, die es begleiten.

Ausgelagert aus :mod:`routes.devices` (Grössen-Policy §12.1) und aus einem
zweiten Grund: die Zeile eines Geräts verlässt den Server nicht nur über die
Route. Der Rauswurf- und der Bann-Pfad (:mod:`remote_guard`) müssen dasselbe
``device_changed`` schicken, und ein Wach-Modul, das dafür eine Route importiert,
hätte die Abhängigkeitsrichtung auf den Kopf gestellt. Hier steht die Form
einmal, und beide Seiten holen sie sich.

Beide Meldungen sind bewusst **fehlertolerant**: die Datenbank ist die Wahrheit,
die Meldung an die offenen Fenster ist Bequemlichkeit. Ein fehlendes Redis darf
keine Eintragung scheitern lassen — dieselbe Linie wie bei den Plugin-Toggles
(``routes/guild_plugins.py``).
"""

from __future__ import annotations

import logging

from dcc_shared.events import DeviceAccessChangedEvent
from fastapi import Request
from pydantic import BaseModel

from dcc_chat_gateway.models import Device

log = logging.getLogger(__name__)


class DeviceOut(BaseModel):
    id: str
    guild_id: str
    channel_id: str
    owner_user_id: str
    name: str
    #: ``ready`` | ``busy`` | ``offline`` — aus dem Verbindungsregister.
    state: str
    #: Wer es gerade steuert (nur bei ``busy``), sonst ``None``.
    busy_with: str | None = None
    #: Die Bildschirme, die das Gerät beim Anmelden gemeldet hat. Leer, solange
    #: es nie verbunden war — der Steuernde sieht dann nur „ein Bildschirm",
    #: und das ist ehrlicher als eine erfundene Liste.
    monitors: list[dict] = []
    #: Plätze, auf denen dieses Gerät gerade sendet — leer heisst „sendet
    #: nicht". Aus dem Verbindungsregister wie der Zustand, nicht aus der
    #: Datenbank: der Strom eines Geräts läuft unter dem Konto seines
    #: Besitzers, das Gerät meldet seine Plätze also selbst
    #: (``device_streams``). Das Geräte-Merkmal am Strom (seit 2026-10-16,
    #: ``stream:active``) ersetzt das nicht: es dient nur der
    #: Zuschauer-Schranke (``geraete_zuschauen.py``), die Stromliste der
    #: Clients führt es nicht.
    stream_slots: list[int] = []
    #: Darf DIESER Betrachter das Gerät wecken und steuern? Sicht am Standplatz
    #: UND eine deckende, nicht abgelaufene Freigabe; für den Besitzer immer
    #: ``False`` (``geraete_freigabe.steuerbar_je_geraet``). Nur in den
    #: REST-Antworten belegt — die Meldung ``device_changed`` geht an alle und
    #: lässt das Feld deshalb weg (``device_registry.publish_device_change``).
    #: Ändert sich die Liste, kommt ``device_access_changed`` (:func:`zugang_melden`).
    steuerbar: bool = False


def manager_von(request: Request):
    return getattr(request.app.state, "connection_manager", None)


def device_out(device: Device, mgr) -> DeviceOut:
    """Die Zeile in ihrer Aussenform — Antwort einer Route und, als
    ``model_dump()``, Nutzlast eines ``device_changed``-Rahmens.

    Die eine Stelle, an der diese Form entsteht. Auch der Rauswurf-Pfad holt
    sie sich hier, statt sich eine zweite, langsam auseinanderlaufende Kopie
    des Feldsatzes zu bauen.
    """
    # Ohne Manager (Testaufbau ohne WS-Schicht) ist nichts angemeldet — und
    # „offline" ist die richtige Antwort auf „ich weiss es nicht".
    zustand, mit = mgr.device_state(device.id) if mgr is not None else ("offline", None)
    schirme = mgr.device_monitors(device.id) if mgr is not None else []
    plaetze = mgr.device_streams(device.id) if mgr is not None else []
    return DeviceOut(
        id=str(device.id),
        guild_id=str(device.guild_id),
        channel_id=str(device.channel_id),
        owner_user_id=str(device.owner_user_id),
        name=device.name,
        state=zustand,
        busy_with=mit,
        monitors=schirme,
        stream_slots=plaetze,
    )


async def melden(
    request: Request,
    device: Device,
    stand: DeviceOut,
    *,
    entfernt: bool = False,
    kanal: int | None = None,
    guild: int | None = None,
    umzug: bool = False,
) -> None:
    """``device_changed`` an die Community schicken.

    ``kanal`` übersteuert den Standplatz — gebraucht beim Umstellen, wo die
    Meldung „weg hier" an den ALTEN Kanal gehen muss. ``guild`` übersteuert
    ebenso die Community — seit dem Community-Wechsel kann die ALTE Community
    eine andere sein als ``device.guild_id`` (das Gerät trägt zu diesem
    Zeitpunkt schon die neue). Beide Vorgaben (``device.guild_id`` /
    ``device.channel_id``) halten das Verhalten für alle bestehenden Rufer
    unverändert.

    ``umzug`` gehört zusammen mit ``entfernt=True`` beim Umstellen gesetzt:
    ohne die Unterscheidung räumt der eigene Rechner des Geräts (Mitglied der
    alten Community, sieht den alten Kanal) seine lokale Eintragung dauerhaft
    weg, sobald er die eigene Abmeldung empfängt — obwohl das Gerät nur
    umgezogen ist, nicht gelöscht (Prüfbefund K-1, 2026-08-20). Der Client
    kann das aus der sonstigen Nutzlast nicht unterscheiden, der Server muss
    es sagen.
    """
    mgr = manager_von(request)
    if mgr is None:
        return
    try:
        await mgr.publish_device_change(
            guild_id=guild if guild is not None else device.guild_id,
            channel_id=kanal if kanal is not None else device.channel_id,
            device=stand.model_dump(),
            removed=entfernt,
            moved=umzug,
        )
    except Exception:  # pragma: no cover - Meldung ist nie kritisch
        log.debug("device_changed not published", exc_info=True)


async def zugang_melden(request: Request, device: Device) -> None:
    """``device_access_changed`` an alle, die den Standplatz sehen — „wer
    dieses Gerät steuern darf, hat sich geändert, lade neu".

    Ohne Ergebnis im Rahmen (Begründung an ``DeviceAccessChangedEvent``):
    ``steuerbar`` ist je Betrachter verschieden, und die Liste selbst darf nur
    der Besitzer lesen. Fehlertolerant wie :func:`melden`.
    """
    mgr = manager_von(request)
    if mgr is None:
        return
    try:
        await mgr.publish_guild_event(
            DeviceAccessChangedEvent(
                guild_id=str(device.guild_id),
                channel_id=str(device.channel_id),
                device_id=str(device.id),
            )
        )
    except Exception:  # pragma: no cover - Meldung ist nie kritisch
        log.debug("device_access_changed not published", exc_info=True)


async def sitzung_beenden(request: Request, device: Device) -> None:
    """Eine laufende Fernsteuerung dieses Geräts abbauen."""
    mgr = manager_von(request)
    if mgr is None:
        return
    try:
        await mgr.end_remote_sessions_for_device(device.id)
    except Exception:  # pragma: no cover
        log.debug("device sessions not ended", exc_info=True)
