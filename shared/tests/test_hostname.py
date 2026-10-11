"""Eine Schreibweise fuer jede Server-Adresse.

Die Cloud traegt beim Verbinden eines Servers dessen Adresse in
``auth.registered_instances.hostname`` ein und findet ihn spaeter darueber
wieder (Serverticket, Uebernahme). Kaeme dieselbe Adresse einmal mit Schema,
Port oder Grossbuchstaben an, entstuenden zwei Eintraege fuer einen Server.
"""

from __future__ import annotations

import pytest

from dcc_shared.hostname import normalisiere_hostname


@pytest.mark.parametrize(
    ("roh", "erwartet"),
    [
        ("chat.example.org", "chat.example.org"),
        ("Chat.Example.ORG", "chat.example.org"),
        ("https://chat.example.org", "chat.example.org"),
        ("https://chat.example.org:443/", "chat.example.org"),
        ("chat.example.org:8443", "chat.example.org"),
        ("  chat.example.org.  ", "chat.example.org"),
        ("xn--bcher-kva.example", "xn--bcher-kva.example"),
        ("pulse.xn--p1ai", "pulse.xn--p1ai"),
    ],
)
def test_gueltige_adressen(roh, erwartet):
    assert normalisiere_hostname(roh) == erwartet


@pytest.mark.parametrize(
    "roh",
    [
        "",
        "   ",
        "localhost",
        "127.0.0.1",
        "[::1]",
        "-boese.example.org",
        "a..b.org",
        "bücher.de",
        "x" * 250 + ".org",
    ],
)
def test_ungueltige_adressen(roh):
    assert normalisiere_hostname(roh) is None
