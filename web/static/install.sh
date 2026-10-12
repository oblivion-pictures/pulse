#!/usr/bin/env bash
#
# Pulse Self-Host — One-command installer
# =======================================
#   curl -fsSL https://howispulse.com/install | bash
#   curl -fsSL https://howispulse.com/install | PULSE_HOSTNAME=chat.example.org bash
#
# Fragt nach der Adresse des Servers (oder nimmt PULSE_HOSTNAME bzw. das erste
# Argument), startet den Container und verbindet ihn am Ende mit dem
# Pulse-Konto des Betreibers: `pulse-connect` im Container zeigt Link und Code,
# der Betreiber bestätigt im Browser. Seit Oktober 2026 ohne Antrag und ohne
# Token (docs/superpowers/specs/2026-10-09-selfhost-ohne-freigabe-design.md).
#
# Das Script erkennt die Umgebung selbst und richtet sich passend ein — auch
# wenn auf dem Server schon ein Reverse-Proxy läuft (User-Output ist Englisch,
# Kommentare bleiben Deutsch für die Wartung):
#
#   1. Auto-Discovery-Proxy (caddy-docker-proxy / Traefik / nginx-proxy) → der
#      Container hängt sich ins Proxy-Netz + setzt Labels/Env → automatisch.
#   2. Port 80 + 443 frei → Pulse terminiert HTTPS selbst (Let's Encrypt).
#   3. Statischer dockerisierter Proxy → Netz-Anbindung + eine Route ausgeben.
#   4. Reverse-Proxy außerhalb von Docker → Loopback-Port + Route ausgeben.
#
# --dry-run zeigt nur den Plan und verändert nichts.
set -euo pipefail

# --- Konfiguration (per Env überschreibbar) --------------------------------
CLOUD_ORIGIN="${PULSE_CLOUD_ORIGIN:-https://howispulse.com}"
IMAGE="${PULSE_IMAGE:-ghcr.io/oblivion-pictures/pulse:stable}"
CONTAINER="${PULSE_CONTAINER:-pulse}"
VOLUME="${PULSE_VOLUME:-pulse-data}"
# Config-Verzeichnis: root → /opt/pulse, sonst ins Home (Docker-Gruppen-User
# ohne root-FS-Zugriff). Per PULSE_DIR überschreibbar.
if [ -n "${PULSE_DIR:-}" ]; then
  :
elif [ "$(id -u)" = "0" ]; then
  PULSE_DIR="/opt/pulse"
else
  PULSE_DIR="${HOME:-/tmp}/.pulse"
fi
HTTP_PORT="${PULSE_HTTP_PORT:-8080}"
ENV_FILE="${PULSE_DIR}/pulse.env"
UPDATE_SH="${PULSE_DIR}/pulse-update.sh"
# Optionale harte Overrides:
#   PULSE_TLS_MODE = auto | provided | behind-proxy ; PULSE_NETWORK = Docker-Netz
FORCE_TLS_MODE="${PULSE_TLS_MODE:-}"
FORCE_NETWORK="${PULSE_NETWORK:-}"
# Woher Eingaben kommen. Bei `curl … | bash` ist stdin die Pipe, deshalb das
# Terminal direkt. PULSE_TTY biegt das um — die Tests setzen es, damit ein
# Lauf aus einem Terminal heraus nie auf eine Eingabe wartet.
TTY_GERAET="${PULSE_TTY:-/dev/tty}"

# --- Args ---------------------------------------------------------------- #
DRY_RUN=""
SRV_HOST="${PULSE_HOSTNAME:-}"
ADMIN_EMAIL="${PULSE_ADMIN_EMAIL:-}"
ALTER_TOKEN=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --*) ;;                       # unbekannte Flags ignorieren
    plse_boot_*) ALTER_TOKEN=1 ;; # alter Befehl `bash -s -- <TOKEN>`, s. unten
    *) if [ -z "$SRV_HOST" ]; then SRV_HOST="$arg"; fi ;;
  esac
done
# Zugangsdaten kennt der Installer nur von Bestandsservern (bestand_uebernehmen)
# oder, nach dem Verbinden, aus dem Datenvolumen (zugang_aus_volumen).
INSTANCE_ID=""; CLIENT_ID=""; CLIENT_SECRET=""; BESTAND_ZEILEN=""
# Zusatzzeilen einer früheren pulse.env (zusatz_uebernehmen), Name der Sicherungskopie
# dieser pulse.env und die Adresse, auf die sie zuletzt lief, falls sie nicht diese ist.
ZUSATZ_ZEILEN=""; ENV_SICHERUNG=""; ALTE_ADRESSE=""
# Gesetzt von server_verbinden, sobald der Server mit einem Pulse-Konto verbunden ist.
VERBUNDEN=""

# --- Ausgabe-Helfer --------------------------------------------------------
log()  { printf '\033[1;36m[pulse]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[pulse]\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m[pulse] ERROR:\033[0m %s\n' "$*" >&2; }
die()  { err "$*"; exit 1; }

# Bis Oktober 2026 verlangte der Installer einen Einmal-Token aus der Cloud.
# Alte Befehle laufen weiter; der Token wird nicht mehr verwendet.
if [ -n "$ALTER_TOKEN" ] || [ -n "${PULSE_BOOTSTRAP_TOKEN:-}" ]; then
  warn "Setup tokens are no longer needed — ignoring the token."
fi

# --- Docker prüfen ------------------------------------------------------- #
command -v docker >/dev/null 2>&1 \
  || die "Docker is not installed. → https://docs.docker.com/engine/install/"
docker info >/dev/null 2>&1 \
  || die "Cannot reach the Docker daemon. Run this script as root (sudo) or start Docker."

# --- Helfer: Port belegt? ------------------------------------------------ #
port_busy() {
  if command -v ss >/dev/null 2>&1; then
    ss -Hltn "sport = :$1" 2>/dev/null | grep -q .
  elif command -v netstat >/dev/null 2>&1; then
    netstat -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$1\$"
  else
    return 1   # kann nicht prüfen → als frei annehmen
  fi
}

udp_port_busy() {
  if command -v ss >/dev/null 2>&1; then
    ss -Hlun "sport = :$1" 2>/dev/null | grep -q .
  elif command -v netstat >/dev/null 2>&1; then
    netstat -lun 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$1\$"
  else
    return 1
  fi
}

# --- Alle Ports prüfen, die wir binden werden --------------------------- #
#
# Warum VOR jeder Änderung: `docker run` läuft erst in Schritt 3, nachdem die
# Konfiguration geschrieben und das Bild geladen ist. Ein belegter Port 3478
# (ein anderer coturn, gar nicht selten) liess das Script unter `set -e`
# sterben — mit einer rohen Docker-Fehlermeldung und einem halb eingerichteten
# Server. Zwei Sekunden vorher war das erkennbar.
#
# Übersprungen bei einer Neuinstallation: dort hält der ALTE Pulse-Container
# die Ports noch, und `docker run` bekommt sie, weil er vorher entfernt wird.
# Ohne diese Ausnahme meldete das Script bei jedem zweiten Lauf einen Konflikt
# mit sich selbst.
check_ports() {
  # Nur ein LAUFENDER eigener Container darf die Prüfung überspringen — er
  # hält die Ports selbst und gibt sie beim `docker run` nach dem `rm -f`
  # wieder frei. Ein gestoppter (`created`/`exited`) hält nichts: `docker
  # inspect` gelingt für ihn genauso, aber ohne diese Unterscheidung prüfte
  # ein zweiter Lauf nach einem Teilabbruch gar keinen Port mehr, und ein
  # echter Fremdkonflikt wäre erst an `docker run` gescheitert.
  eigener_container_laeuft && return 0
  local belegt=""
  local p
  case "$MODE" in
    greenfield) for p in 80 443; do port_busy "$p" && belegt="${belegt} ${p}/tcp"; done ;;
    hostproxy)  port_busy "$HTTP_PORT" && belegt="${belegt} ${HTTP_PORT}/tcp" ;;
  esac
  port_busy 3478 && belegt="${belegt} 3478/tcp"
  port_busy 1936 && belegt="${belegt} 1936/tcp"
  udp_port_busy 3478 && belegt="${belegt} 3478/udp"
  udp_port_busy 8189 && belegt="${belegt} 8189/udp"
  for p in $(seq 7882 7892); do
    udp_port_busy "$p" && belegt="${belegt} ${p}/udp"
  done
  [ -z "$belegt" ] && return 0
  die "These ports are already in use:${belegt}
  Pulse needs them for voice and screen sharing. Free them (or stop whatever
  is listening) and run this command again. Nothing has been changed yet."
}

# --- $PULSE_DIR muss beschreibbar sein — vor der ersten Änderung -------- #
#
# `mkdir -p "$PULSE_DIR"` ist der erste schreibende Dateisystemzugriff des Laufs.
# Wer PULSE_DIR=/opt/pulse ohne Schreibrechte setzt, bekam sonst erst beim
# Schreiben der Konfiguration eine rohe mkdir-Fehlermeldung unter set -e. Legt
# das Verzeichnis hier bereits an (idempotent, kein Test-und-wieder-Löschen)
# statt es nur zu prüfen — die spätere `mkdir -p` in schreibe_konfiguration
# wird damit zu einem reinen No-op und bleibt dort trotzdem stehen, falls sich
# der Ablauf dazwischen je trennt.
pruefe_pulse_dir_schreibbar() {
  mkdir -p "$PULSE_DIR" 2>/dev/null && [ -w "$PULSE_DIR" ] || die "Cannot create or write to '${PULSE_DIR}'.
  Check the permissions on that path, or set PULSE_DIR=<a writable path> and
  run this command again. Nothing has been changed yet."
}

# --- Adresse des Servers ------------------------------------------------- #
#
# Sie kommt aus PULSE_HOSTNAME, dem ersten Argument oder einer Frage am
# Terminal (Frage auf stdout wie bei der Routen-Frage weiter unten, Antwort
# aus TTY_GERAET). Liegt von einer früheren Installation schon eine
# pulse.env da, ist deren Adresse die Vorgabe — ein erneuter Lauf soll nicht
# aus Versehen eine andere Adresse eintragen.
frage_adresse() {
  [ -n "$SRV_HOST" ] && return 0
  local vorschlag=""
  if [ -r "$ENV_FILE" ]; then
    vorschlag="$(grep -m1 '^PULSE_HOSTNAME=' "$ENV_FILE" | cut -d= -f2- || true)"
  fi
  if { : <"$TTY_GERAET"; } 2>/dev/null; then
    if [ -n "$vorschlag" ]; then
      printf '  Address of this server [%s]: ' "$vorschlag"
    else
      printf '  Address of this server (e.g. chat.example.org): '
    fi
    read -r SRV_HOST <"$TTY_GERAET" || true
  fi
  SRV_HOST="${SRV_HOST:-$vorschlag}"
  [ -n "$SRV_HOST" ] || die "No server address given.
  Usage: curl -fsSL ${CLOUD_ORIGIN}/install | PULSE_HOSTNAME=chat.example.org bash
  The address needs a DNS record pointing at this machine."
}

# Dieselbe Form, die die Cloud beim Verbinden einträgt
# (dcc_shared.hostname.normalisiere_hostname): Kleinbuchstaben, ohne Schema,
# Pfad, Port und abschliessenden Punkt. Wiche sie ab, stünde in pulse.env eine
# andere Adresse als im Cloud-Eintrag.
pruefe_adresse() {
  SRV_HOST="$(printf '%s' "$SRV_HOST" | tr -d '[:space:]' | tr 'A-Z' 'a-z' \
    | sed -e 's|^[a-z][a-z0-9+.-]*://||' -e 's|[/:?#].*$||' -e 's|\.$||')"
  printf '%s' "$SRV_HOST" \
    | grep -qE '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,63}|xn--[a-z0-9-]{1,59})$' \
    || die "'${SRV_HOST}' is not a valid server address (expected something like chat.example.org).
  The address needs a DNS record pointing at this machine."
}

# --- Zugangsdaten aus KEY=wert-Zeilen lesen (stdin) ---------------------- #
# Setzt INSTANCE_ID, CLIENT_ID und CLIENT_SECRET. Gibt nichts aus.
zugang_lesen() {
  local k v
  while IFS='=' read -r k v || [ -n "$k" ]; do
    v="${v%\"}"; v="${v#\"}"
    case "$k" in
      PULSE_INSTANCE_ID)         INSTANCE_ID="$v" ;;
      PULSE_CLOUD_CLIENT_ID)     CLIENT_ID="$v" ;;
      PULSE_CLOUD_CLIENT_SECRET) CLIENT_SECRET="$v" ;;
    esac
  done
}

