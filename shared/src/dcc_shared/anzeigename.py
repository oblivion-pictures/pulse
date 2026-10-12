"""Der Anzeigename eines Self-Hosts — eine Bereinigung für beide Wege.

Der Betreiber gibt seinem Server einen Namen (``chat_settings.instance_name``
im chat-gateway des Servers). Derselbe Name erscheint in jeder Server-Leiste:
live vom Server selbst und über die Cloud (``registered_instances.anzeigename``,
``POST /selfhost/anzeigename``). Beide Wege müssen DENSELBEN Text ergeben —
sonst hieße ein Server je nach Weg zweimal anders. Deshalb steht die Regel
hier, nicht zweimal.

Entfernt wird nur, was in einer einzeiligen Beschriftung nichts zu suchen hat
oder unsichtbar täuscht: Steuerzeichen, Zeilen-/Absatztrenner, Null-Breite-
Leerzeichen und die Byte-Order-Marke. **Bewusst erhalten** bleiben der
Zero-Width-Joiner und -Non-Joiner sowie die Variantenselektoren: ohne sie
zerfällt ein Familien-Emoji in drei einzelne, und persische Namen verlieren
ihre Schreibweise. Ein No-Break-Space oder ein ideographisches Leerzeichen wird
zu einem normalen Leerzeichen statt zu einer Lücke im Wort. ``str.isprintable()``
war dafür zu grob (es verwirft alle Cf-/Z*-Zeichen und, je nach Unicode-Stand
der Laufzeit, jedes neue Emoji).
"""

from __future__ import annotations

import unicodedata

#: Unsichtbar und ohne Nutzen in einer Beschriftung.
_UNSICHTBAR = {"\u200b", "\ufeff"}
_VERWERFEN = {"Cc", "Zl", "Zp"}


def bereinige_anzeigename(name: str | None) -> str | None:
    """Bereinigter Name, oder ``None`` (= keiner gesetzt / zurückgesetzt)."""
    aus: list[str] = []
    for z in name or "":
        if z in _UNSICHTBAR:
            continue
        kategorie = unicodedata.category(z)
        if kategorie in _VERWERFEN:
            continue
        aus.append(" " if kategorie == "Zs" else z)
    return "".join(aus).strip() or None
