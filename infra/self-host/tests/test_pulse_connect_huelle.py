"""Die Hülle ``pulse-connect`` im Container.

Das Dockerfile kopiert ``infra/self-host/s6/`` als Ganzes nach ``/`` und setzt
für ``/usr/local/bin`` keinen Modus — das Ausführungsrecht kommt allein aus
Git (wie bei ``pulse-doctor``). Fehlt es, antwortet ``docker exec pulse
pulse-connect`` mit „permission denied“, und genau dieser Befehl steht im
Container-Log jedes unverbundenen Servers.
"""

from __future__ import annotations

import importlib
import os
import pathlib
import sys

import pytest

if sys.platform == "win32":
    pytest.skip("Ausführungsbit gibt es nur unter Linux/macOS", allow_module_level=True)

HUELLE = pathlib.Path(__file__).resolve().parents[1] / "s6" / "usr/local/bin/pulse-connect"


def test_huelle_ist_ausfuehrbar_und_ruft_das_modul():
    assert os.access(HUELLE, os.X_OK), "chmod 755 + git update-index --chmod=+x vergessen?"
    text = HUELLE.read_text(encoding="utf-8")
    assert ". /etc/pulse/env.sh" in text
    assert "-m dcc_chat_gateway.verbinden_cli" in text
    # Der Neustart am Ende braucht root (halt) — kein gosu.
    assert "gosu" not in text.split("set -eu", 1)[1]


def test_das_aufgerufene_modul_hat_einen_einstieg():
    modul = importlib.import_module("dcc_chat_gateway.verbinden_cli")
    assert callable(modul.main)
