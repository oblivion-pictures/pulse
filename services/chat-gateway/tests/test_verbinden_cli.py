"""``pulse-connect`` (``verbinden_cli.py``) gegen eine nachgebaute Cloud.

Die Cloud ist ein ``httpx.MockTransport`` mit genau den Antworten aus dem
Vertrag (auth-svc ``routes_verbinden.py``). Uhr und Schlaf sind ersetzt, damit
15 Minuten Warten keine 15 Minuten dauern; der Neustart ist eine Liste, in die
der Test schaut — ein echtes ``halt`` beendete den Container, nicht den Test.
"""

from __future__ import annotations

import errno
import json
import os
import signal
import stat
import subprocess
import sys
from pathlib import Path

import httpx
import pytest

from dcc_chat_gateway import verbinden_cli
from dcc_chat_gateway.verbinden_cli import Umgebung, nachweis_aus_kennung, verbinden
from dcc_chat_gateway.verbindung import (
    NACHWEIS_DATEI,
    NACHWEIS_PFAD,
    SPERR_DATEI,
    VERBINDUNG_DATEI,
    nachweis_lesen,
)

CLOUD = "https://cloud.example"
LOKAL = "http://127.0.0.1:8002"
HOST = "chat.example.org"
START = "/api/auth/selfhost/verbinden/start"
ABHOLEN = "/api/auth/selfhost/verbinden/abholen"
VORGANG = {
    "code": "K7QM-2XDP",
    "link": f"{CLOUD}/verbinden#K7QM-2XDP",
    "gueltig_s": 900,
    "abstand_s": 5,
}
ZUGANG = {
    "instance_id": "73315227868860500",
    "owner_user_id": "73315227868860416",
    "owner_name": "michael",
    "hostname": HOST,
    "client_id": "Zx9_client-id",
    "client_secret": "geheim_secret-123",
    "cloud_origin": CLOUD,
    "admin_email": None,
}
WARTET = (202, {"status": "wartet"})


class Cloud:
    """Die beiden anonymen Routen der Cloud, mit vorgegebenen Antworten."""

    def __init__(self, verzeichnis: Path, *, start=(201, VORGANG), abholen=()):
        self.verzeichnis = verzeichnis
        self.start = start
        self.abholen = list(abholen)
        self.pfade: list[str] = []
        self.kennung_beim_start: str | None = None
        self.nachweis_beim_start: str | None = None
        self.kennungen_beim_abholen: list[str] = []
        self.fristen: dict[str, dict] = {}

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.pfade.append(request.url.path)
        self.fristen[request.url.path] = request.extensions["timeout"]
        koerper = json.loads(request.content)
        if request.url.path == START:
            # Vertrag, Nachtrag 2: die Kennung selbst, nie der (öffentlich
            # lesbare) Nachweis — die Cloud bildet den Hash selbst.
            assert set(koerper) == {"hostname", "kennung"}
            assert koerper["hostname"] == HOST
            self.kennung_beim_start = koerper["kennung"]
            # Der Nachweis muss VOR der Anfrage bereitliegen: die Cloud ruft
            # ihn sofort von aussen ab und vergleicht ihn mit sha256(kennung).
            self.nachweis_beim_start = (self.verzeichnis / NACHWEIS_DATEI).read_text().strip()
            assert self.nachweis_beim_start == nachweis_aus_kennung(koerper["kennung"])
            status, daten = self.start
            return httpx.Response(status, json=daten)
        if request.url.path == ABHOLEN:
            assert set(koerper) == {"kennung"}
            self.kennungen_beim_abholen.append(koerper["kennung"])
            status, daten = self.abholen.pop(0) if self.abholen else WARTET
            return httpx.Response(status, json=daten)
        return httpx.Response(404, json={"detail": "Not Found"})


class Uhr:
    def __init__(self) -> None:
        self.jetzt = 0.0
        self.schlaefe: list[float] = []

    def __call__(self) -> float:
        return self.jetzt

    def schlafen(self, sekunden: float) -> None:
        self.schlaefe.append(sekunden)
        self.jetzt += sekunden


def _nein(_frage: str) -> bool:
    return False


def _dateien(verzeichnis: Path) -> list[str]:
    """Was ein Lauf zurücklässt — die Sperrdatei selbst ist leer und bleibt stehen."""
    return sorted(p.name for p in verzeichnis.iterdir() if p.name != SPERR_DATEI)


def _pulse_selbst(verzeichnis: Path):
    """Die Route des chat-gateway: der abgelegte Nachweis, sonst 404."""

    def route(request: httpx.Request) -> httpx.Response:
        assert request.method == "GET"
        assert str(request.url) == LOKAL + NACHWEIS_PFAD
        wert = nachweis_lesen(verzeichnis)
        if wert is None:
            return httpx.Response(404, json={"detail": "Not Found"})
        return httpx.Response(200, json={"nachweis": wert})

    return route


