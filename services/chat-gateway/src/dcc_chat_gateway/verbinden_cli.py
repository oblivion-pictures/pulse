"""``pulse-connect`` — diesen Server mit einem Pulse-Konto verbinden.

Aufruf im Container: ``docker exec -it pulse pulse-connect [--no-restart] [--yes]``
(Hülle: ``infra/self-host/s6/usr/local/bin/pulse-connect``). Ablauf nach dem
Muster „Device Authorization Grant“ (RFC 8628), Spec
``docs/superpowers/specs/2026-10-09-selfhost-ohne-freigabe-design.md`` E1/E2/E6:

1. Eine geheime Abholkennung erzeugen und ihren SHA-256 als Nachweis nach
   ``<pulse_verbinden_dir>/verbinden-nachweis`` legen; der chat-gateway liefert
   ihn unter ``/.well-known/pulse-verbinden`` aus.
2. Bei der Cloud einen Gerätecode anfragen und dabei die Kennung selbst
   mitschicken; die Cloud bildet den Hash und vergleicht ihn sofort von außen
   mit dem Nachweis — ein nicht erreichbarer Server verbraucht keinen Code
   (Exit 3). Der Nachweis ist öffentlich lesbar: stünde er statt der Kennung
   im Anfragekörper, könnte jeder Mitleser einen Vorgang für diesen Server
   anlegen (Vertrag, Nachtrag 2).
3. Link und Code zeigen und alle ``abstand_s`` Sekunden abholen, bis der
   Betreiber im Browser bestätigt oder ablehnt, höchstens 15 Minuten.
4. Die Zugangsdaten atomar nach ``verbindung.env`` schreiben (0600), den
   Nachweis löschen und den Container neu starten: erst der Neustart rendert
   ``/etc/pulse/env.sh`` neu (07-render-env.sh liest die Datei dort).

**Abholkennung und Secret erscheinen in keiner Ausgabe.** Die Kennung geht
nur an die Cloud (``start``, ``abholen``). Link und Code erscheinen — sie zu
zeigen ist der Zweck. Die Texte stehen in ``verbinden_texte.py``.

**Rechte.** ``docker exec`` läuft als root, und dabei bleibt es: der Neustart
über ``/run/s6/basedir/bin/halt`` braucht root (wie in restart-gate.sh). Der
Dienst liest trotzdem alles: ``/data/pulse`` gehört ``pulse`` (uid 10001,
01-init-data-dirs.sh), der Nachweis ist 0644, und ``verbindung.env`` (0600) liest
allein 07-render-env.sh, das als root läuft. Beim nächsten Start macht
``chown -R pulse:pulse /data`` ohnehin alles zu ``pulse``.

Exit-Codes: 0 verbunden · 1 Fehler · 2 abgelehnt, abgelaufen oder die Adresse
ist gerade gesperrt · 3 der Nachweis ist von außen nicht erreichbar · 4 das
bestätigende Konto besitzt die Adresse nicht, ein Übernahme-Antrag läuft (kein
Neustart: es gibt nichts anzuwenden).
"""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import secrets
import subprocess
import sys
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import httpx

from dcc_chat_gateway import config as chat_config
from dcc_chat_gateway import verbinden_texte as texte
from dcc_chat_gateway.verbindung import NACHWEIS_DATEI, VERBINDUNG_DATEI

#: Beendet den Container sauber; die Regel ``unless-stopped`` holt ihn zurück.
HALT = "/run/s6/basedir/bin/halt"
#: Spec E8: ein Gerätecode gilt 15 Minuten, auch wenn die Cloud mehr nennt.
HOECHSTENS_S = 900
ANFRAGE_FRIST_S = 15.0
#: Erlaubte Zeichen in ``verbindung.env``. 07-render-env.sh weist alles andere
#: ab (``*[!A-Za-z0-9._@+-]*``) — beide Stellen synchron halten.
_WERT = re.compile(r"[A-Za-z0-9._@+-]+")
_ZAHL = re.compile(r"[0-9]+")


class _Abbruch(Exception):
    """Beendet den Ablauf mit Exit-Code und einer Meldung für den Betreiber."""

    def __init__(self, exit_code: int, meldung: str) -> None:
        super().__init__(meldung)
        self.exit_code = exit_code
        self.meldung = meldung


@dataclass(frozen=True)
class Umgebung:
    """Was ``pulse-connect`` über diesen Server wissen muss (aus env.sh)."""

    hostname: str
    cloud_origin: str
    verzeichnis: Path
    instanz_id: int  # ``pulse_instance_id`` aus /etc/pulse/env.sh; 0 = unverbunden
    modus: str


@dataclass(frozen=True)
class _Vorgang:
    code: str
    link: str
    gueltig_s: int
    abstand_s: int


def nachweis_aus_kennung(kennung: str) -> str:
    """SHA-256 der Abholkennung, hex, klein — dieselbe Rechnung wie
    ``dcc_auth.verbinden.nachweis_aus_kennung`` (Prüfstein im Test)."""
    return hashlib.sha256(kennung.encode("utf-8")).hexdigest()


