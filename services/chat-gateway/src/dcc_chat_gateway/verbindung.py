"""Verbindung dieses Servers mit einem Pulse-Konto (Spec 2026-10-09, E2/E4/E6).

Gemeinsame Namen für die Stellen, die sonst je eine eigene Fassung hätten: die
Nachweis-Route (``routes/verbinden_nachweis.py``), die Server-Info
(``routes/server_info.py``), ``POST /session``, den Start (``app.py``) und das
Werkzeug ``pulse-connect`` (``verbinden_cli.py``). Die Dateien liegen in
``settings.pulse_verbinden_dir`` (Container: ``/data/pulse``, gesetzt von
07-render-env.sh).
"""

from __future__ import annotations

import re
from pathlib import Path

#: Eine Zeile, 64 Hex-Zeichen: der SHA-256 der Abholkennung. Liegt nur, solange
#: ``pulse-connect`` auf die Bestätigung wartet.
NACHWEIS_DATEI = "verbinden-nachweis"
#: Die abgeholten Zugangsdaten (0600). Gelesen von 07-render-env.sh, nicht von
#: den Diensten selbst — die sehen nur ``/etc/pulse/env.sh``.
VERBINDUNG_DATEI = "verbindung.env"

_NACHWEIS_FORM = re.compile(r"[0-9a-f]{64}")


def ist_verbunden(settings) -> bool:
    """Ein Self-Host ohne Instanz-Nummer ist noch mit keinem Konto verbunden.

    Die Cloud gilt immer als verbunden — sie ist die Gegenstelle.
    """
    return settings.pulse_instance_mode != "self-host" or bool(settings.pulse_instance_id)


def nachweis_lesen(verzeichnis: Path) -> str | None:
    """Der abgelegte Nachweis, oder ``None``, wenn keiner in gültiger Form da ist.

    Eine Datei mit anderem Inhalt liefert ``None`` statt ihres Inhalts: die
    Route ist anonym und soll nichts ausliefern, was nicht genau die erwartete
    Form hat.
    """
    try:
        wert = (verzeichnis / NACHWEIS_DATEI).read_text(encoding="ascii").strip()
    except (OSError, UnicodeDecodeError):
        return None
    return wert if _NACHWEIS_FORM.fullmatch(wert) else None
