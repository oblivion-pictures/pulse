"""Startskripte des Containers: nur die Adresse ist Pflicht (Spec 2026-10-09, E4).

Die Skripte laufen unter ``set -eu``; eine nicht gesetzte Variable bricht den
ganzen Start ab. Deshalb wird jeweils das echte Skript — oder der echte Block,
unverändert herausgeschnitten wie in ``test_caddy_tls_modi.py`` — mit einer
Umgebung gefahren, in der die alten Cloud-Werte FEHLEN, nicht nur leer sind.
"""

from __future__ import annotations

import os
import pathlib
import shutil
import subprocess
import sys

import pytest

if sys.platform == "win32":
    pytest.skip("Shell-Skripte des Containers — Linux-CI-Sache", allow_module_level=True)

S6 = pathlib.Path(__file__).resolve().parents[1] / "s6"
SKRIPTE = S6 / "etc/s6-overlay/scripts"
PRUEFUNG = SKRIPTE / "10-check-cloud-creds.sh"
RENDER = SKRIPTE / "07-render-env.sh"
CADDY = SKRIPTE / "09-init-caddy.sh"
DATENVERZEICHNISSE = SKRIPTE / "01-init-data-dirs.sh"
ENV_BEISPIEL = S6.parent / ".env.example"
TEMPLATE = S6 / "etc/caddy/Caddyfile.template"
_ALT = (
    "PULSE_HOSTNAME",
    "PULSE_INSTANCE_ID",
    "PULSE_INSTANCE_OWNER_ID",
    "PULSE_CLOUD_CLIENT_ID",
    "PULSE_CLOUD_CLIENT_SECRET",
    "PULSE_ADMIN_EMAIL",
)
_AUSGABE = (
    'printf "%s|%s|%s|%s|%s\\n" "${PULSE_INSTANCE_ID:-}" "${PULSE_INSTANCE_OWNER_ID:-}" '
    '"${PULSE_CLOUD_CLIENT_ID:-}" "${PULSE_CLOUD_CLIENT_SECRET:-}" "${PULSE_ADMIN_EMAIL:-}"'
)
ZUGANG = (
    "PULSE_INSTANCE_ID=73315227868860500\n"
    "PULSE_INSTANCE_OWNER_ID=73315227868860416\n"
    "PULSE_CLOUD_CLIENT_ID=Zx9_client-id\n"
    "PULSE_CLOUD_CLIENT_SECRET=geheim_secret-123\n"
)


def _umgebung(**gesetzt: str) -> dict[str, str]:
    # Auch PULSE_INSTANCE_ID=0 aus dem Gate (scripts/gate.sh) muss hier weg.
    basis = {k: v for k, v in os.environ.items() if k not in _ALT}
    return {**basis, **gesetzt}


def _block(datei: pathlib.Path, anfang: str, ende: str) -> str:
    """Von der Zeile, die mit ``anfang`` beginnt, bis zur ersten danach, die mit
    ``ende`` beginnt — unverändert aus dem echten Skript."""
    zeilen = datei.read_text(encoding="utf-8").split("\n")
    start = next((i for i, z in enumerate(zeilen) if z.startswith(anfang)), None)
    assert start is not None, f"{anfang!r} fehlt in {datei.name} — Skript umgebaut?"
    schluss = next((i for i, z in enumerate(zeilen) if i > start and z.startswith(ende)), None)
    assert schluss is not None, f"kein {ende!r} nach {anfang!r} in {datei.name}"
    return "\n".join(zeilen[start : schluss + 1])


def _sh(skript: str, **umgebung: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["sh", "-c", skript], env=_umgebung(**umgebung), capture_output=True, text=True
    )


# ── 10-check-cloud-creds.sh ───────────────────────────────────────────────


def test_nur_die_adresse_genuegt():
    r = _sh(f'sh "{PRUEFUNG}"', PULSE_HOSTNAME="chat.example.org")
    assert r.returncode == 0, r.stderr


def test_ohne_adresse_bricht_der_start_ab():
    r = _sh(f'sh "{PRUEFUNG}"')
    assert r.returncode == 1
    assert "PULSE_HOSTNAME" in r.stderr


def test_ungueltige_adresse_bricht_ab():
    r = _sh(f'sh "{PRUEFUNG}"', PULSE_HOSTNAME="kein punkt")
    assert r.returncode == 1


# ── 07-render-env.sh: Zugangsdaten aus dem Datenvolumen ───────────────────


def _verbindung_lesen(tmp_path, inhalt: str | None, **umgebung: str):
    daten = tmp_path / "data"
    (daten / "pulse").mkdir(parents=True)
    if inhalt is not None:
        (daten / "pulse" / "verbindung.env").write_text(inhalt, encoding="utf-8")
    block = _block(RENDER, "# Verbindung mit einem Pulse-Konto", "fi")
    return _sh(f'set -eu\nDATA="{daten}"\n{block}\n{_AUSGABE}\n', **umgebung)


