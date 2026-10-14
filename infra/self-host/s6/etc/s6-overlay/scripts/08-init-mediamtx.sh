#!/bin/sh
# Render MediaMTX config from template. Phase 6.A ships a minimal config —
# 6.B will overwrite with the full proxy + TLS-cert paths.
set -eu
DATA="${PULSE_DATA_PATH:-/data}"
CERT_DIR="${DATA}/certs"
TEMPLATE=/opt/pulse/templates/mediamtx.yml.template

# Zusätzliche Host-Kandidaten des App-Hosts als fertige YAML-Zeile (oder
# nichts). $1 = PULSE_VM_ANNOUNCE_IP, $2 = PULSE_DIRECT_EXTRA_HOST_IPS
# (kommagetrennt, so schreibt sie containerEnv.ts), $3 = die eigenen
# Interface-Adressen des Containers (leerzeichengetrennt, `hostname -I`).
# Nur IPv4 kommt durch — der ICE-Socket ist auf 0.0.0.0 gebunden, eine
# IPv6-Ankündigung liefe ins Leere. Was der Container schon selbst sieht
# (pasta: echte LAN-IP am Interface), steuert webrtcIPsFromInterfaces bei
# und fällt hier als Doppel heraus.
zusatz_kandidaten_zeile() {
    _liste=""
    for _ip in $1 $(printf '%s' "${2:-}" | tr ',' ' '); do
        case "$_ip" in
            *[!0-9.]* | *..* | *.*.*.*.* | .* | *. ) continue ;;
            *.*.*.*) ;;
            *) continue ;;
        esac
        case " ${3:-} " in *" $_ip "*) continue ;; esac
        case ", $_liste, " in *", $_ip, "*) continue ;; esac
        _liste="${_liste:+$_liste, }$_ip"
    done
    [ -n "$_liste" ] && printf 'webrtcAdditionalHosts: [%s]\n' "$_liste"
    return 0
}

# Kandidaten-Zeile eines VPS-Self-Hosts. $1 = PULSE_HOSTNAME, $2 = öffentliche
# IPv4 (PULSE_PUBLIC_IP oder STUN; leer/kaputt = unbekannt), $3 = wohin der
# Hostname IM CONTAINER auflöst (leerzeichengetrennt, leer = gar nicht).
# Begründung beim Aufruf unten. Zwei Sonderfälle:
# - die IP steht schon unter den Auflösungen → nur der Hostname. Auf einem
#   gewöhnlichen VPS bleibt die Konfiguration damit genau wie bis 2026-10-14.
# - der Hostname ist im Container gar nicht auflösbar → nur die IP. MediaMTX
#   bricht `addAdditionalCandidates` beim ersten nicht auflösbaren Eintrag mit
#   Fehler ab (peer_connection.go, 1.19.1); eine IP dahinter käme nie an.
vps_kandidaten_zeile() {
    _ip="${2:-}"
    case "$_ip" in
        *[!0-9.]* | *..* | *.*.*.*.* | .* | *. ) _ip="" ;;
        *.*.*.*) ;;
        *) _ip="" ;;
    esac
    [ -n "$_ip" ] && case " ${3:-} " in *" $_ip "*) _ip="" ;; esac
    if [ -z "$_ip" ]; then
        printf 'webrtcAdditionalHosts: [%s]\n' "$1"
    elif [ -z "${3:-}" ]; then
        printf 'webrtcAdditionalHosts: [%s]\n' "$_ip"
    else
        printf 'webrtcAdditionalHosts: [%s, %s]\n' "$1" "$_ip"
    fi
    return 0
}

# Self-signed cert for MediaMTX RTMPS (rtmpsAddress :1936). Idempotent —
# only generated on first start. Self-host operators that want a real cert
# can drop their own ${CERT_DIR}/mediamtx.{crt,key} into the data volume.
mkdir -p "${CERT_DIR}"
chown pulse:pulse "${CERT_DIR}"
if [ ! -f "${CERT_DIR}/mediamtx.crt" ] || [ ! -f "${CERT_DIR}/mediamtx.key" ]; then
    echo "[08-init-mediamtx] generating self-signed RTMPS cert (10y)"
    openssl req -x509 -nodes -newkey rsa:2048 \
        -keyout "${CERT_DIR}/mediamtx.key" \
        -out    "${CERT_DIR}/mediamtx.crt" \
        -days   3650 \
        -subj   "/CN=${PULSE_HOSTNAME}" \
        -addext "subjectAltName=DNS:${PULSE_HOSTNAME}" >/dev/null 2>&1
    chown pulse:pulse "${CERT_DIR}/mediamtx.crt" "${CERT_DIR}/mediamtx.key"
    chmod 0640 "${CERT_DIR}/mediamtx.crt" "${CERT_DIR}/mediamtx.key"
