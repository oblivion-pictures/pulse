#!/bin/sh
# pulse-livekit-node-ip — die öffentliche IPv4 als LiveKit-node_ip setzen, auf
# Wunsch dazu die LAN-IPv4 des Rechners als extra_node_ips.
#
#   pulse-livekit-node-ip <ipv4> [--neustart]              node_ip setzen; eine
#                                                         gesetzte LAN-Adresse bleibt
#   pulse-livekit-node-ip <ipv4> [--neustart] --lan <ipv4> … und die LAN-Adresse
#                                                         daneben ankündigen
#   pulse-livekit-node-ip <ipv4> [--neustart] --ohne-lan   … und sie entfernen
#   pulse-livekit-node-ip --zeige                          gesetzte node_ip (leer = keine)
#   pulse-livekit-node-ip --zeige-lan                      gesetzte LAN-Adresse (leer = keine)
#
#   --neustart startet danach nur den LiveKit-Dienst neu.
#
# Warum feste node_ip (Linux-Test 2026-10-08): Mit `use_external_ip: true`
# ermittelt LiveKit die öffentliche Adresse selbst per STUN — und schaltet
# dann für Browser, die laut LiveKit kein „prflx over relay" können (Firefox),
# fest auf „nur die öffentliche Adresse" um (pkg/rtc/transport.go, 1.13.3).
# Mit fest vorgegebener `node_ip` bleibt NAT1To1IPs leer, und die
# Sonderbehandlung greift nicht.
#
# Warum zusätzlich die LAN-Adresse (2026-10-12): im node_ip-Weg ersetzt
# LiveKit JEDE lokale Adresse durch diese eine — `advertise_internal_ip` wirkt
# dort nicht (nur im STUN-Weg), und die „interne" Adresse wäre im Container
# ohnehin die Docker-Brücke, nicht die LAN-IP. Mit node_ip allein müsste jedes
# Gerät im Heimnetz, auch der Rechner des Servers selbst, über die öffentliche
# Adresse zurück ins eigene Netz; die Fritz!Box kann kein Hairpin-NAT →
# „could not establish pc connection". `extra_node_ips` kündigt die LAN-IP
# daneben an — eine Option, die es nur im Pulse-Fork gibt
# (infra/livekit-fork/, gebaut in dieses Image).
#
# Wer das Feld schreiben darf: im Container NUR dieses Skript, weil es im
# selben Image liegt wie das gepatchte Binary. Das offizielle livekit-server
# liest seine Konfiguration im strengen Modus (`KnownFields`,
# pkg/config/config.go) und startet mit `extra_node_ips` gar nicht („field
# extra_node_ips not found in type config.RTCConfig", nachgefahren mit 1.13.3
# am 2026-10-12). Die
# Server-App schreibt es deshalb nie selbst in den Container, sondern ruft
# dieses Skript — ein älteres Image ohne die Option erkennt sie daran, dass es
# `--zeige-lan` als ungültige IPv4 abweist (Exit 2).
#
# `--zeige` gibt weiter NUR die node_ip aus: ältere Server-Apps vergleichen
# die Ausgabe wörtlich mit ihrer öffentlichen IP; eine zweite Zeile liesse sie
# LiveKit alle zwei Minuten neu starten.
#
# Preis: LiveKit folgt einem IP-Wechsel nicht mehr selbst — das tat es mit
# STUN aber auch nur beim Start. Die Server-App prüft beide Adressen deshalb
# regelmäßig und ruft dieses Skript mit --neustart, wenn sich eine ändert.
#
# LIVEKIT_YAML überschreibt den Pfad, PULSE_S6_SVC das Neustart-Werkzeug
# (beides nur für Tests).
set -eu
DATEI="${LIVEKIT_YAML:-/etc/livekit/livekit.yaml}"
# s6-overlay legt seine Werkzeuge nach /command, nicht in den PATH von
# `podman exec` — deshalb absolut.
S6_SVC="${PULSE_S6_SVC:-/command/s6-svc}"

