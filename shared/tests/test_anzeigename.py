"""Bereinigung des Server-Anzeigenamens — dieselbe Funktion auf dem Server und
in der Cloud (``dcc_shared.anzeigename``).

Sonderzeichen stehen hier als ``\\u``-Escapes, damit man im Quelltext sieht,
was geprüft wird.
"""

from __future__ import annotations

import pytest

from dcc_shared.anzeigename import bereinige_anzeigename

ZWJ = "‍"
FAMILIE = f"\U0001f468{ZWJ}\U0001f469{ZWJ}\U0001f467"
REGENBOGENFLAGGE = f"\U0001f3f3️{ZWJ}\U0001f308"


@pytest.mark.parametrize(
    ("roh", "erwartet"),
    [
        ("Michaels Server", "Michaels Server"),
        ("  Michaels\u0007 Server \n", "Michaels Server"),
        ("Zeile\neins", "Zeileeins"),
        ("Tab\there", "Tabhere"),
        ("a b c", "abc"),  # Zeilen- und Absatztrenner
        ("Büro — Süd", "Büro — Süd"),
        ("Café ß Ünï", "Café ß Ünï"),
    ],
)
def test_entfernt_steuerzeichen_und_ränder(roh: str, erwartet: str) -> None:
    assert bereinige_anzeigename(roh) == erwartet


@pytest.mark.parametrize(
    "roh", [None, "", "   ", "\u0007\t", "​﻿", " 　 "]
)
def test_leer_heißt_zurücksetzen(roh: str | None) -> None:
    assert bereinige_anzeigename(roh) is None


def test_zusammengesetzte_emoji_bleiben_heil() -> None:
    """Der Zero-Width-Joiner hält Familien-/Flaggen-Emoji zusammen; ihn zu
    entfernen ließe sie in Einzel-Emoji zerfallen."""
    assert bereinige_anzeigename(f"Clan {FAMILIE}") == f"Clan {FAMILIE}"
    assert bereinige_anzeigename(REGENBOGENFLAGGE) == REGENBOGENFLAGGE


def test_persisches_zwnj_bleibt() -> None:
    wort = "می‌خواهم"
    assert bereinige_anzeigename(wort) == wort


def test_sonderleerzeichen_werden_zu_einem_normalen() -> None:
    """Ein No-Break-Space oder ideographisches Leerzeichen ist ein Wortabstand,
    keine Lücke, die man löscht („MeinServer“)."""
    assert bereinige_anzeigename("Mein Server") == "Mein Server"
    assert bereinige_anzeigename("ミニ　サーバー") == "ミニ サーバー"


def test_unsichtbare_breite_null_zeichen_fallen_weg() -> None:
    assert bereinige_anzeigename("Ad​min﻿") == "Admin"
