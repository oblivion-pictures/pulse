"""pulse-oeffentliche-ip (STUN) und die VPS-Kandidatenzeile in 08-init-mediamtx.sh.

Anlass (2026-10-14, pulse.all3media.de): MediaMTX löst den Hostnamen aus
``webrtcAdditionalHosts`` im Container per DNS auf. Bei Split-DNS kündigt er nur
die interne Adresse an, und von außen kommt ICE nie zustande. Der VPS-Zweig
kündigt deshalb zusätzlich die per STUN ermittelte öffentliche IPv4 an.
"""

from __future__ import annotations

import importlib.util
import pathlib
import socket
import struct
import subprocess
import threading

import pytest
import yaml

WERKZEUG = pathlib.Path(__file__).resolve().parents[1] / "oeffentliche_ip.py"
SKRIPT = "etc/s6-overlay/scripts/08-init-mediamtx.sh"


@pytest.fixture(scope="module")
def stun():
    spec = importlib.util.spec_from_file_location("oeffentliche_ip", WERKZEUG)
    modul = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(modul)
    return modul


def _antwort(stun, tid: bytes, ip: str, *, xor: bool = True, vorweg: bytes = b"") -> bytes:
    roh = struct.unpack("!I", socket.inet_aton(ip))[0]
    if xor:
        roh ^= stun.MAGIC
    wert = struct.pack("!BBHI", 0, 0x01, 0x1234, roh)
    art = stun.XOR_MAPPED_ADDRESS if xor else stun.MAPPED_ADDRESS
    attribute = vorweg + struct.pack("!HH", art, len(wert)) + wert
    return struct.pack("!HHI", stun.BINDING_ANTWORT, len(attribute), stun.MAGIC) + tid + attribute


TID = bytes(range(12))


def test_xor_mapped_address_wird_gelesen(stun):
    assert stun.lies_adresse(_antwort(stun, TID, "203.0.113.7"), TID) == "203.0.113.7"


def test_mapped_address_als_rueckfall(stun):
    assert stun.lies_adresse(_antwort(stun, TID, "198.51.100.4", xor=False), TID) == "198.51.100.4"


def test_fremdes_attribut_davor_wird_uebersprungen(stun):
    # SOFTWARE-Attribut mit 5 Byte → auf 8 aufgefüllt; der Leser muss die
    # Auffüllung überspringen, sonst liest er Müll.
    vorweg = struct.pack("!HH", 0x8022, 5) + b"pulse" + b"\0\0\0"
    assert stun.lies_adresse(_antwort(stun, TID, "203.0.113.9", vorweg=vorweg), TID) == "203.0.113.9"


def test_fremde_transaktion_wird_verworfen(stun):
    assert stun.lies_adresse(_antwort(stun, TID, "203.0.113.7"), bytes(12)) is None


def test_xor_gewinnt_auch_wenn_mapped_vorher_kommt(stun):
    roh = struct.unpack("!I", socket.inet_aton("198.51.100.4"))[0]
    mapped = struct.pack("!HH", stun.MAPPED_ADDRESS, 8) + struct.pack("!BBHI", 0, 0x01, 1, roh)
    assert stun.lies_adresse(_antwort(stun, TID, "203.0.113.7", vorweg=mapped), TID) == "203.0.113.7"


def test_ipv6_attribut_wird_uebersprungen(stun):
    # Familie 0x02 (IPv6), 20 Byte Wert — darf weder gelesen noch falsch
    # zerlegt werden; die IPv4 dahinter zählt.
    v6 = struct.pack("!HH", stun.XOR_MAPPED_ADDRESS, 20) + struct.pack("!BBH", 0, 0x02, 1) + bytes(16)
    assert stun.lies_adresse(_antwort(stun, TID, "203.0.113.8", vorweg=v6), TID) == "203.0.113.8"


def test_kurze_oder_falsche_antwort(stun):
    assert stun.lies_adresse(b"", TID) is None
    falsch = bytearray(_antwort(stun, TID, "203.0.113.7"))
    falsch[0:2] = struct.pack("!H", 0x0111)  # Fehler-Antwort statt Erfolg
    assert stun.lies_adresse(bytes(falsch), TID) is None


