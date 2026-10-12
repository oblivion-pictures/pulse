#!/usr/bin/env bash
# Entscheidungslogik von `github-release.sh` — ohne echtes GitHub.
#
# Warum es das gibt: das Skript läuft nur in den Bau-Workflows auf main, also
# erst NACH dem Landen und dann gleich viermal parallel. Ein Fehler darin
# (falsches Release, fehlende APK, Abbruch beim Wettlauf zweier Läufe) fiele
# erst an einem roten Bau oder an einem toten Download-Link auf.
#
# Aufruf:  bash infra/release/tests/github-release-faelle.sh
set -euo pipefail

hier="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
skript="$hier/../github-release.sh"
arbeit="$(mktemp -d)"
trap 'rm -rf "$arbeit"' EXIT
mkdir -p "$arbeit/bin"

# gh-Attrappe: ein Release ist ein Verzeichnis unter $GH_ZUSTAND/releases,
# die Anlage-Reihenfolge steht in $GH_ZUSTAND/reihenfolge (neueste unten).
cat > "$arbeit/bin/gh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
z="$GH_ZUSTAND"; r="$z/releases"; mkdir -p "$r"; touch "$z/reihenfolge"
[ "$1" = release ] || { echo "attrappe: unerwartet: $*" >&2; exit 9; }
sub="$2"; shift 2
tag=""; dateien=(); json=""; muster=""; ziel=""; latest=""; notes=""
while [ $# -gt 0 ]; do
  case "$1" in
    --repo|--target|--title|--limit|--jq) shift ;;
    --json) json="$2"; shift ;;
    --notes-file) notes="$2"; shift ;;
    --pattern) muster="$2"; shift ;;
    --dir) ziel="$2"; shift ;;
    --latest) latest=ja ;;
    --clobber) ;;
    -*) echo "attrappe: unbekannte Option $1" >&2; exit 9 ;;
    *) if [ -z "$tag" ] && [ "$sub" != list ]; then tag="$1"; else dateien+=("$1"); fi ;;
  esac
  shift
done
case "$sub" in
  view)
    [ -d "$r/$tag" ] || exit 1
    [ "$json" = assets ] && ls "$r/$tag" | grep -v '^_' || true
    exit 0 ;;
  create)
    if [ -n "${WETTLAUF:-}" ] && [ ! -e "$z/wettlauf-erledigt" ]; then
      touch "$z/wettlauf-erledigt"; mkdir -p "$r/$tag"; echo "$tag" >> "$z/reihenfolge"
      echo "already exists" >&2; exit 1
    fi
    [ -d "$r/$tag" ] && exit 1
    mkdir -p "$r/$tag"; echo "$tag" >> "$z/reihenfolge"
    cp "$notes" "$r/$tag/_notizen"; [ -n "$latest" ] && touch "$r/$tag/_latest"
    echo "CREATE $tag" >> "$z/protokoll"; exit 0 ;;
  upload)
    [ -d "$r/$tag" ] || exit 1
    for d in "${dateien[@]}"; do cp "$d" "$r/$tag/"; echo "UPLOAD $tag $(basename "$d")" >> "$z/protokoll"; done
    exit 0 ;;
  list)
    tac "$z/reihenfolge" | grep '^desktop-v' || true; exit 0 ;;
  download)
    cp "$r/$tag/$muster" "$ziel/"; exit 0 ;;
esac
echo "attrappe: unerwartet: $sub" >&2; exit 9
STUB
chmod +x "$arbeit/bin/gh"

printf 'EXE' > "$arbeit/setup.exe"; printf 'MAP' > "$arbeit/setup.exe.blockmap"; printf 'APK' > "$arbeit/app.apk"

fehler=0
ok()   { echo "✓ $1"; }
nein() { echo "✗ $1" >&2; fehler=1; }
lauf() {  # lauf <zustand> <args…> — gibt den Exit-Code zurück, Ausgabe nach $zustand/ausgabe
  local z="$1"; shift
  env PATH="$arbeit/bin:$PATH" GH_ZUSTAND="$z" GITHUB_REPOSITORY=o/r GITHUB_SHA=abc123 \
    bash "$skript" "$@" > "$z/ausgabe" 2>&1
}
neu() { local z="$arbeit/z$1"; mkdir -p "$z/releases"; touch "$z/reihenfolge" "$z/protokoll"; echo "$z"; }

# 1. Erste Version: Release anlegen, Dateien unter festem Namen, als „Latest“.
z="$(neu 1)"
if lauf "$z" 0.1.101 "Pulse-Setup-Windows.exe=$arbeit/setup.exe" "Pulse-Setup-Windows.exe.blockmap=$arbeit/setup.exe.blockmap" \
   && [ "$(cat "$z/releases/desktop-v0.1.101/Pulse-Setup-Windows.exe")" = EXE ] \
   && [ -f "$z/releases/desktop-v0.1.101/Pulse-Setup-Windows.exe.blockmap" ] \
   && [ -f "$z/releases/desktop-v0.1.101/_latest" ] \
   && grep -q "Pulse 0.1.101" "$z/releases/desktop-v0.1.101/_notizen" \
   && grep -q "abc123" "$z/releases/desktop-v0.1.101/_notizen"; then
  ok "neue Version legt desktop-v0.1.101 als Latest an, feste Namen"
