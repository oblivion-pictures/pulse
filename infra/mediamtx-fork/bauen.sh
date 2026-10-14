#!/usr/bin/env bash
# bauen.sh — MediaMTX mit den Pulse-Patches als einzelnes Binary bauen, für
# die Windows-Server-App (fetch-win-native.ps1). Das Linux-Bild baut weiter
# das Dockerfile daneben; beide lesen Fassung und Patch-Stand aus DERSELBEN
# Stelle (`MEDIAMTX_VERSION` / `PULSE_REVISION` im Dockerfile) und wenden
# dieselben Patches an.
#
#   bauen.sh --aus <datei> [--os <goos>] [--arch <goarch>] [--lizenz <ordner>]
#            [--arbeit <ordner>]
#
#   --aus     Ziel des Binarys (Pflicht). Daneben entsteht <datei>.fork mit dem
#             Stempel `<version>-pulse<revision>` — an ihm erkennt
#             fetch-win-native.ps1 eine veraltete, zwischengespeicherte Kopie.
#   --os/--arch  Zielplattform (Vorgabe: die des Rechners). Ohne CGO
#             kompiliert Go für jedes Ziel selbst.
#   --lizenz  Ordner für LICENSE von MediaMTX und die angewendeten Patches
#             (MIT: der Lizenztext reist mit dem Binary, die Patches zeigen
#             die Änderung).
#   --arbeit  Arbeitsordner behalten (Vorgabe: Wegwerf-Ordner).
#
# **Warum es das gibt (2026-10-14):** die Windows-Server-App lud bis dahin das
# offizielle MediaMTX-Release herunter — ohne einen einzigen unserer Patches.
# Damit fehlte Windows-Heimservern nicht nur der kleine Ton-Puffer (0008),
# sondern auch der Vollbild-Rückweg (0002), und die Variable
# `PULSE_KEYFRAME_INTERVAL`, die die App setzt, lief ins Leere.
#
# Ablauf wie im Dockerfile: Upstream-Tag holen → patches/*.patch der Reihe
# nach anwenden (bricht ab, wenn einer nicht sauber passt) → die beiden
# Generatoren, die `go build` braucht → `go mod vendor` und
# patches-vendor/*.patch → die Pulse-Tests der gepatchten Pakete (in der
# Plattform des RECHNERS, ein Test-Binary für ein fremdes Ziel liesse sich
# hier nicht starten) → bauen.
#
# **Nur die Pulse-Tests, nicht die ganzen Pakete** wie im Dockerfile: dort
# laufen sie unter Linux schon für genau diese Quellen. Die Upstream-Tests
# des webrtc-Pakets binden feste UDP-Ports (`TestPeerConnectionCandidates`,
# :3454) und hängen an der Netzwerkumgebung des Läufers; unter Windows fielen
# sie aus Gründen, die mit unseren Patches nichts zu tun haben.
#
# Braucht: bash, git, go (1.26). Läuft unter Linux und unter Git Bash auf
# Windows (win-build-server.yml).
set -euo pipefail

HIER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

fehler() { echo "[mediamtx-fork] $*" >&2; exit 1; }

# Fassung und Patch-Stand: allein im Dockerfile (dessen Kopf erklärt, warum).
arg_aus_dockerfile() {
    sed -n "s/^ARG $1=\\([0-9A-Za-z.]*\\)\$/\\1/p" "$HIER/Dockerfile" | head -n 1
}
MEDIAMTX_VERSION="$(arg_aus_dockerfile MEDIAMTX_VERSION)"
PULSE_REVISION="$(arg_aus_dockerfile PULSE_REVISION)"
[ -n "$MEDIAMTX_VERSION" ] && [ -n "$PULSE_REVISION" ] \
    || fehler "Dockerfile: MEDIAMTX_VERSION oder PULSE_REVISION nicht gefunden"

AUS=""
ZIEL_OS=""
ZIEL_ARCH=""
LIZENZ=""
ARBEIT=""
while [ $# -gt 0 ]; do
    case "$1" in
        --aus) AUS="${2:-}"; shift ;;
        --os) ZIEL_OS="${2:-}"; shift ;;
        --arch) ZIEL_ARCH="${2:-}"; shift ;;
        --lizenz) LIZENZ="${2:-}"; shift ;;
        --arbeit) ARBEIT="${2:-}"; shift ;;
        *) fehler "unbekanntes Argument: $1" ;;
    esac
    shift
done
[ -n "$AUS" ] || fehler "--aus <datei> fehlt"