# --- Zusatzzeilen einer früheren pulse.env übernehmen -------------------- #
#
# Der Installer schreibt pulse.env jedes Mal neu. Was ein Betreiber dort von
# Hand ergänzt hat (öffentliche IP hinter NAT, Log-Stufe, Sicherungs-Schalter,
# Adresse für Let's Encrypt), wäre sonst mit dem nächsten Lauf weg — und weil
# der Container die Datei nur beim Anlegen liest, merkte er es erst beim
# nächsten Update. Übernommen wird eine feste Liste, nichts Unbekanntes; was
# der Installer selbst schreibt (Adresse, TLS-Modus, Port), kommt aus dem neuen
# Lauf. Ein Wert mit Zeichen ausserhalb von Buchstaben, Ziffern und `._:@/+,=-` (auch ein
# Zeilenende aus Windows) wird mit seinem Namen gemeldet und nicht übernommen.
# Die Mail-Adresse geht über ADMIN_EMAIL; eine ausdrücklich gesetzte
# PULSE_ADMIN_EMAIL gewinnt gegen die alte Datei. Liest nur.
zusatz_uebernehmen() {
  local zeile name wert
  while IFS= read -r zeile; do
    name="${zeile%%=*}"
    wert="${zeile#*=}"
    [ -n "$wert" ] || continue
    if ! printf '%s' "$wert" | grep -qE '^[A-Za-z0-9._:@/+,=-]+$'; then
      warn "Ignoring ${name} in ${ENV_FILE}: its value has characters this installer does not carry over."
      continue
    fi
    if [ "$name" = "PULSE_ADMIN_EMAIL" ]; then
      [ -z "$ADMIN_EMAIL" ] || continue
      ADMIN_EMAIL="$wert"
    else
      ZUSATZ_ZEILEN="${ZUSATZ_ZEILEN:+${ZUSATZ_ZEILEN}$'\n'}${name}=${wert}"
    fi
    log "Keeping ${name} from the previous configuration."
  done < <(grep -E '^(PULSE_PUBLIC_IP|PULSE_LOG_LEVEL|PULSE_BACKUP_[A-Z0-9_]+|PULSE_ADMIN_EMAIL)=' "$ENV_FILE" || true)
}

# --- Bestand: Verbindung einer Installation aus der Freigabe-Zeit ------- #
#
# Server, die vor Oktober 2026 mit Freigabe eingerichtet wurden, tragen ihre
# Zugangsdaten in $ENV_FILE und nicht im Datenvolumen. Schriebe ein erneuter
# Lauf die Datei ohne sie, stünde der Server unverbunden da; ein neues
# Verbinden gäbe ihm eine neue Instanz-Nummer, und seine Mitglieder verlören
# ihn aus ihrer Server-Liste. Gehört die alte Datei zu derselben Adresse,
# wandern ihre Verbindungswerte deshalb unverändert mit (im Container gewinnt
# die Umgebung ohnehin vor /data/pulse/verbindung.env). Liest nur.
#
# Die alte Datei wird beim Schreiben als Sicherung beiseitegelegt
# (schreibe_konfiguration); ihr Name steht hier schon fest, damit Meldung,
# Dry-Run und Kopie denselben Pfad nennen. Gehört sie zu einer anderen
# Adresse, steht in ihr die einzige Kopie der Zugangsdaten des alten Servers
# ausserhalb seines Containers. Eine Verbindung im Datenvolumen ist davon
# unberührt: sie bleibt beim Volumen, gilt aber für die alte Adresse — ALTE_ADRESSE
# erinnert server_verbinden daran.
bestand_uebernehmen() {
  [ -r "$ENV_FILE" ] || return 0
  ENV_SICHERUNG="${ENV_FILE}.bak-$(date +%s)"
  if [ -n "$DRY_RUN" ]; then
    log "Dry run: ${ENV_FILE} exists — a real run saves it as ${ENV_SICHERUNG} before rewriting it."
  fi
  zusatz_uebernehmen
  local alter_host
  alter_host="$(grep -m1 '^PULSE_HOSTNAME=' "$ENV_FILE" | cut -d= -f2- || true)"
  [ -n "$alter_host" ] || return 0
  if [ "$alter_host" != "$SRV_HOST" ]; then
    ALTE_ADRESSE="$alter_host"
    warn "The previous configuration in ${ENV_FILE} belongs to ${alter_host}. Its connection values are not carried over; a copy of the file is saved as ${ENV_SICHERUNG} before it is rewritten."
    warn "A connection saved in the Docker volume '${VOLUME}' stays with that volume and still belongs to ${alter_host}."
    return 0
  fi
  BESTAND_ZEILEN="$(grep -E '^PULSE_(INSTANCE_ID|INSTANCE_OWNER_ID|CLOUD_CLIENT_ID|CLOUD_CLIENT_SECRET)=.' "$ENV_FILE" || true)"
  [ -n "$BESTAND_ZEILEN" ] || return 0
  zugang_lesen <<<"$BESTAND_ZEILEN"
  log "Keeping the existing connection of ${SRV_HOST} (instance ${INSTANCE_ID})."
}

# --- Bild: das eines vorhandenen Servers beibehalten --------------------- #
#
# Ohne ausdrückliches PULSE_IMAGE ist die Vorgabe `…/pulse:stable`. Ein
# erneuter Lauf auf einem Server, der schon steht, darf ihn nicht still darauf
# umstellen: einzelne Server stehen bewusst auf `:edge`, die drei
# Bestandsserver ziehen vom Spiegel. Also das Bild des vorhandenen eigenen
# Containers übernehmen, ersatzweise die IMAGE-Zeile einer vorhandenen
# pulse-update.sh (Container entfernt, Updater liegt noch da).
#
# Der Spiegel registry.howispulse.com kennt nur Zugangsdaten, die der Installer
# aus der pulse.env eines Bestandsservers hat (bestand_uebernehmen). Fehlen
# sie, wird daraus das öffentliche Bild mit demselben Tag; ein Digest oder ein
# Bild ohne Tag lässt sich nicht abbilden und fällt auf die Vorgabe zurück.
#
# Muss nach bestand_uebernehmen laufen (Zugangsdaten) und vor build_run_args
# (das Bild landet in RUN_ARGS und im Updater).
waehle_bild() {
  [ -z "${PULSE_IMAGE:-}" ] || return 0
  local vorhanden="" tag
  if ist_unser_container; then
    vorhanden="$(docker inspect -f '{{.Config.Image}}' "$CONTAINER" 2>/dev/null || true)"
  fi
  if [ -z "$vorhanden" ] && [ -r "$UPDATE_SH" ]; then
    # Nur schlichte Bildnamen: die Zeile stammt aus einer Datei, die jemand
    # von Hand angefasst haben kann.
    vorhanden="$(sed -n 's|^IMAGE=\([A-Za-z0-9._:@/-]*\)$|\1|p' "$UPDATE_SH" | head -n1)"
  fi
  [ -n "$vorhanden" ] || return 0
  IMAGE="$vorhanden"
  case "$vorhanden" in
    registry.howispulse.com/*)
      if [ -z "$CLIENT_ID" ] || [ -z "$CLIENT_SECRET" ]; then
        tag="${vorhanden##*/}"
        case "$tag" in
          *@*) tag=stable ;;
          *:*) tag="${tag##*:}" ;;
          *)   tag=stable ;;
        esac
        IMAGE="ghcr.io/oblivion-pictures/pulse:${tag}"
        log "Using image ${IMAGE} — the registry mirror needs credentials this server does not have."
        return 0
      fi ;;
  esac
  log "Keeping image ${IMAGE} of the existing server."
}

