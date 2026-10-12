"""``pulse-connect`` — diesen Server mit einem Pulse-Konto verbinden.

Aufruf im Container: ``docker exec -it pulse pulse-connect [--no-restart] [--yes]``
(Hülle: ``infra/self-host/s6/usr/local/bin/pulse-connect``). Ablauf nach dem
Muster „Device Authorization Grant“ (RFC 8628), Spec
``docs/superpowers/specs/2026-10-09-selfhost-ohne-freigabe-design.md`` E1/E2/E6:

1. Eine geheime Abholkennung erzeugen und ihren SHA-256 als Nachweis nach
   ``<pulse_verbinden_dir>/verbinden-nachweis`` legen; der chat-gateway liefert
   ihn unter ``/.well-known/pulse-verbinden`` aus.
2. Prüfen, ob Pulse den Nachweis selbst ausliefert (``GET /.well-known/
   pulse-verbinden`` auf dem eigenen chat-gateway, sonst Exit 3). Die Cloud
   erlaubt nur 10 Starts je Stunde (``rate_limit_verbinden_start``); einer an
   einem Server, der noch gar nicht antwortet, wäre vergeudet.
3. Bei der Cloud einen Gerätecode anfragen und dabei die Kennung selbst
   mitschicken; die Cloud bildet den Hash und vergleicht ihn sofort von außen
   mit dem Nachweis — ein nicht erreichbarer Server verbraucht keinen Code
   (Exit 3). Der Nachweis ist öffentlich lesbar: stünde er statt der Kennung
   im Anfragekörper, könnte jeder Mitleser einen Vorgang für diesen Server
   anlegen (Vertrag, Nachtrag 2).
4. Link und Code zeigen und alle ``abstand_s`` Sekunden abholen, bis der
   Betreiber im Browser bestätigt oder ablehnt, höchstens 15 Minuten.
5. Die Zugangsdaten atomar nach ``verbindung.env`` schreiben (0600), den
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

**Ein Lauf zugleich.** Eine ``flock``-Sperre auf ``/data/pulse/.pulse-connect.lock``
hält einen zweiten Aufruf (anderes Terminal) draußen: er meldet das und fasst
weder Nachweis noch Dateien des ersten an. Der Kernel gibt sie frei, wenn der
Prozess endet, auch bei SIGKILL oder geschlossenem Terminal.

Exit-Codes: 0 verbunden · 1 Fehler · 2 abgelehnt, abgelaufen oder die Adresse
ist gerade gesperrt · 3 der Nachweis wird nicht ausgeliefert (Pulse selbst oder
von außen nicht erreichbar) · 4 das bestätigende Konto besitzt die Adresse
nicht, ein Übernahme-Antrag läuft (kein Neustart: es gibt nichts anzuwenden).
"""

from __future__ import annotations

import argparse
import os
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
from dcc_chat_gateway.verbinden_hilfen import (
    Abbruch,
    abholen_entschieden,
    ablegen,
    anzeigbar,
    detail,
    entferne_still,
    lies_verbindung,
    lokal_pruefen,
    lokaler_client,
    nachweis_aus_kennung,
    sperre,
    verbindung_env,
    zugang_aus,
)
from dcc_chat_gateway.verbindung import (
    NACHWEIS_DATEI,
    NACHWEIS_PFAD,
    SPERR_DATEI,
    VERBINDUNG_DATEI,
)

#: Beendet den Container sauber; eine Neustart-Regel (``unless-stopped``) holt ihn
#: zurück, ohne sie bleibt er stehen (``texte.NEUSTART`` nennt den Handgriff).
HALT = "/run/s6/basedir/bin/halt"
#: Spec E8: ein Gerätecode gilt 15 Minuten, auch wenn die Cloud mehr nennt.
HOECHSTENS_S = 900
#: Der Abstand zwischen zwei Abfragen kommt von der Cloud; über diese Grenze
#: hinaus schliefe ``pulse-connect`` an der Frist vorbei.
ABSTAND_HOECHSTENS_S = 60
ANFRAGE_FRIST_S = 15.0
#: Beim Start prüft die Cloud erst DNS (bis 5 s) und ruft dann den Nachweis ab
#: (bis 8 s): im schlechtesten Fall ~13 s, die 15 s Grundfrist wären zu knapp.
START_FRIST_S = 30.0
#: Wo der chat-gateway im Container lauscht (s6-rc.d/chat-gateway/run); env.sh
#: nennt dieselbe Adresse als ``CHAT_GATEWAY_URL``.
LOKAL_URL_VORGABE = "http://127.0.0.1:8002"


