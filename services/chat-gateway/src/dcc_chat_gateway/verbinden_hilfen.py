"""Kleine Helfer von ``pulse-connect`` (``verbinden_cli.py``): Dateien, Hash, Anzeige.

Ausgelagert, damit die Ablauflogik unter der Größengrenze bleibt. Die Namen der
Dateien stehen in ``verbindung.py``.
"""

from __future__ import annotations

import contextlib
import hashlib
import os
import re
import secrets
from pathlib import Path

import httpx

from dcc_chat_gateway import verbinden_texte as texte
from dcc_chat_gateway.verbindung import VERBINDUNG_DATEI

#: Erlaubte Zeichen in ``verbindung.env``. 07-render-env.sh weist alles andere
#: ab (``*[!A-Za-z0-9._@+-]*``) — beide Stellen synchron halten.
_WERT = re.compile(r"[A-Za-z0-9._@+-]+")
_ZAHL = re.compile(r"[0-9]+")
#: Der eigene chat-gateway antwortet in Millisekunden oder gar nicht.
LOKAL_FRIST_S = 3.0


class Abbruch(Exception):
    """Beendet den Ablauf mit Exit-Code und einer Meldung für den Betreiber."""

    def __init__(self, exit_code: int, meldung: str) -> None:
        super().__init__(meldung)
        self.exit_code = exit_code
        self.meldung = meldung


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
    nie eine halbe ``verbindung.env``, die 07-render-env.sh dann läse.

    Der Name der Nachbardatei ist zufällig, und sie wird mit ``O_EXCL`` und
    ``O_NOFOLLOW`` neu angelegt: das Verzeichnis gehört dem Dienstkonto, und
    ``pulse-connect`` läuft als root. Ein dort vorbereiteter Symlink (die
    Prozessnummer als Name errät jeder im Container) dürfte sonst root dazu
    bringen, eine fremde Datei zu überschreiben. Unter Windows gibt es
    ``O_NOFOLLOW`` nicht; ``pulse-connect`` läuft nur im Linux-Container."""
    zwischen = ziel.with_name(f".{ziel.name}.{secrets.token_hex(8)}.tmp")
    flaggen = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(zwischen, flaggen, modus)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as datei:
            os.fchmod(datei.fileno(), modus)  # die umask darf den Modus nicht verändern
            datei.write(inhalt)
            datei.flush()
            os.fsync(datei.fileno())
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


def zugang_aus(antwort: httpx.Response) -> dict:
    """Der Körper eines 200 von ``abholen``: ein Objekt, sonst Abbruch."""
    try:
        daten = antwort.json()
    except ValueError:
        daten = None
    if not isinstance(daten, dict):
        raise Abbruch(1, texte.ZUGANG_UNBRAUCHBAR)
    return daten


def verbindung_env(zugang: dict) -> str:
    """Inhalt von ``verbindung.env`` — oder Abbruch, ohne die Werte zu nennen."""
    pflicht = (
        ("PULSE_INSTANCE_ID", zugang.get("instance_id"), _ZAHL),
        ("PULSE_INSTANCE_OWNER_ID", zugang.get("owner_user_id"), _ZAHL),
        ("PULSE_CLOUD_CLIENT_ID", zugang.get("client_id"), _WERT),
        ("PULSE_CLOUD_CLIENT_SECRET", zugang.get("client_secret"), _WERT),
    )
    zeilen = []
    for name, wert, form in pflicht:
        if not isinstance(wert, str) or not form.fullmatch(wert):
            raise Abbruch(1, texte.ZUGANG_UNBRAUCHBAR)
        zeilen.append(f"{name}={wert}")
    mail = zugang.get("admin_email")
    if isinstance(mail, str) and "@" in mail and _WERT.fullmatch(mail):
        zeilen.append(f"PULSE_ADMIN_EMAIL={mail}")
    return "\n".join(zeilen) + "\n"


def lokaler_client(*, transport: httpx.BaseTransport | None = None) -> httpx.Client:
    """Für die Anfrage an den eigenen chat-gateway. ``trust_env=False``: httpx
    schickt auch 127.0.0.1 über einen ``HTTP_PROXY`` der Umgebung, und ein Proxy
    dazwischen machte aus einem laufenden Server ein falsches „liefert nichts aus“.
    ``transport`` ist die Naht für Tests."""
    return httpx.Client(
        timeout=LOKAL_FRIST_S, trust_env=False, follow_redirects=False, transport=transport
    )