# --- Spiegel registry.howispulse.com nur mit Bestands-Zugang ------------- #
#
# Der Spiegel nimmt die Zugangsdaten jeder aktiven Instanz an
# (routes_registry_auth.py), genutzt wird er aber nur von Bestandsservern: der
# Installer kennt Zugangsdaten allein aus deren pulse.env. Ohne sie scheiterte
# ein Lauf erst beim Pull, nach dem Schreiben der Konfiguration — deshalb
# hier, vor jeder Änderung.
pruefe_registry_zugang() {
  case "$IMAGE" in
    registry.howispulse.com/*)
      if [ -z "$CLIENT_ID" ] || [ -z "$CLIENT_SECRET" ]; then
        die "The image ${IMAGE} is the registry mirror, which needs instance credentials.
  This installer only knows them from the pulse.env of an existing server on the same address.
  Use the public image instead: unset PULSE_IMAGE and run this command again.
  Nothing has been changed yet."
      fi ;;
  esac
  return 0
}

# --- Konfiguration schreiben (chmod 600) -------------------------------- #
#
# Nur Adresse und Betriebswerte. Die Zugangsdaten holt pulse-connect am Ende
# selbst ab und legt sie ins Datenvolumen (/data/pulse/verbindung.env); hier
# stehen sie allein bei einem Bestandsserver (s. bestand_uebernehmen).
#
# Eine vorhandene Datei wird vorher kopiert (cp -p, Modus 600: sie kann das
# Secret eines Bestandsservers tragen). Scheitert die Kopie, bricht der Lauf ab,
# bevor die Datei angefasst wird. `${ENV_SICHERUNG:-…}` fängt den Fall, dass
# bestand_uebernehmen die Datei nicht lesen konnte und den Namen nicht festlegte.
schreibe_konfiguration() {
  mkdir -p "$PULSE_DIR"
  if [ -e "$ENV_FILE" ]; then
    local sicherung="${ENV_SICHERUNG:-${ENV_FILE}.bak-$(date +%s)}"
    ( umask 077; cp -p -- "$ENV_FILE" "$sicherung" ) \
      || die "Could not save the existing ${ENV_FILE} as ${sicherung}. Nothing has been changed."
    chmod 600 "$sicherung"
    log "Previous configuration saved as ${sicherung} (readable by root only)"
  fi
  ( umask 077
    {
      printf 'PULSE_HOSTNAME=%s\n' "$SRV_HOST"
      printf 'PULSE_INSTANCE_MODE=self-host\n'
      printf 'PULSE_CLOUD_ORIGIN=%s\n' "$CLOUD_ORIGIN"
      if [ -n "$ADMIN_EMAIL" ]; then printf 'PULSE_ADMIN_EMAIL=%s\n' "$ADMIN_EMAIL"; fi
      printf 'PULSE_TLS_MODE=%s\n' "$TLS_MODE"
      printf 'PULSE_HTTP_PORT=%s\n' "$HTTP_PORT"
      if [ -n "$ZUSATZ_ZEILEN" ]; then printf '%s\n' "$ZUSATZ_ZEILEN"; fi
      if [ -n "$BESTAND_ZEILEN" ]; then printf '%s\n' "$BESTAND_ZEILEN"; fi
    } > "$ENV_FILE"
  )
  chmod 600 "$ENV_FILE"
}

# --- Helfer: alle Nutzer-Netze eines Containers, eines je Zeile ---------- #
#
# `|| true`, weil "kein Treffer" ein normaler Zustand ist (der Proxy haengt
# nur im Default-Bridge-Netz) und `grep`s Exit 1 unter `pipefail` sonst den
# ganzen Lauf beendet — samt der Warnung in `decide_mode`, die genau fuer
# diesen Fall geschrieben wurde und deshalb nie erscheinen konnte.
proxy_netze() {
  docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}' "$1" 2>/dev/null \
    | grep -vE '^(host|none|bridge)$' | grep -v '^$' || true
}

# --- Helfer: veroeffentlicht dieser Container 80 oder 443 nach aussen? --- #
#
# `.NetworkSettings.Ports` bildet Container-Port -> Host-Bindungen ab. Ein
# Container, der 80 nur EXPONIERT (Wert null), taucht damit nicht auf — genau
# der Unterschied zwischen einem Reverse-Proxy und einer App, die zufaellig
# nginx im Image hat.
publishes_web_port() {
  docker inspect -f '{{range $p, $c := .NetworkSettings.Ports}}{{if $c}}{{$p}} {{end}}{{end}}' "$1" 2>/dev/null \
    | grep -qE '(^| )(80|443)/tcp'
}

# --- Helfer: laeuft dieser Container mit network_mode: host? ------------- #
#
# `publishes_web_port` sieht so einen Proxy nie: `--network host` traegt
# keine Eintraege in `.NetworkSettings.Ports` (es gibt keinen eigenen
# Netzwerk-Namespace, den Docker dort abbilden koennte). Ohne diesen
# zweiten, ebenfalls container-eigenen Beweis muesste die Ausnahme fuer
# Host-Networking auf einen host-weiten `port_busy`-Check ausweichen — der
# aber nur zeigt, dass IRGENDETWAS auf der Maschine 80/443 haelt, nicht
# dieser Container. Auf einer Maschine mit mehreren Projekten (z.B. dem
# Produktiv-VPS) haette das einem unveroeffentlichten `traefik/whoami`
# denselben Freifahrtschein zurueckgegeben, den die Beweisregel gerade
# schliessen soll — nur ueber einen fremden Port statt ueber den Image-Namen.
nutzt_host_netzwerk() {
  [ "$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$1" 2>/dev/null)" = "host" ]
}

# --- Helfer: ist das unser eigener, laufender Container? ----------------- #
#
# Ohne diese Frage stuft sich der Installer beim ZWEITEN Lauf selbst herunter:
# im greenfield-Modus haelt Pulse 80 und 443, das Image passt auf kein
# Proxy-Muster, und der Zweig `none` schliesst daraus auf einen fremden
# Reverse-Proxy. Ergebnis: TLS kippt auf behind-proxy, ACME stellt ein, der
# Server verschwindet aus dem Internet — waehrend der Container laeuft und die
# Checkliste gruen ist. `check_ports` kennt diese Ausnahme laengst (s. dort);
# nur die Moduswahl kannte sie nicht.
#
# Bewusst die LOSE Lesart von `.State.Running` (anders als Fund 1,
# Schlussprüfung, `container_laeuft_stabil()`): hier zählt nur „existiert er
# und hält er die Ports", nicht „läuft er stabil". Ein Container in einer
# Neustartschleife ist da und kommt wieder — ihn als abwesend zu behandeln
# wäre genau der Fehler, den Task 1 behoben hat (der zweite Lauf stufte einen
# laufenden Server auf `hostproxy` herunter und nahm ihn vom Netz).
eigener_container_laeuft() {
  [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" = "true" ]
}

# --- Helfer: gehört der vorhandene $CONTAINER wirklich zu Pulse? --------- #
#
# Nicht zu verwechseln mit `eigener_container_laeuft` oben — die fragt nur
# den Laufzustand ab und geht (wie an ihrem eigenen Aufrufort begründet)
# unausgesprochen davon aus, dass unter dem Namen "$CONTAINER" ohnehin nur
# Pulse selbst laufen kann. Genau diese Annahme prüft diese Funktion nach:
# ein FREMDER Container, der zufällig denselben Namen trägt (der
# Vorgabename `pulse` ist nicht reserviert), ist keine Randbedingung,
# sondern der Grund, warum dieser Helfer existiert.
#
# Geprüft wird das Image, nicht der Name — der Name ist ja gerade die
# Kollisionsquelle. DREI Wege gelten als "unser Container":
#   1. Ein Substring-Vergleich auf `pulse-allinone` — so heisst das Bild am
#      Spiegel registry.howispulse.com (Bestandsserver) und bis Oktober 2026
#      auf GHCR. `PULSE_IMAGE` ist überschreibbar, und ein Betreiber mit
#      eigenem Spiegel/Fork (eigene Registry, eigener Tag) soll den Installer
#      trotzdem benutzen können, solange der Repository-Name erhalten bleibt.
#   2. Das öffentliche Bild `ghcr.io/oblivion-pictures/pulse` mit beliebigem
#      Tag oder Digest — der Name `pulse` allein wäre zu allgemein, deshalb
#      nur unter genau diesem Pfad.
#   3. Ein exakter Vergleich mit dem AKTUELL konfigurierten `$IMAGE` (Fund 3,
#      Schlussprüfung) — Weg 1 allein sperrt einen Betreiber aus, der
#      `PULSE_IMAGE` auf einen anders benannten Spiegel/Fork gesetzt hat
#      (kein `pulse-allinone` im Namen): sein eigener Container gälte dann
#      unter demselben Containernamen für immer als fremd, und ein erneuter
#      Lauf des Installers könnte nie wieder auf ihn zugreifen.
# Ein Docker-LABEL wäre robuster (unabhängig von allen dreien), existiert im
# Image aber nicht — das einzuführen läge ausserhalb dieser Behebung.
ist_unser_container() {
  local img
  img="$(docker inspect -f '{{.Config.Image}}' "$CONTAINER" 2>/dev/null)"
  case "$img" in
    *pulse-allinone*) return 0 ;;
    ghcr.io/oblivion-pictures/pulse:*|ghcr.io/oblivion-pictures/pulse@*) return 0 ;;
    "$IMAGE") return 0 ;;
    *) return 1 ;;
  esac
}

# --- Fremdkonflikt am Containernamen erkennen (liest nur, löscht nichts) - #
#
# Wird an ZWEI Stellen aufgerufen: FRÜH, direkt nach `check_ports` und damit
# vor jeder Änderung — und SPÄT, direkt vor dem tatsächlichen `docker rm -f`
# in `sichere_container_ersetzung`. Die frühe Prüfung allein würde nicht
# reichen: zwischen ihr und dem eigentlichen Ersetzen liegen das Schreiben der
# Konfiguration und der Image-Pull, spürbare Zeit, in der sich der
# Containername theoretisch neu belegen liesse — ein Fremdkonflikt, der
# GENAU in dieser Lücke entsteht, fände die frühe Prüfung nicht mehr. Die
# späte Prüfung allein liesse eine geschriebene Konfiguration zurück, obwohl
# der Lauf von Anfang an keine Chance hatte. Beide zusammen schliessen das
# Fenster; keine der beiden ersetzt die andere.
#
# $1 = zusätzlicher Satz für die Meldung (früh: es wurde noch nichts
# verändert; spät: die Konfiguration steht schon, ein neuer Lauf ist sicher).
pruefe_container_konflikt() {
  local zusatz="${1:-}"
  docker inspect "$CONTAINER" >/dev/null 2>&1 || return 0
  ist_unser_container && return 0
  local meldung="A container named '${CONTAINER}' already exists, but its image
  ($(docker inspect -f '{{.Config.Image}}' "$CONTAINER" 2>/dev/null)) doesn't look like a Pulse
  installation. Refusing to remove it — it might belong to something else
  entirely.
  Rename or remove that container yourself and run this command again, or
  set PULSE_CONTAINER=<a different name> to make Pulse use its own name."
  [ -n "$zusatz" ] && meldung="${meldung}
  ${zusatz}"
  die "$meldung"
}

# --- Vorhandenen Container nur ersetzen, wenn er nachweislich unserer ist  #
#
# `docker rm -f` fragt nicht nach; ohne die vorangehende Prüfung wäre ein
# fremder Container namens "$CONTAINER" ohne Rückfrage weg. Die eigentliche
# Prüfung sitzt in `pruefe_container_konflikt` (s. dort) — hier nur noch der
# Aufruf plus das Entfernen selbst.
sichere_container_ersetzung() {
  pruefe_container_konflikt "The configuration has already been written — running this command again is safe."
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}

# --- Helfer: Traefik-certresolver von vorhandenen Containern erben ------- #
detect_traefik_certresolver() {
  docker ps -q 2>/dev/null | while read -r id; do
    docker inspect -f '{{range $k,$v := .Config.Labels}}{{$k}}={{$v}}{{"\n"}}{{end}}' "$id" 2>/dev/null
  done | grep -oE 'certresolver=[A-Za-z0-9_-]+' | head -1 | cut -d= -f2
}

# --- Reverse-Proxy erkennen --------------------------------------------- #
# Setzt: PROXY_KIND (none|caddy-docker-proxy|traefik|nginx-proxy|static-caddy|
#        static-nginx), PROXY_CONTAINER, PROXY_NET
PROXY_KIND=none; PROXY_CONTAINER=""; PROXY_NET=""
# PULSE_NETWORK ist ein harter Override (s. Kopf) und gewinnt bedingungslos —
# auch VOR jeder Mehrdeutigkeits-Pruefung. `decide_mode` wendet ihn am Ende
# zwar ohnehin nochmal an (fuer den Fall, dass ueberhaupt kein Proxy erkannt
# wurde), aber die MODE-Wahl direkt nach `detect_proxy` braucht schon HIER
# ein nicht-leeres PROXY_NET: sonst faellt ein erkannter Proxy in mehreren
# Netzen trotz gesetztem PULSE_NETWORK zunaechst auf den Loopback-Modus
# zurueck, und der spaetere Override kommt zu spaet, um das MODE noch zu
# reparieren — der Admin liefe nach der Abbruch-Meldung unten in eine
# Sackgasse.
_set_proxy() {
  PROXY_CONTAINER="$1"; PROXY_KIND="$2"
  if [ -n "$FORCE_NETWORK" ]; then
    PROXY_NET="$FORCE_NETWORK"
    return
  fi
  local netze
  netze="$(proxy_netze "$1")"
  if [ -n "$netze" ] && [ "$(printf '%s\n' "$netze" | grep -c .)" -gt 1 ]; then
    die "Proxy '${PROXY_CONTAINER}' is attached to more than one Docker network:
$(printf '%s\n' "$netze" | sed 's/^/    - /')
  Picking one automatically would be a guess — on a real machine, that guess
  once put Pulse into a different project's network. Nothing has been
  changed yet.
  Set PULSE_NETWORK=<name> to the one Pulse should join and run this command
  again."
  fi
  PROXY_NET="$netze"
}

detect_proxy() {
  local name image
  # 1) Auto-Discovery-Proxies (höchste Priorität)
  # Dieselbe Beweisregel wie unten im statischen Zweig gilt fuer BEIDE
  # Auto-Discovery-Schleifen, nicht nur die zweite: ein Image-Name allein
  # ist kein Beweis, sonst kapert ein Container, der zufaellig
  # `caddy-docker-proxy`/`traefik`/`nginx-proxy` im Namen traegt (Demo-,
  # Test- oder Fork-Image), die Erkennung. Die Ausnahme ist absichtlich
  # container-eigen (`nutzt_host_netzwerk`, nicht ein host-weiter
  # `port_busy`): ein Proxy mit `network_mode: host` veroeffentlicht nichts
  # und IST trotzdem einer, aber ein host-weiter Check wuesste nur, dass
  # IRGENDETWAS auf der Maschine 80/443 haelt, nicht dieser Container — auf
  # einer Maschine mit mehreren Projekten reisst das genau die Luecke
  # wieder auf, die diese Regel schliessen soll.
  while IFS=$'\t' read -r name image; do
    publishes_web_port "$name" || nutzt_host_netzwerk "$name" || continue
    case "$image" in
      *caddy-docker-proxy*) _set_proxy "$name" caddy-docker-proxy; return ;;
    esac
  done < <(docker ps --format '{{.Names}}'$'\t''{{.Image}}' 2>/dev/null)
  while IFS=$'\t' read -r name image; do
    publishes_web_port "$name" || nutzt_host_netzwerk "$name" || continue
    case "$image" in
      *traefik*)                              _set_proxy "$name" traefik;     return ;;
      *nginxproxy/nginx-proxy*|*jwilder/nginx-proxy*) _set_proxy "$name" nginx-proxy; return ;;
    esac
  done < <(docker ps --format '{{.Names}}'$'\t''{{.Image}}' 2>/dev/null)
  # 2) Statische dockerisierte Proxies — nur relevant, wenn 80/443 belegt.
  #
  # Anders als oben sind die Muster hier GENERISCH (`*caddy*`, `*nginx*`) und
  # treffen deshalb auch Container, die bloss zufaellig nginx im Image haben.
  # Deswegen zaehlt nur, wer 80/443 auch wirklich veroeffentlicht — das ist die
  # einzige Eigenschaft, die einen Reverse-Proxy von einer App unterscheidet.
  #
  # Ohne diese Bedingung nahm die Schleife den ERSTEN Namenstreffer aus
  # `docker ps`, und das sortiert nach Erstellzeit (neueste zuerst). Am
  # 2026-08-25 gewann so `pulsetest_web` (nginx:1.27-alpine, Port 80 nur
  # intern, die Weboberflaeche des Dev-Stacks) gegen den echten `caddy`, der
  # zwei Monate aelter war — der Installer haette den Betreiber angewiesen,
  # eine Route in einen Container einzutragen, der gar kein Proxy ist.
  #
  # Faellt hier nichts an, bleibt PROXY_KIND=none und `decide_mode` waehlt bei
  # belegtem 80/443 den Modus `hostproxy` — richtig fuer einen Proxy auf dem
  # Host und auch fuer einen mit `network_mode: host` (der veroeffentlicht
  # nichts und hat ohnehin kein eigenes Docker-Netz).
  if port_busy 80 || port_busy 443; then
    while IFS=$'\t' read -r name image; do
      publishes_web_port "$name" || continue
      case "$image" in
        *caddy*) _set_proxy "$name" static-caddy; return ;;
        *nginx*) _set_proxy "$name" static-nginx; return ;;
        *traefik*) _set_proxy "$name" traefik; return ;;
      esac
    done < <(docker ps --format '{{.Names}}'$'\t''{{.Image}}' 2>/dev/null)
  fi
}

# --- Modus festlegen ----------------------------------------------------- #
# MODE: greenfield | discovery | static-docker | hostproxy
decide_mode() {
  detect_proxy
  case "$PROXY_KIND" in
    caddy-docker-proxy|traefik|nginx-proxy)
      if [ -n "$PROXY_NET" ]; then MODE=discovery
      # Ein host-vernetzter Auto-Discovery-Proxy (`--network host`) hat
      # ebenfalls kein eigenes Docker-Netz (PROXY_NET bleibt leer, wie beim
      # Default-Bridge-Fall unten) — er teilt aber den Netzwerk-Namensraum
      # des Hosts und erreicht 127.0.0.1:8080 unmittelbar. Nachgewiesen an
      # einem echten Docker-Daemon mit echtem Listener auf 127.0.0.1:
      # Standard-Bridge scheitert mit "connection refused" (eigenes
      # Loopback), ueber die Bridge-Gateway-Adresse mit Zeitueberschreitung,
      # --network host gelingt. Diese Bedingung unterscheidet nur diese zwei
      # nachgewiesenen Faelle, nicht jede denkbare Netzwerk-Topologie
      # (Macvlan, IPv6-only, rootless Docker mit abweichendem NAT sind
      # ungeprueft).
      elif nutzt_host_netzwerk "$PROXY_CONTAINER"; then MODE=hostproxy
      # Steht hier weder ein Netz noch Host-Networking fest, kennt der Code
      # nur, DASS keine gemeinsame Adresse existiert — nicht WARUM (default
      # Bridge? "none"-Netz?). Die Meldung behauptet deshalb keine Ursache,
      # die nie geprueft wurde.
      else die "Proxy '${PROXY_CONTAINER}' has no Docker network Pulse could join to reach it — the only address it could offer, a loopback (127.0.0.1), would be inside the PROXY CONTAINER itself, not the host's, and could never reach Pulse from there.
  Set PULSE_NETWORK=<name> to a network Pulse and '${PROXY_CONTAINER}' can both join, and run this command again.
  Nothing has been changed yet."; fi ;;
    static-caddy|static-nginx)
      if [ -n "$PROXY_NET" ]; then MODE=static-docker
      else die "Proxy '${PROXY_CONTAINER}' is only on the default Docker bridge network — Pulse has no reachable address to hand it.
  A loopback address (127.0.0.1) would be the PROXY CONTAINER's own loopback, not the host's; it could never reach Pulse from there.
  Set PULSE_NETWORK=<name> to a network Pulse and '${PROXY_CONTAINER}' can both join, and run this command again.
  Nothing has been changed yet."; fi ;;
    none)
      # Veroeffentlicht unser eigener laufender Container 80/443 SELBST, ist
      # das KEIN fremder Proxy, sondern der greenfield-Modus eines fruehreren
      # Laufs — der Container haelt die Ports dann zurecht. Blosses "laeuft"
      # reicht nicht: im hostproxy-Modus laeuft der Container ebenso, bindet
      # aber nur Loopback (s. build_run_args) — 80/443 gehoeren dann einem
      # host-nativen Reverse-Proxy, den `docker ps` gar nicht sieht. Ohne die
      # Veroeffentlichungs-Pruefung wuerde genau dieser gueltige, gleichwertige
      # Fall auf greenfield umgestellt und beim naechsten `docker run` die
      # eigenen 80/443 gegen den fremden Proxy verlieren.
      if eigener_container_laeuft && publishes_web_port "$CONTAINER"; then
        MODE=greenfield
      elif port_busy 80 || port_busy 443; then
        MODE=hostproxy
      else
        MODE=greenfield
      fi ;;
  esac
  # --- Harte Overrides ----------------------------------------------------
  # Reihenfolge ist Teil der Korrektheit, nicht nur Geschmack:
  #   1. PULSE_TLS_MODE validieren — VOR jeder Wirkung und vor allem vor dem
  #      Schreiben der Konfiguration weiter unten. Der Container kennt nur
  #      auto|provided|behind-proxy (s. 09-init-caddy.sh:20-62); ein
  #      unbekannter Wert (Tippfehler oder ein hier nicht abgebildeter Name)
  #      wirkte bisher STILL gar nicht — der Admin haette es erst am
  #      laufenden Server gemerkt.
  #   2. PULSE_NETWORK — es aendert nur PROXY_NET und hebt den Loopback-
  #      Ersatz `hostproxy` (wie `greenfield`) auf `static-docker`. Vorher
  #      wirkte das NUR aus `greenfield` heraus, obwohl `hostproxy` genau der
  #      Fall ist, in dem ein Admin die Fehlerkennung korrigieren will (ein
  #      Docker-Proxy, den `detect_proxy` uebersehen hat). Ist schon ein
  #      Proxy erkannt (discovery/static-docker, `_set_proxy` hat
  #      PULSE_NETWORK dort laengst verbaut), steht MODE hier bereits
  #      richtig — dieser Block aendert dann nichts mehr.
  #   3. PULSE_TLS_MODE zuletzt — sonst zoege ein gleichzeitig gesetztes
  #      PULSE_NETWORK ein ausdrueckliches `auto` (Schritt 2 laeuft ja davor)
  #      wieder auf `static-docker`, obwohl der Admin ausdruecklich eigenes
  #      Let's-Encrypt-Auto-TLS verlangt hat.
  case "$FORCE_TLS_MODE" in
    ''|auto|provided|behind-proxy) ;;
    *) die "Unknown PULSE_TLS_MODE='${FORCE_TLS_MODE}'.
  Allowed values: auto | provided | behind-proxy
  Nothing has been changed yet." ;;
  esac

  if [ -n "$FORCE_NETWORK" ]; then
    PROXY_NET="$FORCE_NETWORK"
    case "$MODE" in
      greenfield|hostproxy) MODE=static-docker ;;
    esac
  fi

  case "$FORCE_TLS_MODE" in
    auto)
      # PROXY_NET hier leeren, nicht nur MODE setzen: ein gleichzeitig
      # gesetztes PULSE_NETWORK hat den Block darüber vielleicht schon
      # gefüllt, aber greenfield hängt den Container an KEIN Netz
      # (build_run_args kennt --network nur für discovery/static-docker).
      # Bliebe PROXY_NET stehen, meldete print_plan weiterhin "network
      # <name>", obwohl das Netz gerade verworfen wurde — ein Override, der
      # still wirkungslos bleibt und trotzdem als wirksam gilt.
      MODE=greenfield; PROXY_NET="" ;;
    provided)
      # `provided` teilt sich die Port-Topologie mit `auto` (Caddy bindet
      # 80/443 fuer die Site, nur ohne ACME, s. 09-init-caddy.sh) — MODE
      # kennt aber nur Netzwerk-/Port-Topologie, nicht die Cert-Herkunft.
      # Das eigentliche TLS_MODE=provided setzt build_run_args separat.
      # PROXY_NET leeren aus demselben Grund wie bei `auto` oben.
      MODE=greenfield; PROXY_NET="" ;;
    behind-proxy)
      # Nur der Loopback-Ersatz zaehlt als "noch unentschieden" — ein bereits
      # erkannter Proxy (discovery/static-docker) bleibt unangetastet, sonst
      # wuerfe dieses Override z. B. die Auto-Discovery-Labels weg, obwohl
      # der Admin nur bestaetigt, was ohnehin schon richtig erkannt wurde.
      case "$MODE" in
        greenfield) MODE=hostproxy ;;
      esac ;;
  esac
  return 0   # nie über den Exit-Status der letzten Bedingung stolpern (set -e)
}

# --- docker-run-Argumente nach Modus zusammenbauen ---------------------- #
build_run_args() {
  RUN_ARGS=( -d --name "$CONTAINER" --restart unless-stopped
             --env-file "$ENV_FILE" -v "${VOLUME}:/data" )
  # Voice/HQ-Ports immer (Mirror infra/self-host/docker-compose.yml):
  # LiveKit-WebRTC, TURN, RTMPS-Ingest + MediaMTX-WHEP-ICE (8189/udp —
  # ohne den kommt die HQ-Stream-Wiedergabe nicht über den ICE-Handshake).
  RUN_ARGS+=( -p 7882-7892:7882-7892/udp -p 3478:3478/tcp -p 3478:3478/udp
              -p 1936:1936/tcp -p 8189:8189/udp )

  case "$MODE" in
    greenfield)
      TLS_MODE=auto
      RUN_ARGS+=( -p 80:80 -p 443:443 ) ;;
    discovery)
      TLS_MODE=behind-proxy
      RUN_ARGS+=( --network "$PROXY_NET" )
      case "$PROXY_KIND" in
        caddy-docker-proxy)
          RUN_ARGS+=( --label "caddy=${SRV_HOST}"
                      --label "caddy.reverse_proxy={{upstreams ${HTTP_PORT}}}" ) ;;
        traefik)
          # Traefik zerlegt Label-SCHLUESSEL an Punkten (Reflection auf eine
          # verschachtelte Struktur, "field not found, node: …" bei jedem
          # Bruch) und verwirft dabei die GESAMTE Label-Konfiguration des
          # Containers — nicht nur das eine Label. Am echten Traefik v3.5
          # gemessen, nicht nur aus der Doku (die verbietet ausdruecklich nur
          # "@"): ein FQDN als Router-Name hat den discovery-Modus fuer
          # KEINEN echten Hostnamen je funktionieren lassen, obwohl print_plan
          # "the proxy picks it up automatically. No manual step." verspricht.
          # tr -c '[:alnum:]' ersetzt bewusst ALLES ausser Buchstaben/Ziffern
          # (nicht nur Punkte) — jedes Zeichen, dem Traefiks Parser irgendwo
          # eine Sonderbedeutung gibt (Punkt als Feldtrenner, "@" als
          # Provider-Trenner, "[...]" als Index-Syntax), soll draussen
          # bleiben, ohne dass jedes einzelne davon hier aufgezaehlt wird. Die
          # HOST-REGEL unten bekommt weiterhin den echten SRV_HOST — dort ist
          # der Hostname ein Label-WERT, den Traefik nicht aufspaltet.
          local r="pulse-$(printf '%s' "$SRV_HOST" | tr -c '[:alnum:]' '-')"
          RUN_ARGS+=( --label "traefik.enable=true"
                      --label "traefik.http.routers.${r}.rule=Host(\`${SRV_HOST}\`)"
                      --label "traefik.http.routers.${r}.entrypoints=websecure"
                      --label "traefik.http.routers.${r}.tls=true"
                      --label "traefik.http.services.${r}.loadbalancer.server.port=${HTTP_PORT}" )
          local cr; cr="$(detect_traefik_certresolver || true)"
          [ -n "$cr" ] && RUN_ARGS+=( --label "traefik.http.routers.${r}.tls.certresolver=${cr}" ) || true ;;
        nginx-proxy)
          RUN_ARGS+=( -e "VIRTUAL_HOST=${SRV_HOST}" -e "VIRTUAL_PORT=${HTTP_PORT}" )
          if docker ps --format '{{.Image}}' 2>/dev/null | grep -qiE 'acme-companion|nginx-proxy-companion'; then
            RUN_ARGS+=( -e "LETSENCRYPT_HOST=${SRV_HOST}" -e "LETSENCRYPT_EMAIL=${ADMIN_EMAIL}" )
          fi ;;
      esac ;;
    static-docker)
      TLS_MODE=behind-proxy
      RUN_ARGS+=( --network "$PROXY_NET" ) ;;
    hostproxy)
      TLS_MODE=behind-proxy
      RUN_ARGS+=( -p "127.0.0.1:${HTTP_PORT}:${HTTP_PORT}" ) ;;
  esac
  # PULSE_TLS_MODE=provided ueberschreibt zuletzt: es teilt sich MODE=greenfield
  # mit `auto` (s. decide_mode), verlangt vom Container aber ein anderes
  # Cert-Herkunfts-Etikett im env-file. `if` statt `[ … ] && …` — unter
  # set -e reisst ein fehlschlagender `&&`-Test sonst den ganzen Lauf ab.
  if [ "${FORCE_TLS_MODE:-}" = "provided" ]; then TLS_MODE=provided; fi
  RUN_ARGS+=( "$IMAGE" )
}

# --- Plan ausgeben ------------------------------------------------------- #
print_plan() {
  log "Detected mode: ${MODE}${PROXY_KIND:+  (proxy: ${PROXY_KIND}${PROXY_CONTAINER:+ → ${PROXY_CONTAINER}}${PROXY_NET:+, network ${PROXY_NET}})}"
  case "$MODE" in
    greenfield)    log "→ Pulse binds 80/443 and obtains its own Let's Encrypt certificate." ;;
    discovery)     log "→ Pulse joins '${PROXY_NET}'; the proxy picks it up automatically. No manual step." ;;
    static-docker) log "→ Pulse joins '${PROXY_NET}', reachable as '${CONTAINER}:${HTTP_PORT}'. One route needed (see below)." ;;
    hostproxy)     log "→ Pulse listens on 127.0.0.1:${HTTP_PORT}. One route in your proxy needed (see below)." ;;
  esac
}

# --- Host-Updater: Skript generieren (ersetzt Watchtower) --------------- #
# Statt eines dauerlaufenden Fremd-Containers mit Docker-Socket (= Root auf
# dem Host) schreibt der Installer ein kleines, lesbares Skript auf den Host
# und lässt es per systemd-Timer laufen. KEIN Container hält den Socket; der
# Update-Code führt nur fest verdrahtete Befehle aus, nimmt keine Anweisungen
# aus dem Image entgegen. Die exakten docker-run-Argumente werden quoting-sicher
# ins Skript eingebacken, damit der Container identisch neu erstellt wird.
write_update_script() {
  mkdir -p "$PULSE_DIR"
  {
    cat <<'HEADER'
#!/usr/bin/env bash
# Pulse self-host updater — generated by the installer, replaces Watchtower.
# Pulls the configured image; if its digest changed, recreates the container
# with the exact same run arguments. Run by systemd timer 'pulse-update' or
# manually. Edit nothing here — re-run the installer to regenerate.
set -euo pipefail
HEADER
    printf 'IMAGE=%q\n' "$IMAGE"
    printf 'CONTAINER=%q\n' "$CONTAINER"
    # Eigener Log-Pfad, damit das Skript ihn selbst kappen kann (s. BODY).
    # Nur die Cron-Variante schreibt dorthin; unter systemd geht alles nach
    # journald (das begrenzt sich selbst) und die Datei existiert nie — das
    # Kappen ist dann ein No-op.
    printf 'LOG=%q\n' "${PULSE_DIR}/pulse-update.log"
    printf 'RUN_ARGS=('
    printf '%q ' "${RUN_ARGS[@]}"
    printf ')\n'
    # Registry-Zugang einbacken (chmod 700, gleicher Schutz wie pulse.env) —
    # nur für den Spiegel registry.howispulse.com, den nur Bestandsserver
    # nutzen (der Installer kennt die Zugangsdaten allein aus deren pulse.env,
    # s. pruefe_registry_zugang). Das öffentliche Bild auf GHCR braucht keine
    # Anmeldung.
    case "$IMAGE" in
      registry.howispulse.com/*)
        printf 'REGISTRY=%q\n' "registry.howispulse.com"
        printf 'REG_USER=%q\n' "$CLIENT_ID"
        printf 'REG_PASS=%q\n' "$CLIENT_SECRET" ;;
    esac
    cat <<'BODY'

# Das eigene Log kappen — auf JEDEM Ausgang, deshalb per trap.
#
# Ohne das waechst die Datei unbegrenzt: der Updater laeuft alle fuenf Minuten,
# und sobald die Instanz in der Cloud geloescht oder gesperrt ist, scheitert
# schon der Registry-Login (403 "instance is not available") — dann schreibt
# jeder Lauf eine Zeile, fuer immer. Rund 17 KB am Tag auf einem fremden
# Rechner, auf dem niemand nachsieht. Genau die frueh abbrechenden Pfade sind
# die lauten, deshalb trap statt einer Zeile am Ende.
#
# In-place gekappt (gleiche Inode), nicht per Umbenennen: der Cron haelt die
# Datei mit O_APPEND offen, waehrend dieses Skript laeuft. Ein Umbenennen
# liesse die laufende Ausgabe in der alten Datei verschwinden.
# Erst ab 4000 Zeilen kappen, dann auf 2000 — nicht bei jedem Ueberschreiten.
# Ohne diesen Abstand traefe die Grenze nach dem ersten Kappen bei JEDEM Lauf
# wieder zu (2000 + eine neue Zeile) und das Skript schriebe alle fuenf Minuten
# 2000 Zeilen neu, fuer nichts.
_trim_log() {
  [ -f "${LOG:-}" ] || return 0
  local zeilen tmp
  zeilen="$(wc -l < "$LOG" 2>/dev/null || echo 0)"
  [ "${zeilen:-0}" -gt 4000 ] 2>/dev/null || return 0
  tmp="$(mktemp 2>/dev/null)" || return 0
  if tail -n 2000 "$LOG" > "$tmp" 2>/dev/null; then
    cat "$tmp" > "$LOG" 2>/dev/null || true
  fi
  rm -f "$tmp"
}
trap _trim_log EXIT

# `docker run -d` liefert 0, sobald der Container ERZEUGT wurde — nicht, wenn
# er tatsaechlich laeuft. Ein Image, das startet und sofort wieder stirbt,
# gaelte sonst als Erfolg: der Updater loeschte daraufhin die Rollback-Kopie
# UND das zuletzt funktionierende Image. Da IMAGE ein rollender Tag ist
# (z. B. ':edge'), ist die Vorversion danach nicht mehr adressierbar.
#
# Versuche/Intervall ueber Env steuerbar, damit Tests nicht 15 Sekunden je
# Fall warten muessen. Im Betrieb bleibt das GESAMTFENSTER beim Defaultwert
# von 15 Sekunden: ein frisch gestarteter Container kann kurz brauchen
# (eigene Migration, langsamer Healthcheck), bevor er dauerhaft laeuft — ein
# einzelner Check waere zu ungeduldig.
#
# GEPRUEFT WIRD '.RestartCount' + '.State.Status', NICHT '.State.Running'.
# Docker haelt '.State.Running' waehrend der GESAMTEN Neustart-Rueckstufung
# auf 'true' — ein Container, der sofort stirbt und in der Schleife haengt
# (gestartet mit '--restart unless-stopped', s. build_run_args), meldet
# 'true' bei JEDER Probe, egal wie fein das Intervall ist. Zweimal
# unabhaengig an einem echten Docker-Daemon gemessen ('alpine sh -c "exit 1"'
# + '--restart unless-stopped'): 75 von 75 Proben 'true', waehrend
# 'status=restarting' und 'restarts' im selben Moment bei 5-8 stand.
# '.State.Restarting' waere die naheliegende Alternative, ist aber ebenfalls
# unbrauchbar: gemessen liefert es bei 'status=restarting' teils 'false'
# zurueck (Momentaufnahme-Rennen zwischen Zyklus-Ende und naechstem Start).
# '.RestartCount' dagegen ist ein monoton wachsender Zaehler INNERHALB einer
# Neustartschleife — dort faellt er nie zurueck. Er faellt aber sehr wohl
# zurueck bei einem MANUELLEN Neustart: 'docker restart' setzt ihn auf 0
# zurueck (gemessen: 5 im Karussell, unmittelbar nach 'docker restart' 0 —
# bei einem schnell wieder abstuerzenden Container steigt er von dort aus
# binnen Sekunden erneut). Fuer DIESES Fenster ist das folgenlos — es liegt
# unmittelbar nach 'docker run', niemand startet
# hier von Hand neu. Der Container ist hier gerade frisch erzeugt worden,
# sein Zaehler MUSS also ueber das ganze Fenster 0 bleiben, sonst ist der
# Start nicht stabil. Zusaetzlich wird '.State.Status = "running"' verlangt:
# das faengt den Moment ab, in dem der Container gerade zwischen zwei
# Neustarts steht ('restarting'/'exited'), der Zaehler die naechste
# Erhoehung aber noch nicht eingetragen hat.
#
# Bei der EINMALIGEN Probe im Aufraeum-Tor weiter unten ist derselbe
# Rueckfall keineswegs folgenlos — dort steht die bekannte Luecke im
# Kommentar an ihrem eigenen Ort.
#
# Das INTERVALL bleibt trotzdem fein (0,2 s statt 1 s, bei entsprechend mehr
# Versuchen — dasselbe Gesamtfenster, nur feiner abgetastet), aber aus einem
# ANDEREN Grund als frueher hier stand: nicht mehr, weil eine grobe Probe
# eine kurze Neustartschleife zwischen zwei Proben verpassen koennte (das
# kann sie nicht mehr — '.RestartCount' faellt INNERHALB der Schleife nie
# zurueck, s. Einschraenkung oben, eine einzige Erhoehung bleibt fuer den
# Rest des Fensters bei JEDER Abtastrate sichtbar).
# Die Schleife bricht beim ersten fehlgeschlagenen Check weiterhin sofort ab
# (sitzt also nichts aus); ein feines Intervall erkennt einen echten Absturz
# lediglich frueher, ohne die Kulanzzeit fuer einen langsam startenden,
# gesunden Container zu verkuerzen. Kostet ein paar zusaetzliche
# 'docker inspect'-Aufrufe — vernachlaessigbar. Bruchteilssekunden bei
# 'sleep' sind keine GNU-Besonderheit: das Skript setzt an keiner Stelle eine
# bestimmte Distribution voraus, und sowohl GNU coreutils als auch BusyBox
# (Alpine 3.20 sowie busybox:1.36 direkt geprüft) akzeptieren 'sleep 0.2'.
# Welche Shell interpretiert, spielt dabei ohnehin keine Rolle — 'sleep' ist
# ein externes Programm, kein Shell-Builtin, in bash genau wie in dash/sh.
# Der erzeugte Updater läuft trotzdem immer unter bash, nie unter /bin/sh:
# Zeile 1 ist '#!/usr/bin/env bash' (s. HEADER-Heredoc oben, direkt geprüft
# am generierten Skript). Der tragende Grund ist NICHT die Abwesenheit eines
# expliziten 'sh $UPDATE_SH' — Cron ruft seine Zeilen sehr wohl über
# '/bin/sh -c' auf. Das ist nur egal, weil dieses 'sh' den Updater als
# EXTERNES Kommando über seinen ausführbaren Pfad (chmod 700) startet: der
# Kernel liest dabei selbst die Shebang-Zeile und exec't bash, nicht sh.
# Dieselbe Shebang-plus-execve-Kette gilt für 'ExecStart=${UPDATE_SH}' im
# systemd-Unit.
container_laeuft_stabil() {
  local i versuche intervall werte restarts status
  versuche="${PULSE_UPDATE_STABIL_VERSUCHE:-75}"
  intervall="${PULSE_UPDATE_STABIL_INTERVALL:-0.2}"
  for i in $(seq 1 "$versuche"); do
    werte="$(docker inspect -f '{{.RestartCount}} {{.State.Status}}' "$1" 2>/dev/null)" || return 1
    restarts="${werte%% *}"
    status="${werte#* }"
    [ "$restarts" = "0" ] && [ "$status" = "running" ] || return 1
    sleep "$intervall"
  done
  return 0
}

# Rückweg der letzten Aktualisierung aufräumen — NICHT im Erfolgszweig unten
# (siehe dort), sondern erst hier, am Anfang des NÄCHSTEN Laufs. `docker run`
# und die Stabilitätsprüfung oben decken nur den häufigsten Fall ab: einen
# Container, der sofort wieder stirbt oder gleich in eine Neustartschleife
# fällt. Einen, der zwei Minuten sauber läuft und DANN erst abstürzt, wiesen
# sie fälschlich als Erfolg aus — beide Rückwege wären da schon gelöscht.
#
# Geprüft wird HIER, genau wie in container_laeuft_stabil() oben, ob
# '.RestartCount' seit der Erzeugung bei 0 steht (statt '.State.Running',
# das in einer Neustartschleife durchgehend 'true' bleibt — Begründung
# oben) — dieselbe Probe, aber diesmal EINMALIG statt in einer Schleife.
# Eine einzelne Abfrage jetzt deckt den GANZEN Fünf-Minuten-Takt seit dem
# letzten 'docker run' ab, SOLANGE niemand den Container von Hand neu
# gestartet hat.
#
# BEKANNTE LÜCKE, nicht behoben: 'docker restart' setzt '.RestartCount' auf
# 0 zurück (gemessen: 5 im Karussell, unmittelbar nach 'docker restart' 0 —
# bei einem langsam sterbenden Container bleibt er danach den ganzen
# Fünf-Minuten-Takt auf 0, nicht nur kurz) — und genau das rät die eigene
# Diagnose bei einem abgelaufenen oder selbstsignierten Zertifikat
# (dcc_auth/diagnose_texte.py, s. auch die Anleitung unter
# docs/self-host-guide.html, Abschnitt "When something is wrong"). Hing
# $CONTAINER im Fünf-Minuten-Fenster im Absturzkarussell und wurde dann per
# 'docker restart' neu gestartet, gilt er hier fälschlich als dauerhaft
# erfolgreich und verliert seinen Rückweg. Kein Umbau hier: die richtige
# Lösung wäre '.State.StartedAt' gegen die Taktlänge zu prüfen (misst, seit
# wann der AKTUELLE Prozess läuft, unabhängig vom Zähler) — eine eigene
# Entscheidung mit eigener Messung, nicht diese Korrektur.
#
# Muss VOR dem Digest-Kurzschluss unten stehen — sonst räumt ein Lauf ohne
# neues Image (der häufigste) nie auf, und der Rückweg bliebe für immer liegen.
#
# Ersetzt die frühere bedingungslose "docker rm -f ${CONTAINER}-old # Rest
# eines früheren Fehlversuchs" direkt vor dem Umbenennen weiter unten: die
# hätte nach diesem Umbau auch einen noch nicht bestätigten, gültigen
# Rückweg gelöscht. Ihren eigentlichen Fall — ein abgebrochener früherer Lauf
# (Host stirbt zwischen Umbenennen und Neustart) — deckt weiterhin etwas ab:
# entweder existiert "$CONTAINER" danach gar nicht mehr (dann greift das
# "if docker inspect $CONTAINER" unten erst gar nicht, keine Namenskollision
# möglich) oder er läuft wieder — und genau den räumt dieser Block hier beim
# nächsten Takt auf. Existiert "$CONTAINER" stattdessen weiter, aber gestoppt
# ("${CONTAINER}-old" schon vorhanden), greift dieser Block nicht (er verlangt
# laufendes $CONTAINER), und seit dem Handstopp-Riegel weiter unten endet der
# Lauf dann ohne jede Änderung: beide Container bleiben stehen, bis jemand
# "$CONTAINER" wieder startet — erst dann räumt dieser Block "-old" ab. Ein
# Absturz zwischen zwei Läufen sieht anders aus: mit '--restart
# unless-stopped' steht ein abgestürzter Container auf 'restarting', nicht
# auf 'exited', und den behandelt der Update-Zweig wie einen laufenden.
if docker inspect "${CONTAINER}-old" >/dev/null 2>&1; then
  werte="$(docker inspect -f '{{.RestartCount}} {{.State.Status}}' "$CONTAINER" 2>/dev/null)" || werte=""
  restarts="${werte%% *}"
  status="${werte#* }"
  if [ "$restarts" = "0" ] && [ "$status" = "running" ]; then
    backup_image_id="$(docker inspect -f '{{.Image}}' "${CONTAINER}-old" 2>/dev/null || true)"
    docker rm -f "${CONTAINER}-old" >/dev/null 2>&1 || true
    # Nur das damalige Rückweg-Image entfernen — kein host-weites 'image prune'.
    { [ -n "$backup_image_id" ] && docker image rm "$backup_image_id" >/dev/null 2>&1; } || true
  fi
fi

# Nicht-existierender Container = Deinstallation (docker rm / docker rmi) —
# der Updater erweckt nichts wieder (Nutzer-Entscheid 2026-10-06: wer den
# Container löscht, will ihn los sein; die EINZIGE Anlege-Stelle ist der
# Installer). Vorher lief ein fehlender Container auf "anlegen" hinaus —
# damit war Deinstallation unmöglich, ohne vorher den Cron auszuklemmen.
#
# Einzige Ausnahme: "${CONTAINER}-old" existiert noch — dann ist ein
# früherer Update-Lauf zwischen Umbenennen und Neustart gestorben (Host-Blitz,
# Abort), und wir stellen den Rückweg wieder her statt neu zu erfinden.
if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  if docker inspect "${CONTAINER}-old" >/dev/null 2>&1; then
    docker rename "${CONTAINER}-old" "$CONTAINER" >/dev/null 2>&1 || true
    docker start "$CONTAINER" >/dev/null 2>&1 || true
    echo "pulse-update: unterbrochener Lauf wiederhergestellt — $CONTAINER aus ${CONTAINER}-old zurückgeholt"
  else
    echo "pulse-update: container $CONTAINER fehlt — nichts angelegt (Entfernen = Deinstallation)"
  fi
  exit 0
fi

# Ein Handstopp wird respektiert: steht der Container auf exited/paused
# (docker stop / docker pause), rührt der Updater ihn nicht an — auch nicht
# für ein neues Image. Vorher stellte er den angehaltenen Container beiseite
# und startete den neuen: wer den Server für Wartung anhielt, hatte ihn fünf
# Minuten nach dem nächsten Push wieder laufen. `restarting` fällt NICHT
# darunter — das ist ein Absturzkarussell, und ein neues Image ist dort
# womöglich gerade die Heilung. Ein fehlender Container ist oben schon
# behandelt (Deinstallation/Wiederherstellung) und kommt hier nie an.
#
# Der Riegel steht VOR Login und Pull — ursprünglich stand er dahinter, und
# genau das füllte Platten (Fund 2026-10-06, Test-Server): gestoppter
# Container, rollender ':edge'-Tag aktualisiert ~5×/Tag → jeder Lauf lud
# ~890 MB, das verdrängte Image blieb namenlos (dangling) liegen, und der
# Karussell-Aufräum-Block oben läuft im Handstopp nie (er verlangt einen
# LAUFenden $CONTAINER). ~4,5 GB/Tag ohne Zweck. Ein gestoppter Container
# will keinen Image-Ballast, den er vor dem Wiederanstellen ohnehin nicht
# benutzt — der nächste Lauf nach dem Wiederanstellen holt ihn.
cur_status="$(docker inspect --format '{{.State.Status}}' "$CONTAINER" 2>/dev/null || true)"
case "$cur_status" in
  exited|paused)
    echo "pulse-update: container is stopped ($cur_status) — leaving it alone"
    exit 0 ;;
esac

if [ -n "${REG_PASS:-}" ]; then
  printf '%s' "$REG_PASS" | docker login "$REGISTRY" -u "$REG_USER" --password-stdin >/dev/null 2>&1 \
    || { echo "pulse-update: registry login failed, will retry next run" >&2; exit 0; }
fi
docker pull "$IMAGE" >/dev/null 2>&1 \
  || { echo "pulse-update: pull failed (network/registry?), will retry next run" >&2; exit 0; }
new_id="$(docker image inspect --format '{{.Id}}' "$IMAGE" 2>/dev/null || true)"
cur_id="$(docker inspect --format '{{.Image}}' "$CONTAINER" 2>/dev/null || true)"
[ -n "$new_id" ] || { echo "pulse-update: cannot read image id, skipping" >&2; exit 0; }
[ "$new_id" = "$cur_id" ] && exit 0   # already up to date

echo "pulse-update: updating $CONTAINER -> $new_id"
# Alten Container beiseitestellen statt sofort löschen → Rollback bei Fehlstart.
# Single-Container mit festen Ports: der alte MUSS vor dem neuen gestoppt werden
# (kurze Downtime unvermeidbar), aber er bleibt als '<name>-old' erhalten, bis
# der Aufräum-Block oben ihn beim nächsten bestätigt erfolgreichen Lauf entfernt.
if docker inspect "$CONTAINER" >/dev/null 2>&1; then
  docker rename "$CONTAINER" "${CONTAINER}-old" >/dev/null 2>&1 || true
  docker stop "${CONTAINER}-old" >/dev/null 2>&1 || true
fi
if docker run "${RUN_ARGS[@]}" >/dev/null && container_laeuft_stabil "$CONTAINER"; then
  echo "pulse-update: done"
else
  echo "pulse-update: new container failed to start — rolling back" >&2
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  if docker inspect "${CONTAINER}-old" >/dev/null 2>&1; then
    docker rename "${CONTAINER}-old" "$CONTAINER" >/dev/null 2>&1 || true
    docker start "$CONTAINER" >/dev/null 2>&1 || true
  fi
  exit 1
fi
BODY
  } > "$UPDATE_SH"
  chmod 700 "$UPDATE_SH"
}

# --- Host-Updater: systemd-Timer installieren --------------------------- #
install_update_timer() {
  cat > /etc/systemd/system/pulse-update.service <<EOF
[Unit]
Description=Pulse self-host auto-update
Wants=network-online.target
After=network-online.target docker.service

[Service]
Type=oneshot
ExecStart=${UPDATE_SH}
EOF
  cat > /etc/systemd/system/pulse-update.timer <<'EOF'
[Unit]
Description=Pulse self-host auto-update (every 5 min)

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
Persistent=true

[Install]
WantedBy=timers.target
EOF
  # Auto-Update ist optional, die Proxy-Route weiter unten im Hauptablauf
  # nicht: ein scheiterndes systemd (z. B. in einer Umgebung ohne echtes PID
  # 1 systemd) darf den Installer nicht abbrechen, nachdem der Container
  # schon läuft und BEVOR die Pflicht-Anweisung für die Route ausgegeben
  # wurde — ohne dieses `|| warn` riss genau das unter `set -e` ab.
  systemctl daemon-reload \
    || warn "systemctl daemon-reload failed — auto-update timer not installed. Update manually anytime: ${UPDATE_SH}"
  systemctl enable --now pulse-update.timer >/dev/null 2>&1 \
    || warn "systemctl enable failed — auto-update timer not active. Update manually anytime: ${UPDATE_SH}"
}

# --- Host-Updater: User-Crontab (Fallback ohne root/systemd) ------------- #
# Ein docker-group-User (non-root) kann keinen System-Timer schreiben, aber
# seine eigene Crontab — die läuft sudo-frei und unabhängig vom Login. So
# bleibt Auto-Update auch beim non-root-Install erhalten (der alte Watchtower
# lief als Container ebenfalls non-root — ohne Fallback wäre das ein Regress).
install_update_cron() {
  local entry="*/5 * * * * ${UPDATE_SH} >> ${PULSE_DIR}/pulse-update.log 2>&1"
  # Bestehenden Eintrag für unser Skript ersetzen (idempotent), Rest behalten.
  # `crontab -l` endet bei leerer/fehlender Crontab mit 1 und schweigt; bleibt
  # nach dem Herausfiltern nichts übrig (leere Crontab ODER eine Crontab, die
  # bisher NUR unseren eigenen Eintrag enthielt), endet `grep -vF` ebenfalls
  # mit 1 — hier ist das ein Normalzustand, kein Fehler. Ohne das `|| true`
  # reisst `pipefail` + `set -e` (Skriptkopf) die Gruppe ab, BEVOR
  # `echo "$entry"` läuft: die Crontab würde leer installiert, und der
  # gesamte Installer stirbt danach still mit Exit 1 — nachdem der Container
  # schon läuft und bevor die Proxy-Route ausgegeben wird.
  #
  # Derselbe Grund gilt für das `crontab -` am Ende: Auto-Update ist optional,
  # die Route nicht. Ein scheiterndes `crontab -` (kaputte cron-Installation,
  # kein Cron-Daemon) darf den Installer ebenfalls nicht mitreissen.
  { crontab -l 2>/dev/null | grep -vF "$UPDATE_SH" || true; echo "$entry"; } | crontab - \
    || warn "Could not write to your crontab — auto-update not scheduled. Update manually anytime: ${UPDATE_SH}"
}

