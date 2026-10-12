"""pulse-livekit-node-ip (infra/self-host/livekit-node-ip.sh).

Setzt die öffentliche IPv4 als LiveKit-``node_ip`` statt STUN (Firefox im
selben Heimnetz bekam sonst nur die öffentliche Adresse, Linux-Test
2026-10-08) und, seit 2026-10-12, die LAN-IPv4 als ``extra_node_ips`` daneben
(im node_ip-Weg ersetzt LiveKit sonst jede lokale Adresse durch die
öffentliche — Geräte im Heimnetz bräuchten Hairpin-NAT). Geprüft wird das
echte Skript gegen das echte Template: das Ergebnis muss gültiges YAML mit
genau den erwarteten RTC-Schaltern sein, ein zweiter Aufruf (IP-Wechsel) darf
nichts doppeln, und die Aufrufformen älterer Server-Apps müssen weiter
genau das tun, was sie vorher taten.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest
import yaml

WURZEL = Path(__file__).resolve().parents[1]
SKRIPT = WURZEL / "livekit-node-ip.sh"
TEMPLATE = WURZEL / "templates" / "livekit.yaml.template"

OEFFENTLICH = "203.0.113.7"
LAN = "192.168.178.20"


def _lauf(datei: Path, *args: str, s6: Path | None = None) -> subprocess.CompletedProcess[str]:
    env = {**os.environ, "LIVEKIT_YAML": str(datei)}
    if s6 is not None:
        env["PULSE_S6_SVC"] = str(s6)
    return subprocess.run(["sh", str(SKRIPT), *args], env=env, capture_output=True, text=True)


def _rtc(datei: Path) -> dict:
    return yaml.safe_load(datei.read_text())["rtc"]


def _zeilen(datei: Path, schluessel: str) -> list[str]:
    # Nur echte Schlüssel zählen — das Template erwähnt beide auch im Kommentar.
    return [z for z in datei.read_text().splitlines() if z.startswith(f"  {schluessel}: ")]


@pytest.fixture
def yaml_datei(tmp_path: Path) -> Path:
    ziel = tmp_path / "livekit.yaml"
    ziel.write_text(
        TEMPLATE.read_text()
        .replace("@@LIVEKIT_KEY@@", "k")
        .replace("@@LIVEKIT_SECRET@@", "s")
        .replace("@@PULSE_HOSTNAME@@", "x.example.com")
    )
    return ziel


@pytest.fixture
def s6_attrappe(tmp_path: Path) -> tuple[Path, Path]:
    """Ersatz für /command/s6-svc, der seine Argumente mitschreibt."""
    protokoll = tmp_path / "s6-aufrufe"
    attrappe = tmp_path / "s6-svc"
    attrappe.write_text(f'#!/bin/sh\necho "$@" >> {protokoll}\n')
    attrappe.chmod(0o755)
    return attrappe, protokoll


def test_template_ohne_skript_bleibt_stun_weg(yaml_datei: Path) -> None:
    # VPS-Self-Hosts (Installer/Compose) setzen kein PULSE_PUBLIC_IPV4, das
    # Skript läuft dort nie: das gerenderte Template ist ihre livekit.yaml, und
    # ohne extra_node_ips verhält sich der gepatchte LiveKit wie der offizielle.
    rtc = _rtc(yaml_datei)
    assert rtc["use_external_ip"] is True
    assert rtc["skip_external_ip_validation"] is True
    assert "node_ip" not in rtc
    assert "extra_node_ips" not in rtc


def test_setzt_node_ip_und_schaltet_stun_ab(yaml_datei: Path) -> None:
    r = _lauf(yaml_datei, OEFFENTLICH)
    assert r.returncode == 0, r.stderr
    rtc = _rtc(yaml_datei)
    assert rtc["node_ip"] == OEFFENTLICH
    assert rtc["use_external_ip"] is False
    assert "skip_external_ip_validation" not in rtc
    # Ohne --lan keine Zusatzadresse — und advertise_internal_ip bringt im
    # node_ip-Weg keine (wirkt nur im STUN-Weg), bleibt aber stehen.
    assert "extra_node_ips" not in rtc
    assert rtc["advertise_internal_ip"] is True
    assert rtc["ips"]["excludes"] == ["::/0"]


def test_ip_wechsel_ersetzt_statt_zu_doppeln(yaml_datei: Path) -> None:
    assert _lauf(yaml_datei, OEFFENTLICH).returncode == 0
    assert _lauf(yaml_datei, "198.51.100.9").returncode == 0
    assert _zeilen(yaml_datei, "node_ip") == ["  node_ip: 198.51.100.9"]
    assert _rtc(yaml_datei)["node_ip"] == "198.51.100.9"
    assert _lauf(yaml_datei, "--zeige").stdout.strip() == "198.51.100.9"


@pytest.mark.parametrize("wert", ["", "1.2.3", "1.2.3.4; rm -rf /", "::1", "1.2.3.4\nnode_ip: 9.9.9.9"])
def test_weist_alles_ausser_einer_nackten_ipv4_ab(yaml_datei: Path, wert: str) -> None:
    vorher = yaml_datei.read_text()
    r = _lauf(yaml_datei, wert)
    assert r.returncode == 2
    assert yaml_datei.read_text() == vorher


def test_zeige_ohne_node_ip_ist_leer(yaml_datei: Path) -> None:
    assert _lauf(yaml_datei, "--zeige").stdout.strip() == ""
    assert _lauf(yaml_datei, "--zeige-lan").stdout.strip() == ""


# ── LAN-Adresse (extra_node_ips) ─────────────────────────────────────────────


def test_lan_wird_als_extra_node_ips_gesetzt(yaml_datei: Path) -> None:
    r = _lauf(yaml_datei, OEFFENTLICH, "--lan", LAN)
    assert r.returncode == 0, r.stderr
    rtc = _rtc(yaml_datei)
    assert rtc["node_ip"] == OEFFENTLICH
    assert rtc["extra_node_ips"] == [LAN]
    assert rtc["use_external_ip"] is False


def test_zeige_bleibt_einzeilig_und_zeige_lan_liefert_die_lan_adresse(yaml_datei: Path) -> None:
    # Ältere Server-Apps vergleichen `--zeige` wörtlich mit ihrer öffentlichen
    # IP — eine zweite Zeile liesse sie LiveKit alle zwei Minuten neu starten.
    assert _lauf(yaml_datei, OEFFENTLICH, "--lan", LAN).returncode == 0
    zeige = _lauf(yaml_datei, "--zeige")
    assert zeige.returncode == 0
    assert zeige.stdout == f"{OEFFENTLICH}\n"
    zeige_lan = _lauf(yaml_datei, "--zeige-lan")
    assert zeige_lan.returncode == 0
    assert zeige_lan.stdout == f"{LAN}\n"


def test_lan_wechsel_ersetzt_statt_zu_doppeln(yaml_datei: Path) -> None:
    assert _lauf(yaml_datei, OEFFENTLICH, "--lan", LAN).returncode == 0
    assert _lauf(yaml_datei, OEFFENTLICH, "--lan", "192.168.178.31").returncode == 0
    assert _zeilen(yaml_datei, "extra_node_ips") == ["  extra_node_ips: [192.168.178.31]"]
    assert _zeilen(yaml_datei, "node_ip") == [f"  node_ip: {OEFFENTLICH}"]


def test_ohne_lan_entfernt_die_zusatzadresse(yaml_datei: Path) -> None:
    assert _lauf(yaml_datei, OEFFENTLICH, "--lan", LAN).returncode == 0
    r = _lauf(yaml_datei, OEFFENTLICH, "--ohne-lan")
    assert r.returncode == 0, r.stderr
    assert "extra_node_ips" not in _rtc(yaml_datei)
    assert _lauf(yaml_datei, "--zeige-lan").stdout == ""


def test_alte_aufrufform_laesst_lan_stehen(yaml_datei: Path) -> None:
    # Abgleich einer älteren Server-App gegen ein neues Image: sie kennt nur
    # `<ip>` (und `<ip> --neustart`) und darf die LAN-Adresse nicht verlieren.
    assert _lauf(yaml_datei, OEFFENTLICH, "--lan", LAN).returncode == 0
    assert _lauf(yaml_datei, "198.51.100.9").returncode == 0
    rtc = _rtc(yaml_datei)
    assert rtc["node_ip"] == "198.51.100.9"
    assert rtc["extra_node_ips"] == [LAN]


def test_lan_gleich_oeffentlich_kuendigt_nur_node_ip_an(yaml_datei: Path) -> None:
    # Rechner direkt am Netz: dieselbe Adresse zweimal brächte nichts.
    assert _lauf(yaml_datei, OEFFENTLICH, "--lan", LAN).returncode == 0
    assert _lauf(yaml_datei, OEFFENTLICH, "--lan", OEFFENTLICH).returncode == 0
    rtc = _rtc(yaml_datei)
    assert rtc["node_ip"] == OEFFENTLICH
    assert "extra_node_ips" not in rtc


@pytest.mark.parametrize("wert", ["", "1.2.3", "192.168.1.2]\n  node_ip: 9.9.9.9", "fe80::1", "a.b.c.d"])
def test_weist_ungueltige_lan_adresse_ab(yaml_datei: Path, wert: str) -> None:
    assert _lauf(yaml_datei, OEFFENTLICH).returncode == 0
    vorher = yaml_datei.read_text()
    r = _lauf(yaml_datei, OEFFENTLICH, "--lan", wert)
    assert r.returncode == 2
    assert yaml_datei.read_text() == vorher


def test_lan_ohne_wert_und_unbekanntes_argument(yaml_datei: Path) -> None:
    vorher = yaml_datei.read_text()
    assert _lauf(yaml_datei, OEFFENTLICH, "--lan").returncode == 2
    assert _lauf(yaml_datei, OEFFENTLICH, "--irgendwas").returncode == 2
    assert yaml_datei.read_text() == vorher


def test_aufruf_der_app_mit_neustart(yaml_datei: Path, s6_attrappe: tuple[Path, Path]) -> None:
    # Genau die Form aus desktop/…/oeffentlicheIp.ts::nodeIpSkriptArgumente:
    # `--neustart` an zweiter Stelle, die LAN-Angabe dahinter.
    attrappe, protokoll = s6_attrappe
    r = _lauf(yaml_datei, OEFFENTLICH, "--neustart", "--lan", LAN, s6=attrappe)
    assert r.returncode == 0, r.stderr
    assert protokoll.read_text() == "-r /run/service/livekit\n"
    assert _rtc(yaml_datei)["extra_node_ips"] == [LAN]
    r = _lauf(yaml_datei, OEFFENTLICH, "--neustart", "--ohne-lan", s6=attrappe)
    assert r.returncode == 0, r.stderr
    assert protokoll.read_text().count("-r /run/service/livekit") == 2
    assert "extra_node_ips" not in _rtc(yaml_datei)


def test_ohne_neustart_wird_nichts_neu_gestartet(yaml_datei: Path, s6_attrappe: tuple[Path, Path]) -> None:
    attrappe, protokoll = s6_attrappe
    assert _lauf(yaml_datei, OEFFENTLICH, "--lan", LAN, s6=attrappe).returncode == 0
    assert not protokoll.exists()


def test_ohne_use_external_ip_bleibt_die_datei_unberuehrt(tmp_path: Path) -> None:
    # Minimal-Konfiguration aus 05-init-livekit.sh (Template fehlt): keine
    # Stelle für node_ip — nichts schreiben, Exit 3.
    datei = tmp_path / "livekit.yaml"
    datei.write_text("port: 7880\nrtc:\n  tcp_port: 7881\n")
    vorher = datei.read_text()
    r = _lauf(datei, OEFFENTLICH, "--lan", LAN)
    assert r.returncode == 3
    assert datei.read_text() == vorher