def _lauf(
    tmp_path,
    cloud,
    *,
    verzeichnis=None,
    aus_umgebung=False,
    rueckfrage=_nein,
    neustart=None,
    lokal=None,
):
    zeilen: list[str] = []
    uhr = Uhr()
    umgebung = Umgebung(
        hostname=HOST,
        cloud_origin=CLOUD,
        verzeichnis=verzeichnis or tmp_path,
        aus_umgebung=aus_umgebung,
        modus="self-host",
        lokal_url=LOKAL,
    )
    lokal = lokal or _pulse_selbst(verzeichnis or tmp_path)
    with (
        httpx.Client(transport=httpx.MockTransport(cloud)) as client,
        verbinden_cli.lokaler_client(transport=httpx.MockTransport(lokal)) as pulse,
    ):
        code = verbinden(
            umgebung,
            client,
            lokal=pulse,
            neustart=neustart,
            rueckfrage=rueckfrage,
            schlafen=uhr.schlafen,
            uhr=uhr,
            ausgabe=zeilen.append,
        )
    return code, "\n".join(zeilen), uhr


def test_verbindet_schreibt_die_zugangsdaten_und_startet_neu(tmp_path):
    cloud = Cloud(tmp_path, abholen=[WARTET, WARTET, (200, ZUGANG)])
    neustarts: list[str] = []
    code, text, uhr = _lauf(tmp_path, cloud, neustart=lambda: neustarts.append("halt"))

    assert code == 0
    assert cloud.pfade == [START, ABHOLEN, ABHOLEN, ABHOLEN]
    assert uhr.schlaefe == [5, 5, 5]
    kennung = cloud.kennung_beim_start
    # Abgeholt wird mit derselben Kennung, die beim Anfragen mitging; abgelegt
    # war nur ihr Hash, nicht die Kennung selbst.
    assert cloud.kennungen_beim_abholen == [kennung] * 3
    assert cloud.nachweis_beim_start != kennung
    datei = tmp_path / VERBINDUNG_DATEI
    assert datei.read_text().splitlines() == [
        "PULSE_INSTANCE_ID=73315227868860500",
        "PULSE_INSTANCE_OWNER_ID=73315227868860416",
        "PULSE_CLOUD_CLIENT_ID=Zx9_client-id",
        "PULSE_CLOUD_CLIENT_SECRET=geheim_secret-123",
    ]
    assert stat.S_IMODE(datei.stat().st_mode) == 0o600
    assert not (tmp_path / NACHWEIS_DATEI).exists()
    assert neustarts == ["halt"]
    assert VORGANG["link"] in text
    assert "K7QM-2XDP" in text
    assert "Connected to michael. Your server now appears in Pulse." in text
    # Kennung und Secret erscheinen in keiner Ausgabe.
    assert kennung not in text
    assert ZUGANG["client_secret"] not in text


def test_ohne_neustart_bleibt_der_container_stehen(tmp_path):
    cloud = Cloud(tmp_path, abholen=[(200, ZUGANG)])
    code, text, _ = _lauf(tmp_path, cloud, neustart=None)
    assert code == 0
    assert "Restarting" not in text
    # Wer ``--no-restart`` selbst tippt, soll wissen, dass noch nichts gilt.
    assert "only takes effect after the server restarts" in text
    assert "docker restart pulse" in text
    assert (tmp_path / VERBINDUNG_DATEI).exists()


def test_admin_mail_nur_wenn_die_cloud_eine_liefert(tmp_path):
    cloud = Cloud(tmp_path, abholen=[(200, {**ZUGANG, "admin_email": "ops@example.org"})])
    assert _lauf(tmp_path, cloud)[0] == 0
    zeilen = (tmp_path / VERBINDUNG_DATEI).read_text().splitlines()
    assert zeilen[-1] == "PULSE_ADMIN_EMAIL=ops@example.org"


def test_nachweis_von_aussen_nicht_erreichbar(tmp_path):
    detail = {"code": "nachweis_fehlt", "befund": "nicht_erreichbar"}
    cloud = Cloud(tmp_path, start=(409, {"detail": detail}))
    code, text, _ = _lauf(tmp_path, cloud)
    assert code == 3
    assert cloud.pfade == [START]
    assert "port 443" in text
    assert "No code was used up" in text
    assert not (tmp_path / NACHWEIS_DATEI).exists()
    assert not (tmp_path / VERBINDUNG_DATEI).exists()


@pytest.mark.parametrize(
    "antwort", [(403, {"detail": "abgelehnt"}), (410, {"detail": "abgelaufen"})]
)
def test_abgelehnt_oder_abgelaufen(tmp_path, antwort):
    cloud = Cloud(tmp_path, abholen=[WARTET, antwort])
    code, _text, _ = _lauf(tmp_path, cloud)
    assert code == 2
    assert not (tmp_path / VERBINDUNG_DATEI).exists()
    assert not (tmp_path / NACHWEIS_DATEI).exists()


def _antrag(frist_bis) -> tuple[int, dict]:
    return 409, {"detail": {"code": "uebernahme_beantragt", "frist_bis": frist_bis}}