def test_werte_aus_dem_volumen_fuellen_die_luecken(tmp_path):
    r = _verbindung_lesen(tmp_path, ZUGANG + "PULSE_ADMIN_EMAIL=ops@example.org\n")
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip() == (
        "73315227868860500|73315227868860416|Zx9_client-id|geheim_secret-123|ops@example.org"
    )


def test_umgebung_gewinnt(tmp_path):
    """Bestandsserver und Server-App setzen die Werte per Umgebung — sie
    dürfen von einer Datei im Volumen nichts bemerken."""
    r = _verbindung_lesen(
        tmp_path,
        ZUGANG,
        PULSE_INSTANCE_ID="4711",
        PULSE_INSTANCE_OWNER_ID="42",
        PULSE_CLOUD_CLIENT_ID="alt",
        PULSE_CLOUD_CLIENT_SECRET="alt-geheim",
    )
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip() == "4711|42|alt|alt-geheim|"


def test_ohne_datei_bleibt_alles_leer(tmp_path):
    r = _verbindung_lesen(tmp_path, None)
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip() == "||||"


def test_nichts_aus_der_datei_wird_ausgefuehrt(tmp_path):
    marke = tmp_path / "ausgefuehrt"
    inhalt = f"PULSE_INSTANCE_ID=$(touch {marke})\nPATH=/nirgends\nPULSE_CLOUD_CLIENT_ID=abc\n"
    r = _verbindung_lesen(tmp_path, inhalt)
    assert r.returncode == 0, r.stderr
    assert not marke.exists()
    assert r.stdout.strip() == "||abc||"
    assert "ignored" in r.stderr


def _env_datei(pfad: pathlib.Path) -> dict[str, str]:
    """Die Belegung, die ``env_file: .env`` im Container ergibt: ``NAME=wert``,
    ``#`` ist Kommentar, ein leerer Wert bleibt die leere Zeichenkette."""
    belegung = {}
    for zeile in pfad.read_text(encoding="utf-8").splitlines():
        zeile = zeile.strip()
        if zeile and not zeile.startswith("#") and "=" in zeile:
            name, wert = zeile.split("=", 1)
            belegung[name] = wert
    return belegung


def test_env_beispiel_laesst_die_verbindung_leer(tmp_path):
    """``cp .env.example .env`` ist der dokumentierte Weg eines neuen Servers.
    Trüge das Beispiel Platzhalter, gewönnen die gegen ``verbindung.env``
    (Umgebung vor Datei) und ``pulse-connect`` bliebe wirkungslos — der Server
    liefe unter einer erfundenen Nummer."""
    belegung = _env_datei(ENV_BEISPIEL)
    assert belegung["PULSE_HOSTNAME"]
    for name in _ALT[1:]:
        assert belegung.get(name) == "", f"{name} im Beispiel nicht leer: {belegung.get(name)!r}"
    r = _verbindung_lesen(tmp_path, ZUGANG + "PULSE_ADMIN_EMAIL=ops@example.org\n", **belegung)
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip() == (
        "73315227868860500|73315227868860416|Zx9_client-id|geheim_secret-123|ops@example.org"
    )


def test_env_beispiel_behauptet_nichts_ueber_ein_ungelesenes_secret():
    """Das Secret lesen der direct-adapter (``config.rs``) und ``instance_name.py``."""
    text = " ".join(ENV_BEISPIEL.read_text(encoding="utf-8").replace("#", " ").split())
    assert "KEIN Dienst" not in text
    assert "noch nicht implementiert" not in text


# ── 07-render-env.sh: env.sh unter set -u ─────────────────────────────────


def _env_sh(**umgebung: str) -> subprocess.CompletedProcess:
    block = _block(RENDER, "# Self-host identity.", "export PULSE_VERBINDEN_DIR")
    return _sh(
        f"set -eu\nDATA=/data\ncat <<EOF\n{block}\nEOF\n",
        PULSE_HOSTNAME="chat.example.org",
        PULSE_CLOUD_ORIGIN="https://howispulse.com",
        **umgebung,
    )


def test_env_sh_ohne_verbindung():
    r = _env_sh()
    assert r.returncode == 0, r.stderr
    for zeile in (
        "export PULSE_INSTANCE_ID='0'",
        "export PULSE_INSTANCE_OWNER_ID='0'",
        "export PULSE_CLOUD_CLIENT_ID=''",
        "export PULSE_CLOUD_CLIENT_SECRET=''",
        "export PULSE_ADMIN_EMAIL=''",
        "export PULSE_VERBINDEN_DIR='/data/pulse'",
    ):
        assert zeile in r.stdout.splitlines()


