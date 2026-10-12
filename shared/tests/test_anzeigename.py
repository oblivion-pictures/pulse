"""Bereinigung des Server-Anzeigenamens — dieselbe Funktion auf dem Server und
in der Cloud (``dcc_shared.anzeigename``).

Sonderzeichen stehen hier ausschließlich als ``\\u``-Escapes, damit man im
Quelltext sieht, was geprüft wird.
"""

from __future__ import annotations

import pytest

from dcc_shared.anzeigename import bereinige_anzeigename

ZWJ = "\u200d"
ZWNJ = "\u200c"
VS16 = "\ufe0f"
FAMILIE = f"\U0001f468{ZWJ}\U0001f469{ZWJ}\U0001f467"
REGENBOGENFLAGGE = f"\U0001f3f3{VS16}{ZWJ}\U0001f308"
TAG_GBENG = "".join(chr(0xE0000 + ord(c)) for c in "gbeng")
# England: schwarze Flagge + Tag-Buchstaben g b e n g + Cancel-Tag
ENGLAND = "\U0001f3f4" + TAG_GBENG + "\U000e007f"


@pytest.mark.parametrize(
    ("roh", "erwartet"),
    [
        ("Michaels Server", "Michaels Server"),
        ("  Michaels\u0007 Server \n", "Michaels Server"),
        ("Büro — Süd", "Büro — Süd"),
        ("Café ß Ünï", "Café ß Ünï"),
        ("日本語のサーバー", "日本語のサーバー"),
    ],
)
def test_entfernt_steuerzeichen_und_ränder(roh: str, erwartet: str) -> None:
    assert bereinige_anzeigename(roh) == erwartet


@pytest.mark.parametrize(
    ("roh", "erwartet"),
    [
        ("Zeile\neins", "Zeile eins"),
        ("Tab\there", "Tab here"),
        ("a\r\nb", "a b"),
        ("a\u2028b\u2029c", "a b c"),  # Zeilen- und Absatztrenner
        ("Mein\u00a0Server", "Mein Server"),  # No-Break-Space
        ("ミニ\u3000サーバー", "ミニ サーバー"),
        ("viel     Platz", "viel Platz"),
        ("  \t Rand \n ", "Rand"),
    ],
)
def test_jedes_leerzeichen_wird_eins_und_mehrere_werden_zu_einem(roh: str, erwartet: str) -> None:
    assert bereinige_anzeigename(roh) == erwartet


@pytest.mark.parametrize(
    ("roh", "erwartet"),
    [
        ("Admin\u202etxt", "Admintxt"),  # RLO kehrt den Rest um
        ("\u202dLeise\u202c", "Leise"),  # LRO ... PDF
        ("\u202aeins\u202b zwei\u202c", "eins zwei"),  # LRE / RLE
        ("a\u2066b\u2067c\u2068d\u2069", "abcd"),  # LRI RLI FSI PDI
        ("a\u200eb\u200fc", "abc"),  # LRM / RLM
        ("a\u061cb", "ab"),  # ALM
        ("Soft\u00adHyphen", "SoftHyphen"),
        ("Ad\u200bmin\ufeff", "Admin"),  # Null-Breite-Leerzeichen, BOM
        ("Join\u2060er", "Joiner"),  # Word-Joiner
        ("a\u2061b\u2062c\u2063d\u2064e", "abcde"),  # unsichtbare Operatoren
        ("a\u206ab\u206fc", "abc"),  # veraltete Format-Steuerzeichen
    ],
)
def test_richtungssteuerung_und_unsichtbares_fällt_weg(roh: str, erwartet: str) -> None:
    assert bereinige_anzeigename(roh) == erwartet


@pytest.mark.parametrize(
    "roh",
    [
        None,
        "",
        "   ",
        "\u0007\t",
        "\u200b\ufeff",
        "\u202e",
        "\u2066\u2069",
        "\u200e\u200f",
        "\u00ad",
        "\u00a0\u3000 ",
        # Nur Formatzeichen, die erhalten bleiben: nichts Sichtbares dahinter.
        ZWJ,
        ZWNJ + ZWJ,
        VS16,
        TAG_GBENG,
        " \u202e \u200d \u200b ",
    ],
)
def test_ohne_sichtbares_zeichen_gilt_der_name_als_leer(roh: str | None) -> None:
    assert bereinige_anzeigename(roh) is None


def test_zusammengesetzte_emoji_bleiben_heil() -> None:
    """Der Zero-Width-Joiner hält Familien-/Flaggen-Emoji zusammen; ihn zu
    entfernen ließe sie in Einzel-Emoji zerfallen."""
    assert bereinige_anzeigename(f"Clan {FAMILIE}") == f"Clan {FAMILIE}"
    assert bereinige_anzeigename(REGENBOGENFLAGGE) == REGENBOGENFLAGGE


def test_england_flagge_behält_ihre_tag_zeichen() -> None:
    name = f"Pub {ENGLAND}"
    assert bereinige_anzeigename(name) == name


def test_variantenselektor_bleibt() -> None:
    herz = "❤" + VS16
    assert bereinige_anzeigename(f"Mit {herz}") == f"Mit {herz}"


def test_persisches_zwnj_bleibt() -> None:
    wort = "می" + ZWNJ + "خواهم"
    assert bereinige_anzeigename(wort) == wort


def test_zwj_neben_sichtbarem_ist_nicht_leer() -> None:
    assert bereinige_anzeigename(f"{ZWJ}\U0001f600{ZWJ}") == f"{ZWJ}\U0001f600{ZWJ}"