@pytest.mark.parametrize(
    ("frist_bis", "angezeigt"),
    [
        ("2026-10-14T12:30:45.123456+00:00", "2026-10-14 12:30 UTC"),
        # Die Cloud nennt UTC; kommt doch ein Versatz, rechnet der Server um.
        ("2026-10-14T14:30:45+02:00", "2026-10-14 12:30 UTC"),
        # Ohne Zeitzone gilt, was die Cloud meint: UTC.
        ("2026-10-14T12:30:45", "2026-10-14 12:30 UTC"),
    ],
)
def test_uebernahme_beantragt_endet_mit_exit_4(tmp_path, frist_bis, angezeigt):
    """Der Besitzer des Eintrags ist ein anderes Konto: Antrag gestellt, Frist
    läuft. Kein Neustart (es gibt nichts anzuwenden), keine ``verbindung.env``."""
    cloud = Cloud(tmp_path, abholen=[WARTET, _antrag(frist_bis)])
    neustarts: list[str] = []
    code, text, _ = _lauf(tmp_path, cloud, neustart=lambda: neustarts.append("halt"))

    assert code == 4
    assert cloud.pfade == [START, ABHOLEN, ABHOLEN]
    assert f"can object until {angezeigt}." in text
    assert f"does not own {HOST} in Pulse" in text
    # Der Satz für den Fall, dass ein Fremder den Code schneller bestätigt hat.
    assert "run pulse-connect again now and confirm with the owner's account" in text
    assert neustarts == []
    assert not (tmp_path / VERBINDUNG_DATEI).exists()
    assert not (tmp_path / NACHWEIS_DATEI).exists()


@pytest.mark.parametrize("frist_bis", [None, "", "morgen", 42])
def test_uebernahme_beantragt_ohne_lesbares_fristende(tmp_path, frist_bis):
    """Ein Fristende, das sich nicht lesen lässt, ist kein Grund für eine
    Ausnahme — der Betreiber braucht den Rest der Meldung trotzdem."""
    cloud = Cloud(tmp_path, abholen=[_antrag(frist_bis)])
    code, text, _ = _lauf(tmp_path, cloud)
    assert code == 4
    assert "can object until the end of the waiting period." in text
    assert "morgen" not in text


def test_uebernahme_gesperrt_endet_mit_exit_2(tmp_path):
    detail = {"code": "uebernahme_gesperrt", "bis": "2026-10-15T08:00:00+00:00"}
    cloud = Cloud(tmp_path, abholen=[(403, {"detail": detail})])
    neustarts: list[str] = []
    code, text, _ = _lauf(tmp_path, cloud, neustart=lambda: neustarts.append("halt"))

    assert code == 2
    assert "(until 2026-10-15 08:00 UTC)" in text
    assert 'under "My servers"' in text
    # Nicht die Meldung für „im Browser abgelehnt“: hier hat niemand abgelehnt.
    assert "declined" not in text
    assert neustarts == []
    assert not (tmp_path / VERBINDUNG_DATEI).exists()
    assert not (tmp_path / NACHWEIS_DATEI).exists()


def test_cloud_ausgelastet_verbraucht_nichts(tmp_path):
    cloud = Cloud(tmp_path, start=(503, {"detail": "verbinden_ausgelastet"}))
    neustarts: list[str] = []
    code, text, _ = _lauf(tmp_path, cloud, neustart=lambda: neustarts.append("halt"))

    assert code == 1
    assert cloud.pfade == [START]
    assert "busy checking servers right now" in text
    assert "again in a minute" in text
    assert neustarts == []
    assert not (tmp_path / NACHWEIS_DATEI).exists()
    assert not (tmp_path / VERBINDUNG_DATEI).exists()


def test_vorgang_laeuft_ist_kein_nachweis_befund(tmp_path):
    """409 gibt es auch als Zeichenkette (``vorgang_laeuft``). Die Cloud meldet es
    nur für DIESELBE Kennung (``vorgang_anlegen``): der Start kam zweimal an. Das
    ist nicht „von aussen nicht erreichbar“ (Exit 3), und es behauptet auch nicht,
    ein anderer Versuch laufe — die Kennung ist bei jedem Lauf neu."""
    cloud = Cloud(tmp_path, start=(409, {"detail": "vorgang_laeuft"}))
    code, text, _ = _lauf(tmp_path, cloud)

    assert code == 1
    assert "arrived twice" in text
    assert "Run pulse-connect again" in text
    assert "already running" not in text
    assert "port 443" not in text
    assert not (tmp_path / NACHWEIS_DATEI).exists()


def test_frist_laeuft_ab(tmp_path):
    cloud = Cloud(tmp_path, start=(201, {**VORGANG, "gueltig_s": 15}))
    code, text, uhr = _lauf(tmp_path, cloud)
    assert code == 2
    assert uhr.jetzt >= 15
    assert "expired" in text


def test_schon_verbunden_fragt_nach(tmp_path):
    (tmp_path / VERBINDUNG_DATEI).write_text("PULSE_INSTANCE_ID=4711\n")
    fragen: list[str] = []

    def merke(frage: str) -> bool:
        fragen.append(frage)
        return False

    cloud = Cloud(tmp_path)
    code, _text, _ = _lauf(tmp_path, cloud, rueckfrage=merke)
    assert code == 1
    assert cloud.pfade == []
    assert "already connected" in fragen[0]
    # Die Frage nennt, was ein Wechsel kostet, bevor jemand mit y antwortet.
    assert "has to wait 72 hours" in fragen[0]
    assert 'under "My servers"' in fragen[0]


def test_mit_ja_verbindet_er_neu(tmp_path):
    (tmp_path / VERBINDUNG_DATEI).write_text("PULSE_INSTANCE_ID=4711\n")
    cloud = Cloud(tmp_path, abholen=[(200, ZUGANG)])
    code, _text, _ = _lauf(tmp_path, cloud, rueckfrage=lambda _f: True)
    assert code == 0
    assert "PULSE_INSTANCE_ID=73315227868860500" in (tmp_path / VERBINDUNG_DATEI).read_text()


