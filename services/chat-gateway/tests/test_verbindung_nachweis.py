"""``nachweis_lesen``: was der anonyme Nachweis-Weg aus der Datei ausliefert.

Die Datei legt ``pulse-connect`` ab (64 Hex-Zeichen und ein Zeilenende). Die
Route ist anonym und braucht keine Bremse, weil sie höchstens eine winzige Datei
liest — das gilt nur, solange die Lesegrenze wirklich greift.
"""

from __future__ import annotations

import pytest

from dcc_chat_gateway.verbindung import NACHWEIS_DATEI, nachweis_lesen

WERT = "ab12" * 16


def _ablegen(verzeichnis, inhalt: bytes) -> None:
    (verzeichnis / NACHWEIS_DATEI).write_bytes(inhalt)


@pytest.mark.parametrize(
    "inhalt",
    [
        WERT.encode() + b"\n",
        WERT.encode(),
        WERT.encode() + b"\r\n",
        b"  " + WERT.encode() + b"\n",
        # Noch innerhalb der Lesegrenze: Leerraum am Ende gehört nicht zum Wert.
        WERT.encode() + b"\n" + b" " * 60,
    ],
)
def test_gueltige_formen(tmp_path, inhalt):
    _ablegen(tmp_path, inhalt)
    assert nachweis_lesen(tmp_path) == WERT


def test_ohne_datei(tmp_path):
    assert nachweis_lesen(tmp_path) is None


def test_datei_ist_ein_verzeichnis(tmp_path):
    (tmp_path / NACHWEIS_DATEI).mkdir()
    assert nachweis_lesen(tmp_path) is None


@pytest.mark.parametrize(
    "inhalt",
    [
        pytest.param(b"", id="leer"),
        pytest.param(b"\n", id="nur-zeilenende"),
        pytest.param(WERT.upper().encode() + b"\n", id="grossbuchstaben-hex"),
        pytest.param(WERT[:63].encode() + b"\n", id="63-zeichen"),
        pytest.param((WERT + "a").encode() + b"\n", id="65-zeichen"),
        pytest.param(b"x" + WERT.encode(), id="vorangestelltes-zeichen"),
        pytest.param(WERT.encode() + b"\n" + WERT.encode(), id="zwei-werte"),
        pytest.param(b"PULSE_CLOUD_CLIENT_SECRET=geheim\n", id="fremder-inhalt"),
    ],
)
def test_falsche_form(tmp_path, inhalt):
    _ablegen(tmp_path, inhalt)
    assert nachweis_lesen(tmp_path) is None


@pytest.mark.parametrize(
    "inhalt",
    [
        pytest.param(b"\xff\xfe" + WERT.encode(), id="nicht-utf8-am-anfang"),
        pytest.param(WERT.encode() + b"\n\xc3\xa4", id="umlaut-am-ende"),
        pytest.param(b"\x80" * 70, id="nur-muell"),
    ],
)
def test_nicht_ascii_ist_kein_nachweis(tmp_path, inhalt):
    """Der ``UnicodeDecodeError``-Zweig: kein Absturz der anonymen Route."""
    _ablegen(tmp_path, inhalt)
    assert nachweis_lesen(tmp_path) is None


def test_uebergrosse_datei_wird_nicht_gelesen_und_nicht_ausgeliefert(tmp_path):
    """Gültiger Anfang, danach ein Megabyte Leerraum: keine Form, die ``pulse-connect``
    schreibt. Ohne Lesegrenze läse die anonyme Route die ganze Datei und lieferte,
    weil das ``strip`` alles Weiße frisst, den Wert aus."""
    _ablegen(tmp_path, WERT.encode() + b"\n" + b" " * (1024 * 1024))
    assert nachweis_lesen(tmp_path) is None


def test_lesegrenze_greift_beim_lesen(tmp_path, monkeypatch):
    """Nicht nur das Ergebnis, auch der Aufwand ist begrenzt: höchstens ein paar
    Byte über die Lesegrenze hinaus, egal wie groß die Datei ist."""
    _ablegen(tmp_path, WERT.encode() + b"\n" + b"0" * (1024 * 1024))
    gelesen: list[int] = []
    echt = open

    def zaehlend(datei, modus="r", *args, **kwargs):
        handle = echt(datei, modus, *args, **kwargs)
        lese = handle.read

        def read(groesse=-1):
            daten = lese(groesse)
            gelesen.append(len(daten))
            return daten

        handle.read = read  # type: ignore[method-assign]
        return handle

    # ``Path.open`` ruft ``io.open``, ein direktes ``open()`` ``builtins.open``: beide fangen.
    monkeypatch.setattr("builtins.open", zaehlend)
    monkeypatch.setattr("io.open", zaehlend)
    assert nachweis_lesen(tmp_path) is None
    assert gelesen
    assert sum(gelesen) <= 200
