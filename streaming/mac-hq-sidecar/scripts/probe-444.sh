#!/bin/bash
# Prüft auf einem Mac, was VideoToolbox in voller Farbauflösung (4:4:4) kann —
# als gesteuerter Rechner (kodieren) und als Steuernder (entschlüsseln).
#
# Anlass (2026-10-22): 4:4:4 macht farbige Schrift in der Fernsteuerung
# deutlich sauberer (gemessen auf einer RTX 4090, `hevc_nvenc`). Für den Mac
# steht nur fest, was der FFmpeg-Quelltext sagt: `hevc_videotoolbox` bietet als
# erweitertes Profil allein „Main 4:2:2 10" an (`videotoolboxenc.c`, Kommentar
# „only main42210 is supported"), `h264_videotoolbox` kein 4:4:4-Profil. Ob der
# Chip trotzdem etwas annimmt, ob er still auf 4:2:0 herunterrechnet und ob er
# 4:4:4 in Hardware entschlüsselt, ist ungeprüft — das klärt dieses Skript mit
# echten Läufen.
#
# Aufruf:  bash streaming/mac-hq-sidecar/scripts/probe-444.sh
#          FFMPEG=/pfad/zu/ffmpeg bash …   (sonst: ~/src/ffmpeg-openssl, dann PATH)
#
# Für den Entschlüssel-Teil braucht es eine Probe in 4:4:4. Die erzeugt das
# Skript mit libx265/libx264, die das Homebrew-FFmpeg mitbringt (unser eigener
# LGPL-Bau hat sie absichtlich nicht, `build-ffmpeg.sh`). Fehlen sie, wird der
# Teil übersprungen und das gemeldet.
#
# Schreibt nichts außerhalb eines Wegwerf-Ordners; das Protokoll landet zum
# Zurückschicken in probe-444-<datum>.txt im aktuellen Ordner.
set -u

if [ -z "${FFMPEG:-}" ]; then
  if [ -x "$HOME/src/ffmpeg-openssl/bin/ffmpeg" ]; then
    FFMPEG="$HOME/src/ffmpeg-openssl/bin/ffmpeg"
  else
    FFMPEG="$(command -v ffmpeg || true)"
  fi
fi
[ -n "$FFMPEG" ] && [ -x "$FFMPEG" ] || { echo "kein ffmpeg gefunden (FFMPEG=… setzen)" >&2; exit 1; }
FFPROBE="$(dirname "$FFMPEG")/ffprobe"
[ -x "$FFPROBE" ] || FFPROBE="$(command -v ffprobe || true)"
[ -n "$FFPROBE" ] || { echo "kein ffprobe gefunden" >&2; exit 1; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/probe444.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
PROTOKOLL="$PWD/probe-444-$(date +%Y%m%d-%H%M%S).txt"
exec > >(tee "$PROTOKOLL") 2>&1

echo "== System"
sw_vers 2>/dev/null | tr '\n' ' '; echo
sysctl -n machdep.cpu.brand_string 2>/dev/null
"$FFMPEG" -hide_banner -version | head -1
echo "ffmpeg: $FFMPEG"
echo

# Testbild: 1440p60, 2 s, mit farbigen Kanten (testsrc2 hat feine Farbübergänge).
QUELLE="-f lavfi -i testsrc2=s=2560x1440:r=60 -t 2"

# Gibt "profil,pix_fmt" des ersten Videostroms aus, leer bei kaputter Datei.
art() { "$FFPROBE" -v error -select_streams v:0 -show_entries stream=profile,pix_fmt -of csv=p=0 "$1" 2>/dev/null; }

# kodieren <name> <encoder> <eingangs-pix_fmt> [weitere Optionen…]
# Meldet JA nur, wenn die Datei wirklich in 4:4:4 vorliegt — VideoToolbox darf
# laut Apple still umrechnen, ein Erfolg ohne Prüfung des Ergebnisses sagt also
# nichts.
kodieren() {
  name=$1; enc=$2; pf=$3; shift 3
  out="$TMP/$name.mov"
  if "$FFMPEG" -hide_banner -loglevel error -y $QUELLE -pix_fmt "$pf" -c:v "$enc" -b:v 8M "$@" "$out" 2>"$TMP/$name.err"; then
    a="$(art "$out")"
    case "$a" in
      *444*|*nv24*|*yuv444*|*4444*) urteil="JA   (4:4:4)";;
      *422*|*p210*|*nv16*)          urteil="nein (4:2:2)";;
      "")                           urteil="nein (Datei unlesbar)";;
      *)                            urteil="nein (still auf 4:2:0)";;
    esac
    printf '  %-34s %-22s %s\n' "$name" "$urteil" "$a"
  else
    printf '  %-34s %-22s %s\n' "$name" "nein (abgelehnt)" "$(head -c 160 "$TMP/$name.err" | tr '\n' ' ')"
  fi
}