def test_env_sh_bestand_unveraendert():
    r = _env_sh(
        PULSE_INSTANCE_ID="4711",
        PULSE_INSTANCE_OWNER_ID="42",
        PULSE_CLOUD_CLIENT_ID="cid",
        PULSE_CLOUD_CLIENT_SECRET="geheim",
        PULSE_ADMIN_EMAIL="admin@firma.de",
    )
    assert r.returncode == 0, r.stderr
    for zeile in (
        "export PULSE_INSTANCE_ID='4711'",
        "export PULSE_INSTANCE_OWNER_ID='42'",
        "export PULSE_CLOUD_CLIENT_ID='cid'",
        "export PULSE_CLOUD_CLIENT_SECRET='geheim'",
        "export PULSE_ADMIN_EMAIL='admin@firma.de'",
    ):
        assert zeile in r.stdout.splitlines()


# ── 09-init-caddy.sh: Admin-Mail optional ─────────────────────────────────


def _caddy(tmp_path, env_sh: str | None) -> tuple[subprocess.CompletedProcess, str]:
    ziel = tmp_path / "Caddyfile"
    shutil.copy(TEMPLATE, ziel)
    datei = tmp_path / "env.sh"
    if env_sh is not None:
        datei.write_text(env_sh, encoding="utf-8")
    block = _block(CADDY, "# Ohne Admin-Mail", "fi")
    skript = f'set -euo pipefail\nTARGET="{ziel}"\nENV_SH="{datei}"\n{block}\n'
    r = subprocess.run(["bash", "-c", skript], env=_umgebung(), capture_output=True, text=True)
    return r, ziel.read_text(encoding="utf-8")


def test_caddy_ohne_admin_mail_hat_keine_leere_email_zeile(tmp_path):
    r, text = _caddy(tmp_path, "export PULSE_ADMIN_EMAIL=''\n")
    assert r.returncode == 0, r.stderr
    assert "email {$PULSE_ADMIN_EMAIL}" not in text
    assert "admin off" in text


def test_caddy_nimmt_die_mail_aus_env_sh(tmp_path):
    """Die Mail kann aus verbindung.env stammen — dann steht sie nur in env.sh."""
    r, text = _caddy(tmp_path, "export PULSE_ADMIN_EMAIL='ops@example.org'\n")
    assert r.returncode == 0, r.stderr
    assert "    email {$PULSE_ADMIN_EMAIL}" in text.splitlines()


def test_caddy_ohne_env_sh_stirbt_nicht(tmp_path):
    r, text = _caddy(tmp_path, None)
    assert r.returncode == 0, r.stderr
    assert "email {$PULSE_ADMIN_EMAIL}" not in text


# ── 01-init-data-dirs.sh: Nachweis eines abgebrochenen pulse-connect ──────


def test_start_raeumt_den_liegengebliebenen_nachweis_weg(tmp_path):
    """SIGHUP/SIGTERM/SIGKILL beim Lauf von pulse-connect lassen den Nachweis
    liegen (sein ``finally`` läuft dann nicht). Der Name kommt aus dem Code des
    chat-gateway, nicht aus dem Skript — ein Auseinanderlaufen fiele sonst nie auf."""
    from dcc_chat_gateway.verbindung import NACHWEIS_DATEI, VERBINDUNG_DATEI

    daten = tmp_path / "data"
    (daten / "pulse").mkdir(parents=True)
    (daten / "pulse" / NACHWEIS_DATEI).write_text("ab" * 32 + "\n", encoding="ascii")
    (daten / "pulse" / VERBINDUNG_DATEI).write_text(ZUGANG, encoding="utf-8")
    block = _block(DATENVERZEICHNISSE, "# Ein Lauf von pulse-connect", "rm -f")
    r = _sh(f'set -eu\nDATA="{daten}"\n{block}\n')
    assert r.returncode == 0, r.stderr
    assert not (daten / "pulse" / NACHWEIS_DATEI).exists()
    assert (daten / "pulse" / VERBINDUNG_DATEI).read_text(encoding="utf-8") == ZUGANG


def test_start_ohne_nachweis_stirbt_nicht(tmp_path):
    """Der Normalfall — und ``set -e`` darf an der fehlenden Datei nicht hängen."""
    daten = tmp_path / "data"
    (daten / "pulse").mkdir(parents=True)
    block = _block(DATENVERZEICHNISSE, "# Ein Lauf von pulse-connect", "rm -f")
    assert _sh(f'set -eu\nDATA="{daten}"\n{block}\n').returncode == 0
