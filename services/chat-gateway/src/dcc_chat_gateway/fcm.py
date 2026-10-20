"""FCM-Push (Firebase Cloud Messaging) für die Handy-Apps (Übergabe P0.1).

Ein inhaltsfreier Benachrichtigungskanal neben dem Web-Push aus
:mod:`dcc_chat_gateway.push`: eine neue DM wird als Systemmeldung auf dem
Telefon sichtbar (wer bekommt was: :mod:`dcc_chat_gateway.fcm_empfaenger`).
Die Nutzlast trägt deshalb nur Absendername und Kanalkennung — niemals
Nachrichtentext (derselbe Riegel wie ``fan_out_dm_push_encrypted``). Der Bau
der Nachricht steht in :mod:`dcc_chat_gateway.fcm_nachricht`.

**Einrichtung des Service-Account-Keys** (einmalig, Betreiber):

1. Firebase Console → Projekt "Pulse" (pulse-8cad0) → Projekteinstellungen
   → Dienstkonten → „Neuen privaten Schlüssel generieren" (JSON).
2. Datei auf dem Server ablegen (z. B. ``/data/fcm-service-account.json``,
   Modus 0600) und den Pfad als ``FIREBASE_SERVICE_ACCOUNT_KEY``-Umgebungs-
   variable setzen. Neustart. Ohne die Variable (oder mit unlesbarer Datei)
   bleibt FCM aus — kein Crash, kein Ambulanz-Log je Nachricht: nur ein
   einzelner WARNING beim ersten missglückten Initialisieren; erst ein
   Neustart versucht es wieder (:func:`ensure_fcm`).

``firebase_admin`` wird erst beim ersten Senden importiert (Muster wie
``pywebpush`` in ``push.py``): Boot und Tests brauchen die Bibliothek nicht.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from sqlalchemy import delete, select

from dcc_chat_gateway import badgezaehler, fcm_nachricht
from dcc_chat_gateway.config import get_settings
from dcc_chat_gateway.db import SessionLocal
from dcc_chat_gateway.fcm_empfaenger import (
    empfangende_geraete,
    geraetearten,
    gruppenmitglieder,
)
from dcc_chat_gateway.fcm_nachricht import ANDROID_CHANNEL_ID, DM_KATEGORIE
from dcc_chat_gateway.fcm_stumm import stumme_gruppenmitglieder, stumme_konten
from dcc_chat_gateway.fcm_texte import Lokal
from dcc_chat_gateway.models import FcmToken

# Nur für die Typangabe von ``_build_dm_message``: zur Laufzeit lädt diese
# Zeile nichts — ``firebase_admin`` wird erst beim ersten Senden importiert
# (s. Modulkopf).
if TYPE_CHECKING:
    from firebase_admin import messaging

log = logging.getLogger(__name__)

#: Inhaltsfreier Benachrichtigungstext — der Server kann (bei verschlüsselten
#: DMs: soll) den Klartext nicht kennen, also steht hier nie mehr als die
#: Kategorie.
DM_BODY = "Neue Nachricht"

#: Dasselbe, wenn ein Anhang dranhängt (Eigentümer-Entscheid 2026-10-08).
#: Der Server WEISS das — die Bezugszeilen (``dm_anhang_bezuege``) stehen in
#: seiner Datenbank —, und nur das sagt dieser Text. Kein Dateiname, keine
#: Art, keine Grösse: die hat er auch gar nicht entschlüsselt vorliegen.
#: Der Preis ist bewusst in Kauf genommen und klein: Apple und der Server
#: erfahren, DASS diese eine Nachricht einen Anhang trug.
DM_BODY_ANHANG = "Hat dir einen Anhang geschickt"


def dm_body(hat_anhang: bool) -> str:
    """Der Mitteilungstext für eine DM. Eigene Funktion, weil die Entscheidung
    an zwei Stellen gleich ausfallen muss (``aps.alert`` für iOS und
    ``notification`` für Android) — stünden dort verschiedene Texte, sähe
    dieselbe Nachricht je nach Gerät anders aus."""
    return DM_BODY_ANHANG if hat_anhang else DM_BODY


#: Zeitgrenze je HTTP-Aufruf an Firebase. Ohne sie wartet firebase_admin
#: 120 s (``_http_client.DEFAULT_TIMEOUT_SECONDS``) — in der Push-Warteschlange
#: hielte ein hängender Aufruf so lange eine Versand-Aufgabe und ihre Pacht
#: (``fcm_warteschlange.PACHT_S`` ist auf diesen Wert abgestimmt).
FCM_HTTP_TIMEOUT_S = 10

#: Wie lange die Plaketten-Marke eines Warteschlangen-Eintrags hält — länger
#: als alle Wiederholungen zusammen (``fcm_warteschlange.RUECKOFF_S``).
PLAKETTE_MARKE_HALTBARKEIT_S = 24 * 60 * 60

#: Initialisierte ``firebase_admin.App`` — Prozess-Singleton, erster Aufruf
#: gewinnt. ``None`` heisst: nicht konfiguriert oder fehlgeschlagen (kein Push).
_FCM_APP: Any | None = None

#: Ein Initialisieren ist in diesem Prozess schon gescheitert (Bibliothek
#: fehlt, Schlüsseldatei unbrauchbar). Ohne den Merker versuchte und loggte
#: JEDE Nachricht es neu — der Modulkopf verspricht einen einzigen WARNING.
_FCM_GESCHEITERT = False


def ensure_fcm() -> Any | None:
    """Firebase-App mit Service-Account initialisieren (gecacht).

    Liefert ``None``, wenn ``FIREBASE_SERVICE_ACCOUNT_KEY`` nicht gesetzt ist,
    ``firebase_admin`` fehlt oder die Datei unbrauchbar ist — aufruferseitig
    dasselbe Verhalten: kein Push, kein Fehler. Ein Fehlschlag wird einmal
    geloggt und bis zum Neustart gemerkt.
    """
    global _FCM_APP, _FCM_GESCHEITERT
    if _FCM_APP is not None:
        return _FCM_APP
    if _FCM_GESCHEITERT:
        return None
    settings = get_settings()
    if not settings.firebase_service_account_key:
        return None
    try:
        import firebase_admin
        from firebase_admin import credentials
    except ImportError:
        _FCM_GESCHEITERT = True
        log.warning("firebase_admin nicht installiert; FCM-Push deaktiviert")
        return None
    try:
        _FCM_APP = firebase_admin.initialize_app(
            credentials.Certificate(settings.firebase_service_account_key),
            options={"httpTimeout": FCM_HTTP_TIMEOUT_S},
        )
    except Exception as exc:  # noqa: BLE001 — schlechter Key darf nie den Versandpfad sprengen
        _FCM_GESCHEITERT = True
        # Nur der Typ, keine Meldung und kein Traceback: was eine Ausnahme
        # beim Laden der Datei in ihre Meldung schreibt, sagt die Bibliothek
        # nicht zu, und die Datei enthält den privaten Schlüssel.
        log.warning(
            "fcm_key_unbrauchbar — Service-Account-Datei %s nicht ladbar (%s); "
            "FCM-Push bis zum Neustart deaktiviert",
            settings.firebase_service_account_key,
            type(exc).__name__,
        )
        return None
    log.info("fcm_aktiviert — Service-Account-Key geladen")
    return _FCM_APP


def reset_fcm_cache_for_tests() -> None:
    """Prozess-Cache leeren (Tests mit wechselnden Key-Pfaden)."""
    global _FCM_APP, _FCM_GESCHEITERT
    _FCM_GESCHEITERT = False
    if _FCM_APP is not None:
        try:
            import firebase_admin

            firebase_admin.delete_app(_FCM_APP)
        except Exception:  # noqa: BLE001
            pass
    _FCM_APP = None


def _build_dm_message(
    *, token: str, payload: dict, badge: int | None = None, lokal: Lokal | None = None
) -> messaging.Message:
    """Die FCM-Message einer DM (:func:`fcm_nachricht.dm_mitteilung`). Der Name
    bleibt, weil die Tests den echten Bau über ihn durch den firebase-Encoder
    schicken (Befund 2026-10-06: messaging.ApsSound existierte nicht — nur
    ein echter Konstruktions-Test fängt so etwas).

    ``badge`` ist der Ungelesen-Stand des EMPFÄNGERS (s. ``badgezaehler``).
    ``None`` heisst *schweigen*: das Feld entfällt und die Zahl am Gerät
    bleibt stehen. Eine ``0`` dagegen räumt die Plakette ab — deshalb darf
    ein unbekannter Stand niemals als 0 durchgehen.

    ``lokal`` (nur Geräte mit Zusage, s. :mod:`dcc_chat_gateway.fcm_texte`):
    statt des fertigen Textes gehen Schlüssel hinaus, und der FCM-Block
    ``notification`` entfällt.
    """
    return fcm_nachricht.dm_mitteilung(token=token, payload=payload, badge=badge, lokal=lokal)


def _send_one(
    *, token: str, payload: dict, badge: int | None = None, lokal: Lokal | None = None
) -> str:
    """Ein Sendeversuch; Ausgänge und ihre Bedeutung: :func:`fcm_nachricht.senden`.

    ``dead`` = Token weg (App deinstalliert, rotiert) → Zeile löschen,
    damit jeder DM-Versand nicht ewig gegen eine tote Registrierung läuft.
    Niemals ``token`` oder Payload loggen.
    """
    try:
        nachricht = _build_dm_message(token=token, payload=payload, badge=badge, lokal=lokal)
    except ImportError:
        log.error("firebase_admin nicht installiert; FCM-Push deaktiviert")
        return "warn"
    return fcm_nachricht.senden(nachricht)


async def tote_tokens_loeschen(session: Any, tokens: list[str]) -> None:
    """FCM-Zeilen löschen, deren Token Firebase als abgemeldet meldet
    (``"dead"``, :func:`fcm_nachricht.senden`) — für jeden Weg, der an FCM
    sendet (DM, Erwähnung, Freundschaft, Anruf), dieselbe Regel."""
    if not tokens:
        return
    # warning, nicht info: die Cloud loggt erst ab warning. Ohne Token (die
    # sind Geheimnisse) — nur die Anzahl.
    log.warning("fcm_token_tot — %d Token entfernt (abgemeldet)", len(tokens))
    await session.execute(delete(FcmToken).where(FcmToken.token.in_(tokens)))
    await session.commit()


@dataclass(frozen=True)
class Versand:
    """Ausgang eines Versands. ``stoerung`` = nichts ging hinaus, und ein
    späterer Versuch kann helfen (Datenbank weg, Firebase-Zeitüberschreitung
    oder 5xx) — im Gegensatz zu „niemand zu erreichen", toten Tokens oder
    einer Anfrage, die Firebase als ungültig ablehnt (``"ungueltig"``)."""

    gesendet: int = 0
    stoerung: bool = False


async def fan_out_fcm_dm_push(**kwargs: Any) -> int:
    """Wie :func:`dm_push_senden`, liefert nur die Zahl erfolgreicher
    Sendungen (die Form der Aufrufer von vor der Warteschlange)."""
    return (await dm_push_senden(**kwargs)).gesendet


async def dm_push_senden(
    *,
    recipient_ids: set[int],
    author_name: str,
    channel_id: int,
    manager: Any | None = None,
    hat_anhang: bool = False,
    anzahl: int = 1,
    plakette_marke: str | None = None,
    text: str | None = None,
    lokal: Lokal | None = None,
    art: str = "dm",
) -> Versand:
    """Inhaltsfreien FCM-Push an die DM-Empfänger ausliefern — SOFORT.

    Der Normalweg geht nicht hierher, sondern über die Warteschlange
    (:func:`dcc_chat_gateway.fcm_warteschlange.vormerken`), die erst nach der
    Wartezeit hierher ruft. ``anzahl`` ist die Zahl der Nachrichten, für die
    diese eine Mitteilung steht (gebündelt), und zählt so oft die Plakette hoch.

    Wer einen bekommt, entscheidet :func:`empfangende_geraete`: jedes Gerät,
    ausser einem iOS-Bau ohne die Zusage ``dm_vordergrund``, solange das Konto
    eine wache WebSocket hat (Begründung dort). Der Check läuft über
    ``ConnectionManager.user_socket_count``; ohne ``manager`` (Tests, pfad-
    lose Aufrufe) gilt jeder Empfänger als offline.

    **Wer sich Pushes verbeten hat, bekommt keinen** (:mod:`dcc_chat_gateway.fcm_stumm`):
    „Nicht stören“, der DM-Schalter und — nur bei ``art == "gruppe"`` — die
    stummgeschaltete Gruppe. Bei „Nicht stören“ und dem DM-Schalter zählt
    die Plakette trotzdem hoch (Begründung dort), bei der stummen Gruppe
    nicht — die zählt auch die App nicht mit (``abzeichen.svelte.ts``).
    **Bei ``art == "gruppe"`` zählt die Mitgliedschaft JETZT**, nicht beim
    Vormerken: wer in der Wartezeit austritt oder hinausgeworfen wird, oder
    wessen Gruppe aufgelöst wurde, bekommt nichts mehr.
    ``lokal`` (:mod:`dcc_chat_gateway.fcm_texte`) ersetzt den fertigen Text
    durch Schlüssel — nur für Geräte mit Zusage (iOS ``dm_vordergrund``,
    Android ``texte_lokal``), alle anderen bekommen den deutschen Text.

    Löst nie aus — Fehlkonfiguration und tote Tokens dürfen den
    Nachrichtenweg nie brechen. Ob ein neuer Versuch lohnt, sagt
    :attr:`Versand.stoerung`; die Warteschlange plant danach neu ein.
    """
    if not recipient_ids:
        return Versand()
    if ensure_fcm() is None:
        return Versand()

    def wach(uid: int) -> bool:
        return manager is not None and manager.user_socket_count(uid) > 0

    payload = {
        "type": "dm",
        "title": author_name or "Pulse",
        # ``text`` setzt nur die Warteschlange, für ein Bündel (inhaltsfrei).
        "body": text or dm_body(hat_anhang),
        "channel_id": str(channel_id),
    }

    try:
        async with SessionLocal() as session:
            if art == "gruppe":
                recipient_ids = await gruppenmitglieder(session, channel_id, recipient_ids)
                if not recipient_ids:
                    return Versand()
            ergebnis = await session.execute(
                select(FcmToken).where(FcmToken.user_id.in_(list(recipient_ids)))
            )
            alle = ergebnis.scalars().all()
            redis = getattr(manager, "redis", None)
            arten = await geraetearten(session, alle, redis)
            rows = empfangende_geraete(alle, riegel=arten.riegel, wach=wach)
            if not rows:
                return Versand()
            # Icon-Badge: EINMAL je Konto hochzählen, nicht je Gerätezeile —
            # ein Konto hat einen Ungelesen-Stand, auch wenn Handy und Tablet
            # beide einen Push bekommen. Ohne Redis (pfadlose Aufrufe, Tests)
            # bleibt der Stand unbekannt und das Feld entfällt im Push. Auch
            # die Konten mit „Nicht stören“ oder DM-Schalter aus zählen
            # (``fcm_stumm``), ihre Zahl geht nur nirgends hin — wer die
            # Gruppe stummgeschaltet hat, zählt dagegen nicht.
            konten = {r.user_id for r in rows}
            gruppe_stumm = (
                await stumme_gruppenmitglieder(session, channel_id, konten)
                if art == "gruppe"
                else set()
            )
            stumm = await stumme_konten(session, redis, konten) | gruppe_stumm
            badges = await badgezaehler.fuer_konten(
                redis,
                konten - gruppe_stumm,
                anzahl,
                plakette_marke,
                marke_haltbarkeit_s=PLAKETTE_MARKE_HALTBARKEIT_S,
            )
            rows = [r for r in rows if r.user_id not in stumm]
            if not rows:
                return Versand()
            results = await asyncio.gather(
                *(
                    asyncio.to_thread(
                        _send_one,
                        token=r.token,
                        payload=payload,
                        badge=badges.get(r.user_id),
                        lokal=lokal if (r.user_id, r.geraet_id) in arten.texte_lokal else None,
                    )
                    for r in rows
                ),
                return_exceptions=True,
            )
            await tote_tokens_loeschen(
                session, [r.token for r, o in zip(rows, results, strict=True) if o == "dead"]
            )
            gesendet = sum(1 for outcome in results if outcome == "ok")
            gestoert = any(o == "warn" or isinstance(o, BaseException) for o in results)
            return Versand(gesendet=gesendet, stoerung=gesendet == 0 and gestoert)
    except Exception:  # noqa: BLE001
        log.exception("fan_out_fcm_dm_push fehlgeschlagen")
        return Versand(stoerung=True)


__all__ = [
    "ANDROID_CHANNEL_ID",
    "DM_BODY",
    "DM_KATEGORIE",
    "Versand",
    "dm_push_senden",
    "ensure_fcm",
    "fan_out_fcm_dm_push",
    "reset_fcm_cache_for_tests",
    "tote_tokens_loeschen",
]
