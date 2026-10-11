"""Jeder well-known-Pfad des chat-gateway braucht eine eigene Zeile in der Caddy-Vorlage.

Fehlt sie, greift der SPA-Rückfall am Ende der Vorlage und antwortet mit einer
leeren HTML-Seite und Status 200 — für ``/.well-known/pulse-verbinden`` hieße
das: die Cloud findet beim Verbinden keinen Nachweis, und ``pulse-connect``
schickt den Betreiber auf die Suche nach einem Fehler, der in der Vorlage
steckt. Dieselbe Falle hat die Cloud-Poller schon einmal erwischt (CLAUDE.md,
well-known-Endpoints). Geprüft wird die Vorlage selbst; die sed-Ersetzungen
aus 09-init-caddy.sh fassen diese Blöcke nicht an.
"""

from __future__ import annotations

import pathlib

import pytest

TEMPLATE = (
    pathlib.Path(__file__).resolve().parents[1] / "s6" / "etc" / "caddy" / "Caddyfile.template"
)


def _handle_block(pfad: str) -> str | None:
    """Der ``handle <pfad> { … }``-Block (Klammern gezählt), oder ``None``."""
    zeilen = TEMPLATE.read_text(encoding="utf-8").split("\n")
    start = next((i for i, z in enumerate(zeilen) if z.strip() == f"handle {pfad} {{"), None)
    if start is None:
        return None
    tiefe = 0
    for i in range(start, len(zeilen)):
        tiefe += zeilen[i].count("{") - zeilen[i].count("}")
        if tiefe == 0:
            return "\n".join(zeilen[start : i + 1])
    raise AssertionError(f"handle-Block für {pfad} nicht geschlossen")


@pytest.mark.parametrize(
    "pfad",
    [
        "/.well-known/pulse-server-info",
        "/.well-known/pulse-owner-check",
        "/.well-known/pulse-verbinden",
    ],
)
def test_well_known_pfad_geht_an_den_chat_gateway(pfad):
    block = _handle_block(pfad)
    assert block is not None, f"keine Zeile 'handle {pfad} {{' in der Caddy-Vorlage"
    assert "reverse_proxy 127.0.0.1:8002" in block
