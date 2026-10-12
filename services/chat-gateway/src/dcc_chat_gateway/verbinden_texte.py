"""Die Texte von ``pulse-connect`` (``verbinden_cli.py``).

Englisch, weil sie im Terminal fremder Betreiber stehen (Regel aus
``owner_admin_log.py``); eigene Datei, damit die Ablauflogik unter der
Größengrenze bleibt — Muster ``dcc_auth/diagnose_texte.py``. Kein Text hier
enthält die Abholkennung oder ein Secret, und keiner darf es je tun.

``BEFUNDE`` deckt die Befunde der Cloud-Prüfung ab (``verbinden_nachweis.py``
im auth-svc: ``nicht_erreichbar``, ``zertifikat``, ``kein_nachweis``,
``falscher_wert``). Kommt dort einer dazu, gehört er hierher. ``utc_minute``
formt nur den Zeitpunkt für die Fristen-Meldungen.
"""

from __future__ import annotations

from datetime import UTC, datetime

#: Ersatz, wenn die Cloud kein lesbares Fristende nennt (der Rest der Meldung
#: stimmt trotzdem). Nie der Wert der Cloud selbst: er käme ungeprüft ins Terminal.
FRIST_UNBEKANNT = "the end of the waiting period"

BEFUNDE = {
    "nicht_erreichbar": (
        "The Pulse cloud could not reach https://{host}/. Check that the DNS record "
        "of {host} points at this server and that port 443 is open."
    ),
    "zertifikat": (
        "https://{host}/ has no valid certificate yet. It usually arrives within a "
        "few minutes after the DNS record points at this server."
    ),
    "kein_nachweis": (
        "https://{host}/ answered, but without the connection proof. If a proxy sits "
        "in front of Pulse, it must forward /.well-known/pulse-verbinden."
    ),
    "falscher_wert": (
        "https://{host}/ answered with a different connection proof. Is another "
        "Pulse server running under this address?"
    ),
}
BEFUND_UNBEKANNT = "The Pulse cloud could not verify https://{host}/."
NACHWEIS_HILFE = (
    "No code was used up. Details: docker exec pulse pulse-doctor\n"
    "Then try again: docker exec -it pulse pulse-connect"
)

LOKAL_OHNE_NACHWEIS = (
    "Pulse itself is not serving the proof yet (is the server fully started?)\n" + NACHWEIS_HILFE
)

HILFE = "Connect this Pulse server to your Pulse account."
HILFE_OHNE_NEUSTART = "do not restart the server afterwards (the installer restarts it itself)"
HILFE_JA = "connect again without asking if already connected"

NUR_SELF_HOST = "pulse-connect only works on a self-hosted Pulse server."
OHNE_ADRESSE = "PULSE_HOSTNAME is not set. Set it to the address of this server."
AUS_DER_UMGEBUNG = (
    "This server is connected through its configuration (PULSE_INSTANCE_ID in .env\n"
    "or docker run -e), and pulse-connect cannot change that. To connect it to\n"
    "another account, remove PULSE_INSTANCE_ID, PULSE_INSTANCE_OWNER_ID,\n"
    "PULSE_CLOUD_CLIENT_ID and PULSE_CLOUD_CLIENT_SECRET there, recreate the\n"
    "container and run pulse-connect again."
)
SCHON_VERBUNDEN = (
    "This server is already connected to a Pulse account.\n"
    "Another account has to wait 72 hours unless the current owner deletes the "
    'server under "My servers" first.\n'
    "Connect it to a different account? [y/N] "
)
NICHTS_GEAENDERT = "Nothing changed."

BEGINN = "Connecting {host} to a Pulse account."
ANLEITUNG = (
    "Open this link in a browser where you are signed in to Pulse:\n\n"
    "  {link}\n\n"
    "Check that it shows the code {code}, then confirm.\n"
    "Only confirm if you are installing this server yourself right now.\n"
    "Waiting for the confirmation (up to {minuten} minutes) ..."
)

