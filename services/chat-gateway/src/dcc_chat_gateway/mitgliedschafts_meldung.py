"""Mitgliedschaft der Cloud melden — der Nachweis hinter dem Telefonbuch.

Sicherheits-Scan 2026-10-24 (Heim-IP-Lücke): Die Cloud schaltete das
Direktpfad-Telefonbuch für JEDE Membership-Zeile frei, und „beitreten" war
eine nachweislose Selbst-Eintragung jedes Kontos — die Heim-Adresse jedes
aktiven Heim-Servers war damit für jedes Konto abrufbar. Jetzt bestätigt DER
SERVER: Nach bestandenem Beitritts-Gate (``routes/session_ticket.py``) meldet
der Gateway die Kennung an die Cloud; erst deren frisches ``bestaetigt_am``
öffnet dort Lookup und Offer (``routes_selfhost_directory.py`` im Auth-Dienst,
Auth wie der Heartbeat — Pairing-Creds, nie Konto-Geheimnisse).

Getaktet: Die Cloud prüft bei jeder Meldung das Pairing-Secret (Argon2), und
Sitzungen erneuern sich stündlich — jede Anmeldung einzeln zu melden wäre
Verschwendung. Der Takt (6 h, wie ``instance_name.ABGLEICH_TAKT_S``) ist rein
lokal und verliert den Neustart nicht überlebenswichtige Zustände: Nach einem
Neustart meldet jedes aktive Mitglied genau einmal nach. Gescheiterte
Meldungen markieren NICHT und wiederholen sich bei der nächsten Anmeldung.

Best effort wie ``auth_mirror``/``instance_name``: Scheitert die Meldung
(Netz, Cloud-Ausfall), läuft die Anmeldung trotzdem weiter — nur das
Telefonbuch hinkt nach und heilt bei der nächsten Anmeldung.
"""

from __future__ import annotations

import logging
import time

import httpx

from dcc_chat_gateway import config as chat_cfg

log = logging.getLogger(__name__)

#: Abstand der Meldung je Mitglied. Die Cloud-Antwort ``204`` verlängert; eine
#: gescheiterte Meldung verlängert NICHT (nächste Anmeldung probiert wieder).
MELDE_TAKT_S = 6 * 3600

#: kennung → monotone Zeit der letzten erfolgreichen Meldung.
_letzte_meldung: dict[str, float] = {}


def zuruecksetzen() -> None:
    """Takt-Zustand leeren — Tests starten so mit ungetaktetem Mitglied."""
    _letzte_meldung.clear()


async def _sende(kennung: str) -> bool:
    """Der eigentliche Cloud-Aufruf (eigenständig, damit Tests hier ansetzen).
    ``True`` bei 204."""
    s = chat_cfg.get_settings()
    url = s.pulse_cloud_origin.rstrip("/") + "/api/auth/selfhost/directory/mitgliedschaft"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.post(
                url,
                json={
                    "instance_id": str(s.pulse_instance_id),
                    "client_id": s.pulse_cloud_client_id,
                    # Wie der direct-adapter im Heartbeat: das Secret als
                    # ``token``.
                    "token": s.pulse_cloud_client_secret,
                    "user_id": kennung,
                },
            )
    except httpx.HTTPError as exc:
        log.warning("mitgliedschafts_meldung_fehlgeschlagen: %s", type(exc).__name__)
        return False
    if r.status_code != 204:
        log.warning("mitgliedschafts_meldung_abgelehnt: HTTP %s", r.status_code)
        return False
    return True


async def melde_mitgliedschaft(kennung: str) -> bool:
    """Die Cloud um Bestätigung dieser Mitgliedschaft bitten (getaktet).

    ``True`` = Cloud bestätigt oder Takt griff (nichts zu tun). ``False`` =
    Meldung gescheitert — der Aufrufer darf darüber NICHT stolpern (best
    effort). Nur Self-Hosts mit Instanz-Zugangsdaten — die Cloud selbst hat
    niemanden, dem sie melden könnte.
    """
    s = chat_cfg.get_settings()
    if s.pulse_instance_mode != "self-host" or not s.pulse_instance_id:
        return False
    if not s.pulse_cloud_client_id or not s.pulse_cloud_client_secret:
        return False
    jetzt = time.monotonic()
    if jetzt - _letzte_meldung.get(kennung, float("-inf")) < MELDE_TAKT_S:
        return True
    if await _sende(kennung):
        _letzte_meldung[kennung] = jetzt
        return True
    return False