# --- Startfortschritt verfolgen — mitlaufende Checkliste statt Stille --- #
#
# Gelesen wird der Fortschritt AUS DEM CONTAINER (`docker exec … cat
# /data/setup-status`, geschrieben von cont-init-main.sh), nicht über HTTP.
# Das ist der einzige Weg, der in jedem Modus funktioniert: im Modus
# `greenfield` ist der externe HTTPS-Weg genau so lange tot, wie Caddy noch
# kein Zertifikat hat — also genau während der Phase, über die man etwas
# wissen will. Und im Modus `static-docker` gibt es überhaupt keinen Weg von
# aussen, bevor der Betreiber die Route unten angelegt hat.
schritt_text() {
  case "$1" in
    start)               echo "container started" ;;
    10-check-cloud-creds) echo "configuration checked" ;;
    01-init-data-dirs)   echo "data directory prepared" ;;
    03-init-secrets)     echo "keys generated" ;;
    02-init-postgres)    echo "database initialised" ;;
    04-init-coturn)      echo "TURN configured" ;;
    05-init-livekit)     echo "voice server configured" ;;
    07-render-env)       echo "runtime configuration written" ;;
    08-init-mediamtx)    echo "screen-share relay configured" ;;
    09-init-caddy)       echo "web server configured" ;;
    11-render-frpc)      echo "tunnel configured" ;;
    06-run-migrations)   echo "database migrated" ;;
    fertig)              echo "startup complete" ;;
    *)                   echo "$1" ;;
  esac
}

