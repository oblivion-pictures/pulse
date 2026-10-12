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
import shutil
import subprocess
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


# ── Das Signal „Werte aus der Umgebung“ ───────────────────────────────────
#
# 07-render-env.sh schreibt die fünf Verbindungswerte IMMER in env.sh (leer als
# 0 bzw. ''), und zwar auch die, die aus verbindung.env stammen. Ob die
# Container-Umgebung sie wirklich trug, sieht man dort nicht mehr; die Hülle
# muss es vor dem Sourcen festhalten.

_NAMEN = (
    "PULSE_INSTANCE_ID",
    "PULSE_INSTANCE_OWNER_ID",
    "PULSE_CLOUD_CLIENT_ID",
    "PULSE_CLOUD_CLIENT_SECRET",
)
_SHELLS = [
    "sh",
    pytest.param(
        "dash",
        marks=pytest.mark.skipif(
            shutil.which("dash") is None, reason="dash nicht installiert (Debian-/sh im Image)"
        ),
    ),
]
# Wie 07-render-env.sh es rendert: unverbunden als 0 bzw. leer, sonst die Werte.
_ENV_SH_UNVERBUNDEN = (
    "export PULSE_INSTANCE_ID='0'\nexport PULSE_INSTANCE_OWNER_ID='0'\n"
    "export PULSE_CLOUD_CLIENT_ID=''\nexport PULSE_CLOUD_CLIENT_SECRET=''\n"
)
_ENV_SH_AUS_DATEI = (
    "export PULSE_INSTANCE_ID='73315227868860500'\nexport PULSE_INSTANCE_OWNER_ID='42'\n"
    "export PULSE_CLOUD_CLIENT_ID='cid'\nexport PULSE_CLOUD_CLIENT_SECRET='geheim'\n"
)


def _signal(tmp_path, shell: str, env_sh: str, **container: str) -> str:
    """Die echte Hülle, mit umgelenktem env.sh und statt Python einem ``echo``."""
    ziel = tmp_path / "env.sh"
    ziel.write_text(env_sh, encoding="utf-8")
    text = HUELLE.read_text(encoding="utf-8").replace("/etc/pulse/env.sh", str(ziel))
    zeilen = text.splitlines()
    exec_zeilen = [i for i, z in enumerate(zeilen) if z.startswith("exec ")]
    assert len(exec_zeilen) == 1, "Hülle umgebaut? Es sollte genau ein exec geben."
    zeilen[exec_zeilen[0]] = 'echo "[${PULSE_CONNECT_AUS_UMGEBUNG-unset}]"'
    skript = tmp_path / "huelle.sh"
    skript.write_text("\n".join(zeilen) + "\n", encoding="utf-8")
    umgebung = {
        k: v for k, v in os.environ.items() if k not in (*_NAMEN, "PULSE_CONNECT_AUS_UMGEBUNG")
    }
    umgebung.update(container)
    lauf = subprocess.run(
        [shutil.which(shell), str(skript)], env=umgebung, capture_output=True, text=True
    )
    assert lauf.returncode == 0, lauf.stderr
    return lauf.stdout.strip()


@pytest.mark.parametrize("shell", _SHELLS)
@pytest.mark.parametrize("name", _NAMEN)
def test_jeder_verbindungswert_im_container_zaehlt_als_umgebung(tmp_path, shell, name):
    assert _signal(tmp_path, shell, _ENV_SH_AUS_DATEI, **{name: "x"}) == "[1]"


@pytest.mark.parametrize("shell", _SHELLS)
def test_ohne_verbindungswerte_im_container_ist_es_keine_umgebung(tmp_path, shell):
    """Auch dann nicht, wenn env.sh Werte trägt: die stammen aus ``verbindung.env``."""
    assert _signal(tmp_path, shell, _ENV_SH_UNVERBUNDEN) == "[]"
    assert _signal(tmp_path, shell, _ENV_SH_AUS_DATEI) == "[]"
    # ``-e PULSE_INSTANCE_ID=`` und die leeren Zeilen aus der .env.example zählen nicht.
    leer = dict.fromkeys(_NAMEN, "")
    assert _signal(tmp_path, shell, _ENV_SH_AUS_DATEI, **leer) == "[]"


@pytest.mark.parametrize("shell", _SHELLS)
def test_ein_von_aussen_vorgegebenes_signal_wird_ueberschrieben(tmp_path, shell):
    """Das Signal gehört der Hülle; wer es im Container setzt, ändert nichts."""
    assert _signal(tmp_path, shell, _ENV_SH_UNVERBUNDEN, PULSE_CONNECT_AUS_UMGEBUNG="1") == "[]"


@pytest.mark.parametrize("shell", _SHELLS)
def test_signal_erreicht_den_prozess_der_cli(tmp_path, shell):
    """Es muss exportiert sein, sonst sähe ``os.environ`` in Python es nicht."""
    assert _signal(tmp_path, shell, _ENV_SH_UNVERBUNDEN, PULSE_INSTANCE_ID="4711") == "[1]"