@dataclass(frozen=True)
class Umgebung:
    """Was ``pulse-connect`` über diesen Server wissen muss (Hülle, env.sh, Settings)."""

    hostname: str
    cloud_origin: str
    verzeichnis: Path
    #: Kamen die Verbindungswerte aus der Container-Umgebung (``docker run -e``, .env)?
    #: Das sagt allein die Hülle (``PULSE_CONNECT_AUS_UMGEBUNG``); ein Blick in env.sh
    #: kann es nicht, denn dort stehen auch die Werte aus ``verbindung.env``.
    aus_umgebung: bool
    modus: str
    lokal_url: str = LOKAL_URL_VORGABE


@dataclass(frozen=True)
class _Vorgang:
    code: str
    link: str
    gueltig_s: int
    abstand_s: int


def _vorpruefung(umgebung: Umgebung) -> None:
    """Was ohne jeden Zugriff auf Dateien feststeht."""
    if umgebung.modus != "self-host":
        raise Abbruch(1, texte.NUR_SELF_HOST)
    if not umgebung.hostname:
        raise Abbruch(1, texte.OHNE_ADRESSE)
    # Werte aus der Umgebung gewinnen gegen die Datei (07-render-env.sh): eine
    # neue Datei bliebe wirkungslos, also gar nicht erst anfangen.
    if umgebung.aus_umgebung:
        raise Abbruch(1, texte.AUS_DER_UMGEBUNG)


def _bestehende_verbindung(umgebung: Umgebung, rueckfrage: Callable[[str], bool]) -> None:
    verbunden = lies_verbindung(umgebung.verzeichnis).get("PULSE_INSTANCE_ID")
    if verbunden and not rueckfrage(texte.SCHON_VERBUNDEN):
        raise Abbruch(1, texte.NICHTS_GEAENDERT)


def _starten(umgebung: Umgebung, client: httpx.Client, kennung: str) -> _Vorgang:
    url = f"{umgebung.cloud_origin}/api/auth/selfhost/verbinden/start"
    host = umgebung.hostname
    try:
        antwort = client.post(
            url, json={"hostname": host, "kennung": kennung}, timeout=START_FRIST_S
        )
    except httpx.TimeoutException:
        raise Abbruch(1, texte.CLOUD_ZU_LANGSAM) from None
    except httpx.HTTPError:
        raise Abbruch(1, texte.CLOUD_WEG.format(origin=umgebung.cloud_origin)) from None
    info = detail(antwort)
    if antwort.status_code == 409 and info == "vorgang_laeuft":
        raise Abbruch(1, texte.VORGANG_LAEUFT.format(host=host))
    if antwort.status_code == 409:
        befund = info.get("befund") if isinstance(info, dict) else None
        text = texte.BEFUNDE.get(befund, texte.BEFUND_UNBEKANNT).format(host=host)
        raise Abbruch(3, f"{text}\n{texte.NACHWEIS_HILFE}")
    if antwort.status_code == 400:
        gesperrt = info == "adresse_gesperrt"
        vorlage = texte.ADRESSE_GESPERRT if gesperrt else texte.ADRESSE_UNGUELTIG
        raise Abbruch(1, vorlage.format(host=host))
    if antwort.status_code == 429:
        raise Abbruch(1, texte.ZU_VIELE)
    if antwort.status_code == 503 and info == "verbinden_ausgelastet":
        raise Abbruch(1, texte.AUSGELASTET)
    if antwort.status_code in (502, 503, 504):  # Deploy der Cloud: später noch einmal
        raise Abbruch(1, texte.CLOUD_NICHT_BEREIT.format(status=antwort.status_code))
    if antwort.status_code != 201:
        raise Abbruch(1, texte.UNERWARTET.format(status=antwort.status_code))
    try:
        daten = antwort.json()
        return _Vorgang(
            code=anzeigbar(str(daten["code"])),
            link=anzeigbar(str(daten["link"])),
            gueltig_s=min(int(daten["gueltig_s"]), HOECHSTENS_S),
            abstand_s=min(max(1, int(daten["abstand_s"])), ABSTAND_HOECHSTENS_S),
        )
    except (ValueError, KeyError, TypeError):
        raise Abbruch(1, texte.UNERWARTET.format(status=201)) from None


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

    def warten() -> None:  # nie über die Frist hinaus
        schlafen(max(0.0, min(vorgang.abstand_s, ende - uhr())))

    while uhr() < ende:
        warten()
        try:
            antwort = client.post(url, json={"kennung": kennung})
        except httpx.HTTPError:
            continue  # Netzaussetzer: weiter warten, die Frist läuft mit
        if antwort.status_code == 200:
            return zugang_aus(antwort)
        if antwort.status_code in (403, 409):
            abholen_entschieden(umgebung.hostname, antwort)
        if antwort.status_code == 410:
            break
        if antwort.status_code == 429:
            warten()
        # 202 heißt „wartet“, ebenso alles Unbekannte (502 beim Deploy der Cloud).
    raise Abbruch(2, texte.ABGELAUFEN)