def lies_verbindung(verzeichnis: Path) -> dict[str, str]:
    """Die Schlüssel aus ``verbindung.env``; leer, wenn es keine gibt."""
    try:
        zeilen = (verzeichnis / VERBINDUNG_DATEI).read_text(encoding="utf-8").splitlines()
    except OSError:
        return {}
    return dict(zeile.split("=", 1) for zeile in zeilen if "=" in zeile)


def _schreibe_atomar(ziel: Path, inhalt: str, modus: int) -> None:
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


def _anzeigbar(text: str) -> str:
    """Steuerzeichen aus Cloud-Text entfernen, bevor er im Terminal landet."""
    return "".join(zeichen for zeichen in text if zeichen.isprintable())


def _vorpruefung(umgebung: Umgebung, rueckfrage: Callable[[str], bool]) -> None:
    if umgebung.modus != "self-host":
        raise _Abbruch(1, texte.NUR_SELF_HOST)
    if not umgebung.hostname:
        raise _Abbruch(1, texte.OHNE_ADRESSE)
    datei_id = lies_verbindung(umgebung.verzeichnis).get("PULSE_INSTANCE_ID", "")
    # Eine Instanz-Nummer, die nicht aus der Datei stammt, steht in der Umgebung —
    # und die gewinnt (07-render-env.sh). Eine neue Datei bliebe wirkungslos.
    if umgebung.instanz_id and str(umgebung.instanz_id) != datei_id:
        raise _Abbruch(1, texte.AUS_DER_UMGEBUNG)
    if datei_id and not rueckfrage(texte.SCHON_VERBUNDEN):
        raise _Abbruch(1, texte.NICHTS_GEAENDERT)


def _detail(antwort: httpx.Response) -> object:
    try:
        return antwort.json().get("detail")
    except (ValueError, AttributeError):
        return None


def _starten(umgebung: Umgebung, client: httpx.Client, kennung: str) -> _Vorgang:
    url = f"{umgebung.cloud_origin}/api/auth/selfhost/verbinden/start"
    host = umgebung.hostname
    try:
        antwort = client.post(url, json={"hostname": host, "kennung": kennung})
    except httpx.HTTPError:
        raise _Abbruch(1, texte.CLOUD_WEG.format(origin=umgebung.cloud_origin)) from None
    detail = _detail(antwort)
    if antwort.status_code == 409 and detail == "vorgang_laeuft":
        raise _Abbruch(1, texte.VORGANG_LAEUFT.format(host=host))
    if antwort.status_code == 409:
        befund = detail.get("befund") if isinstance(detail, dict) else None
        text = texte.BEFUNDE.get(befund, texte.BEFUND_UNBEKANNT).format(host=host)
        raise _Abbruch(3, f"{text}\n{texte.NACHWEIS_HILFE}")
    if antwort.status_code == 400:
        gesperrt = detail == "adresse_gesperrt"
        vorlage = texte.ADRESSE_GESPERRT if gesperrt else texte.ADRESSE_UNGUELTIG
        raise _Abbruch(1, vorlage.format(host=host))
    if antwort.status_code == 429:
        raise _Abbruch(1, texte.ZU_VIELE)
    if antwort.status_code == 503 and detail == "verbinden_ausgelastet":
        raise _Abbruch(1, texte.AUSGELASTET)
    if antwort.status_code != 201:
        raise _Abbruch(1, texte.UNERWARTET.format(status=antwort.status_code))
    try:
        daten = antwort.json()
        return _Vorgang(
            code=_anzeigbar(str(daten["code"])),
            link=_anzeigbar(str(daten["link"])),
            gueltig_s=min(int(daten["gueltig_s"]), HOECHSTENS_S),
            abstand_s=max(1, int(daten["abstand_s"])),
        )
    except (ValueError, KeyError, TypeError):
        raise _Abbruch(1, texte.UNERWARTET.format(status=201)) from None


def _entschieden(umgebung: Umgebung, antwort: httpx.Response) -> None:
    """403 und 409 von ``abholen``. Ein 403 ohne Namen heißt „im Browser abgelehnt“;
    ein 409 ohne Namen kennt der Vertrag nicht und zählt als „wartet“."""
    detail = _detail(antwort)
    name = detail.get("code") if isinstance(detail, dict) else None
    if antwort.status_code == 409 and name == "uebernahme_beantragt":
        frist = texte.utc_minute(detail.get("frist_bis"))
        raise _Abbruch(4, texte.UEBERNAHME_BEANTRAGT.format(host=umgebung.hostname, frist=frist))
    if antwort.status_code == 403 and name == "uebernahme_gesperrt":
        raise _Abbruch(2, texte.UEBERNAHME_GESPERRT.format(bis=texte.utc_minute(detail.get("bis"))))
    if antwort.status_code == 403:
        raise _Abbruch(2, texte.ABGELEHNT)


