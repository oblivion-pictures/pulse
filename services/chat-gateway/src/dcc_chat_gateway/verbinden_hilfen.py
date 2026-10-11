"""Kleine Helfer von ``pulse-connect`` (``verbinden_cli.py``): Dateien, Hash, Anzeige.

Ausgelagert, damit die Ablauflogik unter der Größengrenze bleibt. Die Namen der
Dateien stehen in ``verbindung.py``.
"""

from __future__ import annotations

import contextlib
import hashlib
import os
from pathlib import Path

from dcc_chat_gateway.verbindung import VERBINDUNG_DATEI


def nachweis_aus_kennung(kennung: str) -> str:
    """SHA-256 der Abholkennung, hex, klein — dieselbe Rechnung wie
    ``dcc_auth.verbinden.nachweis_aus_kennung`` (Prüfstein im Test)."""
    return hashlib.sha256(kennung.encode("utf-8")).hexdigest()


def anzeigbar(text: str) -> str:
    """Steuerzeichen aus Cloud-Text entfernen, bevor er im Terminal landet."""
    return "".join(zeichen for zeichen in text if zeichen.isprintable())


def grund(fehler: OSError) -> str:
    """Was das Betriebssystem sagt („No space left on device“), ohne Pfade."""
    return anzeigbar(fehler.strerror or type(fehler).__name__)


def lies_verbindung(verzeichnis: Path) -> dict[str, str]:
    """Die Schlüssel aus ``verbindung.env``; leer, wenn es keine gibt."""
    try:
        zeilen = (verzeichnis / VERBINDUNG_DATEI).read_text(encoding="utf-8").splitlines()
    except OSError:
        return {}
    return dict(zeile.split("=", 1) for zeile in zeilen if "=" in zeile)


def schreibe_atomar(ziel: Path, inhalt: str, modus: int) -> None:
    """Erst eine Nachbardatei, dann umbenennen: ein Abbruch mittendrin hinterlässt
    nie eine halbe ``verbindung.env``, die 07-render-env.sh dann läse."""
    zwischen = ziel.with_name(f".{ziel.name}.{os.getpid()}.tmp")
    fd = os.open(zwischen, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, modus)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as datei:
            datei.write(inhalt)
            datei.flush()
            os.fsync(datei.fileno())
        os.chmod(zwischen, modus)  # die umask darf den Modus nicht verändern
        os.replace(zwischen, ziel)
    except BaseException:
        zwischen.unlink(missing_ok=True)
        raise


def entferne_still(datei: Path) -> None:
    """Aufräumen im ``finally``: scheitert es (Platte nur lesbar), darf es den
    eigentlichen Ausgang nicht überdecken. Ein Rest ist harmlos — der nächste
    Containerstart räumt ihn weg (01-init-data-dirs.sh)."""
    with contextlib.suppress(OSError):
        datei.unlink(missing_ok=True)
