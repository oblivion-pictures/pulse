"""Die Dateihelfer von ``pulse-connect`` (``verbinden_hilfen.py``).

``pulse-connect`` läuft als root und schreibt in ``/data/pulse``, ein Verzeichnis,
das dem Dienstkonto ``pulse`` gehört. Wer den Dienst übernimmt, kann dort einen
Symlink hinlegen — was root dann schreibt, landet am Ziel des Symlinks.
"""

from __future__ import annotations

import os
import secrets
import stat
import sys

import pytest

from dcc_chat_gateway.verbinden_hilfen import schreibe_atomar

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="Symlinks und Modi: Linux/macOS")


def _opfer(tmp_path):
    opfer = tmp_path / "opfer"
    opfer.write_text("unberuehrt", encoding="utf-8")
    return opfer


def test_zwischendatei_wird_nicht_durch_einen_symlink_verfolgt(tmp_path, monkeypatch):
    """Selbst ein erratener Name der Zwischendatei darf nichts überschreiben."""
    monkeypatch.setattr(secrets, "token_hex", lambda n=None: "ab" * (n or 16))
    ziel = tmp_path / "verbindung.env"
    opfer = _opfer(tmp_path)
    (tmp_path / f".{ziel.name}.{'ab' * 8}.tmp").symlink_to(opfer)

    with pytest.raises(OSError):
        schreibe_atomar(ziel, "PULSE_INSTANCE_ID=1\n", 0o600)

    assert opfer.read_text(encoding="utf-8") == "unberuehrt"
    assert not ziel.exists()


def test_der_alte_name_mit_der_prozessnummer_ist_wertlos(tmp_path):
    """Die Prozessnummer errät jeder im Container; sie steckt nicht mehr im Namen."""
    ziel = tmp_path / "verbindung.env"
    opfer = _opfer(tmp_path)
    (tmp_path / f".{ziel.name}.{os.getpid()}.tmp").symlink_to(opfer)

    schreibe_atomar(ziel, "PULSE_INSTANCE_ID=1\n", 0o600)

    assert opfer.read_text(encoding="utf-8") == "unberuehrt"
    assert ziel.read_text(encoding="utf-8") == "PULSE_INSTANCE_ID=1\n"


@pytest.mark.parametrize("modus", [0o600, 0o644])
def test_modus_gilt_trotz_umask(tmp_path, modus):
    ziel = tmp_path / "datei"
    alt = os.umask(0o277)
    try:
        schreibe_atomar(ziel, "x\n", modus)
    finally:
        os.umask(alt)
    assert stat.S_IMODE(ziel.stat().st_mode) == modus


def test_ein_fehler_hinterlaesst_keine_zwischendatei(tmp_path):
    (tmp_path / "datei").mkdir()  # os.replace auf ein Verzeichnis scheitert immer
    with pytest.raises(OSError):
        schreibe_atomar(tmp_path / "datei", "x\n", 0o600)
    assert [p.name for p in tmp_path.iterdir()] == ["datei"]