def _abholen(
    umgebung: Umgebung,
    client: httpx.Client,
    kennung: str,
    vorgang: _Vorgang,
    schlafen: Callable[[float], None],
    uhr: Callable[[], float],
) -> dict:
    url = f"{umgebung.cloud_origin}/api/auth/selfhost/verbinden/abholen"
    ende = uhr() + vorgang.gueltig_s
    while uhr() < ende:
        schlafen(vorgang.abstand_s)
        try:
            antwort = client.post(url, json={"kennung": kennung})
        except httpx.HTTPError:
            continue  # Netzaussetzer: weiter warten, die Frist läuft mit
        if antwort.status_code == 200:
            try:
                return antwort.json()
            except ValueError:
                raise _Abbruch(1, texte.UNERWARTET.format(status=200)) from None
        if antwort.status_code in (403, 409):
            _entschieden(umgebung, antwort)
        if antwort.status_code == 410:
            break
        if antwort.status_code == 429:
            schlafen(vorgang.abstand_s)
        # 202 heißt „wartet“, ebenso alles Unbekannte (502 beim Deploy der Cloud).
    raise _Abbruch(2, texte.ABGELAUFEN)


def _verbindung_env(zugang: dict) -> str:
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
            raise _Abbruch(1, texte.UNERWARTET.format(status=200))
        zeilen.append(f"{name}={wert}")
    mail = zugang.get("admin_email")
    if isinstance(mail, str) and "@" in mail and _WERT.fullmatch(mail):
        zeilen.append(f"PULSE_ADMIN_EMAIL={mail}")
    return "\n".join(zeilen) + "\n"


def _drucke(text: str) -> None:
    print(text, flush=True)


def verbinden(
    umgebung: Umgebung,
    client: httpx.Client,
    *,
    neustart: Callable[[], None] | None,
    rueckfrage: Callable[[str], bool],
    schlafen: Callable[[float], None] = time.sleep,
    uhr: Callable[[], float] = time.monotonic,
    ausgabe: Callable[[str], None] = _drucke,
) -> int:
    """Der ganze Ablauf; gibt den Exit-Code zurück. ``neustart=None`` = ``--no-restart``."""
    try:
        _vorpruefung(umgebung, rueckfrage)
        ausgabe(texte.BEGINN.format(host=umgebung.hostname))
        kennung = secrets.token_urlsafe(32)
        nachweis_datei = umgebung.verzeichnis / NACHWEIS_DATEI
        umgebung.verzeichnis.mkdir(parents=True, exist_ok=True)
        try:
            # VOR der Anfrage: die Cloud ruft den Nachweis sofort von außen ab.
            _schreibe_atomar(nachweis_datei, nachweis_aus_kennung(kennung) + "\n", 0o644)
            vorgang = _starten(umgebung, client, kennung)
            minuten = vorgang.gueltig_s // 60
            ausgabe(texte.ANLEITUNG.format(link=vorgang.link, code=vorgang.code, minuten=minuten))
            zugang = _abholen(umgebung, client, kennung, vorgang, schlafen, uhr)
            inhalt = _verbindung_env(zugang)
            _schreibe_atomar(umgebung.verzeichnis / VERBINDUNG_DATEI, inhalt, 0o600)
        finally:
            nachweis_datei.unlink(missing_ok=True)
    except _Abbruch as abbruch:
        ausgabe(abbruch.meldung)
        return abbruch.exit_code
    besitzer = _anzeigbar(str(zugang.get("owner_name") or "your account"))
    ausgabe(texte.VERBUNDEN.format(besitzer=besitzer))
    if neustart is not None:
        ausgabe(texte.NEUSTART)
        neustart()
    return 0


def container_neustarten() -> None:
    """Container über s6 beenden; Docker startet ihn neu (``unless-stopped``)."""
    try:
        erfolgreich = subprocess.run([HALT], check=False).returncode == 0
    except OSError:
        erfolgreich = False
    if not erfolgreich:
        print(texte.NEUSTART_VON_HAND, flush=True)


def frage_im_terminal(frage: str) -> bool:
    try:
        return input(frage).strip().lower() in ("y", "yes")
    except EOFError:  # kein Terminal (docker exec ohne -it): lieber nichts ändern
        return False


def _immer_ja(_frage: str) -> bool:
    return True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="pulse-connect", description=texte.HILFE)
    parser.add_argument("--no-restart", action="store_true", help=texte.HILFE_OHNE_NEUSTART)
    parser.add_argument("--yes", action="store_true", help=texte.HILFE_JA)
    optionen = parser.parse_args(argv)
    settings = chat_config.get_settings()
    umgebung = Umgebung(
        hostname=os.environ.get("PULSE_HOSTNAME", "").strip(),
        cloud_origin=settings.pulse_cloud_origin.rstrip("/"),
        verzeichnis=Path(settings.pulse_verbinden_dir),
        instanz_id=settings.pulse_instance_id,
        modus=settings.pulse_instance_mode,
    )
    with httpx.Client(timeout=ANFRAGE_FRIST_S, follow_redirects=False) as client:
        try:
            return verbinden(
                umgebung,
                client,
                neustart=None if optionen.no_restart else container_neustarten,
                rueckfrage=_immer_ja if optionen.yes else frage_im_terminal,
            )
        except KeyboardInterrupt:
            print(texte.ABGEBROCHEN, file=sys.stderr)
            return 1


if __name__ == "__main__":
    sys.exit(main())
