#!/bin/sh
# /data/ skeleton. /data is bind-mounted (or named-volume) → idempotent.
# All subdirs are pulse:pulse, 700 except pg (700 — postgres refuses else).
set -eu
DATA="${PULSE_DATA_PATH:-/data}"

mkdir -p \
    "${DATA}" \
    "${DATA}/pg" \
    "${DATA}/redis" \
    "${DATA}/backups" \
    "${DATA}/certs" \
    "${DATA}/jwt_keys" \
    "${DATA}/coturn" \
    "${DATA}/caddy" \
    "${DATA}/livekit" \
    "${DATA}/mediamtx" \
    "${DATA}/garage/meta" \
    "${DATA}/garage/data" \
    "${DATA}/uploads" \
    "${DATA}/uploads/avatars" \
    "${DATA}/uploads/guild-icons" \
    "${DATA}/pulse"

chown -R pulse:pulse "${DATA}"
chmod 0700 "${DATA}"
chmod 0700 "${DATA}/pg" "${DATA}/redis" "${DATA}/jwt_keys" "${DATA}/coturn" "${DATA}/garage"
chmod 0750 "${DATA}/uploads"
# pulse-connect legt hier Nachweis und Zugangsdaten ab (verbinden_cli.py). Es
# läuft als root; lesen muss den Nachweis der chat-gateway als pulse — deshalb
# gehört das Verzeichnis pulse, und das chown -R oben zieht die Dateien beim
# nächsten Start nach.
chmod 0700 "${DATA}/pulse"
# Ein Lauf von pulse-connect, den SIGHUP, SIGTERM oder SIGKILL trifft (Terminal
# zu, docker stop, OOM), lässt den Nachweis liegen — sein finally läuft dann
# nicht. Der Dienst lieferte ihn weiter unter /.well-known/pulse-verbinden aus,
# obwohl kein Vorgang mehr zu ihm gehört. Beim Start läuft garantiert kein
# pulse-connect (docker exec endet mit dem Container), also ist die Datei hier
# immer ein Rest. Der Name steht auch in verbindung.py (NACHWEIS_DATEI).
rm -f "${DATA}/pulse/verbinden-nachweis"

# Also chown runtime state dirs (recreated empty on container restart)
mkdir -p /var/run/pulse /var/log/pulse
chown -R pulse:pulse /var/run/pulse /var/log/pulse
chmod 0750 /var/run/pulse /var/log/pulse

echo "[01-init-data-dirs] /data tree ready"