case "${1:-}" in
    --zeige)
        sed -n 's|^  node_ip: \([0-9.]*\)$|\1|p' "$DATEI" | head -n1
        exit 0
        ;;
    --zeige-lan)
        sed -n 's|^  extra_node_ips: \[\([0-9.]*\)\]$|\1|p' "$DATEI" | head -n1
        exit 0
        ;;
esac

# Nur eine nackte IPv4 — der Wert landet per sed in einer YAML-Datei.
# Zwei Riegel: `case` weist jedes fremde Zeichen ab (auch Zeilenumbrüche —
# grep allein prüft zeilenweise und liesse „1.2.3.4⏎node_ip: …" durch).
ist_ipv4() {
    case "$1" in
        ''|*[!0-9.]*) return 1 ;;
    esac
    printf '%s' "$1" | grep -Eqx '([0-9]{1,3}\.){3}[0-9]{1,3}'
}

IP="${1:-}"
if ! ist_ipv4 "$IP"; then
    echo "[livekit-node-ip] ungültige IPv4: '$IP'" >&2
    exit 2
fi
shift

NEUSTART=0
LAN_MODUS=bleibt
LAN=""
while [ $# -gt 0 ]; do
    case "$1" in
        --neustart) NEUSTART=1 ;;
        --lan)
            LAN="${2:-}"
            if ! ist_ipv4 "$LAN"; then
                echo "[livekit-node-ip] ungültige LAN-IPv4: '$LAN'" >&2
                exit 2
            fi
            LAN_MODUS=setzen
            shift
            ;;
        --ohne-lan) LAN_MODUS=entfernen ;;
        *)
            echo "[livekit-node-ip] unbekanntes Argument: '$1'" >&2
            exit 2
            ;;
    esac
    shift
done
# Dieselbe Adresse zweimal anzukündigen bringt nichts (Rechner direkt am Netz).
if [ "$LAN_MODUS" = setzen ] && [ "$LAN" = "$IP" ]; then
    LAN_MODUS=entfernen
fi

# Idempotent: alte node_ip und den STUN-Validierungsschalter entfernen,
# use_external_ip ausschalten, node_ip direkt dahinter neu setzen. Die
# LAN-Zeile nur anfassen, wenn danach gefragt ist — der Aufruf ohne --lan
# (Abgleich einer älteren Server-App, 05-init-livekit.sh ohne PULSE_LAN_IPV4)
# lässt sie stehen.
lan_filter() {
    if [ "$LAN_MODUS" = bleibt ]; then cat; else sed -e '/^  extra_node_ips: /d'; fi
}
ZUSATZ=""
if [ "$LAN_MODUS" = setzen ]; then
    ZUSATZ="\n  extra_node_ips: [${LAN}]"
fi
TMP="$(mktemp)"
sed \
    -e '/^  node_ip: /d' \
    -e '/^  skip_external_ip_validation: /d' \
    -e 's|^  use_external_ip: true$|  use_external_ip: false|' \
    "$DATEI" \
  | lan_filter \
  | sed -e "s|^  use_external_ip: false\$|  use_external_ip: false\n  node_ip: ${IP}${ZUSATZ}|" > "$TMP"
if ! grep -q "^  node_ip: ${IP}\$" "$TMP" \
    || { [ "$LAN_MODUS" = setzen ] && ! grep -q "^  extra_node_ips: \[${LAN}\]\$" "$TMP"; }; then
    echo "[livekit-node-ip] 'use_external_ip' nicht gefunden — Datei unverändert" >&2
    rm -f "$TMP"
    exit 3
fi
cat "$TMP" > "$DATEI"   # Inhalt ersetzen: Besitzer und Rechte der Datei bleiben
rm -f "$TMP"
echo "[livekit-node-ip] node_ip=${IP} extra_node_ips=[$(sed -n 's|^  extra_node_ips: \[\([0-9.]*\)\]$|\1|p' "$DATEI" | head -n1)]"

if [ "$NEUSTART" = 1 ]; then
    "$S6_SVC" -r /run/service/livekit
    echo "[livekit-node-ip] LiveKit neu gestartet"
fi
