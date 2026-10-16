"""Die Bindung einer Fernsteuer-Sitzung an ein Standplatz-Gerät.

Ausgelagert aus :mod:`routes.ws_remote_handlers` (Grössen-Policy §12.1) und
inhaltlich ein eigener Gedanke: der Handshake dort beschreibt die Zustimmung,
hier steht, **wem** eine Anfrage überhaupt gelten darf.

## Der Fehlerfall, der diese Datei erzwungen hat (Bughunt 2026-08-16)

Ein Gerät mit Dauerfreigabe stimmt selbsttätig zu — es fragt niemanden, es
prüft nur, ob die Anfrage IHM gilt (``$lib/remote/geraeteanbindung.ts``). Eine
Anfrage **ohne** ``device_id`` galt ihm damit ebenfalls, und der Kanal, an dem
der Gateway die Rechte prüfte, war der, den der RUFER hineinschrieb. Wer also
irgendwo eine eigene Community hat, in der das Opfer Mitglied ist, gab sich
dort ``REMOTE_CONTROL``, nannte diesen Kanal und übernahm einen Rechner, der in
einer ganz anderen Community steht — vorbei an jedem Overwrite des echten
Standplatzes.

Der Standplatz ist der Rechteanker des Geräts (``models/devices.py``). Also:

* Eine Anfrage, die ein Gerät **nennt**, muss im Standplatz dieses Geräts
  gestellt sein — sonst 4051.
* Eine Anfrage, die **keines** nennt, erreicht keinen Geräte-Socket. Sie gilt
  einem Menschen, und ein Mensch, der gerade an einem eingetragenen Gerät
  sitzt, wird über dessen Standplatz angefragt oder gar nicht.
* Und wer zustimmt, wird beim Wort genommen: ein Geräte-Socket darf nur eine
  Sitzung annehmen, die auf seinen eigenen Standplatz zeigt. Das schliesst das
  Rennen „Gerät meldet sich an, NACHDEM die Einladung hinausging".

Die Prüfung ist **hier** verbindlich. Der Client prüft dieselbe Sache noch
einmal, aber ein Client ist der Teil des Systems, der dem Angreifer gehört.

## Seit 2026-10-16: die Freigabeliste ist die Tür, nicht das Kanalrecht

Eine Anfrage, die ein Gerät nennt, verlangt Sicht auf den Standplatz UND eine
deckende Freigabe (:func:`geraet_anfrage_fehler`, Regel in
``geraete_freigabe.py``). ``REMOTE_CONTROL`` spielt dafür keine Rolle mehr;
eine Anfrage ohne Freigabe kommt gar nicht erst beim Gerät an (4062), es gibt
also keinen Dialog an einem Rechner, vor dem niemand sitzt.
"""

from __future__ import annotations

from typing import Any

from dcc_chat_gateway.geraete_freigabe import NICHT_FREIGEGEBEN, OK, steuer_pruefung
from dcc_chat_gateway.models import Device

#: Fehlercode, wenn der Rufer das Gerät sieht, aber keine Freigabe ihn deckt
#: (Eigentümer-Entscheid 2026-10-16). Eigener Code statt 4051, weil die Lage
#: für den Nutzer eine andere ist: nicht „kein Zugriff auf den Kanal", sondern
#: „der Besitzer hat dich nicht freigegeben". Wer den Kanal nicht sieht, bekommt
#: weiterhin 4051 — sonst verriete die Antwort ein Gerät in einem versteckten
#: Kanal. Gleicher Code beim Weckruf (``ws_device_handlers.handle_wake``).
#: Gegenstück im Client: ``WS_FEHLER.GERAET_NICHT_FREIGEGEBEN`` in
#: ``web/src/lib/api/constants.ts``.
NICHT_FREIGEGEBEN_CODE = 4062


async def geraet_anfrage_fehler(
    session, user, device_id: int, channel_id: int
) -> tuple[int, str] | None:
    """Darf ``user`` dieses Gerät in diesem Kanal anfragen? ``None`` = ja,
    sonst ``(code, text)`` für den Fehlerrahmen.

    Reihenfolge = Verrat-Schutz: erst der Standplatz (falscher Kanal oder
    unbekannte Kennung → 4051, wie „kein Zugriff" — bis 2026-10-16 die eigene
    Funktion ``standplatz_stimmt``), dann die Sicht (4051), erst danach die
    Freigabe (4062). Ein Unberechtigter kann so aus der Antwort nicht ablesen,
    welche Gerätekennungen es gibt.
    """
    device = await session.get(Device, device_id)
    if device is None or device.channel_id != channel_id:
        return 4051, "no access"
    pruefung = await steuer_pruefung(session, user, device)
    if pruefung == OK:
        return None
    if pruefung == NICHT_FREIGEGEBEN:
        return NICHT_FREIGEGEBEN_CODE, "device not granted"
    return 4051, "no access"


def einladungsziele(mgr, host_user_id: int, device_id: int | None) -> list[Any]:
    """Welche Verbindungen des Hosts die Einladung sehen dürfen.

    Mit Gerät: nur dessen angemeldete Verbindungen. Ohne Gerät: nur die, die
    **keines** angemeldet haben (Begründung im Modulkopf). Leere Liste heisst
    für den Aufrufer „Host nicht erreichbar" — die ehrliche Antwort, denn der
    Gemeinte ist es dann tatsächlich nicht.

    Holt die Socket-Liste selbst, statt sie sich reichen zu lassen: der
    Aufrufer fragt zweimal (einmal vor, einmal nach den DB-Abfragen), und
    beide Male muss sie frisch sein.
    """
    host_sockets = mgr.remote_user_sockets(host_user_id)
    if device_id is None:
        return [hs for hs in host_sockets if not mgr.device_ids_for_socket(hs)]
    return [hs for hs in host_sockets if device_id in mgr.device_ids_for_socket(hs)]


def darf_zustimmen(mgr, sess, websocket: Any) -> bool:
    """Darf diese Verbindung dieser Sitzung zustimmen?

    Für alles, was kein angemeldetes Gerät ist: ja — die Zustimmung eines
    Menschen ist genau das, was der Handshake einholt. Für ein Gerät nur dann,
    wenn die Sitzung ihm gilt und auf seinen Standplatz zeigt.
    """
    geraete = mgr.device_ids_for_socket(websocket)
    if not geraete:
        return True
    if sess.device_id is None:
        return False
    gemeint = int(sess.device_id)
    return gemeint in geraete and sess.channel_id == str(mgr.device_channel(gemeint))
