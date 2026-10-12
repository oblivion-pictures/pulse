"""Der Anzeigename eines Self-Hosts — eine Bereinigung für beide Wege.

Der Betreiber gibt seinem Server einen Namen (``chat_settings.instance_name``
im chat-gateway des Servers). Derselbe Name erscheint in jeder Server-Leiste:
live vom Server selbst und über die Cloud (``registered_instances.anzeigename``,
``POST /selfhost/anzeigename``). Beide Wege müssen DENSELBEN Text ergeben —
sonst hieße ein Server je nach Weg zweimal anders. Deshalb steht die Regel
hier, nicht zweimal.

Was die Bereinigung tut:

* **Jedes Leerzeichen-artige Zeichen wird ein Leerzeichen** (Tab, Zeilenumbruch,
  No-Break-Space, ideographisches Leerzeichen, Zeilen-/Absatztrenner), mehrere
  hintereinander werden eins, die Ränder fallen weg. Ein Name ist eine einzelne
  Zeile; ein Wortabstand soll keine Lücke im Wort werden („MeinServer“).
* **Steuerzeichen fallen weg**, ebenso eine enge Liste unsichtbarer Format-
  zeichen (``_FORMAT_SPERRE``): die Richtungssteuerung (RLO/LRO/Isolate/LRM/RLM/
  ALM) kehrt Text um oder verdeckt ihn, Soft-Hyphen, Null-Breite-Leerzeichen,
  Word-Joiner und die Byte-Order-Marke machen einen Namen unsichtbar oder
  täuschen eine Gleichheit vor. Sie gingen über die Cloud an alle Mitglieder.
* **Bleibt nichts Sichtbares übrig**, gilt der Name als leer — der Server zeigt
  dann wieder seine Adresse.

**Bewusst erhalten** bleiben der Zero-Width-Joiner (U+200D) und -Non-Joiner
(U+200C), die Variantenselektoren und die Tag-Zeichen (U+E0020–E007F): ohne sie
zerfällt ein Familien-Emoji in drei einzelne, die England-Flagge in eine
schwarze Flagge samt Buchstaben, und persische Namen verlieren ihre
Schreibweise. ``str.isprintable()`` war dafür zu grob — es verwirft jedes
Format- und Leerzeichen-Zeichen und, je nach Unicode-Stand der Laufzeit, jedes
neue Emoji.
"""

from __future__ import annotations

import unicodedata


def _bereich(von: int, bis: int) -> set[str]:
    return {chr(c) for c in range(von, bis + 1)}


#: Unsichtbare Format-Zeichen (Kategorie Cf), die einen Namen leer wirken lassen
#: oder die Leserichtung verändern. Eng gehalten: ZWJ/ZWNJ, Variantenselektoren
#: und Tag-Zeichen stehen NICHT darin (s. Modulkopf).
_FORMAT_SPERRE: frozenset[str] = frozenset(
    {"\u00ad", "\u061c", "\u180e", "\u200b", "\u200e", "\u200f", "\ufeff"}
    | _bereich(0x202A, 0x202E)  # LRE RLE PDF LRO RLO
    | _bereich(0x2060, 0x2064)  # Word-Joiner, unsichtbare Operatoren
    | _bereich(0x2066, 0x2069)  # Isolate LRI RLI FSI PDI
    | _bereich(0x206A, 0x206F)  # veraltete Format-Steuerzeichen
    | _bereich(0xFFF9, 0xFFFB)  # Interlinear-Annotation
)

#: Kategorien, die für sich nichts Sichtbares ergeben.
_UNSICHTBAR = {"Cf", "Cc", "Zs", "Zl", "Zp"}


def _sichtbar(z: str) -> bool:
    if z == " ":
        return False
    if unicodedata.category(z) in _UNSICHTBAR:
        return False
    # Variantenselektoren (Mn) stehen hinter einem Zeichen, allein zeigen sie nichts.
    return not (0xFE00 <= ord(z) <= 0xFE0F or 0xE0100 <= ord(z) <= 0xE01EF)


def bereinige_anzeigename(name: str | None) -> str | None:
    """Bereinigter Name, oder ``None`` (= keiner gesetzt / zurückgesetzt)."""
    aus: list[str] = []
    for z in name or "":
        if z.isspace():
            aus.append(" ")
        elif z in _FORMAT_SPERRE or unicodedata.category(z) == "Cc":
            continue
        else:
            aus.append(z)
    text = " ".join("".join(aus).split())
    return text if any(_sichtbar(z) for z in text) else None
