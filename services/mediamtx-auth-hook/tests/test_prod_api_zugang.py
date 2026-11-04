"""Security-Scan 2026-11-04: Die MediaMTX-Steuer-API der Cloud braucht ein Passwort.

Bis dahin winkte ``infra/prod/mediamtx.yml`` die API per ``authHTTPExclude``
am Hook vorbei; geschützt war sie allein durch UFW. Jeder Container im
Docker-Netz erreichte sie trotzdem — und über die Archiv-Weiterreichung des
chat-gateway (``ablage_ssrf``, die eigene öffentliche IP ist kein privates
Netz) konnte jedes Konto sie lesen: laufende Streams samt Lese-Token im
``query``-Feld, die IP-Adressen aller Zuschauer.

Jetzt läuft ``action: api`` durch den Hook (``api_zugang.py``) wie im
Self-Host, und media-svc schickt Basic-Auth aus derselben ``.env``.
"""

from __future__ import annotations

import re
from pathlib import Path

PROD = Path(__file__).resolve().parents[3] / "infra" / "prod"


def _exclude_block() -> str:
    text = (PROD / "mediamtx.yml").read_text()
    m = re.search(r"^authHTTPExclude:\n((?:[ \t]+.*\n)*)", text, re.M)
    assert m, "authHTTPExclude fehlt in infra/prod/mediamtx.yml"
    return m[1]


def test_api_laeuft_durch_den_hook() -> None:
    assert not re.search(r"action:\s*api\b", _exclude_block())


def test_env_vorlage_nennt_das_api_passwort() -> None:
    vorlage = (PROD / ".env.example").read_text()
    assert re.search(r"^MEDIAMTX_API_PASSWORD=", vorlage, re.M)