STEMPEL="${MEDIAMTX_VERSION}-pulse${PULSE_REVISION}"
WIRT_OS="$(go env GOOS)"
WIRT_ARCH="$(go env GOARCH)"
ZIEL_OS="${ZIEL_OS:-$WIRT_OS}"
ZIEL_ARCH="${ZIEL_ARCH:-$WIRT_ARCH}"
# arm-Ziele brauchen den Raspberry-Pi-Generator, den dieses Skript nicht fährt
# (`//go:embed mtxrpicam_64/*`, Dockerfile) — dafür ist das Linux-Bild da.
case "$ZIEL_ARCH" in arm|arm64) fehler "Ziel ${ZIEL_ARCH}: nur über das Dockerfile" ;; esac

# Absolute Pfade, bevor irgendwo hineingewechselt wird.
mkdir -p "$(dirname "$AUS")"
AUS="$(cd "$(dirname "$AUS")" && pwd)/$(basename "$AUS")"
if [ -n "$LIZENZ" ]; then
    mkdir -p "$LIZENZ"
    LIZENZ="$(cd "$LIZENZ" && pwd)"
fi
if [ -n "$ARBEIT" ]; then
    mkdir -p "$ARBEIT"
    ARBEIT="$(cd "$ARBEIT" && pwd)"
else
    ARBEIT="$(mktemp -d)"
    trap 'rm -rf "$ARBEIT"' EXIT
fi
QUELLE="$ARBEIT/mediamtx"

echo "[mediamtx-fork] ${STEMPEL} → ${ZIEL_OS}/${ZIEL_ARCH}"
# autocrlf AUS: unter Windows stünden die Quellen sonst mit CRLF da, und
# `git apply` fände die LF-Patches nicht (wie in infra/livekit-fork/bauen.sh).
rm -rf "$QUELLE"
git init -q "$QUELLE"
git -C "$QUELLE" config core.autocrlf false
# Den Tag als Tag holen, nicht nur seinen Commit: MediaMTX' Versions-Generator
# liest ihn aus .git, ohne ihn meldet sich das Binary als `v0.0.0`.
git -C "$QUELLE" fetch -q --depth 1 https://github.com/bluenviron/mediamtx.git \
    "refs/tags/v${MEDIAMTX_VERSION}:refs/tags/v${MEDIAMTX_VERSION}"
git -C "$QUELLE" checkout -q "v${MEDIAMTX_VERSION}"

anwenden() {
    local p="$1"
    echo "[mediamtx-fork] → $(basename "$p")"
    git -C "$QUELLE" apply --check "$p" || fehler "$(basename "$p") passt nicht sauber"
    git -C "$QUELLE" apply "$p"
}
for p in "$HIER"/patches/*.patch; do anwenden "$p"; done

# Fixture für Patch 0006, wie im Dockerfile (dort steht, warum sie nicht im
# Patch steckt).
mkdir -p "$QUELLE/internal/protocols/webrtc/testdata"
cp "$HIER/bildmarke-formen.json" "$QUELLE/internal/protocols/webrtc/testdata/bildmarke-formen.json"

export CGO_ENABLED=0
(
    cd "$QUELLE"
    # Die beiden `//go:embed`-Generatoren (Begründung im Dockerfile). Die
    # Raspberry-Pi-Kamera braucht nur ein arm-Ziel — Windows nie.
    go generate -mod=mod ./internal/servers/hls/... ./internal/core/...
    go mod vendor
)
# Vendorierte Patches erst nach `go mod vendor`, wie im Dockerfile.
for p in "$HIER"/patches-vendor/*.patch; do anwenden "$p"; done

(
    cd "$QUELLE"
    echo "[mediamtx-fork] go test (Pulse-Tests)"
    go test -run 'Pulse|Bildmarke' ./internal/stream/ ./internal/protocols/webrtc/
    GOOS="$ZIEL_OS" GOARCH="$ZIEL_ARCH" go build \
        -tags=osusergo,netgo -ldflags="-s -w" -trimpath -o "$AUS" .
)

printf '%s\n' "$STEMPEL" > "$AUS.fork"

if [ -n "$LIZENZ" ]; then
    cp "$QUELLE/LICENSE" "$LIZENZ/LICENSE"
    mkdir -p "$LIZENZ/patches"
    cp "$HIER"/patches/*.patch "$HIER"/patches-vendor/*.patch "$LIZENZ/patches/"
    printf 'MediaMTX %s, verändert von Pulse (%s).\nDie Änderungen stehen in patches/.\n' \
        "$MEDIAMTX_VERSION" "$STEMPEL" > "$LIZENZ/AENDERUNGEN.txt"
fi

echo "[mediamtx-fork] fertig: $AUS"