@pytest.fixture
def schein_server(stun):
    """Ein STUN-Server auf 127.0.0.1, der die ERSTE Anfrage verschluckt (ein
    verlorenes Paket) und die zweite beantwortet."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.bind(("127.0.0.1", 0))
    s.settimeout(5)

    def antworte():
        try:
            s.recvfrom(2048)
            daten, absender = s.recvfrom(2048)
        except OSError:
            return
        s.sendto(_antwort(stun, daten[8:20], "203.0.113.42"), absender)

    t = threading.Thread(target=antworte, daemon=True)
    t.start()
    yield f"127.0.0.1:{s.getsockname()[1]}"
    t.join(timeout=5)
    s.close()


def test_main_fragt_der_reihe_nach_und_wiederholt(stun, schein_server, capsys, monkeypatch):
    monkeypatch.setattr(stun, "WARTEZEIT_S", 0.2)
    # Der erste Eintrag ist kaputt, der zweite antwortet nie — erst der dritte,
    # und der auch erst auf die Wiederholung.
    tot = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    tot.bind(("127.0.0.1", 0))
    try:
        stumm = f"127.0.0.1:{tot.getsockname()[1]}"
        assert stun.main(["kaputt", stumm, schein_server]) == 0
    finally:
        tot.close()
    assert capsys.readouterr().out.strip() == "203.0.113.42"


def test_main_ohne_antwort_exit_1(stun, monkeypatch, capsys):
    monkeypatch.setattr(stun, "WARTEZEIT_S", 0.2)
    tot = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    tot.bind(("127.0.0.1", 0))
    try:
        assert stun.main([f"127.0.0.1:{tot.getsockname()[1]}"]) == 1
    finally:
        tot.close()
    assert capsys.readouterr().out == ""


@pytest.fixture
def vps_zeile(skript_funktion):
    quelle = skript_funktion(SKRIPT, "vps_kandidaten_zeile")

    def lauf(host: str, ip: str, intern: str) -> list[str]:
        r = subprocess.run(
            ["sh", "-c", f'set -eu\n{quelle}\nvps_kandidaten_zeile "$1" "$2" "$3"', "x", host, ip, intern],
            capture_output=True,
            text=True,
        )
        assert r.returncode == 0, r.stderr
        dok = yaml.safe_load(r.stdout)
        assert list(dok) == ["webrtcAdditionalHosts"]
        return dok["webrtcAdditionalHosts"]

    return lauf


def test_split_dns_hostname_und_oeffentliche_ip(vps_zeile):
    # Der Fall von 2026-10-14: intern zeigt der Name auf die LAN-Adresse.
    assert vps_zeile("pulse.example.com", "203.0.113.7", "10.20.0.5") == [
        "pulse.example.com",
        "203.0.113.7",
    ]


def test_gewoehnlicher_vps_bleibt_wie_bisher(vps_zeile):
    # Name zeigt schon auf die öffentliche Adresse → keine Doppelung.
    assert vps_zeile("pulse.example.com", "203.0.113.7", "203.0.113.7") == ["pulse.example.com"]
    assert vps_zeile("pulse.example.com", "203.0.113.7", "10.0.0.1 203.0.113.7") == ["pulse.example.com"]


def test_teilstring_zaehlt_nicht_als_treffer(vps_zeile):
    assert vps_zeile("pulse.example.com", "3.0.113.7", "203.0.113.7") == [
        "pulse.example.com",
        "3.0.113.7",
    ]


def test_im_container_nicht_aufloesbar_nur_ip(vps_zeile):
    # MediaMTX bräche beim nicht auflösbaren Namen ab — die IP käme nie an.
    assert vps_zeile("pulse.example.com", "203.0.113.7", "") == ["203.0.113.7"]


def test_ohne_oeffentliche_ip_nur_hostname_wie_bisher(vps_zeile):
    assert vps_zeile("pulse.example.com", "", "10.20.0.5") == ["pulse.example.com"]
    assert vps_zeile("pulse.example.com", "", "") == ["pulse.example.com"]


@pytest.mark.parametrize("kaputt", ["fe80::1", "1..2.3", "1.2.3", "1.2.3.4.5", ".1.2.3", "host.example", "Fehler"])
def test_kaputte_ip_faellt_heraus(vps_zeile, kaputt):
    assert vps_zeile("pulse.example.com", kaputt, "10.20.0.5") == ["pulse.example.com"]
