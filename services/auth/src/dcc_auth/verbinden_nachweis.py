"""Nachweis beim Verbinden: läuft unter dieser Adresse der anfragende Server?

Der Server legt den SHA-256 seiner Abholkennung unter
``/.well-known/pulse-verbinden`` ab; nur er kennt die Kennung (Spec
``docs/superpowers/specs/2026-10-09-selfhost-ohne-freigabe-design.md``, E2).
Die Cloud prüft das beim Anfragen des Codes und noch einmal vor dem Eintragen.
Das verhindert, dass jemand eine fremde Adresse für sich einträgt, und macht
einen Besitzerwechsel eindeutig: Es gewinnt, wer die Adresse nachweislich
gerade betreibt — ein fremdes Konto erst nach der Widerspruchsfrist
(``verbinden_uebernahme.py``).

Die Route dahinter ist anonym — die Cloud ruft hier auf Zuruf eines
Unbekannten einen fremden Rechner auf. Deshalb dieselbe Absicherung wie bei
der Erreichbarkeitsprüfung: erst auflösen und private Netze verwerfen
(``pruefe_dns``), dann an die geprüfte IP verbinden (``Ziel``), Zertifikat
voll geprüft, keine Weiterleitungen, und die Antwort nur bis zu einer festen
Grösse lesen. Denselben Weg nimmt ``server_info_instanz`` für den Widerspruch
gegen einen Übernahme-Antrag.
"""

from __future__ import annotations

import asyncio
import json
import re
import ssl

import httpx

from dcc_auth.selfhost_probe import pruefe_dns
from dcc_auth.selfhost_probe_dienst import Ziel

PFAD = "/.well-known/pulse-verbinden"
SERVER_INFO_PFAD = "/.well-known/pulse-server-info"
#: Ganze Prüfung höchstens so lange — ein Betreiber wartet im Terminal darauf.
FRIST_S = 8.0
# Der echte Nachweis hat unter 100 Bytes, die Server-Info wenige hundert.
# Mehr liest die Cloud von einem Unbekannten nicht.
_HOECHSTENS_BYTES = 4096
_HEX64 = re.compile(r"[0-9a-f]{64}")


def _klient() -> httpx.AsyncClient:
    return httpx.AsyncClient(follow_redirects=False, verify=True)


def _zertifikatsfehler(exc: BaseException) -> bool:
    """httpx verpackt den TLS-Fehler zweimal (httpcore, dann httpx); die
    Ursache steht unten in der Kette."""
    kette: BaseException | None = exc
    for _ in range(10):
        if kette is None:
            return False
        if isinstance(kette, ssl.SSLCertVerificationError) or (
            "CERTIFICATE_VERIFY_FAILED" in str(kette)
        ):
            return True
        kette = kette.__cause__ or kette.__context__
    return False


class _Unbrauchbar(Exception):
    """Antwort da, aber nicht 200 oder über der Grössengrenze."""


async def _koerper_lesen(klient: httpx.AsyncClient, ziel: Ziel, pfad: str) -> bytes:
    """Den Antwortkörper roh und gedeckelt — für jeden Abruf hier derselbe Weg.

    Wirft ``_Unbrauchbar`` oder den Netz- bzw. Zeitfehler; was daraus folgt,
    entscheidet der Aufrufer.
    """
    roh = bytearray()
    async with asyncio.timeout(FRIST_S):
        async with klient.stream(
            "GET",
            ziel.url(pfad),
            headers=ziel.kopf({"Accept-Encoding": "identity"}),
            extensions=ziel.sni,
        ) as antwort:
            if antwort.status_code != 200:
                raise _Unbrauchbar
            # Roh lesen, nicht entpackt: ``aiter_bytes`` liefert erst, was
            # httpx aus einem Stück schon entpackt hat, und ein Unbekannter
            # packt 64 MiB Nullen in 64 KiB — der Speicher wäre belegt, ehe
            # die Grenze unten greift. Ein komprimierter Körper ist damit
            # schlicht kein JSON.
            async for stueck in antwort.aiter_raw():
                roh += stueck
                if len(roh) > _HOECHSTENS_BYTES:
                    raise _Unbrauchbar
    return bytes(roh)


async def nachweis_lesen(klient: httpx.AsyncClient, ziel: Ziel, erwartet: str) -> str | None:
    """``None`` = in Ordnung, sonst der Befund."""
    try:
        roh = await _koerper_lesen(klient, ziel, PFAD)
    except _Unbrauchbar:
        return "kein_nachweis"
    except Exception as exc:  # noqa: BLE001 — jeder Fehler hier ist ein Befund
        return "zertifikat" if _zertifikatsfehler(exc) else "nicht_erreichbar"

    try:
        gemeldet = json.loads(roh)["nachweis"]
    except (ValueError, KeyError, TypeError):
        return "kein_nachweis"
    if not isinstance(gemeldet, str):
        return "kein_nachweis"
    gemeldet = gemeldet.strip().lower()
    if not _HEX64.fullmatch(gemeldet):
        return "kein_nachweis"
    # Kein Vergleich in konstanter Zeit nötig: der Wert ist öffentlich, er
    # steht ja unter der Adresse für jeden lesbar.
    if gemeldet != erwartet:
        return "falscher_wert"
    return None


async def nachweis_pruefen(hostname: str, erwartet: str) -> str | None:
    """``None`` = in Ordnung, sonst ``nicht_erreichbar`` | ``zertifikat`` |
    ``kein_nachweis`` | ``falscher_wert``.

    Eine Adresse, die ins private Netz zeigt, heisst nach aussen schlicht
    ``nicht_erreichbar`` — der anonyme Aufrufer soll aus dem Befund nichts
    über das Netz der Cloud lernen.
    """
    dns = await pruefe_dns(hostname)
    if not dns.ok:
        return "nicht_erreichbar"
    async with _klient() as klient:
        return await nachweis_lesen(klient, Ziel(hostname, dns.adressen[0]), erwartet)


async def server_info_instanz(hostname: str) -> str | None:
    """Welche Instanz meldet sich unter dieser Adresse (``instance_id`` aus
    ``/.well-known/pulse-server-info``)? ``None`` bei jedem Fehler, bei
    fehlendem Feld und bei allem, was keine Zeichenkette ist.

    Für den Widerspruch gegen einen Übernahme-Antrag (``routes_uebernahme.py``):
    widersprechen kann nur, wessen Server noch unter der Adresse antwortet.
    Der Aufruf geht auf Zuruf eines angemeldeten Kontos an einen fremden
    Rechner, also derselbe abgesicherte Weg wie beim Nachweis.
    """
    dns = await pruefe_dns(hostname)
    if not dns.ok:
        return None
    try:
        async with _klient() as klient:
            roh = await _koerper_lesen(klient, Ziel(hostname, dns.adressen[0]), SERVER_INFO_PFAD)
        gemeldet = json.loads(roh)["instance_id"]
    except Exception:  # noqa: BLE001 — jeder Fehler heisst hier „kein Beleg“
        return None
    return gemeldet if isinstance(gemeldet, str) else None