else nein "neue Version: $(cat "$z/ausgabe")"; fi

# 2. Release existiert schon: kein zweites create, Datei wird ersetzt.
z="$(neu 2)"; mkdir -p "$z/releases/desktop-v0.1.101"; echo desktop-v0.1.101 >> "$z/reihenfolge"
printf 'ALT' > "$z/releases/desktop-v0.1.101/Pulse-Setup-Windows.exe"
if lauf "$z" 0.1.101 "Pulse-Setup-Windows.exe=$arbeit/setup.exe" \
   && ! grep -q CREATE "$z/protokoll" \
   && [ "$(cat "$z/releases/desktop-v0.1.101/Pulse-Setup-Windows.exe")" = EXE ]; then
  ok "vorhandenes Release: kein create, Neubau ersetzt die Datei"
else nein "vorhandenes Release: $(cat "$z/ausgabe")"; fi

# 3. Wettlauf: ein paralleler Lauf legt das Release zwischen view und create an.
z="$(neu 3)"
if WETTLAUF=1 lauf "$z" 0.1.101 "Pulse-macOS.dmg=$arbeit/setup.exe" \
   && [ -f "$z/releases/desktop-v0.1.101/Pulse-macOS.dmg" ] \
   && grep -q "paralleler Lauf" "$z/ausgabe"; then
  ok "Wettlauf beim Anlegen ist kein Fehler, Datei hängt trotzdem dran"
else nein "Wettlauf: $(cat "$z/ausgabe")"; fi

# 4. Neue Version ohne Android-Bau: APK kommt aus dem jüngsten Vorgänger, der sie hat.
z="$(neu 4)"
for t in desktop-v0.1.99 desktop-v0.1.100; do mkdir -p "$z/releases/$t"; echo "$t" >> "$z/reihenfolge"; done
printf 'APK-99' > "$z/releases/desktop-v0.1.99/Pulse-Android.apk"
if lauf "$z" 0.1.101 "Pulse-Setup-Windows.exe=$arbeit/setup.exe" \
   && [ "$(cat "$z/releases/desktop-v0.1.101/Pulse-Android.apk")" = APK-99 ] \
   && grep -q "aus desktop-v0.1.99 übernommen" "$z/ausgabe"; then
  ok "APK wird aus dem jüngsten Vorgänger mit APK übernommen"
else nein "APK-Übernahme: $(cat "$z/ausgabe")"; fi

# 5. Android-Lauf lädt die APK selbst hoch: keine Übernahme, die neue gewinnt.
z="$(neu 5)"; mkdir -p "$z/releases/desktop-v0.1.100"; echo desktop-v0.1.100 >> "$z/reihenfolge"
printf 'APK-ALT' > "$z/releases/desktop-v0.1.100/Pulse-Android.apk"
if lauf "$z" 0.1.101 "Pulse-Android.apk=$arbeit/app.apk" \
   && [ "$(cat "$z/releases/desktop-v0.1.101/Pulse-Android.apk")" = APK ] \
   && ! grep -q übernommen "$z/ausgabe"; then
  ok "eigene APK wird hochgeladen, nichts übernommen"
else nein "Android-Lauf: $(cat "$z/ausgabe")"; fi

# 6. Kein Vorgänger mit APK: Hinweis, aber kein Fehler.
z="$(neu 6)"
if lauf "$z" 0.1.101 "Pulse-Setup-Windows.exe=$arbeit/setup.exe" && grep -q "in keinem Vorgänger" "$z/ausgabe"; then
  ok "ohne Vorgänger-APK: Hinweis statt Abbruch"
else nein "ohne Vorgänger-APK: $(cat "$z/ausgabe")"; fi

# 7. Fehlende Datei: Abbruch VOR jedem create.
z="$(neu 7)"
if ! lauf "$z" 0.1.101 "Pulse-Setup-Windows.exe=$arbeit/gibts-nicht.exe" \
   && [ ! -s "$z/protokoll" ] && grep -q "Datei fehlt" "$z/ausgabe"; then
  ok "fehlende Datei bricht ab, bevor ein Release entsteht"
else nein "fehlende Datei: $(cat "$z/ausgabe")"; fi

# 8. Kaputte Version und kaputte Angaben werden abgewiesen.
z="$(neu 8)"
if ! lauf "$z" "" "a=$arbeit/setup.exe" && ! lauf "$z" 0.1 "a=$arbeit/setup.exe" \
   && ! lauf "$z" 0.1.101 "$arbeit/setup.exe" && ! lauf "$z" 0.1.101 "a b=$arbeit/setup.exe" \
   && [ ! -s "$z/protokoll" ]; then
  ok "ungültige Version/Angaben werden abgewiesen"
else nein "ungültige Eingaben: $(cat "$z/ausgabe")"; fi

[ "$fehler" = 0 ] && echo "✓ github-release: alle Fälle wie erwartet" || exit 1