# Wartet, bis der Container seine Startskripte durchlaufen hat, und druckt
# die Checkliste mit. Läuft zweimal: nach dem ersten Start und nach dem
# Neustart, der die abgeholten Zugangsdaten einliest (server_verbinden).
# Bricht der Start ab, endet der Installer hier mit Exit 1 — ein Server, der
# nicht startet, braucht zuerst `docker logs`, nicht den nächsten Schritt.
warte_auf_start() {
  GESEHEN=0
  FERTIG=""
  ABBRUCH=""
  ABBRUCH_CRASH=""
  for _ in $(seq 1 60); do
    STATUS_ROH="$(docker exec "$CONTAINER" cat /data/setup-status 2>/dev/null || true)"
    if [ -n "$STATUS_ROH" ]; then
      ZEILEN="$(printf '%s\n' "$STATUS_ROH" | wc -l)"
      if [ "$ZEILEN" -gt "$GESEHEN" ]; then
        printf '%s\n' "$STATUS_ROH" | tail -n +$((GESEHEN + 1)) | while IFS="$(printf '\t')" read -r _t name zustand; do
          [ -z "$name" ] && continue
          if [ "$zustand" = "ok" ]; then
            printf '    \033[1;32m+\033[0m %s\n' "$(schritt_text "$name")"
          else
            printf '    \033[1;31mx\033[0m %s — FAILED\n' "$(schritt_text "$name")"
          fi
        done
        GESEHEN="$ZEILEN"
      fi
      printf '%s\n' "$STATUS_ROH" | grep -q "$(printf '\t')fertig$(printf '\t')ok" && { FERTIG=1; break; }
      # Merker statt `exit` in der Regel: ein `exit` dort springt nach END,
      # und dessen `exit` ueberschreibt den Status wieder — die Erkennung waere
      # damit immer falsch.
      printf '%s\n' "$STATUS_ROH" \
        | awk -F"$(printf '\t')" '$3 != "" && $3 != "ok" { gefunden=1 } END { exit !gefunden }' \
        && { ABBRUCH=1; break; }
    fi
    # Ein Container, der nicht mehr läuft, wird auch nicht mehr fertig — UND
    # einer, der immer wieder abstürzt und neu startet, macht ebenso wenig
    # Fortschritt, meldet dabei aber '.State.Running' durchgehend 'true' (Fund
    # 1, Schlussprüfung: Docker hält den Wert während der GESAMTEN
    # Neustart-Rückstufung auf 'true', s. container_laeuft_stabil() weiter
    # oben). Ohne diese Unterscheidung wartete die Schleife eine Absturzschleife
    # bis zum Zeitlimit aus, statt sie sofort zu erkennen — und das ist der
    # wahrscheinlichste Fehlschlag einer Erstinstallation überhaupt.
    #
    # '.RestartCount' + '.State.Status' in einem Aufruf, wie in Fund 1: steigt
    # der Zähler, ist es keine Erstinstallation, sondern eine Schleife — dafür
    # unten eine EIGENE Meldung, nicht "the step marked FAILED above", denn
    # oben steht in diesem Fall gar kein FAILED — der Container starb, bevor er
    # überhaupt einen weiteren Schritt in setup-status schreiben konnte.
    WERTE="$(docker inspect -f '{{.RestartCount}} {{.State.Status}}' "$CONTAINER" 2>/dev/null)" || WERTE=""
    RESTARTS="${WERTE%% *}"
    STATUS="${WERTE#* }"
    if [ "${RESTARTS:-0}" != "0" ]; then
      ABBRUCH=1; ABBRUCH_CRASH=1; break
    elif [ -z "$WERTE" ] || [ "$STATUS" != "running" ]; then
      ABBRUCH=1; break
    fi
    # Zustandserkennung Ende — hier weiter mit 'sleep 5' im echten Ablauf.
    sleep 5
  done

  echo
  if [ -n "$ABBRUCH_CRASH" ]; then
    err "Startup aborted — the container is stuck in a restart loop. It keeps crashing before it can make further progress."
    err "  docker logs ${CONTAINER} 2>&1 | tail -50"
    exit 1
  elif [ -n "$ABBRUCH" ]; then
    err "Startup aborted. The step marked FAILED above is where it stopped."
    err "  docker logs ${CONTAINER} 2>&1 | tail -50"
    exit 1
  fi
  [ -n "$FERTIG" ] || warn "Startup is taking longer than expected — check: docker logs -f ${CONTAINER}"
}

