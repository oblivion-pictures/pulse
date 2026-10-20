"""Bau und Versand einer FCM-Nachricht — ohne die Frage, wer sie bekommt.

Aus :mod:`dcc_chat_gateway.fcm` gelöst, weil dort neben den DMs jetzt auch
Erwähnungen, Freundschaftsanfragen (``fcm_hinweise``) und Anrufe an
Android-Geräte (``anruf_push_fcm``) dieselben Bausteine brauchen und
``fcm.py`` sonst über die Größen-Policy gewachsen wäre.

``firebase_admin`` wird erst beim Bau importiert (s. Kopf von ``fcm.py``).
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from dcc_chat_gateway.fcm_texte import Lokal, android_notification, aps_alert

if TYPE_CHECKING:
    from firebase_admin import messaging

log = logging.getLogger("dcc_chat_gateway.fcm")

#: Android-Benachrichtigungskanal für Push-Meldungen. Der Klient legt ihn
#: beim App-Start an (``FirebaseMessaging.createChannel``); FCM ordnet die
#: Meldung über ``AndroidNotification.channel_id`` dort ein.
ANDROID_CHANNEL_ID = "messages"

#: Mitteilungs-Kategorie für DMs. Sie verbindet die Meldung mit den Aktionen,
#: die die App registriert hat (`AppDelegate.swift` — „Antworten" mit
#: Eingabefeld). Der Bezeichner muss dort WORTGLEICH stehen; passt er nicht,
#: zeigt iOS die Meldung ohne Aktionen an — ohne jeden Fehler.
DM_KATEGORIE = "dm"

#: Eigener iOS-Ton im App-Bündel.
PUSH_TON = "pulse-push.caf"


def mitteilung(
    *,
    token: str,
    payload: dict,
    badge: int | None = None,
    lokal: Lokal | None = None,
    kategorie: str,
    gruppe: str,
    tag: str,
    zeitkritisch: bool,
) -> messaging.Message:
    """Eine sichtbare Mitteilung für beide Plattformen (iOS-Alert, Android-Kanal,
    Deep-Link-Daten).

    ``payload`` trägt ``title``/``body`` (fertiger Text) und die Daten für den
    Tipp. ``lokal`` ersetzt den fertigen Text durch Schlüssel
    (:mod:`dcc_chat_gateway.fcm_texte`); dann entfällt der FCM-Block
    ``notification`` — er würde sich in denselben ``aps.alert`` mischen, und
    bei einem ``loc-key`` gilt ``body`` nicht. ``badge``: ``None`` heisst
    *schweigen* (das Feld entfällt, die Zahl am Gerät bleibt stehen).
    ``gruppe`` ist die iOS-``thread-id`` (Stapel in der Mitteilungszentrale),
    ``tag`` der Android-Tag (eine neue Meldung mit demselben Tag ersetzt die
    alte).
    """
    from firebase_admin import messaging

    # Der FCM-``data``-Block ist String→String. ``payload`` trägt heute nur
    # Strings; der Filter ist der Riegel dagegen, dass ein künftiges Feld
    # anderen Typs hineingerät. Einmal gebaut, zweimal verwendet (top-level
    # und im Android-Block) — die beiden müssen denselben Inhalt tragen.
    daten = {k: v for k, v in payload.items() if isinstance(v, str)}
    return messaging.Message(
        notification=(
            None
            if lokal
            else messaging.Notification(title=payload["title"], body=payload["body"])
        ),
        token=token,
        # Deep-Link-Daten TOP-LEVEL, nicht nur im Android-Block: nur so
        # erreichen sie auch die iOS-Hülle, deren Tap-Handler
        # `notification.data.channel_id` liest (Befund Review 2026-10-08 —
        # vorher öffnete ein Push-Tap am iPhone nur die App, nicht den Chat).
        data=daten,
        # iOS: eigener Sound (pulse-push.caf im Bundle), bei DMs zeitkritisch
        # — durchbricht Fokus-Modi; das Zeitkritisch-Privileg vergibt der
        # Nutzer einmalig im Systemdialog.
        #
        # **Die Dringlichkeit steht im `aps`-Block, nicht im Kopf.** Bis zum
        # 2026-10-11 stand hier ein Kopf `apns-interruption-level` — einen
        # solchen Kopf kennt APNs nicht (die Kopfzeilen sind `apns-push-type`,
        # `apns-priority`, `apns-expiration`, `apns-topic`, `apns-collapse-id`,
        # `apns-id`); die Ebene ist ein Feld der Nutzlast,
        # `aps.interruption-level` (Apple, „Generating a remote
        # notification"). Der Kopf wurde still übergangen, und keine Meldung
        # war je zeitkritisch (Bughunt T16). Gefolgert aus der Doku, nicht am
        # Gerät gemessen.
        apns=messaging.APNSConfig(
            headers={"apns-push-type": "alert"},
            payload=messaging.APNSPayload(
                aps=messaging.Aps(
                    alert=aps_alert(payload, lokal),
                    sound=PUSH_TON,
                    # Der Encoder lässt None-Felder weg — genau das ist hier
                    # die Absicht, s. Docstring.
                    badge=badge,
                    category=kategorie,
                    # Eine Gruppe je Unterhaltung in der Mitteilungszentrale:
                    # eine Salve stapelt sich, statt den Sperrbildschirm mit
                    # Einzelkarten zu füllen.
                    thread_id=gruppe,
                    custom_data=(
                        {"interruption-level": "time-sensitive"} if zeitkritisch else None
                    ),
                )
            ),
        ),
        # channel_id im data-Block: das ist die Pulse-Kanalkennung für den
        # Deep-Link des Klienten, nicht der Android-Kanal.
        android=messaging.AndroidConfig(
            notification=android_notification(
                channel_id=ANDROID_CHANNEL_ID, tag=tag, lokal=lokal
            ),
            data=daten,
        ),
    )


def dm_mitteilung(
    *, token: str, payload: dict, badge: int | None = None, lokal: Lokal | None = None
) -> messaging.Message:
    """Die Mitteilung einer DM (Kategorie ``dm``, zeitkritisch); Stapel und
    Android-Tag je Unterhaltung (``payload["channel_id"]``)."""
    return mitteilung(
        token=token,
        payload=payload,
        badge=badge,
        lokal=lokal,
        kategorie=DM_KATEGORIE,
        gruppe=payload["channel_id"],
        tag=payload["channel_id"],
        zeitkritisch=True,
    )


def daten_nachricht(*, token: str, daten: dict[str, str], ttl_s: int) -> messaging.Message:
    """Ein reiner Datenpush an ein Android-Gerät (``anruf_push_fcm``): kein
    ``notification``-Block, also zeigt das System nichts an — die App
    entscheidet selbst. Priorität ``high``, damit er ein Gerät im Doze weckt;
    ``ttl_s``: danach verwirft FCM ihn, statt ihn verspätet zuzustellen."""
    from firebase_admin import messaging

    return messaging.Message(
        token=token,
        data=daten,
        android=messaging.AndroidConfig(priority="high", ttl=ttl_s),
    )


def senden(nachricht: messaging.Message) -> str:
    """Ein Sendeversuch, synchron (Aufrufer: ``asyncio.to_thread``). Liefert:

    * ``"ok"``;
    * ``"dead"`` — Firebase meldet den Token als abgemeldet
      (``UnregisteredError``: App deinstalliert, Token rotiert). Der Aufrufer
      löscht die Zeile;
    * ``"ungueltig"`` — Firebase lehnt die Anfrage ab (``InvalidArgumentError``).
      Das kann der Token sein, aber ebenso ein Feld der Nachricht; ein
      Löschen hiesse dann, bei einem Baufehler des Servers JEDEN Token zu
      verlieren. Also kein Löschen und, weil ein neuer Versuch dieselbe
      Anfrage wieder schickte, auch keine Wiederholung — nur eine Warnung;
    * ``"warn"`` — jede andere Störung (Netz, Zeitüberschreitung, 5xx, Quote,
      auch ``SenderIdMismatchError``: der kommt bei einem falsch
      eingerichteten Firebase-Projekt für JEDEN Token — auch hier kein
      Löschen). Ein späterer Versuch kann helfen.

    Niemals Token oder Nutzlast loggen.
    """
    try:
        from firebase_admin import exceptions, messaging
    except ImportError:
        log.error("firebase_admin nicht installiert; FCM-Push deaktiviert")
        return "warn"
    try:
        messaging.send(nachricht)
        return "ok"
    except messaging.UnregisteredError:
        return "dead"
    except exceptions.InvalidArgumentError:
        log.warning("fcm_send_abgelehnt — Firebase meldet ein ungültiges Argument")
        return "ungueltig"
    except Exception as exc:  # noqa: BLE001 — Push ist best-effort
        # Nur der Typ: die Meldung einer Firebase-Ausnahme kann die Antwort
        # des Dienstes enthalten, und was darin steht, sagt niemand zu.
        log.warning("fcm_send_fehlgeschlagen grund=%s", type(exc).__name__)
        return "warn"


__all__ = [
    "ANDROID_CHANNEL_ID",
    "DM_KATEGORIE",
    "PUSH_TON",
    "daten_nachricht",
    "dm_mitteilung",
    "mitteilung",
    "senden",
]
