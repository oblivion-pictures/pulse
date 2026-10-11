#!/bin/sh
# Startprüfung. Pflicht ist seit 2026-10 nur noch die Adresse (Spec
# docs/superpowers/specs/2026-10-09-selfhost-ohne-freigabe-design.md, E4).
# Instanz-Nummer, Besitzer und Zugangsdaten kommen aus der Umgebung
# (Bestandsserver mit Freigabe, Server-App) oder von pulse-connect aus
# /data/pulse/verbindung.env (07-render-env.sh). Fehlen sie, startet der
# Server trotzdem und nimmt niemanden auf, bis er verbunden ist.
#
# Der Dateiname ist historisch und bleibt: cont-init-main.sh ruft den Schritt
# unter diesem Namen, /data/setup-status (GET /health/setup) meldet ihn so, und
# der Installer übersetzt genau diesen Namen in seine Checkliste.
set -eu

if [ -z "${PULSE_HOSTNAME:-}" ]; then
    cat >&2 <<'EOF'
[10-check-cloud-creds] FATAL: PULSE_HOSTNAME is not set.

Set it to the public address of this server, for example
  -e PULSE_HOSTNAME=chat.example.org     (docker run)
  PULSE_HOSTNAME=chat.example.org        (.env next to docker-compose.yml)

The address needs a DNS record pointing at this machine.
Easiest way to install: curl -fsSL https://howispulse.com/install | bash
EOF
    exit 1
fi

# Sieht die Adresse wie ein echter DNS-Name aus? Lieber hier laut scheitern als
# später still beim Zertifikat.
if ! echo "${PULSE_HOSTNAME}" | grep -qE '^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$'; then
    echo "[10-check-cloud-creds] FATAL: PULSE_HOSTNAME='${PULSE_HOSTNAME}' is not a valid DNS name" >&2
    exit 1
fi

echo "[10-check-cloud-creds] address ok (hostname=${PULSE_HOSTNAME})"
