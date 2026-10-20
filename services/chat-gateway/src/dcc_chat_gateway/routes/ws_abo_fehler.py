"""Fehlerrahmen eines ``subscribe`` — mit Bezug auf Op und Kanal.

Eigene Datei, weil ``ws_ops_handlers.py`` schon ueber der Groessen-Grenze
(PLAN.md §12.1) liegt; gebraucht dort (4003/4004/4012) und in der Op-Schleife
(``ws_ops.py``, 5000 bei einer Ausnahme im Handler).
"""

from __future__ import annotations

from typing import Any


def abo_fehler(code: int, text: str, cid: str | None = None) -> dict[str, Any]:
    """Fehlerrahmen eines ``subscribe`` mit ``ref_op`` und ``channel_id``.

    Der Klient fuehrt den Kanal in seinen ``subs``, sobald er das Abo
    geschickt hat; ohne Bezug konnte er einen Fehlschlag keinem Kanal
    zuordnen, und der Kanal blieb am Server stumm unabonniert — keine
    Live-Nachricht bis zum naechsten Neuaufbau (Push-Bughunt 2026-10-21,
    Befund 3). Wiederholt wird klientenseitig
    (``web/src/lib/ws/aboWiederholung.ts``). Ein aelterer Klient liest nur
    ``code``/``msg`` und uebergeht die Zusatzfelder.
    """
    rahmen: dict[str, Any] = {"op": "error", "code": code, "msg": text, "ref_op": "subscribe"}
    if cid is not None:
        rahmen["channel_id"] = cid
    return rahmen