def _drucke(text: str) -> None:
    print(text, flush=True)


def _durchlaufen(
    umgebung: Umgebung,
    client: httpx.Client,
    lokal: httpx.Client,
    schlafen: Callable[[float], None],
    uhr: Callable[[], float],
    ausgabe: Callable[[str], None],
) -> dict:
    """Nachweis ablegen und prüfen, Code anfragen, abholen, Zugang speichern."""
    ausgabe(texte.BEGINN.format(host=umgebung.hostname))
    kennung = secrets.token_urlsafe(32)
    nachweis_datei = umgebung.verzeichnis / NACHWEIS_DATEI
    try:
        # VOR der Anfrage: die Cloud ruft den Nachweis sofort von außen ab.
        nachweis = nachweis_aus_kennung(kennung)
        ablegen(nachweis_datei, nachweis + "\n", 0o644, texte.DATEN_NICHT_BESCHREIBBAR)
        lokal_pruefen(umgebung.lokal_url + NACHWEIS_PFAD, lokal, nachweis)
        vorgang = _starten(umgebung, client, kennung)
        minuten = vorgang.gueltig_s // 60
        ausgabe(texte.ANLEITUNG.format(link=vorgang.link, code=vorgang.code, minuten=minuten))
        zugang = _abholen(umgebung, client, kennung, vorgang, schlafen, uhr)
        # Scheitert das Speichern, ist das Secret in der Cloud schon rotiert.
        ziel = umgebung.verzeichnis / VERBINDUNG_DATEI
        ablegen(ziel, verbindung_env(zugang), 0o600, texte.ZUGANG_NICHT_GESPEICHERT)
        return zugang
    finally:
        entferne_still(nachweis_datei)


def verbinden(
    umgebung: Umgebung,
    client: httpx.Client,
    *,
    lokal: httpx.Client,
    neustart: Callable[[], None] | None,
    rueckfrage: Callable[[str], bool],
    schlafen: Callable[[float], None] = time.sleep,
    uhr: Callable[[], float] = time.monotonic,
    ausgabe: Callable[[str], None] = _drucke,
) -> int:
    """Der ganze Ablauf; gibt den Exit-Code zurück. ``neustart=None`` = ``--no-restart``."""
    try:
        _vorpruefung(umgebung)
        # Ab hier schreibt dieser Lauf in /data/pulse: nie zwei zugleich.
        with sperre(umgebung.verzeichnis / SPERR_DATEI):
            _bestehende_verbindung(umgebung, rueckfrage)
            zugang = _durchlaufen(umgebung, client, lokal, schlafen, uhr, ausgabe)
    except Abbruch as abbruch:
        ausgabe(abbruch.meldung)
        return abbruch.exit_code
    besitzer = anzeigbar(str(zugang.get("owner_name") or "your account"))
    ausgabe(texte.VERBUNDEN.format(besitzer=besitzer))
    if neustart is None:
        ausgabe(texte.ERST_NACH_NEUSTART)
        return 0
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
        _drucke(texte.NEUSTART_VON_HAND)


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
        aus_umgebung=os.environ.get("PULSE_CONNECT_AUS_UMGEBUNG") == "1",
        modus=settings.pulse_instance_mode,
        lokal_url=os.environ.get("CHAT_GATEWAY_URL", LOKAL_URL_VORGABE).rstrip("/"),
    )
    with (
        httpx.Client(timeout=ANFRAGE_FRIST_S, follow_redirects=False) as client,
        lokaler_client() as lokal,
    ):
        try:
            return verbinden(
                umgebung,
                client,
                lokal=lokal,
                neustart=None if optionen.no_restart else container_neustarten,
                rueckfrage=_immer_ja if optionen.yes else frage_im_terminal,
            )
        except KeyboardInterrupt:
            print(texte.ABGEBROCHEN, file=sys.stderr)
            return 1


if __name__ == "__main__":
    sys.exit(main())