CLOUD_WEG = (
    "Could not reach the Pulse cloud at {origin}. "
    "Check the outgoing internet connection of this server."
)
ADRESSE_GESPERRT = "{host} belongs to Pulse itself. Use your own domain."
ADRESSE_UNGUELTIG = "The Pulse cloud does not accept {host} as an address."
ZU_VIELE = "Too many connection attempts from this server. Try again in an hour."
AUSGELASTET = "Pulse is busy checking servers right now. Run pulse-connect again in a minute."
#: Die Cloud meldet das nur für dieselbe Kennung — und die ist bei jedem Lauf neu.
#: Gemeint ist also ein Start, der zweimal ankam; nicht „ein anderer Versuch läuft“.
VORGANG_LAEUFT = (
    "The Pulse cloud already has this connection attempt for {host} open, probably "
    "because the request arrived twice. Nothing changed. Run pulse-connect again."
)
CLOUD_ZU_LANGSAM = "The Pulse cloud did not answer in time — please try again. Nothing changed."
CLOUD_NICHT_BEREIT = (
    "The Pulse cloud is not ready right now (HTTP {status}); it may be restarting. "
    "Nothing changed — please try again in a minute."
)
UNERWARTET = "Unexpected answer from the Pulse cloud (HTTP {status}). Nothing changed."
ZUGANG_UNBRAUCHBAR = (
    "The Pulse cloud sent credentials this server cannot use. Nothing changed here. "
    "The code is used up. Run pulse-connect again."
)
DATEN_NICHT_BESCHREIBBAR = (
    "Could not write to {pfad} ({grund}). Nothing changed and no code was used up.\n"
    "Check the free space and the permissions of the data volume, then run pulse-connect again."
)
#: Die Cloud hat das Secret beim Abholen schon rotiert — ohne den Hinweis auf den
#: neuen Lauf bliebe der Betreiber bei „Platte voll“ stehen und wüsste nicht, dass
#: ein zweiter Versuch einen neuen Code braucht.
ZUGANG_NICHT_GESPEICHERT = (
    "The Pulse cloud has already issued new credentials for this server, but they could "
    "not be saved to {pfad} ({grund}).\n"
    "Free some space on the data volume (or fix its permissions), then run pulse-connect "
    "again to get fresh ones. Nothing was applied to this server."
)
ABGELEHNT = "The connection was declined in the browser. Nothing changed."
UEBERNAHME_BEANTRAGT = (
    "The account that confirmed this code does not own {host} in Pulse. A takeover "
    "request was filed: the current owner has been notified and can object until "
    "{frist}.\nRun pulse-connect again after that. If you confirmed with the wrong "
    "account, run pulse-connect again now and confirm with the owner's account."
)
UEBERNAHME_GESPERRT = (
    "This address can't be moved to your account right now (until {bis}): its current "
    "owner objected, or another account is already waiting. Ask the current owner to "
    'delete the server under "My servers".'
)
ABGELAUFEN = "The code expired before it was confirmed. Run pulse-connect again."

VERBUNDEN = "Connected to {besitzer}. Your server now appears in Pulse."
#: Wer den Container ohne Neustart-Regel gestartet hat (``docker run`` ohne
#: ``--restart``), findet ihn nach ``halt`` gestoppt vor und muss ihn selbst starten.
NEUSTART = (
    "Restarting the server to apply the connection. It is back in about a minute.\n"
    "If it does not come back by itself, start it again: docker start pulse"
)
NEUSTART_VON_HAND = "Could not restart by itself. On the host, run: docker restart pulse"
ABGEBROCHEN = "\nCancelled. Nothing changed."


def utc_minute(wert: object) -> str:
    """Ein ISO-Zeitpunkt der Cloud als ``2026-10-14 12:30 UTC``; sonst ``FRIST_UNBEKANNT``."""
    try:
        zeit = datetime.fromisoformat(wert)  # type: ignore[arg-type]  # TypeError fängt der except
    except (TypeError, ValueError):
        return FRIST_UNBEKANNT
    if zeit.tzinfo is None:
        zeit = zeit.replace(tzinfo=UTC)  # die Cloud rechnet in UTC
    return f"{zeit.astimezone(UTC):%Y-%m-%d %H:%M} UTC"
