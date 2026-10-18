"""Die Mitteilungstexte eines DM-Pushes als Schlüssel (nur iOS-Geräte).

Android bekommt den fertigen deutschen Text (``notification`` im FCM-Block,
Android-Kanal), unverändert. Ein iOS-Gerät bekommt stattdessen
``loc-key``/``loc-args`` (APNs, ``aps.alert``): die App übersetzt in der
Sprache des Telefons, nicht des Absenders oder Servers. Die Texte stehen in
``mobile/ios/App/App/Localizable.xcstrings`` und müssen dort WORTGLEICH
unter diesen Schlüsseln liegen — fehlt einer, zeigt iOS den Schlüssel selbst.

**Der Schlüssel IST der deutsche Text** (Eigentümer-Entscheid, Rückfall):
ein Bau ohne die Übersetzungen (älter als diese Änderung) zeigt dann
dasselbe wie bisher. Bei den Formaten mit ``%@`` hängt der Rückfall daran,
dass iOS die Argumente auch in einen NICHT gefundenen Schlüssel einsetzt —
das ist aus der Dokumentation gefolgert, nicht am Gerät gemessen.

**Bei einem ``loc-key`` entfällt ``body``** (APNs wertet es dann nicht aus);
deshalb baut :func:`aps_alert` entweder Text oder Schlüssel, nie beides, und
der FCM-Block ``notification`` bleibt bei diesen Nachrichten weg (FCM würde
ihn sonst in denselben ``alert`` einmischen).

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
    "Lokal",
    "SCHLUESSEL_ANHANG",
    "SCHLUESSEL_ANZAHL",
    "SCHLUESSEL_NEU",
    "aps_alert",
    "lokal_aus",
]