# --- /.well-known/pulse-server-info lesen -------------------------------- #
#
# Von innen über den chat-gateway (127.0.0.1:8002 im Container): kein DNS,
# kein Zertifikat, kein Hairpin-NAT — die verlässliche Antwort auf „ist der
# Server schon verbunden?“. Von aussen über https://<adresse>: der Beweis,
# dass DNS, Port 443, Zertifikat und Routing stehen. Beide wiederholen, weil
# „startup complete“ nur das Ende der Startskripte meldet; die Dienste und
# Caddys Zertifikat kommen erst danach. PULSE_INSTALL_WARTE_* nur für Tests.
server_info_innen() {
  local i
  for i in $(seq 1 "${PULSE_INSTALL_WARTE_VERSUCHE:-20}"); do
    docker exec "$CONTAINER" curl -fsS -m 5 \
      http://127.0.0.1:8002/.well-known/pulse-server-info 2>/dev/null && return 0
    sleep "${PULSE_INSTALL_WARTE_INTERVALL:-3}"
  done
  return 1
}

# Antworten die Dienste? „startup complete“ meldet nur das Ende der
# Startskripte, die Dienste kommen erst danach hoch. Gebraucht vor der Prüfung
# aus der Cloud (Schritt 9): direkt nach dem Neustart in server_verbinden traf
# sie sonst auf einen Server, dessen HTTP-Dienste noch nicht antworteten — sechs
# Kreuze für einen gesunden Server (Probe auf dem Hetzner-Rechner, 2026-10-12:
# zehn Sekunden zwischen „fertig“ und grünem pulse-health, danach alles grün).
# pulse-health ist der HEALTHCHECK des Bildes: den chat-gateway über HTTP, die
# übrigen Dienste über ihre Ports. Den internen Caddy fragt er nicht ab; bei
# der Probe lauschte der zu dem Zeitpunkt schon, garantiert ist das nicht.
warte_auf_dienste() {
  local i
  for i in $(seq 1 "${PULSE_INSTALL_WARTE_VERSUCHE:-20}"); do
    docker exec "$CONTAINER" pulse-health >/dev/null 2>&1 && return 0
    sleep "${PULSE_INSTALL_WARTE_INTERVALL:-3}"
  done
  return 1
}

