"""Security-Scan 2026-11-04: Die Compose-Variante läuft gehärtet wie die Server-App.

Die Server-App (``desktop/electron/localBackend/containerLauf.ts``) startet den
Allinone-Container unter Linux mit ``no-new-privileges``, ``--cap-drop ALL`` und
genau den sieben Fähigkeiten, die s6 und die Init-Skripte brauchen. Die
Compose-Dateien für Linux-Server liefen bis dahin mit den vollen Docker-
Standardrechten — ein Ausbruch über einen Kern-Fehler hätte dort Root auf dem
Server bedeutet. Beide Listen müssen gleich bleiben.
"""

from __future__ import annotations

import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
CONTAINER_LAUF = REPO / "desktop" / "electron" / "localBackend" / "containerLauf.ts"
COMPOSE = [
    REPO / "infra" / "self-host" / "docker-compose.yml",
    REPO / "infra" / "self-host" / "docker-compose.behind-proxy.yml",
]


def _app_faehigkeiten() -> set[str]:
    m = re.search(r"ERLAUBTE_FAEHIGKEITEN = \[(.*?)\]", CONTAINER_LAUF.read_text(), re.S)
    assert m, "ERLAUBTE_FAEHIGKEITEN fehlt in containerLauf.ts"
    return set(re.findall(r"'([A-Z_]+)'", m[1]))


def _block(text: str, schluessel: str) -> list[str]:
    m = re.search(rf"^    {schluessel}:\n((?:      - .*\n)+)", text, re.M)
    assert m, f"{schluessel} fehlt"
    return [z.split("- ", 1)[1].strip().strip('"') for z in m[1].splitlines()]


def test_compose_dateien_sind_gehaertet_wie_die_server_app() -> None:
    erwartet = _app_faehigkeiten()
    assert len(erwartet) == 7
    for datei in COMPOSE:
        text = datei.read_text()
        assert _block(text, "cap_drop") == ["ALL"], datei.name
        assert set(_block(text, "cap_add")) == erwartet, datei.name
        assert "no-new-privileges:true" in _block(text, "security_opt"), datei.name