fi

if [ -f "${TEMPLATE}" ]; then
    sed -e "s|@@PULSE_HOSTNAME@@|${PULSE_HOSTNAME}|g" \
        "${TEMPLATE}" > /etc/mediamtx/mediamtx.yml
else
    # MVP fallback — RTMPS + WHEP + auth via the local hook
    cat > /etc/mediamtx/mediamtx.yml <<'EOF'
logLevel: info
logDestinations: [stdout]

# Schreibpuffer je Leser, in Paketen — wie infra/prod/mediamtx.yml (dort steht
# die Begruendung: der 512er-Default riss bei 60-fps-Streams mit FlexFEC schon
# bei halbsekuendigen Zuschauer-Stockern, "reader is too slow" → Ruckler).
writeQueueSize: 2048

api: yes
apiAddress: 127.0.0.1:9997

# RTMP-Eingang nur verschluesselt (RTMPS :1936), RTSP und SRT aus — wie die
# Cloud (infra/prod/mediamtx.yml, dort die Begruendung): media-svc gibt nur
# rtmps:// oder WHIP aus, ueber unverschluesseltes RTMP oder SRT laege das
# Sende-Token im Klartext auf der Leitung. Bis 2026-10-14 standen hier
# `rtmpEncryption: optional` und `:1935`, RTSP und SRT liefen mit ihren
# Vorgaben (:8554, :8890/udp) — ohne Nutzer, ohne festgehaltenen Grund
# (Abgleich Cloud/Self-Host vom 2026-10-14).
rtmp: yes
rtmpEncryption: strict
rtmpsAddress: :1936
rtmpServerCert: /data/certs/mediamtx.crt
rtmpServerKey: /data/certs/mediamtx.key

rtsp: no
srt: no

webrtc: yes
webrtcAddress: :8889
webrtcEncryption: no
# WebRTC/WHEP media plane: advertise a reachable ICE candidate. Without an
# explicit UDP port + host, MediaMTX offers only the container's internal
# bridge IPs and the WHEP connection never negotiates ("deadline exceeded").
webrtcLocalUDPAddress: :8189
webrtcIPsFromInterfaces: no

# HLS ist AUS — wie die Cloud (`hls: no` in infra/prod/mediamtx.yml).
#
# **Drei Gruende, gemessen 2026-09-25 an einem Self-Host** (AV1-Stream, vier
# Sitzungen, Nutzer startete wegen wachsendem Lag neu):
# 1. HLS kann nur an Vollbildern segmentieren → der Muxer fordert vom Sender
#    ein Vollbild je Segment an. Der hier frueher laufende Takt lag bei ~2 s:
#    1 293 Vollbild-Anforderungen in 35 Minuten (die Cloud: 5 in 27 min, nur
#    Zuschauer-Eintritte). Jedes Vollbild ist ein Vielfaches eines normalen
#    Bildes gross — auf knappen Strecken fuettert das den Sendestau.
# 2. `hlsAlwaysRemux: yes` liess den Muxer ZUSATZLICH ohne einen einzigen
#    Zuschauer durchlaufen.
# 3. Es gab ohnehin keine Caddy-Route auf :8888 und der Port ist nicht
#    veroeffentlicht — der Output war fuer niemanden erreichbar. Reine
#    Verschwendung ohne Gegenleistung.
#
# Keyframe-Takt (Heim-Server 2026-09-28, Cloud-Paritaet): der Fork wird mit
# PULSE_KEYFRAME_INTERVAL=0 gefahren (s. s6-rc.d/mediamtx/run) — der
# periodische Vollbild-Takt ist aus, glatter Strom nur mit Vollbildern on
# demand. STEHT HIER NUR ALS KOMMENTAR: eine Env-Zuweisung im YAML ist keine —
# sie liest MediaMTX als Dokument-Skalar und bricht mit "non-map value" ab
# (Erststart im Mac-E2E 2026-09-28, der Container restart-loopte davon).
hls: no

# MoQ (Media over QUIC, Port 8892) ist bei MediaMTX 1.19.1 STANDARDMAESSIG an,
# obwohl es hier niemand konfiguriert hat (2026-09-28 live verifiziert — auch
# die Cloud hoerte unbemerkt auf 8892). Kein Pulse-Client spricht MoQ: Sender
# kommen per WHIP, Zuschauer per WHEP. Aus — ein offener Port ohne Nutzer ist
# Angriffsflaeche ohne Nutzen. (Der Dev-Stack streaming/server/mediamtx.yml
# hat MoQ bewusst AN — dort wird es gelegentlich geprueft; nicht angleichen.)
moq: no

