"""Die Mitteilungstexte eines Pushes ans Handy als Schlüssel.

Ein Gerät, das es zusagt, bekommt statt des fertigen deutschen Textes
Schlüssel und Argumente, und die App übersetzt in der Sprache des Telefons,
nicht des Absenders oder Servers. Wer es zusagt (``fcm_empfaenger``): ein
iOS-Gerät mit der Fähigkeit ``dm_vordergrund``, ein Android-Gerät mit
``texte_lokal``. Alle anderen bekommen den fertigen deutschen Text wie bisher.

* **iOS:** ``loc-key``/``loc-args`` im ``aps.alert`` (APNs). Die Texte stehen
  in ``mobile/ios/App/App/Localizable.xcstrings`` und müssen dort WORTGLEICH
  unter diesen Schlüsseln liegen — fehlt einer, zeigt iOS den Schlüssel selbst.
* **Android:** ``title_loc_key``/``body_loc_key`` + ``*_loc_args`` im Block
  ``AndroidNotification``. Das sind Namen von String-Ressourcen der App
  (``strings.xml``, Platzhalter ``%1$s``); :data:`ANDROID_RESSOURCEN` ordnet
  jedem iOS-Schlüssel seinen Namen zu. Ein Bau, der ``texte_lokal`` meldet,
  muss jede dieser Ressourcen tragen — gegen eine fehlende hilft kein
  Rückfall, die Zusage ist der einzige Riegel.

**Der iOS-Schlüssel IST der deutsche Text** (Eigentümer-Entscheid, Rückfall):
ein iOS-Bau ohne die Übersetzungen (älter als diese Änderung) zeigt dann
dasselbe wie bisher. Bei den Formaten mit ``%@`` hängt der Rückfall daran,
dass iOS die Argumente auch in einen NICHT gefundenen Schlüssel einsetzt —
das ist aus der Dokumentation gefolgert, nicht am Gerät gemessen.

**Bei einem ``loc-key`` entfällt ``body``** (APNs wertet es dann nicht aus);
deshalb baut :func:`aps_alert` entweder Text oder Schlüssel, nie beides, und
der FCM-Block ``notification`` bleibt bei diesen Nachrichten weg (FCM würde
ihn sonst in denselben ``alert`` einmischen). Ein Android-Gerät liest Titel
und Text dann allein aus ``AndroidNotification`` (:func:`android_notification`).

Ein Bündel hat immer mindestens zwei Nachrichten (``buendel_mitteilung``):
eine Mehrzahl-Variante je Sprache ist deshalb nicht nötig — Deutsch und
Englisch brauchen ab 2 dieselbe Form.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from firebase_admin import messaging

#: Schlüssel = deutscher Text (s. Modulkopf). ``fcm.DM_BODY`` und
#: ``fcm.DM_BODY_ANHANG`` müssen denselben Wortlaut tragen — ein Test hält
#: sie zusammen.
SCHLUESSEL_NEU = "Neue Nachricht"
SCHLUESSEL_ANHANG = "Hat dir einen Anhang geschickt"
SCHLUESSEL_ANZAHL = "%@ neue Nachrichten"
SCHLUESSEL_ZWEI = "%1$@ und %2$@"
SCHLUESSEL_DREI = "%1$@, %2$@ und %3$@"
SCHLUESSEL_WEITERE = "%1$@, %2$@ und %3$@ weitere"
#: Freundschaftsanfrage (``fcm_hinweise``). Ohne Argument.
SCHLUESSEL_FREUNDSCHAFT = "Möchte mit dir befreundet sein"

#: iOS-Schlüssel → Name der Android-String-Ressource (s. Modulkopf). Die
#: Argumente sind dieselben, in derselben Reihenfolge.
ANDROID_RESSOURCEN: dict[str, str] = {
    SCHLUESSEL_NEU: "push_neue_nachricht",
    SCHLUESSEL_ANHANG: "push_anhang",
    SCHLUESSEL_ANZAHL: "push_anzahl",
    SCHLUESSEL_ZWEI: "push_zwei",
    SCHLUESSEL_DREI: "push_drei",
    SCHLUESSEL_WEITERE: "push_weitere",
    SCHLUESSEL_FREUNDSCHAFT: "push_freundschaft",
}


@dataclass(frozen=True)
class Lokal:
    """Titel und Text einer Mitteilung als Schlüssel. ``titel`` ist der feste
    Titel (ein Absender: ein Name, nichts zu übersetzen); sonst steht der Titel
    in ``titel_schluessel``/``titel_args``."""

    schluessel: str
    args: tuple[str, ...] = ()
    titel: str | None = None
    titel_schluessel: str | None = None
    titel_args: tuple[str, ...] = ()


def lokal_aus(autoren: list[str], anzahl: int, hat_anhang: bool) -> Lokal:
    """Dieselbe Mitteilung wie ``fcm_abarbeiten.buendel_mitteilung``, als
    Schlüssel. Die beiden müssen dasselbe sagen — ``autoren`` sind die
    eindeutigen Absender in Reihenfolge, ``anzahl`` die Zahl der Nachrichten."""
    if anzahl <= 1:
        return Lokal(
            schluessel=SCHLUESSEL_ANHANG if hat_anhang else SCHLUESSEL_NEU,
            titel=autoren[0] if autoren else "Pulse",
        )
    schluessel, args = SCHLUESSEL_ANZAHL, (str(anzahl),)
    if len(autoren) == 1:
        return Lokal(schluessel=schluessel, args=args, titel=autoren[0])
    if len(autoren) == 2:
        return Lokal(schluessel, args, None, SCHLUESSEL_ZWEI, tuple(autoren))
    if len(autoren) == 3:
        return Lokal(schluessel, args, None, SCHLUESSEL_DREI, tuple(autoren))
    return Lokal(
        schluessel,
        args,
        None,
        SCHLUESSEL_WEITERE,
        (autoren[0], autoren[1], str(len(autoren) - 2)),
    )


def android_ressource(schluessel: str | None) -> str | None:
    """Der Android-Ressourcenname zu einem iOS-Schlüssel; ``None`` bleibt
    ``None``. Ein Schlüssel ohne Eintrag ist ein Programmierfehler (ein Test
    hält :data:`ANDROID_RESSOURCEN` vollständig) und wirft ``KeyError``."""
    return None if schluessel is None else ANDROID_RESSOURCEN[schluessel]


def android_notification(
    *, channel_id: str, tag: str | None, lokal: Lokal | None
) -> messaging.AndroidNotification:
    """Der Block ``AndroidNotification``: Benachrichtigungskanal, ``tag`` und —
    nur mit ``lokal`` — die Ressourcennamen samt Argumenten. Ohne ``lokal``
    trägt der FCM-Block ``notification`` den fertigen Text.

    ``tag``: eine neue Meldung mit demselben Tag ERSETZT die alte in der
    Leiste (Android, ``NotificationManager.notify(tag, …)``), und die App kann
    sie über den Tag gezielt entfernen."""
    from firebase_admin import messaging

    if lokal is None:
        return messaging.AndroidNotification(channel_id=channel_id, tag=tag)
    return messaging.AndroidNotification(
        channel_id=channel_id,
        tag=tag,
        title=lokal.titel,
        title_loc_key=android_ressource(lokal.titel_schluessel),
        title_loc_args=list(lokal.titel_args) or None,
        body_loc_key=android_ressource(lokal.schluessel),
        body_loc_args=list(lokal.args) or None,
    )


def aps_alert(payload: dict, lokal: Lokal | None) -> messaging.ApsAlert:
    """Der ``aps.alert``-Block: fertiger Text (Rückfall, Geräte ohne Zusage)
    oder Schlüssel (``lokal``)."""
    from firebase_admin import messaging

    if lokal is None:
        return messaging.ApsAlert(title=payload["title"], body=payload["body"])
    return messaging.ApsAlert(
        title=lokal.titel,
        title_loc_key=lokal.titel_schluessel,
        title_loc_args=list(lokal.titel_args) or None,
        loc_key=lokal.schluessel,
        loc_args=list(lokal.args) or None,
    )


__all__ = [
    "ANDROID_RESSOURCEN",
    "Lokal",
    "SCHLUESSEL_ANHANG",
    "SCHLUESSEL_ANZAHL",
    "SCHLUESSEL_FREUNDSCHAFT",
    "SCHLUESSEL_NEU",
    "android_notification",
    "android_ressource",
    "aps_alert",
    "lokal_aus",
]
