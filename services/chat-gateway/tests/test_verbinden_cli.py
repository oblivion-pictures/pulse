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
import stat
from pathlib import Path

import httpx
import pytest

from dcc_chat_gateway import verbinden_cli
from dcc_chat_gateway.verbinden_cli import Umgebung, nachweis_aus_kennung, verbinden
from dcc_chat_gateway.verbindung import NACHWEIS_DATEI, VERBINDUNG_DATEI

CLOUD = "https://cloud.example"
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

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.pfade.append(request.url.path)
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


def _lauf(tmp_path, cloud, *, verzeichnis=None, instanz_id=0, rueckfrage=_nein, neustart=None):
    zeilen: list[str] = []
    uhr = Uhr()
    umgebung = Umgebung(
        hostname=HOST,
        cloud_origin=CLOUD,
        verzeichnis=verzeichnis or tmp_path,
        instanz_id=instanz_id,
        modus="self-host",
    )
    with httpx.Client(transport=httpx.MockTransport(cloud)) as client:
        code = verbinden(
            umgebung,
            client,
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
    """409 gibt es auch als Zeichenkette (``vorgang_laeuft``): derselbe Server
    hat schon einen offenen Code. Das ist nicht „von aussen nicht erreichbar“
    (Exit 3), und die Abhilfe ist eine andere."""
    cloud = Cloud(tmp_path, start=(409, {"detail": "vorgang_laeuft"}))
    code, text, _ = _lauf(tmp_path, cloud)

    assert code == 1
    assert "already running" in text
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
    code, _text, _ = _lauf(tmp_path, cloud, instanz_id=4711, rueckfrage=merke)
    assert code == 1
    assert cloud.pfade == []
    assert "already connected" in fragen[0]
    # Die Frage nennt, was ein Wechsel kostet, bevor jemand mit y antwortet.
    assert "has to wait 72 hours" in fragen[0]
    assert 'under "My servers"' in fragen[0]


def test_mit_ja_verbindet_er_neu(tmp_path):
    (tmp_path / VERBINDUNG_DATEI).write_text("PULSE_INSTANCE_ID=4711\n")
    cloud = Cloud(tmp_path, abholen=[(200, ZUGANG)])
    code, _text, _ = _lauf(tmp_path, cloud, instanz_id=4711, rueckfrage=lambda _f: True)
    assert code == 0
    assert "PULSE_INSTANCE_ID=73315227868860500" in (tmp_path / VERBINDUNG_DATEI).read_text()


def test_verbindung_aus_der_umgebung_bleibt_unangetastet(tmp_path):
    """Bestandsserver: die Nummer steht in der .env, nicht in der Datei. Eine
    neue Datei verlöre gegen die Umgebung — also gar nicht erst anfangen."""
    cloud = Cloud(tmp_path)
    code, text, _ = _lauf(tmp_path, cloud, instanz_id=77, rueckfrage=lambda _f: True)
    assert code == 1
    assert cloud.pfade == []
    assert "PULSE_INSTANCE_ID" in text
    assert not (tmp_path / NACHWEIS_DATEI).exists()


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
    assert verbinden_cli.main(["--no-restart", "--yes"]) == 0
    assert verbinden_cli.main([]) == 0
    (umgebung, neustart_a, frage_a), (_u, neustart_b, frage_b) = gesehen
    assert umgebung.hostname == HOST
    assert neustart_a is None
    assert frage_a("?") is True
    assert neustart_b is verbinden_cli.container_neustarten
    assert frage_b is verbinden_cli.frage_im_terminal


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
    assert [p.name for p in tmp_path.iterdir()] == [NACHWEIS_DATEI]


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
    assert list(tmp_path.iterdir()) == []


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
