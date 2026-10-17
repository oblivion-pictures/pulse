"""Startprüfung der Handy-Push-Konfiguration (nur Cloud).

**Warum es das gibt.** In der Cloud fehlte monatelang
``FIREBASE_SERVICE_ACCOUNT_KEY``, und kein Handy (Android wie iOS) bekam
einen Push. Still: ``fcm.ensure_fcm()`` gibt ohne die Variable ``None``
zurück, und die einzige Meldung des Pfades (``fcm_aktiviert``) steht auf
``info`` — die Cloud loggt aber erst ab ``warning``
(``PULSE_LOG_LEVEL``, s. ``dcc_shared/logging_setup.py``). Ein fehlender
Schlüssel war damit die eine Fehlkonfiguration, die man nirgends sehen konnte.

Deshalb hier ``warning``, einmal beim Start, mit den NAMEN der fehlenden
Werte (nie den Werten selbst).

**Nur im Cloud-Modus.** Ein Self-Host hat keinen Firebase-Schlüssel, und das
ist dort der Normalfall; eine Warnung bei jedem Start wäre Lärm, der die
echte Warnung in der Cloud entwerten würde.
"""

from __future__ import annotations

import logging
import os
from typing import Any

log = logging.getLogger(__name__)

#: Die vier Werte, die der direkte APNs-Weg (``apns_voip.py``) braucht —
#: Einstellungsname -> Name der Umgebungsvariable (so steht es im Log, damit
#: der Betreiber weiss, was er in die ``.env`` einträgt).
_APNS_PFLICHT = {
    "apns_key_file": "APNS_KEY_FILE",
    "apns_key_id": "APNS_KEY_ID",
    "apns_team_id": "APNS_TEAM_ID",
    "apns_bundle_id": "APNS_BUNDLE_ID",
}


def _lesbar(pfad: str) -> bool:
    return os.path.isfile(pfad) and os.access(pfad, os.R_OK)


def pruefe_push_konfiguration(settings: Any) -> None:
    """Warnt (``warning``) über fehlende Handy-Push-Konfiguration.

    Ändert nichts am Verhalten: FCM und VoIP bleiben fail-open, die
    Nachrichtenwege laufen weiter. Es wird nur sichtbar, DASS es still ist.
    """
    if settings.pulse_instance_mode != "cloud":
        return

    schluessel = settings.firebase_service_account_key
    if not schluessel:
        log.warning(
            "fcm_nicht_konfiguriert — FIREBASE_SERVICE_ACCOUNT_KEY fehlt; "
            "es gehen keine Handy-Pushes (Android und iOS) hinaus"
        )
    elif not _lesbar(schluessel):
        # Der Pfad wird genannt: er ist kein Geheimnis, und ohne ihn lässt
        # sich "Datei fehlt" nicht von "im Container nicht eingehängt"
        # unterscheiden.
        log.warning(
            "fcm_nicht_konfiguriert — Service-Account-Datei %s nicht lesbar "
            "(Pfad im Container? chmod 0644?); es gehen keine Handy-Pushes hinaus",
            schluessel,
        )

    fehlend = [env for feld, env in _APNS_PFLICHT.items() if not getattr(settings, feld, None)]
    if fehlend:
        log.warning(
            "apns_voip_nicht_konfiguriert — es fehlen: %s; "
            "iPhones werden bei Anrufen nicht geweckt",
            ", ".join(fehlend),
        )
    elif not _lesbar(settings.apns_key_file):
        log.warning(
            "apns_voip_nicht_konfiguriert — APNs-Schlüsseldatei %s nicht lesbar "
            "(Pfad im Container? chmod 0644?); iPhones werden bei Anrufen nicht geweckt",
            settings.apns_key_file,
        )
