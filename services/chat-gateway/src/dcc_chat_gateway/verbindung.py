"""Verbindung dieses Servers mit einem Pulse-Konto (Spec 2026-10-09, E2/E4/E6).

Gemeinsame Namen für die Stellen, die sonst je eine eigene Fassung hätten: die
Nachweis-Route (``routes/verbinden_nachweis.py``), die Server-Info
(``routes/server_info.py``), ``POST /session``, den Start (``app.py``) und das
Werkzeug ``pulse-connect`` (``verbinden_cli.py``). Die Dateien liegen in
``settings.pulse_verbinden_dir`` (Container: ``/data/pulse``, gesetzt von
07-render-env.sh).
"""

from __future__ import annotations

import logging
import re
from pathlib import Path

from dcc_chat_gateway.owner_admin_log import log_owner_konfiguration

log = logging.getLogger(__name__)

#: Eine Zeile, 64 Hex-Zeichen: der SHA-256 der Abholkennung. Liegt nur, solange
#: ``pulse-connect`` auf die Bestätigung wartet.
NACHWEIS_DATEI = "verbinden-nachweis"
#: Die abgeholten Zugangsdaten (0600). Gelesen von 07-render-env.sh, nicht von
#: den Diensten selbst — die sehen nur ``/etc/pulse/env.sh``.
VERBINDUNG_DATEI = "verbindung.env"

#: Englisch, weil die Zeile im Log fremder Betreiber steht (Regel aus
#: ``owner_admin_log.py``). Der Befehl ist derselbe, den Installer und
#: Compose-Datei nennen.
NICHT_VERBUNDEN_HINWEIS = (
    "This server is not connected to a Pulse account yet. "
    "Run: docker exec -it pulse pulse-connect"
)

_NACHWEIS_FORM = re.compile(r"[0-9a-f]{64}")
#: Der Nachweis ist 64 Zeichen und ein Zeilenende (65 Byte); die Luft darüber
#: deckt ``\r\n`` und etwas Leerraum. Länger ist keiner — und die anonyme Route
#: liest nie mehr als dies, egal was in der Datei steht.
_NACHWEIS_MAX_BYTE = 130


def ist_verbunden(settings) -> bool:
    """Ein Self-Host ohne Instanz-Nummer ist noch mit keinem Konto verbunden.

    Die Cloud gilt immer als verbunden — sie ist die Gegenstelle.
    """
    return settings.pulse_instance_mode != "self-host" or bool(settings.pulse_instance_id)


def nachweis_lesen(verzeichnis: Path) -> str | None:
    """Der abgelegte Nachweis, oder ``None``, wenn keiner in gültiger Form da ist.

    Eine Datei mit anderem Inhalt liefert ``None`` statt ihres Inhalts: die
    Route ist anonym und soll nichts ausliefern, was nicht genau die erwartete
    Form hat. Gelesen werden höchstens ``_NACHWEIS_MAX_BYTE`` Byte; eine längere
    Datei ist keine Nachweis-Datei.
    """
    try:
        with open(verzeichnis / NACHWEIS_DATEI, "rb") as datei:
            roh = datei.read(_NACHWEIS_MAX_BYTE + 1)  # ein Byte mehr: „zu lang“ erkennen
        wert = roh.decode("ascii").strip()
    except (OSError, UnicodeDecodeError):
        return None
    if len(roh) > _NACHWEIS_MAX_BYTE:
        return None
    return wert if _NACHWEIS_FORM.fullmatch(wert) else None


def melde_verbindungsstand(settings) -> None:
    """Einmal je Start sagen, wem der Server gehört — oder dass noch niemandem.

    Ein unverbundener Server bekäme von ``log_owner_konfiguration`` die Warnung,
    ``PULSE_INSTANCE_OWNER_ID`` fehle. Das stimmt, nennt aber die falsche
    Abhilfe: eine Zeile in der ``.env`` statt ``pulse-connect``.
    """
    if ist_verbunden(settings):
        log_owner_konfiguration(settings)
    else:
        log.warning(NICHT_VERBUNDEN_HINWEIS)