server_info_aussen() {
  local i
  for i in $(seq 1 "${PULSE_INSTALL_WARTE_VERSUCHE:-20}"); do
    curl -fsS -m 5 "https://${SRV_HOST}/.well-known/pulse-server-info" 2>/dev/null && return 0
    sleep "${PULSE_INSTALL_WARTE_INTERVALL:-3}"
  done
  return 1
}

# Ist der Server mit einem Pulse-Konto verbunden? $1 = Antwort von
# pulse-server-info. Ältere Server kennen das Feld `verbunden` nicht; dort
# heisst eine gesetzte Instanz-Nummer dasselbe (instance_id ist null, solange
# keine gesetzt ist).
ist_verbunden() {
  case "$1" in
    *'"verbunden":true'*|*'"verbunden": true'*) return 0 ;;
    *'"verbunden"'*) return 1 ;;
  esac
  printf '%s' "$1" | grep -qE '"instance_id"[[:space:]]*:[[:space:]]*"[0-9]+"'
}

# $1 = erste Zeile (Vorgabe: der Server läuft nur noch nicht verbunden). Antwortet
# der Server gar nicht, wäre „läuft“ falsch — dort nennt der Aufrufer den Stand.
verbinden_spaeter() {
  warn "${1:-Your server is running, but it is not connected to a Pulse account yet.}"
  warn "Connect later: docker exec -it ${CONTAINER} pulse-connect"
}

# --- Mit einem Pulse-Konto verbinden (pulse-connect im Container) ------- #
#
# Der letzte Schritt einer Installation (Spec E1/E6): pulse-connect fragt bei
# der Cloud einen Gerätecode an, zeigt Link und Code und wartet, bis der
# Betreiber im Browser bestätigt. Es braucht ein Terminal; `--no-restart`,
# weil der Neustart hier geschieht — so sieht der Installer, wann der Server
# mit den abgeholten Zugangsdaten wieder steht.
#
# Ein schon verbundener Server (Neuinstallation auf altem Volumen, Bestand)
# wird nicht angefasst: pulse-connect fragte dort nach, ob er einem anderen
# Konto gehören soll, und das entscheidet niemand nebenbei.
#
# Nie ein Fehler-Exit: Der Server läuft auch unverbunden, er nimmt nur noch
# niemanden auf. Abbruch (Strg+C), abgelaufener oder abgelehnter Code, von
# aussen nicht erreichbar — alles endet mit dem Hinweis, wie man es nachholt.
server_verbinden() {
  local info
  info="$(server_info_innen || true)"
  if [ -z "$info" ]; then
    warn "Your server does not answer inside the container yet — skipping the connection step."
    warn "  docker logs ${CONTAINER} 2>&1 | tail -50"
    verbinden_spaeter "It is not connected to a Pulse account yet."
    return 0
  fi
  if ist_verbunden "$info"; then
    # Die Verbindung im Volumen gehört zur ALTEN Adresse (bestand_uebernehmen):
    # der Eintrag in der Cloud trägt sie noch, und die Prüfung von aussen (Schritt
    # 9) ginge gegen sie. Also weder „fertig“ melden noch VERBUNDEN setzen.
    if [ -n "$ALTE_ADRESSE" ]; then
      warn "This server is connected to a Pulse account, but that entry still has its old address, ${ALTE_ADRESSE}."
      warn "To enter ${SRV_HOST} (confirm with the same account):  docker exec -it ${CONTAINER} pulse-connect"
      warn "It asks before changing anything. The check from the outside is skipped until then."
      return 0
    fi
    VERBUNDEN=1
    log "This server is already connected to a Pulse account."
    if [ -n "$BESTAND_ZEILEN" ]; then
      log "The connection is stored in ${ENV_FILE}, so pulse-connect refuses to change it."
    else
      log "To connect it to a different account:  docker exec -it ${CONTAINER} pulse-connect"
    fi
    return 0
  fi
  if ! { : <"$TTY_GERAET"; } 2>/dev/null; then
    warn "No terminal available — connecting needs one."
    verbinden_spaeter
    return 0
  fi
  log "Connecting your server to your Pulse account…"
  if ! docker exec -it "$CONTAINER" pulse-connect --no-restart <"$TTY_GERAET"; then
    verbinden_spaeter
    return 0
  fi
  # setup-status vorher leeren: sonst sähe warte_auf_start bis zum ersten
  # Startskript noch das „fertig“ des vorigen Laufs.
  docker exec "$CONTAINER" rm -f /data/setup-status >/dev/null 2>&1 || true
  log "Restarting Pulse with the new connection…"
  if ! docker restart "$CONTAINER" >/dev/null; then
    warn "The restart failed. Restart it yourself:  docker restart ${CONTAINER}"
    return 0
  fi
  warte_auf_start
  VERBUNDEN=1
}

# --- Zugangsdaten für die Prüfung aus der Cloud ------------------------- #
#
# Die Prüfung weist sich mit den Zugangsdaten der Instanz aus
# (routes_selfhost_diagnose.py, Weg 2). Ein Bestandsserver hat sie schon in
# $ENV_FILE (bestand_uebernehmen), ein frisch verbundener nur im Datenvolumen
# — pulse-connect hat sie dort abgelegt. Gelesen wird über `docker exec`, und
# nichts davon wird ausgegeben.
zugang_aus_volumen() {
  if [ -z "$CLIENT_SECRET" ]; then
    zugang_lesen <<<"$(docker exec "$CONTAINER" cat /data/pulse/verbindung.env 2>/dev/null || true)"
  fi
  [ -n "$INSTANCE_ID" ] && [ -n "$CLIENT_ID" ] && [ -n "$CLIENT_SECRET" ]
}

# Bericht der Aussen-Pruefung — eine Checkliste, kein Protokollauszug.
#
# Der Adressat sitzt genau hier: er hat gerade installiert, steht auf der
# Maschine und kann sofort handeln. Deshalb je Glied ein Haken oder ein Kreuz,
# und fuer das ERSTE Kreuz der volle Klartext samt Handgriff — die Glieder
# danach wiederholen in aller Regel nur dieselbe Ursache.
#
# Die Saetze kommen vom Server (`dcc_auth/diagnose_texte.py`) und nicht von
# hier. Sonst stuenden sie ein zweites Mal im Repo und beschrieben nach ein
# paar Monaten denselben Zustand anders als die App.
#
# Der Code steht in einer Variablen statt direkt hinter `python3 -c '...'`:
# im zitierten Here-Doc bleiben beide Anfuehrungszeichen frei benutzbar. Kein
# f-String mit eigenen Anfuehrungszeichen — das erlaubt erst Python 3.12
# (PEP 701), und Debian 12 bringt 3.11 mit.
PY_BERICHT=$(cat <<'PYEOF'
import json, os, sys, textwrap

def wrap(text, einzug):
    breite = max(28, 74 - len(einzug))
    zeilen = []
    for absatz in str(text).split("\n"):
        zeilen.extend(textwrap.wrap(absatz, breite) or [""])
    return "\n".join(einzug + z for z in zeilen)

try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(1)

# Farben nur am Terminal. Wer die Ausgabe in eine Datei leitet, um sie zu
# verschicken, soll Text bekommen und keine Steuerzeichen.
if sys.stdout.isatty():
    GRUEN, ROT, GELB, AUS = "\033[1;32m", "\033[1;31m", "\033[1;33m", "\033[0m"
else:
    GRUEN = ROT = GELB = AUS = ""
LINIE = "  " + "-" * 66

schritte = d.get("schritte", [])
print()
for s in schritte:
    marke = GRUEN + "[ ok ]" + AUS if s.get("ok") else ROT + "[FAIL]" + AUS
    print("    {0} {1}".format(marke, s.get("titel") or s.get("schritt")))

# Eine abgebrochene Kette darf sich nicht wie eine vollstaendige lesen.
offen = d.get("nicht_geprueft") or []
if offen:
    print()
    print("    " + GELB + "[ -- ]" + AUS + " not checked, the chain stopped before them:")
    print(wrap(", ".join(offen), "           "))

print()
if d.get("gesamt") == "ok":
    print(LINIE)
    print("  " + GRUEN + "YOUR SERVER IS REACHABLE FROM THE INTERNET." + AUS)
    print("  Every link answered. Your users can sign in.")
    print(LINIE)
    sys.exit(0)

fehler = None
for s in schritte:
    if not s.get("ok"):
        fehler = s
        break
if fehler is None:
    sys.exit(0)

print(LINIE)
print("  " + ROT + "THIS IS WHERE IT BREAKS: " + str(fehler.get("titel") or fehler.get("schritt")) + AUS)
print()
print(wrap(fehler.get("was_ist") or fehler.get("befund"), "    "))
if fehler.get("einzelheit"):
    print()
    print("    measured: " + str(fehler.get("einzelheit")))

# Zeigt der Name auf eine ANDERE Maschine als die, auf der wir stehen?
# Beides ist moeglich — ein falscher DNS-Eintrag oder ein Firmennetz mit
# getrenntem Ein- und Ausgang — und der Unterschied entscheidet ueber den
# Handgriff. Deshalb werden beide Adressen nebeneinandergestellt und beide
# Deutungen genannt, statt eine zu behaupten.
eigene = (os.environ.get("PULSE_EIGENE_IP") or "").strip()
aufgeloest = ""
for s in schritte:
    if s.get("schritt") == "dns" and s.get("ok"):
        aufgeloest = str(s.get("einzelheit") or "").strip()
if eigene and aufgeloest and eigene not in [a.strip() for a in aufgeloest.split(",")]:
    print()
    print(wrap(
        "Note: the name resolves to " + aufgeloest + ", but this machine reports "
        "its own outgoing address as " + eigene + ". Either the DNS record points "
        "at a different machine, or a firewall in front of it is not forwarding "
        "to this one. Both look the same from outside.", "    "))

if fehler.get("was_tun"):
    print()
    print("    " + GELB + "WHAT TO DO" + AUS)
    print(wrap(fehler.get("was_tun"), "    "))

print()
print("  Fix this first, then check again from this machine:")
print("      docker exec " + (os.environ.get("PULSE_CONTAINER_NAME") or "pulse") + " pulse-doctor")
print(LINIE)
PYEOF
)

