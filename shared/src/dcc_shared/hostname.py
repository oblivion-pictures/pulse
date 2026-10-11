"""Hostnamen normalisieren — eine Fassung für Cloud und Self-Host.

Seit dem Verbinden per Gerätecode (Spec
``docs/superpowers/specs/2026-10-09-selfhost-ohne-freigabe-design.md``, E1)
trägt die Cloud die Adresse eines Servers selbst ein: so, wie der Server sie
beim Anfragen des Codes nennt. Dieselbe Adresse muss danach in jeder
Schreibweise (mit Schema, Port, Grossbuchstaben, abschliessendem Punkt)
denselben Eintrag treffen — sonst entstünden zwei Einträge für einen Server,
und die Übernahme einer Adresse (E2) fände den alten nicht.

Nur ASCII: eine Unicode-Adresse muss als Punycode (``xn--…``) kommen. Der
Browser wandelt sie beim Aufruf ohnehin so um.
"""

from __future__ import annotations

import re
from urllib.parse import urlsplit

# Mindestens zwei Labels; ein Label beginnt und endet mit Buchstabe oder Ziffer
# (RFC 1123). Oberste Ebene alphabetisch oder Punycode — eine reine Zahl dort
# hiesse IP-Adresse, und die kann kein Zertifikat für einen Namen tragen.
_FQDN_RE = re.compile(
    r"^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$"
)


def normalisiere_hostname(roh: str) -> str | None:
    """Die Vergleichsform einer Server-Adresse, oder ``None``, wenn es keine ist."""
    text = roh.strip().lower()
    if not text:
        return None
    try:
        # Das ``//``-Präfix nur, wo keines ist — sonst läse ``urlsplit`` bei
        # einem vollen URL das Schema als Host.
        host = urlsplit(text if "//" in text else f"//{text}").hostname or ""
    except ValueError:
        return None
    host = host.rstrip(".")
    if len(host) > 253 or not _FQDN_RE.match(host):
        return None
    return host