authMethod: http
authHTTPAddress: http://127.0.0.1:8005
# "api" steht hier bewusst NICHT (anders als infra/prod/mediamtx.yml): die
# API-Anfragen gehen an den Hook, der die Zugangsdaten aus
# MEDIAMTX_API_PASSWORD prüft (07-render-env.sh, api_zugang.py). Die
# Loopback-Bindung allein schützt im Container nicht — dort laufen weitere
# Prozesse, die Anfragen im Auftrag Fremder stellen (Direktweg-Adapter).
authHTTPExclude:
  - action: metrics
  - action: pprof

# Pulse HQ channel streams use DYNAMIC paths (channel-<id>-<uid>-<nonce>).
# MediaMTX rejects any path not listed here as "not configured" → without this
# catch-all EVERY publish is refused and the HQ push dies silently (no error).
# The auth hook (authMethod: http) still allows/denies each connection per
# path + token; this only lets MediaMTX accept the dynamic path names at all.
# Mirrors infra/prod/mediamtx.yml.
paths:
  all_others:
EOF
    # ICE-Kandidaten: hier trennen sich VPS-Self-Host und App-Hosting.
    # Angehängt nach dem Heredoc, weil der Block gequotet ist (keine Expansion).
    #
    # App-Hosting-Erkennung: explizit via PULSE_HOST_ORIGIN (app_host | vps,
    # von der Desktop-Server-App in container.env gesetzt) mit Vorrang; die
    # alte Token-Heuristik bleibt nur als Fallback für Bestands-Container —
    # ohne Relay-Provisioning (PULSE_RELAY_PROVISION_ENABLED=false) gibt es
    # keinen Token mehr, App-Host bleibt App-Host.
    _is_app_host=false
    case "${PULSE_HOST_ORIGIN:-}" in
        app_host) _is_app_host=true ;;
        vps) _is_app_host=false ;;
        *) [ -n "${PULSE_RELAY_TUNNEL_TOKEN:-}" ] && _is_app_host=true ;;
    esac
    if [ "$_is_app_host" = true ]; then
        # ---- App-Hosting (Server-App auf dem Gerät des Users, hinter Heim-NAT) ----
        # Der Hostname zeigt hier auf den Relay (= die Cloud), NICHT auf dieses
        # Gerät: ein Zuschauer schickte seine Videopakete an den falschen
        # Rechner. Es gibt auch keine öffentliche Adresse, die man eintragen
        # könnte — die Heim-IP wechselt. Also lässt MediaMTX sie sich per STUN
        # selbst sagen (srflx-Kandidat) und locht damit durch das NAT, genau
        # wie LiveKit (use_external_ip) und der direct-adapter.
        #
        # 0.0.0.0 statt :8189 bindet den ICE-Port auf IPv4. Mit Dual-Stack
        # funkte MediaMTX an die IPv6-Adresse des Zuschauers, die kein Heim-
        # Router von außen hereinlässt — 312 Pakete raus, 0 zurück (gemessen
        # 2026-07-10). Derselbe IPv6-Fallstrick wie beim WHEP-Reconnect der Cloud.
        #
        # webrtcIPsFromInterfaces MUSS an bleiben: MediaMTX bricht sonst mit
        # "at least one between 'webrtcIPsFromInterfaces' or
        # 'webrtcAdditionalHosts' must be filled" ab — STUN allein zählt ihm
        # nicht als Kandidatenquelle. Liefert zusätzlich den LAN-Kandidaten
        # für Zuschauer im selben Netz.
        sed -i -e 's|^webrtcLocalUDPAddress: :8189$|webrtcLocalUDPAddress: 0.0.0.0:8189|' \
               -e 's|^webrtcIPsFromInterfaces: no$|webrtcIPsFromInterfaces: yes|' \
            /etc/mediamtx/mediamtx.yml
        # Dieselbe Liste und Schreibweise wie der VPS-Zweig unten und der
        # Direktpfad-Adapter (`direct-adapter/src/config.rs`: Komma-getrennt,
        # Google UND Cloudflare). Bis 2026-10-14 nur Google, und eine gesetzte
        # Komma-Liste wurde hier als EIN Eintrag geschrieben.
        {
            printf 'webrtcICEServers2:\n'
            for stun in $(printf '%s' "${PULSE_DIRECT_STUN_SERVERS:-stun.l.google.com:19302 stun.cloudflare.com:3478}" | tr ',' ' '); do
                printf '  - url: stun:%s\n' "${stun}"
            done
        } >> /etc/mediamtx/mediamtx.yml
        # Host-LAN-IPs als zusätzliche Kandidaten. Zwei Fälle, ein Weg:
        # - VM-Betrieb (Win/podman-machine, PULSE_VM_ANNOUNCE_IP): Interfaces =
        #   VM-intern (172.x), srflx = WAN hinter WSL-Doppel-NAT — beides für
        #   fremde Geräte tot (gleiches Bild wie bei LiveKit, s.
        #   05-init-livekit.sh). Die Pakete erreichen :8189 über das Host-UDP-
        #   Relay auf genau dieser Adresse.
        # - Linux mit Docker-Bridge: das Interface trägt nur 172.17.x, srflx
        #   ist die WAN-Adresse — ein zweites Gerät im WLAN bekäme ohne
        #   Hairpin am Router keinen Stream. Die Host-LAN-IPs
        #   (PULSE_DIRECT_EXTRA_HOST_IPS, setzt die Server-App auf allen
        #   Plattformen) treffen den per `-p 8189:8189/udp` veröffentlichten
        #   Port.
        # Unter pasta sieht der Container die LAN-IP selbst; das Doppel fällt
        # in zusatz_kandidaten_zeile heraus.
        zusatz_kandidaten_zeile "${PULSE_VM_ANNOUNCE_IP:-}" \
            "${PULSE_DIRECT_EXTRA_HOST_IPS:-}" "$(hostname -I 2>/dev/null || true)" \
            >> /etc/mediamtx/mediamtx.yml
    else
        # ---- VPS-Self-Host: öffentlich erreichbar, der Hostname IST der Server ----
        # Die Interface-IPs des Containers sind interne Bridge-Adressen und
        # taugen nicht als Kandidat. Angekündigt werden der Hostname und, wo
        # er im Container nicht ohnehin darauf zeigt, die öffentliche IPv4.
        #
        # Warum der Hostname allein nicht reicht: MediaMTX löst ihn bei jeder
        # Sitzung IM CONTAINER per DNS auf (`net.LookupIP`, peer_connection.go
        # in 1.19.1) und kündigt nur das Ergebnis an. In einem Netz mit
        # Split-DNS ist das die interne Adresse — von innen erreichbar, von
        # außen nicht. So bei pulse.all3media.de (2026-10-14): von innen
        # sendeten und sahen HQ-Streams einwandfrei, von außen kam ICE in
        # keiner Richtung zustande, Voice lief von außen. Dass es dort
        # Split-DNS ist und nicht eine Firewall vor 8189/udp, ist aus diesem
        # Muster GEFOLGERT, nicht am Server gemessen; die Logzeile unten macht
        # es beim nächsten Start sichtbar.
        #
        # Die öffentliche Adresse: eine von Hand gesetzte PULSE_PUBLIC_IP hat
        # Vorrang (derselbe Schalter wie für coturn, .env.example), sonst STUN
        # — aus demselben Container, auf dem Weg, auf dem auch LiveKit
        # (`use_external_ip`, templates/livekit.yaml.template) seine Adresse
        # findet, und die funktioniert dort von außen. Zwei STUN-Server wie
        # beim Direktpfad-Adapter (direct-adapter/src/config.rs); dort ist die
        # Liste kommagetrennt, deshalb das `tr`. `timeout` deckelt einen
        # hängenden DNS, sonst stünde der ganze Start. Ohne Antwort bleibt es
        # beim Hostnamen allein, wie bisher.
        _intern="$(getent ahostsv4 "${PULSE_HOSTNAME}" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ')"
        _intern="${_intern% }"
        _oeffentlich="${PULSE_PUBLIC_IP:-}"
        if [ -z "${_oeffentlich}" ]; then
            # shellcheck disable=SC2046 # Wortzerlegung der Serverliste ist gewollt
            _oeffentlich="$(timeout 8 /usr/local/bin/pulse-oeffentliche-ip \
                $(printf '%s' "${PULSE_DIRECT_STUN_SERVERS:-stun.l.google.com:19302 stun.cloudflare.com:3478}" | tr ',' ' ') \
                2>/dev/null || true)"
        fi
        _zeile="$(vps_kandidaten_zeile "${PULSE_HOSTNAME}" "${_oeffentlich}" "${_intern}")"
        printf '%s\n' "${_zeile}" >> /etc/mediamtx/mediamtx.yml
        echo "[08-init-mediamtx] ${PULSE_HOSTNAME} im Container: ${_intern:-nicht auflösbar}; öffentlich: ${_oeffentlich:-unbekannt} → ${_zeile}"
    fi
fi

chown pulse:pulse /etc/mediamtx/mediamtx.yml
chmod 0640 /etc/mediamtx/mediamtx.yml

echo "[08-init-mediamtx] /etc/mediamtx/mediamtx.yml rendered"