# Die Prüfung von aussen — das Einzige, was der Server über sich selbst NICHT
# sagen kann. Die Cloud geht die ganze Kette ab (DNS, Zertifikat, Routing,
# CORS, WebSocket-Upgrade, UDP, Betreiber-Erkennung) und benennt das Glied,
# das fehlt.
#
# Die Zugangsdaten gehen über stdin an curl (`-K -`), nicht über die
# Befehlszeile — die ist für jeden lokalen Nutzer in `ps` sichtbar, solange
# der Aufruf läuft.
#
# Die eigene Aussenadresse kommt AUS DEM CONTAINER, nicht aus einem zweiten
# Aufruf an einen fremden Dienst: dort steht genau die Zahl, mit der Pulse
# selbst arbeitet (04-init-coturn), und es entsteht keine neue Abhaengigkeit.
pruefung_von_aussen() {
  local antwort eigene
  zugang_aus_volumen || return 1
  antwort="$(printf 'header = "X-Pulse-Client-Id: %s"\nheader = "X-Pulse-Client-Secret: %s"\n' \
      "$CLIENT_ID" "$CLIENT_SECRET" \
    | curl -fsS -m 60 -K - -X POST \
      "${CLOUD_ORIGIN}/api/auth/selfhost/diagnose/${INSTANCE_ID}" \
      -H "X-Pulse-Container-Name: ${CONTAINER}" 2>/dev/null)" || return 1
  [ -n "$antwort" ] || return 1
  command -v python3 >/dev/null 2>&1 || { printf '%s\n' "$antwort"; return 0; }
  eigene="$(docker exec "$CONTAINER" sed -n 's/^external-ip=//p' \
    /etc/coturn/turnserver.conf 2>/dev/null | tr -d '\r' | head -n1 || true)"
  printf '%s' "$antwort" \
    | PULSE_EIGENE_IP="$eigene" PULSE_CONTAINER_NAME="$CONTAINER" python3 -c "$PY_BERICHT"
}

# ======================================================================== #
# Ablauf
# ======================================================================== #

# 1) Adresse festlegen, Bestand lesen, Umgebung erkennen, Modus wählen. Nichts
# davon verändert etwas auf der Maschine.
frage_adresse
pruefe_adresse
log "Server address: ${SRV_HOST}"
bestand_uebernehmen
waehle_bild
decide_mode
build_run_args
print_plan

# 1b) Ports prüfen, bevor irgendetwas verändert wird. VOR dem Dry-Run-Ausstieg
# (Fund 4, Schlussprüfung): diese Prüfung liest nur, und der Vorschau-Modus ist
# gerade der, in dem ein Betreiber einen Konflikt sehen will — vorher meldete
# ein Dry-Run auf einer Maschine mit belegtem Port trotzdem einen grünen Plan.
check_ports

# 1c) Aus demselben Grund wie 1b, ebenfalls VOR dem Dry-Run-Ausstieg: lieber
# jetzt scheitern als mit halb eingerichtetem Server. Ersetzt NICHT die
# gleiche Prüfung in `sichere_container_ersetzung` weiter unten (s. dort).
pruefe_container_konflikt "Nothing has been changed yet."
pruefe_registry_zugang

if [ -n "$DRY_RUN" ]; then
  echo
  log "DRY RUN — nothing changed."
  log "Planned container start:"
  printf '    docker run'; printf ' %q' "${RUN_ARGS[@]}"; echo
  exit 0
fi

# 1d) $PULSE_DIR muss beschreibbar sein — NACH dem Dry-Run-Ausstieg (anders
# als 1b/1c): ein Dry-Run verspricht "nothing changed", und diese Prüfung legt
# das Verzeichnis tatsächlich an (s. Begründung bei der Funktion), das wäre in
# einem Dry-Run ein echter, wenn auch harmloser Seiteneffekt.
pruefe_pulse_dir_schreibbar

# 2) Konfiguration schreiben (chmod 600).
schreibe_konfiguration
log "Configuration written: ${ENV_FILE} (readable by root only)"

# 3) Container starten. Anmelden nur am Spiegel registry.howispulse.com
# (Bestand, s. pruefe_registry_zugang) — das öffentliche Bild braucht keins.
case "$IMAGE" in
  registry.howispulse.com/*)
    log "Logging in to Pulse registry (instance credentials)…"
    printf '%s' "$CLIENT_SECRET" | docker login registry.howispulse.com -u "$CLIENT_ID" --password-stdin \
      || die "Registry login failed — instance credentials rejected (suspended or wrong instance?)." ;;
esac
log "Pulling image ${IMAGE}…"
docker pull "$IMAGE"
sichere_container_ersetzung
log "Starting Pulse (${MODE})…"
docker run "${RUN_ARGS[@]}" >/dev/null

# 4) Auto-Update — Host-systemd-Timer statt eines socket-haltenden Containers.
# Kein Container braucht den Docker-Socket; der Update-Code ist das oben
# generierte, lesbare Skript. PULSE_NO_AUTOUPDATE=1 schaltet es ab
# (PULSE_NO_WATCHTOWER bleibt als Alias erhalten).
# Migration: einen früher angelegten Watchtower-Container ablösen.
docker rm -f pulse-watchtower >/dev/null 2>&1 || true
if [ -z "${PULSE_NO_AUTOUPDATE:-${PULSE_NO_WATCHTOWER:-}}" ]; then
  write_update_script
  log "Update helper written: ${UPDATE_SH}"
  if [ "$(id -u)" = "0" ] && command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
    install_update_timer
    log "Auto-updates enabled (systemd timer 'pulse-update.timer', checks every 5 min)."
  elif command -v crontab >/dev/null 2>&1; then
    install_update_cron
    log "Auto-updates enabled (user crontab, checks every 5 min). 'crontab -l' to view."
  else
    warn "No root+systemd and no crontab — auto-update could not be scheduled."
    warn "Update manually anytime:   ${UPDATE_SH}"
  fi
fi

# 5) Startfortschritt verfolgen (s. warte_auf_start).
log "Starting up — this takes about a minute:"
warte_auf_start

# 6) Falls eine Route nötig ist, sie + den Reload-Befehl konkret ausgeben.
#
# BEVOR geprüft wird, nicht danach: im Modus `static-docker` hat der Container
# keinen veröffentlichten Port, er ist also über https://<hostname> erst
# erreichbar, NACHDEM diese Route steht. Früher stand die Prüfung davor und
# lief zwangsläufig fünf Minuten ins Leere, bevor der Betreiber überhaupt
# erfuhr, was er noch zu tun hat.
if [ "$MODE" = "static-docker" ] || [ "$MODE" = "hostproxy" ]; then
  if [ "$MODE" = "static-docker" ]; then TARGET="${CONTAINER}:${HTTP_PORT}"; else TARGET="127.0.0.1:${HTTP_PORT}"; fi
  # Reload-Befehl nach erkanntem Proxy (bei dockerisiertem statischem Proxy
  # kennen wir den Container-Namen → konkreter Befehl).
  case "$PROXY_KIND" in
    static-caddy) RELOAD_CMD="docker exec ${PROXY_CONTAINER} caddy reload --config /etc/caddy/Caddyfile" ;;
    static-nginx) RELOAD_CMD="docker exec ${PROXY_CONTAINER} nginx -s reload" ;;
    *)            RELOAD_CMD="# reload your reverse proxy, e.g.:  sudo systemctl reload caddy   (or: nginx -s reload)" ;;
  esac
  cat <<EOF

  ----------------------------------------------------------------
  ONE route in your existing reverse proxy is still needed.
  (If a route for ${SRV_HOST} already exists, just point it at http://${TARGET}.)

  Caddy — add to your Caddyfile:
      ${SRV_HOST} {
          reverse_proxy ${TARGET}
      }
  nginx — inside the server block (WebSockets must pass through):
      location / {
          proxy_pass http://${TARGET};
          proxy_http_version 1.1;
          proxy_set_header Upgrade \$http_upgrade;
          proxy_set_header Connection "upgrade";
          proxy_set_header Host \$host;
      }

  Then reload the proxy:
      ${RELOAD_CMD}
  ----------------------------------------------------------------

EOF
  # Ohne die Route kann keine Prüfung von aussen gelingen — also erst fragen.
  # Strg+C beendet den Installer, BEVOR er den Server verbindet (Schritt 8). Der
  # Hinweis dazu steht deshalb schon an der Frage, und ein INT-Trap nur um das
  # Warten wiederholt ihn. Nach dem Warten wird der Trap wieder abgenommen: der
  # Rest des Laufs soll sich bei Strg+C wie bisher verhalten.
  printf '  Stopping here with Ctrl-C? Add the route, then connect the server:\n'
  printf '      docker exec -it %s pulse-connect\n' "$CONTAINER"
  printf '  Press Enter once the route is in place… '
  trap 'echo; verbinden_spaeter "Stopped before the route was checked — your server is running, but not connected to a Pulse account yet."; exit 130' INT
  # Mit Frist: ein unbeaufsichtigter Lauf mit Terminal haenge sonst fuer immer.
  read -r -t 600 _ <"$TTY_GERAET" 2>/dev/null || true
  trap - INT
  echo
fi

# 7) Antwortet der Server unter seiner eigenen Adresse?
#
# Ein Abruf von /.well-known/pulse-server-info prüft DNS, Port 443, Zertifikat
# und Routing in einem Schritt. Ein Fehlschlag hier ist kein Beweis: etliche
# Netze erreichen ihren eigenen öffentlichen Namen von innen nicht (kein
# Hairpin-NAT). Deshalb nur eine Warnung — ob die Cloud den Server erreicht,
# stellt pulse-connect im nächsten Schritt selbst fest.
log "Checking that your server answers under https://${SRV_HOST} …"
if server_info_aussen >/dev/null; then
  log "Your server answers under https://${SRV_HOST}."
else
  warn "Your server does not answer under https://${SRV_HOST} from this machine yet."
  warn "Check that the DNS record points at this machine and that ports 80 and 443 are open."
  warn "Some networks cannot reach their own public address from inside — the next step checks from outside."
  warn "Details:  docker exec ${CONTAINER} pulse-doctor"
fi

# 8) Mit dem Pulse-Konto verbinden (s. server_verbinden).
server_verbinden

# 9) Die Prüfung aus der Cloud — nur ein verbundener Server hat die
# Zugangsdaten, mit denen sie sich ausweist. Vorher auf die Dienste warten
# (warte_auf_dienste), an dieser einen Stelle für alle Wege hierher.
if [ -n "$VERBUNDEN" ]; then
  if ! warte_auf_dienste; then
    warn "Pulse has not finished starting all its services, or one of them failed."
    warn "The check from the outside may report problems because of that. To see which part:  docker exec ${CONTAINER} pulse-doctor"
  fi
  log "Checking your server from the outside — this is what your users will see:"
  if ! pruefung_von_aussen; then
    warn "Could not run the external check right now."
    warn "Run it on this machine any time:  docker exec $CONTAINER pulse-doctor"
    warn "Or in the Pulse app: My servers → Check connection."
  fi
fi

echo
log "Pulse should now be at https://${SRV_HOST}"

# Kernel-UDP-Puffer: NUR ein Hinweis, ausdruecklich kein Eingriff.
#
# Warum nicht selbst setzen: der Installer laeuft nicht zwingend als root, und
# ungefragt am Kernel des WIRTS zu drehen ist etwas anderes, als einen
# Container hinzustellen — die Grenze gilt fuer jeden Dienst auf der Maschine.
# Warum ueberhaupt: MediaMTX buendelt alle WebRTC-Sitzungen auf EINEM
# UDP-Socket, LiveKit fordert von sich aus grosse Puffer an; Debians Vorgabe
# (~212 KB) klemmt beide still, und der Verlust entsteht dann auf dem Server
# selbst — keine Fehlerkorrektur der Welt holt ihn zurueck. Volle Begruendung:
# `infra/prod/sysctl-pulse.conf`, Anleitung `infra/self-host/README.md`.
cat <<'EOF'

  ----------------------------------------------------------------
  Recommended for streaming and voice quality: raise the kernel's UDP
  buffer limits. Without this, the server itself can drop packets once
  several people watch at the same time — visible as stutter even on a
  clean connection. As root, once:

      printf 'net.core.rmem_max = 16777216\nnet.core.wmem_max = 16777216\n' \
        > /etc/sysctl.d/99-pulse.conf && sysctl --system

  These are upper limits, not reservations — no memory is used until
  a socket actually asks for it.
  ----------------------------------------------------------------
EOF

log "Done."
