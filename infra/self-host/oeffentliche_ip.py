#!/opt/pulse/venv/bin/python3
"""pulse-oeffentliche-ip — die öffentliche IPv4 dieses Servers per STUN.

    pulse-oeffentliche-ip <host:port> [<host:port> …]

Fragt die STUN-Server der Reihe nach (je bis zu ``VERSUCHE`` Pakete — UDP geht
verloren, und ein einziges verlorenes Paket hiesse sonst: bis zum nächsten
Containerstart keine öffentliche Adresse) und gibt die erste Antwort auf stdout
aus. Exit 0 mit Adresse, Exit 1, wenn keiner antwortet. Gebraucht von
``08-init-mediamtx.sh``, damit MediaMTX auf einem Self-Host neben dem Hostnamen
auch die öffentliche Adresse ankündigt — ermittelt auf demselben Weg (STUN,
aus demselben Container), auf dem LiveKit über ``use_external_ip``
(``templates/livekit.yaml.template``) seine Adresse findet.

**Warum nicht einfach der Hostname.** MediaMTX löst ``webrtcAdditionalHosts``
bei jeder Sitzung im Container per DNS auf (``net.LookupIP``,
``internal/protocols/webrtc/peer_connection.go`` in 1.19.1). Steht der Server
in einem Firmennetz mit Split-DNS, liefert der interne DNS die interne Adresse,
und genau die bekommen Zuschauer und Sender von außen als einzigen Kandidaten.

Nur die Standardbibliothek: das Werkzeug läuft beim Containerstart, bevor
irgendein Dienst steht, und darf an nichts weiter hängen.
"""

from __future__ import annotations

import os
import socket
import struct
import sys

MAGIC = 0x2112A442
BINDING_ANFRAGE = 0x0001
BINDING_ANTWORT = 0x0101
XOR_MAPPED_ADDRESS = 0x0020
MAPPED_ADDRESS = 0x0001
WARTEZEIT_S = 0.8
VERSUCHE = 3


def anfrage(tid: bytes) -> bytes:
    """Binding-Anfrage ohne Attribute (RFC 5389, Abschnitt 6)."""
    return struct.pack("!HHI", BINDING_ANFRAGE, 0, MAGIC) + tid


def lies_adresse(antwort: bytes, tid: bytes) -> str | None:
    """Die gespiegelte IPv4 aus einer Binding-Antwort, sonst ``None``.

    Bevorzugt XOR-MAPPED-ADDRESS; MAPPED-ADDRESS nur als Rückfall für alte
    Server (RFC 3489), die das XOR-Attribut nicht kennen.
    """
    if len(antwort) < 20:
        return None
    typ, laenge, magic = struct.unpack("!HHI", antwort[:8])
    if typ != BINDING_ANTWORT or magic != MAGIC or antwort[8:20] != tid:
        return None
    rest = antwort[20 : 20 + laenge]
    rueckfall = None
    while len(rest) >= 4:
        art, alen = struct.unpack("!HH", rest[:4])
        wert = rest[4 : 4 + alen]
        if art in (XOR_MAPPED_ADDRESS, MAPPED_ADDRESS) and len(wert) >= 8 and wert[1] == 0x01:
            roh = struct.unpack("!I", wert[4:8])[0]
            if art == XOR_MAPPED_ADDRESS:
                return socket.inet_ntoa(struct.pack("!I", roh ^ MAGIC))
            rueckfall = socket.inet_ntoa(struct.pack("!I", roh))
        # Attribute sind auf 4 Byte aufgefüllt.
        rest = rest[4 + alen + (-alen % 4) :]
    return rueckfall


def frage(ziel: str) -> str | None:
    """Einen STUN-Server (``host:port``) fragen; ``None`` bei jedem Fehler."""
    host, _, port = ziel.rpartition(":")
    if not host or not port.isdigit():
        return None
    try:
        adresse = socket.getaddrinfo(host, int(port), socket.AF_INET, socket.SOCK_DGRAM)[0][4]
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.settimeout(WARTEZEIT_S)
            # Jede gesendete Kennung gilt: eine verspätete Antwort auf den
            # ersten Versuch, die erst im zweiten eintrifft, ist genauso gut.
            gesendet: list[bytes] = []
            for _ in range(VERSUCHE):
                gesendet.append(os.urandom(12))
                s.sendto(anfrage(gesendet[-1]), adresse)
                try:
                    antwort, _ = s.recvfrom(2048)
                except TimeoutError:
                    continue
                for tid in gesendet:
                    ip = lies_adresse(antwort, tid)
                    if ip:
                        return ip
    except OSError:
        return None
    return None


def main(argv: list[str]) -> int:
    for ziel in argv:
        ip = frage(ziel)
        if ip:
            print(ip)
            return 0
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
