#!/usr/bin/env bash
# bauen.sh — LiveKit-Server mit den Pulse-Patches bauen (Fassung, Commits und
# Patch-Stand: quelle.env daneben; warum es den Fork gibt: README.md).
#
#   bauen.sh --aus <datei> [--os <goos>] [--arch <goarch>] [--lizenz <ordner>]
#            [--arbeit <ordner>]
#
#   --aus     Ziel des Binarys (Pflicht). Daneben entsteht <datei>.fork mit dem
#             Stempel aus quelle.env — an ihm erkennt fetch-win-native.ps1 eine
#             veraltete, zwischengespeicherte Kopie.
#   --os/--arch  Zielplattform (Vorgabe: die des Rechners). Go kompiliert ohne
#             CGO für jedes Ziel selbst — das Linux-Image baut arm64 nicht
#             unter Emulation, die Windows-Server-App braucht kein zweites Rezept.
#   --lizenz  Ordner für LICENSE + NOTICE der beiden Upstream-Repos und die
#             angewendeten Patches (Apache-2.0 §4: Lizenz, NOTICE-Text und die
#             Änderung reisen mit dem veränderten Binary).
#   --arbeit  Arbeitsordner behalten (Vorgabe: Wegwerf-Ordner).
#
# Ablauf: beide Repos per COMMIT holen (nicht per Tag) → prüfen, dass LiveKits
# go.mod genau den mediatransportutil-Stand verlangt, gegen den der Patch
# geschrieben ist → patches/*.patch der Reihe nach anwenden (bricht ab, wenn
# einer nicht sauber passt) → die Go-Tests des gepatchten Pakets fahren (in der
# Plattform des RECHNERS, ein Test-Binary für ein fremdes Ziel liesse sich hier
# nicht starten) → LiveKit gegen den gepatchten Stand bauen.
#
# Braucht: bash, git, go (>= die Fassung aus LiveKits go.mod; 1.26).
# Läuft unter Linux und unter Git Bash auf Windows (win-build-server.yml).
set -euo pipefail

HIER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=quelle.env
. "$HIER/quelle.env"

fehler() { echo "[livekit-fork] $*" >&2; exit 1; }

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
for wert in "$LIVEKIT_VERSION" "$LIVEKIT_COMMIT" "$MTU_COMMIT" "$PULSE_REVISION"; do
    [ -n "$wert" ] || fehler "quelle.env unvollständig"
done
case "$LIVEKIT_COMMIT$MTU_COMMIT" in
    *[!0-9a-f]*) fehler "quelle.env: Commits müssen volle SHA-1 sein" ;;
esac
[ "${#LIVEKIT_COMMIT}" = 40 ] && [ "${#MTU_COMMIT}" = 40 ] || fehler "quelle.env: Commits müssen volle SHA-1 sein"

STEMPEL="${LIVEKIT_VERSION}-pulse${PULSE_REVISION} livekit=${LIVEKIT_COMMIT} mediatransportutil=${MTU_COMMIT}"
WIRT_OS="$(go env GOOS)"
WIRT_ARCH="$(go env GOARCH)"
ZIEL_OS="${ZIEL_OS:-$WIRT_OS}"
ZIEL_ARCH="${ZIEL_ARCH:-$WIRT_ARCH}"

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

# Repo an genau einem Commit holen. GitHub liefert einen erreichbaren Commit
# auch ohne Ref; `--depth 1` hält es klein. autocrlf AUS: unter Windows stünden
# die Quellen sonst mit CRLF da, und `git apply` fände die LF-Patches nicht.
holen() {
    local url="$1" commit="$2" ziel="$3"
    rm -rf "$ziel"
    git init -q "$ziel"
    git -C "$ziel" config core.autocrlf false
    git -C "$ziel" fetch -q --depth 1 "$url" "$commit"
    git -C "$ziel" checkout -q FETCH_HEAD
    [ "$(git -C "$ziel" rev-parse HEAD)" = "$commit" ] || fehler "$url: nicht auf $commit"
}

echo "[livekit-fork] ${STEMPEL} → ${ZIEL_OS}/${ZIEL_ARCH}"
holen https://github.com/livekit/livekit.git "$LIVEKIT_COMMIT" "$ARBEIT/livekit"
holen https://github.com/livekit/mediatransportutil.git "$MTU_COMMIT" "$ARBEIT/mtu"

grep -q "^const Version = \"${LIVEKIT_VERSION}\"\$" "$ARBEIT/livekit/version/version.go" \
    || fehler "version/version.go nennt nicht ${LIVEKIT_VERSION} — LIVEKIT_COMMIT und LIVEKIT_VERSION passen nicht zusammen"
grep -Eq "^[[:space:]]*github\.com/livekit/mediatransportutil v[^ ]*-${MTU_COMMIT:0:12}([[:space:]]|\$)" "$ARBEIT/livekit/go.mod" \
    || fehler "LiveKits go.mod verlangt einen anderen mediatransportutil-Stand als MTU_COMMIT — Patch erst gegen den neuen Stand prüfen (README.md)"

for p in "$HIER"/patches/*.patch; do
    echo "[livekit-fork] → $(basename "$p")"
    git -C "$ARBEIT/mtu" apply --check "$p" || fehler "$(basename "$p") passt nicht sauber"
    git -C "$ARBEIT/mtu" apply "$p"
done

export CGO_ENABLED=0
echo "[livekit-fork] go test ./pkg/rtcconfig/"
( cd "$ARBEIT/mtu" && go test ./pkg/rtcconfig/ )

( cd "$ARBEIT/livekit" \
    && go mod edit -replace github.com/livekit/mediatransportutil=../mtu \
    && GOOS="$ZIEL_OS" GOARCH="$ZIEL_ARCH" go build -trimpath -ldflags "-s -w" -o "$AUS" ./cmd/server )

if [ "$ZIEL_OS/$ZIEL_ARCH" = "$WIRT_OS/$WIRT_ARCH" ]; then
    "$AUS" --version | grep -q "version ${LIVEKIT_VERSION}\$" || fehler "gebautes Binary meldet nicht ${LIVEKIT_VERSION}"
fi
printf '%s\n' "$STEMPEL" > "$AUS.fork"

if [ -n "$LIZENZ" ]; then
    cp "$ARBEIT/livekit/LICENSE" "$LIZENZ/LICENSE"
    cp "$ARBEIT/livekit/NOTICE" "$LIZENZ/NOTICE"
    cp "$ARBEIT/mtu/NOTICE" "$LIZENZ/NOTICE.mediatransportutil"
    mkdir -p "$LIZENZ/patches"
    cp "$HIER"/patches/*.patch "$LIZENZ/patches/"
    printf 'LiveKit %s, verändert von Pulse (%s).\nDie Änderungen gegen github.com/livekit/mediatransportutil stehen in patches/.\n' \
        "$LIVEKIT_VERSION" "$STEMPEL" > "$LIZENZ/AENDERUNGEN.txt"
fi

echo "[livekit-fork] fertig: $AUS"