echo "== Kodieren (gesteuerter Rechner). allow_sw 0 = nur Hardware"
kodieren hevc_444_hw            hevc_videotoolbox yuv444p -allow_sw 0
kodieren hevc_444_rext_hw       hevc_videotoolbox yuv444p -profile:v rext -allow_sw 0
kodieren hevc_nv24_hw           hevc_videotoolbox nv24    -allow_sw 0
kodieren hevc_444_sw_erlaubt    hevc_videotoolbox yuv444p -allow_sw 1
kodieren h264_444_hw            h264_videotoolbox yuv444p -allow_sw 0
kodieren h264_nv24_hw           h264_videotoolbox nv24    -allow_sw 0
echo "  -- Gegenproben (sollten gehen):"
kodieren hevc_422_10bit_hw      hevc_videotoolbox p210le  -profile:v main42210 -allow_sw 0
kodieren hevc_420_hw            hevc_videotoolbox nv12    -allow_sw 0
kodieren prores_4444_hw         prores_videotoolbox yuva444p10le -profile:v 4444
echo

# entschluesseln <name> <datei>: erst nur Hardware, dann Prozessor zum
# Vergleich. Mit `-hwaccel_output_format videotoolbox_vld` gibt es keinen
# stillen Rückfall auf Software: kann VideoToolbox den Strom nicht, findet
# ffmpeg kein passendes Ausgabeformat und bricht ab (so auf einem M2 für AV1
# gemessen, `build-ffmpeg.sh`). Rückgabewert 0 heißt also Hardware.
entschluesseln() {
  name=$1; f=$2
  if hw="$("$FFMPEG" -hide_banner -benchmark -hwaccel videotoolbox -hwaccel_output_format videotoolbox_vld -i "$f" -f null - 2>&1)"; then
    hwu="JA   ($(echo "$hw" | grep -oE 'rtime=[0-9.]+s'))"
  else
    hwu="nein ($(echo "$hw" | grep -iE 'failed|error|not implemented' | head -1 | head -c 90))"
  fi
  sw="$("$FFMPEG" -hide_banner -benchmark -threads 1 -i "$f" -f null - 2>&1 | grep -oE 'utime=[0-9.]+s' || echo '?')"
  printf '  %-22s Hardware: %-40s Prozessor (1 Kern, 120 Bilder): %s\n' "$name" "$hwu" "$sw"
}

echo "== Entschlüsseln (Steuernder)"
probe_gemacht=0
if "$FFMPEG" -hide_banner -encoders 2>/dev/null | grep -q libx265; then
  "$FFMPEG" -hide_banner -loglevel error -y $QUELLE -pix_fmt yuv444p -c:v libx265 -preset ultrafast -x265-params log-level=error -b:v 8M "$TMP/x265_444.mp4" \
    && { echo "  Probe HEVC: $(art "$TMP/x265_444.mp4")"; entschluesseln "HEVC 4:4:4" "$TMP/x265_444.mp4"; probe_gemacht=1; }
  "$FFMPEG" -hide_banner -loglevel error -y $QUELLE -pix_fmt yuv420p -c:v libx265 -preset ultrafast -x265-params log-level=error -b:v 8M "$TMP/x265_420.mp4" \
    && entschluesseln "HEVC 4:2:0 (Gegenprobe)" "$TMP/x265_420.mp4"
fi
if "$FFMPEG" -hide_banner -encoders 2>/dev/null | grep -q libx264; then
  "$FFMPEG" -hide_banner -loglevel error -y $QUELLE -pix_fmt yuv444p -c:v libx264 -preset ultrafast -b:v 8M "$TMP/x264_444.mp4" \
    && { echo "  Probe H.264: $(art "$TMP/x264_444.mp4")"; entschluesseln "H.264 4:4:4" "$TMP/x264_444.mp4"; probe_gemacht=1; }
fi
if [ "$probe_gemacht" = 0 ]; then
  echo "  übersprungen: dieses ffmpeg hat weder libx265 noch libx264."
  echo "  Mit Homebrew: FFMPEG=/opt/homebrew/bin/ffmpeg bash $0"
fi
echo
echo "Protokoll: $PROTOKOLL"
