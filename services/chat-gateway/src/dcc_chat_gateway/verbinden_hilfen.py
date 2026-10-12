"""Kleine Helfer von ``pulse-connect`` (``verbinden_cli.py``): Dateien und Sperre,
Hash, Anzeige, die Prüfung des eigenen Servers und das Lesen von Cloud-Antworten.

Ausgelagert, damit die Ablauflogik unter der Größengrenze bleibt. Die Namen der
Dateien stehen in ``verbindung.py``.
"""

from __future__ import annotations

import contextlib
import hashlib
import os
import re
import secrets
from collections.abc import Iterator
from pathlib import Path

import httpx

try:
    import fcntl
except ImportError:  # Windows: pulse-connect läuft nur im Linux-Container
    fcntl = None

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
    """Die Schlüssel aus ``verbindung.env``; leer, wenn es keine gibt, Abbruch, wenn
    sie kein gültiger Text ist."""
    datei = verzeichnis / VERBINDUNG_DATEI
    try:
        zeilen = datei.read_text(encoding="utf-8").splitlines()
    except OSError:
        return {}
    except UnicodeDecodeError:
        raise Abbruch(1, texte.VERBINDUNG_UNLESBAR.format(pfad=datei)) from None
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


@contextlib.contextmanager
def sperre(pfad: Path) -> Iterator[None]:
    """Höchstens ein Lauf von ``pulse-connect`` zugleich; ein zweiter bricht ab.

    ``flock`` statt einer ``O_EXCL``-Datei: der Kernel gibt die Sperre frei, sobald
    der Prozess endet — auch bei SIGKILL oder geschlossenem Terminal, wo kein
    ``finally`` mehr läuft. Eine Datei, die dann stehen bliebe, sperrte jeden
    weiteren Aufruf aus, bis der Container neu startet. Die (leere) Datei bleibt
    liegen: sie zu löschen, während ein Wartender sie schon geöffnet hat, ließe
    zwei Läufe gleichzeitig sperren. Das Dateisystem kann ``flock`` auch nicht
    können; dann läuft ``pulse-connect`` ohne Sperre, statt gar nicht."""
    try:
        pfad.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(pfad, os.O_WRONLY | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
    except OSError as fehler:
        raise Abbruch(
            1, texte.DATEN_NICHT_BESCHREIBBAR.format(pfad=pfad, grund=grund(fehler))
        ) from None
    try:
        if fcntl is not None:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise Abbruch(1, texte.LAEUFT_SCHON) from None
            except OSError:
                pass  # Dateisystem ohne flock
        yield
    finally:
        os.close(fd)


def detail(antwort: httpx.Response) -> object:
    """Das ``detail`` einer Fehlerantwort der Cloud; ``None``, wenn es keins gibt."""
    try:
        return antwort.json().get("detail")
    except (ValueError, AttributeError):
        return None


def abholen_entschieden(host: str, antwort: httpx.Response) -> None:
    """403 und 409 von ``abholen``. Ein 403 ohne Namen heißt „im Browser abgelehnt“;
    ein 409 ohne Namen kennt der Vertrag nicht und zählt als „wartet“."""
    info = detail(antwort)
    name = info.get("code") if isinstance(info, dict) else None
    if antwort.status_code == 409 and name == "uebernahme_beantragt":
        frist = texte.utc_minute(info.get("frist_bis"))
        raise Abbruch(4, texte.UEBERNAHME_BEANTRAGT.format(host=host, frist=frist))
    if antwort.status_code == 403 and name == "uebernahme_gesperrt":
        raise Abbruch(2, texte.UEBERNAHME_GESPERRT.format(bis=texte.utc_minute(info.get("bis"))))
    if antwort.status_code == 403:
        raise Abbruch(2, texte.ABGELEHNT)


def lokal_pruefen(url: str, lokal: httpx.Client, nachweis: str) -> None:
    """Liefert Pulse selbst den Nachweis aus? Sonst scheitert der Start der Cloud
    mit ``kein_nachweis`` und kostet einen ihrer 10 Starts je Stunde."""
    try:
        antwort = lokal.get(url)
        gemeldet = antwort.json().get("nachweis") if antwort.status_code == 200 else None
    except (httpx.HTTPError, ValueError, AttributeError):
        gemeldet = None
    if gemeldet != nachweis:
        raise Abbruch(3, texte.LOKAL_OHNE_NACHWEIS)


def ablegen(ziel: Path, inhalt: str, modus: int, vorlage: str) -> None:
    """Schreiben; ein ``OSError`` (Platte voll, keine Rechte) wird zur Meldung."""
    try:
        ziel.parent.mkdir(parents=True, exist_ok=True)
        schreibe_atomar(ziel, inhalt, modus)
    except OSError as fehler:
        raise Abbruch(1, vorlage.format(pfad=ziel, grund=grund(fehler))) from None