@pytest.mark.parametrize(
    "datei", [None, "PULSE_INSTANCE_ID=4711\n"], ids=["ohne-datei", "mit-datei"]
)
def test_verbindung_aus_der_umgebung_bleibt_unangetastet(tmp_path, datei):
    """Bestandsserver: die Nummer steht in der .env, nicht in der Datei. Eine
    neue Datei verlöre gegen die Umgebung — also gar nicht erst anfangen. Das
    gilt auch dann, wenn zufällig eine Datei mit derselben Nummer daneben liegt."""
    if datei:
        (tmp_path / VERBINDUNG_DATEI).write_text(datei)
    cloud = Cloud(tmp_path)
    fragen: list[str] = []
    code, text, _ = _lauf(
        tmp_path, cloud, aus_umgebung=True, rueckfrage=lambda f: fragen.append(f) or True
    )
    assert code == 1
    assert cloud.pfade == []
    assert fragen == []  # keine Frage, deren Antwort doch nichts ändern könnte
    assert "PULSE_INSTANCE_ID" in text
    assert not (tmp_path / NACHWEIS_DATEI).exists()


def test_veraltete_verbindung_env_nach_no_restart_ist_kein_umgebungswert(tmp_path):
    """Erster Lauf mit ``--no-restart`` (Installer), zweiter vor dem Neustart:
    ``/etc/pulse/env.sh`` trägt noch die alte Nummer, die Datei schon die neue.
    Aus der Umgebung stammt keine von beiden — die Hülle sagt es ausdrücklich,
    statt dass die CLI env.sh gegen die Datei vergleicht (und hier irrt)."""
    (tmp_path / VERBINDUNG_DATEI).write_text("PULSE_INSTANCE_ID=999\n")
    fragen: list[str] = []
    cloud = Cloud(tmp_path, abholen=[(200, ZUGANG)])
    code, _text, _ = _lauf(
        tmp_path, cloud, aus_umgebung=False, rueckfrage=lambda f: fragen.append(f) or True
    )
    assert code == 0
    assert len(fragen) == 1  # die übliche Frage „schon verbunden“
    assert "PULSE_INSTANCE_ID=73315227868860500" in (tmp_path / VERBINDUNG_DATEI).read_text()


def test_unerwartete_zugangsdaten_werden_nicht_geschrieben(tmp_path):
    boese = {**ZUGANG, "client_secret": "x'$(reboot)"}
    cloud = Cloud(tmp_path, abholen=[(200, boese)])
    code, text, _ = _lauf(tmp_path, cloud)
    assert code == 1
    assert not (tmp_path / VERBINDUNG_DATEI).exists()
    assert "reboot" not in text


def test_cloud_nicht_erreichbar(tmp_path):
    def weg(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("weg", request=request)

    code, text, _ = _lauf(tmp_path, weg)
    assert code == 1
    assert CLOUD in text
    assert not (tmp_path / NACHWEIS_DATEI).exists()


def test_nachweis_wie_ihn_die_cloud_rechnet():
    """Server und Cloud rechnen den Nachweis je für sich; laufen die beiden
    Rechnungen auseinander, scheitert jedes Verbinden mit ``falscher_wert``."""
    from dcc_auth.verbinden import nachweis_aus_kennung as cloud_rechnung

    kennung = "Abc-_123xyz"
    assert nachweis_aus_kennung(kennung) == cloud_rechnung(kennung)


def test_main_reicht_die_schalter_durch(monkeypatch):
    gesehen = []

    def falsch(umgebung, client, *, neustart, rueckfrage, **_rest):
        gesehen.append((umgebung, neustart, rueckfrage))
        return 0

    monkeypatch.setattr(verbinden_cli, "verbinden", falsch)
    monkeypatch.setenv("PULSE_HOSTNAME", HOST)
    monkeypatch.delenv("PULSE_CONNECT_AUS_UMGEBUNG", raising=False)
    assert verbinden_cli.main(["--no-restart", "--yes"]) == 0
    assert verbinden_cli.main([]) == 0
    (umgebung, neustart_a, frage_a), (_u, neustart_b, frage_b) = gesehen
    assert umgebung.hostname == HOST
    assert neustart_a is None
    assert frage_a("?") is True
    assert neustart_b is verbinden_cli.container_neustarten
    assert frage_b is verbinden_cli.frage_im_terminal


@pytest.mark.parametrize(
    ("signal", "erwartet"), [(None, False), ("", False), ("0", False), ("1", True)]
)
def test_main_liest_das_umgebungssignal_der_huelle(monkeypatch, signal, erwartet):
    """Allein die Hülle weiss, was der Container wirklich bekam (sie sichert es
    vor ``. /etc/pulse/env.sh``). Was env.sh über die Nummer sagt, zählt nicht."""
    gesehen = []
    monkeypatch.setattr(
        verbinden_cli, "verbinden", lambda umgebung, *_a, **_k: gesehen.append(umgebung) or 0
    )
    monkeypatch.setenv("PULSE_HOSTNAME", HOST)
    monkeypatch.setenv("PULSE_INSTANCE_ID", "4711")  # wie aus env.sh gerendert
    if signal is None:
        monkeypatch.delenv("PULSE_CONNECT_AUS_UMGEBUNG", raising=False)
    else:
        monkeypatch.setenv("PULSE_CONNECT_AUS_UMGEBUNG", signal)
    verbinden_cli.main([])
    assert gesehen[0].aus_umgebung is erwartet


def test_alter_nachweis_wird_ersetzt(tmp_path):
    """Ein abgebrochener Lauf kann eine Nachweis-Datei hinterlassen haben; der
    neue Lauf legt seine eigene darüber (die Cloud prüft beim Start dagegen)."""
    (tmp_path / NACHWEIS_DATEI).write_text("0" * 64 + "\n")
    cloud = Cloud(tmp_path, abholen=[(200, ZUGANG)])
    assert _lauf(tmp_path, cloud)[0] == 0
    assert cloud.nachweis_beim_start != "0" * 64


def test_strg_c_raeumt_den_nachweis_weg(tmp_path):
    def abbruch_beim_abholen(request: httpx.Request) -> httpx.Response:
        if request.url.path == ABHOLEN:
            raise KeyboardInterrupt
        return httpx.Response(201, json=VORGANG)

    with pytest.raises(KeyboardInterrupt):
        _lauf(tmp_path, abbruch_beim_abholen)
    assert not (tmp_path / NACHWEIS_DATEI).exists()
    assert not (tmp_path / VERBINDUNG_DATEI).exists()


# ── Härtung: Platte, kaputte Antworten, Abstand, Neustart ─────────────────


def test_verzeichnis_nicht_anlegbar_ohne_traceback(tmp_path):
    (tmp_path / "datei").write_text("")  # darunter lässt sich nichts anlegen
    cloud = Cloud(tmp_path)
    code, text, _ = _lauf(tmp_path, cloud, verzeichnis=tmp_path / "datei" / "pulse")
    assert code == 1
    assert cloud.pfade == []  # nichts verbraucht, die Cloud wurde nie gefragt
    assert "Could not write to" in text
    assert "no code was used up" in text


def test_nachweis_nicht_schreibbar_ohne_traceback(tmp_path):
    (tmp_path / NACHWEIS_DATEI).mkdir()  # os.replace auf ein Verzeichnis scheitert immer
    cloud = Cloud(tmp_path)
    code, text, _ = _lauf(tmp_path, cloud)
    assert code == 1
    assert cloud.pfade == []
    assert "Could not write to" in text
    assert "no code was used up" in text
    # Auch das Aufräumen scheitert hier (unlink auf ein Verzeichnis) — und schweigt;
    # die Nachbardatei bleibt nicht liegen.
    assert _dateien(tmp_path) == [NACHWEIS_DATEI]


def test_platte_voll_nach_dem_abholen_nennt_die_folge(tmp_path, monkeypatch):
    """Die Cloud hat das Secret da schon rotiert: der Betreiber muss wissen, dass
    er nach dem Platzschaffen erneut verbinden muss — nicht bloss „Fehler“."""
    echt = os.replace

    def voll(quelle, ziel):
        if Path(ziel).name == VERBINDUNG_DATEI:
            raise OSError(errno.ENOSPC, os.strerror(errno.ENOSPC))
        echt(quelle, ziel)

    monkeypatch.setattr(os, "replace", voll)
    cloud = Cloud(tmp_path, abholen=[(200, ZUGANG)])
    neustarts: list[str] = []
    code, text, _ = _lauf(tmp_path, cloud, neustart=lambda: neustarts.append("halt"))

    assert code == 1
    assert "already issued new credentials" in text
    assert "No space left on device" in text
    assert "run pulse-connect again" in text
    assert ZUGANG["client_secret"] not in text
    assert neustarts == []
    # Weder Nachweis noch Zwischendatei noch halbe verbindung.env bleiben liegen.
    assert _dateien(tmp_path) == []


def test_verbindung_env_nicht_schreibbar_ohne_traceback(tmp_path):
    (tmp_path / VERBINDUNG_DATEI).mkdir()
    cloud = Cloud(tmp_path, abholen=[(200, ZUGANG)])
    code, text, _ = _lauf(tmp_path, cloud)
    assert code == 1
    assert "already issued new credentials" in text
    assert not (tmp_path / NACHWEIS_DATEI).exists()


def test_aufraeumen_darf_den_erfolg_nicht_verdecken(tmp_path, monkeypatch):
    echt = Path.unlink

    def verweigert(self, missing_ok=False):
        if self.name == NACHWEIS_DATEI:
            raise PermissionError(errno.EROFS, os.strerror(errno.EROFS))
        return echt(self, missing_ok=missing_ok)

    monkeypatch.setattr(Path, "unlink", verweigert)
    cloud = Cloud(tmp_path, abholen=[(200, ZUGANG)])
    code, _text, _ = _lauf(tmp_path, cloud)
    assert code == 0
    assert (tmp_path / VERBINDUNG_DATEI).exists()


@pytest.mark.parametrize("koerper", [[], "text", None, 42])
def test_abholen_mit_kaputtem_koerper(tmp_path, koerper):
    """Ein 200, dessen Körper kein Objekt ist, ist keine Ausnahme wert."""
    cloud = Cloud(tmp_path, abholen=[(200, koerper)])
    code, text, _ = _lauf(tmp_path, cloud)
    assert code == 1
    assert "cannot use" in text
    assert "Run pulse-connect again" in text
    assert not (tmp_path / VERBINDUNG_DATEI).exists()
    assert not (tmp_path / NACHWEIS_DATEI).exists()


def test_abholen_mit_antwort_ohne_json(tmp_path):
    def kaputt(request: httpx.Request) -> httpx.Response:
        if request.url.path == ABHOLEN:
            return httpx.Response(200, content=b"<html>Bad Gateway</html>")
        return Cloud(tmp_path)(request)

    code, text, _ = _lauf(tmp_path, kaputt)
    assert code == 1
    assert "cannot use" in text
    assert not (tmp_path / NACHWEIS_DATEI).exists()


def test_abholen_mit_fehlendem_pflichtfeld(tmp_path):
    ohne = {k: v for k, v in ZUGANG.items() if k != "client_secret"}
    cloud = Cloud(tmp_path, abholen=[(200, ohne)])
    code, text, _ = _lauf(tmp_path, cloud)
    assert code == 1
    assert "cannot use" in text
    assert "Run pulse-connect again" in text
    assert not (tmp_path / VERBINDUNG_DATEI).exists()


def test_abstand_der_cloud_wird_gedeckelt(tmp_path):
    """Die Cloud nennt den Abstand; eine Stunde Schlaf wäre mehr als die ganze
    Wartezeit (und liefe über die 15 Minuten hinaus)."""
    cloud = Cloud(tmp_path, start=(201, {**VORGANG, "abstand_s": 3600}))
    code, _text, uhr = _lauf(tmp_path, cloud)
    assert code == 2
    assert max(uhr.schlaefe) <= 60
    assert uhr.jetzt <= 900


def test_letzter_schlaf_endet_mit_der_frist(tmp_path):
    cloud = Cloud(tmp_path, start=(201, {**VORGANG, "gueltig_s": 100, "abstand_s": 60}))
    code, _text, uhr = _lauf(tmp_path, cloud)
    assert code == 2
    assert uhr.schlaefe == [60, 40]


def test_auch_die_pause_nach_429_endet_mit_der_frist(tmp_path):
    cloud = Cloud(
        tmp_path,
        start=(201, {**VORGANG, "gueltig_s": 100, "abstand_s": 60}),
        abholen=[(429, {"detail": "zu viele"})],
    )
    code, _text, uhr = _lauf(tmp_path, cloud)
    assert code == 2
    assert uhr.jetzt <= 100


def test_neustart_nennt_den_handgriff_fuer_den_fall_dass_er_nicht_zurueckkommt(tmp_path):
    """Ohne ``--restart`` bleibt der Container nach ``halt`` gestoppt."""
    cloud = Cloud(tmp_path, abholen=[(200, ZUGANG)])
    code, text, _ = _lauf(tmp_path, cloud, neustart=lambda: None)
    assert code == 0
    assert "Restarting the server" in text
    assert "If it does not come back by itself, start it again: docker start pulse" in text


# ── Härtung: Fristen und 5xx beim Start ───────────────────────────────────


def test_start_bekommt_30_sekunden(tmp_path):
    """Die Cloud prüft beim Start DNS (bis 5 s) und ruft den Nachweis ab (bis
    8 s) — im schlechtesten Fall rund 13 s, mehr als die 15 s Grundfrist bei
    Verbindungsaufbau und Antwort zusammen lassen."""
    cloud = Cloud(tmp_path, abholen=[(200, ZUGANG)])
    assert _lauf(tmp_path, cloud)[0] == 0
    assert set(cloud.fristen[START].values()) == {30.0}


@pytest.mark.parametrize("fehler", [httpx.ReadTimeout, httpx.ConnectTimeout])
def test_cloud_antwortet_nicht_rechtzeitig(tmp_path, fehler):
    def langsam(request: httpx.Request) -> httpx.Response:
        raise fehler("zu langsam", request=request)

    neustarts: list[str] = []
    code, text, _ = _lauf(tmp_path, langsam, neustart=lambda: neustarts.append("halt"))
    assert code == 1
    assert "did not answer in time" in text
    assert "please try again" in text
    # Nicht die Meldung für „Netz weg“: die Cloud ist erreichbar, nur langsam.
    assert "Could not reach" not in text
    assert neustarts == []
    assert not (tmp_path / NACHWEIS_DATEI).exists()


@pytest.mark.parametrize("status", [502, 503, 504])
def test_cloud_nicht_bereit_beim_start(tmp_path, status):
    """Deploy der Cloud: Proxy oder Dienst antworten 5xx, oft mit HTML statt JSON."""

    def proxy(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, content=b"<html>Service Unavailable</html>")

    neustarts: list[str] = []
    code, text, _ = _lauf(tmp_path, proxy, neustart=lambda: neustarts.append("halt"))
    assert code == 1
    assert f"HTTP {status}" in text
    assert "please try again in a minute" in text
    assert "Unexpected answer" not in text
    assert neustarts == []
    assert not (tmp_path / NACHWEIS_DATEI).exists()


def test_503_nicht_verfuegbar_mit_json_ist_auch_nur_ein_spaeter_versuch(tmp_path):
    cloud = Cloud(tmp_path, start=(503, {"detail": "verbinden_nicht_verfuegbar"}))
    code, text, _ = _lauf(tmp_path, cloud)
    assert code == 1
    assert "please try again in a minute" in text
    assert "busy checking servers" not in text  # das ist ``verbinden_ausgelastet``


# ── Härtung: Pulse muss den Nachweis selbst ausliefern, bevor die Cloud fragt ──


def test_lokale_vorpruefung_kommt_vor_dem_cloud_start(tmp_path):
    cloud = Cloud(tmp_path, abholen=[(200, ZUGANG)])
    gesehen: list[list[str]] = []
    route = _pulse_selbst(tmp_path)

    def lokal(request: httpx.Request) -> httpx.Response:
        gesehen.append(list(cloud.pfade))  # was die Cloud bis jetzt gehört hat
        assert set(request.extensions["timeout"].values()) == {3.0}
        return route(request)

    assert _lauf(tmp_path, cloud, lokal=lokal)[0] == 0
    assert gesehen == [[]]  # genau einmal, und die Cloud war noch nicht dran


def _antwort(status, koerper):
    return lambda _request: httpx.Response(status, json=koerper)


def _ohne_verbindung(request: httpx.Request) -> httpx.Response:
    raise httpx.ConnectError("Connection refused", request=request)


def _zu_langsam(request: httpx.Request) -> httpx.Response:
    raise httpx.ReadTimeout("zu langsam", request=request)


@pytest.mark.parametrize(
    "lokal",
    [
        _antwort(404, {"detail": "Not Found"}),
        _antwort(200, {"nachweis": "0" * 64}),  # ein anderer Wert als der abgelegte
        _antwort(200, {"anders": "ja"}),
        _antwort(200, ["kein", "objekt"]),
        _antwort(500, {"detail": "kaputt"}),
        lambda _request: httpx.Response(200, content=b"<html>SPA</html>"),
        _ohne_verbindung,
        _zu_langsam,
    ],
    ids=["404", "anderer-wert", "falsches-feld", "liste", "500", "kein-json", "refused", "timeout"],
)
def test_pulse_liefert_den_nachweis_nicht_aus(tmp_path, lokal):
    """Läuft der chat-gateway noch nicht (oder reicht ein Proxy davor etwas
    anderes durch), würde die Cloud den Start mit ``kein_nachweis`` abweisen und
    einen ihrer 10 Starts je Stunde verbrauchen. Das fällt hier vorher auf."""
    cloud = Cloud(tmp_path)
    neustarts: list[str] = []
    code, text, _ = _lauf(tmp_path, cloud, lokal=lokal, neustart=lambda: neustarts.append("halt"))

    assert code == 3
    assert cloud.pfade == []  # kein Cloud-Aufruf
    assert "Pulse itself is not serving the proof yet (is the server fully started?)" in text
    assert "No code was used up" in text
    assert neustarts == []
    assert not (tmp_path / NACHWEIS_DATEI).exists()
    assert not (tmp_path / VERBINDUNG_DATEI).exists()


def test_der_pfad_der_vorpruefung_ist_die_route_des_chat_gateways():
    from dcc_chat_gateway.app import app

    assert NACHWEIS_PFAD in {getattr(route, "path", None) for route in app.routes}


def test_lokaler_client_geht_nie_ueber_einen_umgebungs_proxy(monkeypatch):
    """httpx nimmt ``HTTP_PROXY`` auch für 127.0.0.1; ein Proxy zwischen
    pulse-connect und dem eigenen Dienst gäbe jedem Server dahinter ein
    falsches ``nicht ausgeliefert``."""
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer

    class Antwort(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802 — Name der Basisklasse
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"{}")

        def log_message(self, *_args):
            pass

    server = HTTPServer(("127.0.0.1", 0), Antwort)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:9")  # nichts hört dort
    url = f"http://127.0.0.1:{server.server_port}/"
    try:
        with pytest.raises(httpx.ConnectError):  # die Gegenprobe: ein gewöhnlicher Client
            httpx.Client().get(url, timeout=2)
        with verbinden_cli.lokaler_client() as client:
            assert client.get(url).status_code == 200
    finally:
        server.shutdown()
        server.server_close()


# ── Härtung: ein Lauf zugleich ────────────────────────────────────────────


def test_zweiter_lauf_fasst_den_nachweis_des_ersten_nicht_an(tmp_path):
    """Zwei Terminals: der zweite Lauf legte sonst seinen Nachweis über den des
    ersten (die Cloud fragte den falschen ab) und löschte ihn beim Ende."""
    erste = Cloud(tmp_path, abholen=[(200, ZUGANG)])
    zweiter: dict = {}

    def mit_zweitem_lauf(request: httpx.Request) -> httpx.Response:
        if request.url.path == ABHOLEN and not zweiter:  # der erste wartet gerade
            zweiter["nachweis_vorher"] = (tmp_path / NACHWEIS_DATEI).read_text()
            zweiter["cloud"] = Cloud(tmp_path)
            zweiter["lokal"] = []

            def lokal(req: httpx.Request) -> httpx.Response:
                zweiter["lokal"].append(req)
                return _pulse_selbst(tmp_path)(req)

            zweiter["ergebnis"] = _lauf(tmp_path, zweiter["cloud"], lokal=lokal)
            zweiter["nachweis_nachher"] = (tmp_path / NACHWEIS_DATEI).read_text()
        return erste(request)

    code, _text, _ = _lauf(tmp_path, mit_zweitem_lauf)

    assert code == 0  # der erste Lauf ist ungestört zu Ende gegangen
    code2, text2, _ = zweiter["ergebnis"]
    assert code2 == 1
    assert "pulse-connect is already running" in text2
    assert zweiter["cloud"].pfade == []  # nichts bei der Cloud angefragt
    assert zweiter["lokal"] == []  # und auch nichts am eigenen Server
    assert zweiter["nachweis_nachher"] == zweiter["nachweis_vorher"]
    assert (tmp_path / VERBINDUNG_DATEI).exists()


def test_nach_jedem_ende_ist_der_naechste_lauf_frei(tmp_path):
    abbruch = Cloud(tmp_path, abholen=[(403, {"detail": "abgelehnt"})])
    assert _lauf(tmp_path, abbruch)[0] == 2
    assert _lauf(tmp_path, Cloud(tmp_path, abholen=[(200, ZUGANG)]))[0] == 0


def test_nach_strg_c_ist_der_naechste_lauf_frei(tmp_path):
    def strg_c(request: httpx.Request) -> httpx.Response:
        raise KeyboardInterrupt

    with pytest.raises(KeyboardInterrupt):
        _lauf(tmp_path, strg_c)
    assert _lauf(tmp_path, Cloud(tmp_path, abholen=[(200, ZUGANG)]))[0] == 0


_HALTER = (
    "import sys, time\n"
    "from pathlib import Path\n"
    "from dcc_chat_gateway.verbinden_hilfen import sperre\n"
    "with sperre(Path(sys.argv[1])):\n"
    "    print('gesperrt', flush=True)\n"
    "    time.sleep(60)\n"
)


@pytest.mark.skipif(sys.platform == "win32", reason="flock gibt es nur unter Linux/macOS")
def test_sperre_haelt_ueber_prozesse_und_ein_getoeteter_halter_gibt_sie_frei(tmp_path):
    """Der Betreiber schliesst das Terminal oder ``docker exec`` stirbt: das ``finally``
    von pulse-connect läuft dann nicht. Eine Sperre, die dort stehen bliebe (eine
    ``O_EXCL``-Datei), sperrte jeden weiteren Aufruf bis zum Neustart des Containers."""
    halter = subprocess.Popen(
        [sys.executable, "-c", _HALTER, str(tmp_path / SPERR_DATEI)],
        stdout=subprocess.PIPE,
        text=True,
    )
    try:
        assert halter.stdout.readline().strip() == "gesperrt"
        code, text, _ = _lauf(tmp_path, Cloud(tmp_path))
        assert code == 1
        assert "pulse-connect is already running" in text
        halter.send_signal(signal.SIGKILL)
        halter.wait(timeout=10)
        assert _lauf(tmp_path, Cloud(tmp_path, abholen=[(200, ZUGANG)]))[0] == 0
    finally:
        halter.kill()
        halter.wait()
        halter.stdout.close()


@pytest.mark.skipif(sys.platform == "win32", reason="Symlinks: Linux/macOS")
def test_sperrdatei_folgt_keinem_symlink(tmp_path):
    opfer = tmp_path / "opfer"
    opfer.write_text("unberuehrt")
    (tmp_path / SPERR_DATEI).symlink_to(opfer)
    cloud = Cloud(tmp_path)
    code, text, _ = _lauf(tmp_path, cloud)
    assert code == 1
    assert "Could not write to" in text
    assert cloud.pfade == []
    assert opfer.read_text() == "unberuehrt"


@pytest.mark.skipif(sys.platform == "win32", reason="flock gibt es nur unter Linux/macOS")
def test_dateisystem_ohne_flock_sperrt_den_betreiber_nicht_aus(tmp_path, monkeypatch):
    """Ohne Sperre läuft pulse-connect wie vor der Sperre; sie schützt nur vor
    dem Doppelstart und ist keinen Ausfall des Werkzeugs wert."""
    import fcntl

    def unterstuetzt_nicht(_fd, _operation):
        raise OSError(errno.ENOLCK, os.strerror(errno.ENOLCK))

    monkeypatch.setattr(fcntl, "flock", unterstuetzt_nicht)
    assert _lauf(tmp_path, Cloud(tmp_path, abholen=[(200, ZUGANG)]))[0] == 0


def test_unlesbare_verbindung_env_ist_eine_meldung_kein_traceback(tmp_path):
    """Keine gültige UTF-8-Datei (halb geschrieben, fremd bearbeitet): sagen, was
    zu tun ist, statt mit ``UnicodeDecodeError`` abzubrechen — und nichts
    überschreiben, was vielleicht eine gültige Verbindung war."""
    kaputt = b"PULSE_INSTANCE_ID=\xff\xfe\x80\n"
    (tmp_path / VERBINDUNG_DATEI).write_bytes(kaputt)
    cloud = Cloud(tmp_path)
    code, text, _ = _lauf(tmp_path, cloud, rueckfrage=lambda _f: True)

    assert code == 1
    assert str(tmp_path / VERBINDUNG_DATEI) in text
    assert "not valid text" in text
    assert "Nothing changed" in text
    assert cloud.pfade == []
    assert (tmp_path / VERBINDUNG_DATEI).read_bytes() == kaputt
    assert not (tmp_path / NACHWEIS_DATEI).exists()
