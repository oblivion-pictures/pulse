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
# Asset-IDs wie bei GitHub: eine Nummer je Asset, die beim Umbenennen bleibt und
# beim Löschen verfällt. Die Zuordnung steht in $z/idmap ("ID<TAB>Tag<TAB>Name").
touch "$z/idmap"
id_fuer() {  # id_fuer <tag> <name> — vergibt bei Bedarf
  local i
  i="$(awk -F'\t' -v t="$1" -v n="$2" '$2==t && $3==n { print $1 }' "$z/idmap")"
  if [ -z "$i" ]; then
    i=$(( $(cat "$z/nextid" 2>/dev/null || echo 1000) + 1 )); echo "$i" > "$z/nextid"
    printf '%s\t%s\t%s\n' "$i" "$1" "$2" >> "$z/idmap"
  fi
  echo "$i"
}
if [ "$1" = api ]; then
  # Nur die zwei Formen, die das Skript braucht: alle Assets mit ID lesen und per
  # PATCH umbenennen.
  shift; methode=GET; pfad=""; jq=""; felder=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --method) methode="$2"; shift ;;
      --jq) jq="$2"; shift ;;
      -f) felder+=("$2"); shift ;;
      -*) echo "attrappe: unbekannte api-Option $1" >&2; exit 9 ;;
      *) pfad="$1" ;;
    esac
    shift
  done
  # Aussetzer: die ersten N API-Aufrufe NACH dem ersten Löschen scheitern ohne Wirkung.
  if [ -n "${NACH_DELETE_AUSSETZER:-}" ] && [ -e "$z/geloescht" ]; then
    gezaehlt="$(cat "$z/aussetzer" 2>/dev/null || echo 0)"
    if [ "$gezaehlt" -lt "$NACH_DELETE_AUSSETZER" ]; then
      echo $((gezaehlt + 1)) > "$z/aussetzer"; echo "attrappe: HTTP 502" >&2; exit 1
    fi
  fi
  case "$methode $pfad" in
    "GET repos/o/r/releases/tags/"*)
      tag="${pfad##*/}"; [ -d "$r/$tag" ] || exit 1
      [[ "$jq" == *'\(.id) \(.name)'* ]] || { echo "attrappe: --jq nicht verstanden: $jq" >&2; exit 9; }
      # Lesen scheitert, solange noch nichts gelöscht wurde (Zustand vor dem Löschen).
      if [ -n "${LESEN_SCHEITERT_VOR_DELETE:-}" ] && [ ! -e "$z/geloescht" ]; then
        echo "attrappe: HTTP 502" >&2; exit 1
      fi
      for f in $(ls "$r/$tag" | grep -v '^_' || true); do echo "$(id_fuer "$tag" "$f") $f"; done
      exit 0 ;;
    "PATCH repos/o/r/releases/assets/"*)
      id="${pfad##*/}"; neu=""
      for f in "${felder[@]}"; do case "$f" in name=*) neu="${f#name=}" ;; esac; done
      zeile="$(awk -F'\t' -v i="$id" '$1==i { print $2 "\t" $3 }' "$z/idmap")"
      [ -n "$zeile" ] && [ -n "$neu" ] || { echo "attrappe: 404 Asset $id" >&2; exit 1; }
      tag="${zeile%%$'\t'*}"; alt="${zeile#*$'\t'}"; d="$r/$tag/"
      if [ "${UMBENENNEN_SCHEITERT:-}" = immer ]; then echo "attrappe: Umbenennen scheitert" >&2; exit 1; fi
      if [ -n "${EINDRINGLING:-}" ] && [ ! -e "$z/eindringling-erledigt" ]; then
        # Ein anderer Lauf legt genau jetzt eine Datei unter dem Zielnamen an.
        touch "$z/eindringling-erledigt"; printf 'FREMD' > "$d$neu"
        echo "attrappe: 422 already_exists" >&2; exit 1
      fi
      [ -e "$d$neu" ] && { echo "attrappe: 422 already_exists" >&2; exit 1; }
      mv "$d$alt" "$d$neu"
      awk -F'\t' -v OFS='\t' -v i="$id" -v n="$neu" '$1==i { $3=n } { print }' "$z/idmap" > "$z/idmap.neu" && mv "$z/idmap.neu" "$z/idmap"
      echo "RENAME $tag $alt $neu" >> "$z/protokoll"
      if [ -n "${PATCH_ANTWORT_VERLOREN:-}" ] && [ ! -e "$z/antwort-verloren-erledigt" ]; then
        # Das Umbenennen ist serverseitig gelungen, die Antwort kommt nicht an.
        touch "$z/antwort-verloren-erledigt"; echo "attrappe: Verbindung abgerissen" >&2; exit 1
      fi
      exit 0 ;;
  esac
  echo "attrappe: unerwartetes api: $methode $pfad" >&2; exit 9
fi
[ "$1" = release ] || { echo "attrappe: unerwartet: $*" >&2; exit 9; }
sub="$2"; shift 2
tag=""; dateien=(); json=""; muster=""; ziel=""; latest=""; notes=""; clobber=""
while [ $# -gt 0 ]; do
  case "$1" in
    --repo|--target|--title|--limit|--jq) shift ;;
    --json) json="$2"; shift ;;
    --notes-file) notes="$2"; shift ;;
    --pattern) muster="$2"; shift ;;
    --dir) ziel="$2"; shift ;;
    --latest) latest=ja ;;
    --latest=false) latest=nein ;;
    --clobber) clobber=ja ;;
    --yes) ;;
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
    cp "$notes" "$r/$tag/_notizen"; [ "$latest" = ja ] && touch "$r/$tag/_latest"
    echo "CREATE $tag latest=${latest:-auto}" >> "$z/protokoll"; exit 0 ;;
  upload)
    [ -d "$r/$tag" ] || exit 1
    for d in "${dateien[@]}"; do
      n="$(basename "$d")"
      if [ -n "${UPLOAD_SCHEITERT_MUSTER:-}" ] && [[ "$n" == *"$UPLOAD_SCHEITERT_MUSTER"* ]]; then
        echo "attrappe: Upload scheitert" >&2; exit 1
      fi
      if [ -n "${UPLOAD_SCHEITERT_ENDNAME:-}" ] && [ "$n" = "$UPLOAD_SCHEITERT_ENDNAME" ]; then
        echo "attrappe: Upload unter dem Endnamen scheitert" >&2; exit 1
      fi
      # Wettlauf nachstellen: ein anderer Lauf legt dieselbe Datei genau jetzt ab.
      if [ -n "${RENNEN:-}" ] && [ "$n" = "$RENNEN" ] && [ -z "$clobber" ]; then
        printf 'FRISCH' > "$r/$tag/$n"
      fi
      if [ -e "$r/$tag/$n" ] && [ -z "$clobber" ]; then echo "already exists" >&2; exit 1; fi
      cp "$d" "$r/$tag/"; echo "UPLOAD $tag $n" >> "$z/protokoll"
    done
    exit 0 ;;
  edit)
    [ -d "$r/$tag" ] || exit 1
    [ "$latest" = ja ] && { rm -f "$r"/*/_latest; touch "$r/$tag/_latest"; echo "LATEST $tag" >> "$z/protokoll"; }
    exit 0 ;;
  delete-asset)
    n="${dateien[0]}"
    [ -d "$r/$tag" ] && [ -e "$r/$tag/$n" ] || { echo "asset $n not found" >&2; exit 1; }
    if [ "${DELETE_SCHEITERT_FUER:-}" = "$n" ]; then echo "attrappe: Löschen scheitert" >&2; exit 1; fi
    rm -f "$r/$tag/$n"; touch "$z/geloescht"; echo "DELETE $tag $n" >> "$z/protokoll"
    awk -F'\t' -v t="$tag" -v n="$n" '!($2==t && $3==n)' "$z/idmap" > "$z/idmap.neu" && mv "$z/idmap.neu" "$z/idmap"
    if [ -n "${DELETE_ANTWORT_VERLOREN:-}" ] && [ ! -e "$z/delete-verloren-erledigt" ]; then
      # Gelöscht, aber die Antwort kommt nicht an.
      touch "$z/delete-verloren-erledigt"; echo "attrappe: Verbindung abgerissen" >&2; exit 1
    fi
    exit 0 ;;
  list)
    # Neueste Anlage zuerst, ALLE Tags (auch fremde) — gefiltert wird im Skript.
    sed '1!G;h;$!d' "$z/reihenfolge"; exit 0 ;;
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
  env PATH="$arbeit/bin:$PATH" GH_ZUSTAND="$z" GITHUB_REPOSITORY=o/r GITHUB_SHA=abc123 GITHUB_RELEASE_PAUSE=0 \
    bash "$skript" "$@" > "$z/ausgabe" 2>&1
}
neu() { local z="$arbeit/z$1"; mkdir -p "$z/releases"; touch "$z/reihenfolge" "$z/protokoll"; echo "$z"; }

# 1. Erste Version: Release anlegen, Dateien unter festem Namen — noch nicht
#    Latest, solange die anderen Plattformen fehlen.
z="$(neu 1)"
if lauf "$z" 0.1.101 "Pulse-Setup-Windows.exe=$arbeit/setup.exe" "Pulse-Setup-Windows.exe.blockmap=$arbeit/setup.exe.blockmap" \
   && [ "$(cat "$z/releases/desktop-v0.1.101/Pulse-Setup-Windows.exe")" = EXE ] \
   && [ -f "$z/releases/desktop-v0.1.101/Pulse-Setup-Windows.exe.blockmap" ] \
   && [ ! -f "$z/releases/desktop-v0.1.101/_latest" ] \
   && grep -q "CREATE desktop-v0.1.101 latest=nein" "$z/protokoll" \
   && grep -q "Pulse 0.1.101" "$z/releases/desktop-v0.1.101/_notizen" \
   && grep -q "noch unvollständig" "$z/ausgabe"; then
  ok "neue Version legt desktop-v0.1.101 an, feste Namen, noch nicht Latest"
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

# 9. Letzte fehlende Datei kommt dazu: jetzt Latest, der Vorgänger verliert es.
z="$(neu 9)"
for t in desktop-v0.1.100 desktop-v0.1.101; do mkdir -p "$z/releases/$t"; echo "$t" >> "$z/reihenfolge"; done
touch "$z/releases/desktop-v0.1.100/_latest"
for n in Pulse-Setup-Windows.exe Pulse-Server-Setup-Windows.exe Pulse-macOS.dmg Pulse-Android.apk; do
  printf x > "$z/releases/desktop-v0.1.101/$n"; done
if lauf "$z" 0.1.101 "Pulse-Server-macOS.dmg=$arbeit/setup.exe" \
   && [ -f "$z/releases/desktop-v0.1.101/_latest" ] && [ ! -f "$z/releases/desktop-v0.1.100/_latest" ]; then
  ok "vollständig + höchste Version → Latest wandert"
else nein "Latest bei Vollständigkeit: $(cat "$z/ausgabe")"; fi

# 10. Vollständig, aber eine höhere Version existiert schon (Neubau eines alten Stands).
z="$(neu 10)"
for t in desktop-v0.1.100 desktop-v0.1.102; do mkdir -p "$z/releases/$t"; echo "$t" >> "$z/reihenfolge"; done
touch "$z/releases/desktop-v0.1.102/_latest"
for n in Pulse-Setup-Windows.exe Pulse-Server-Setup-Windows.exe Pulse-macOS.dmg Pulse-Android.apk; do
  printf x > "$z/releases/desktop-v0.1.100/$n"; done
if lauf "$z" 0.1.100 "Pulse-Server-macOS.dmg=$arbeit/setup.exe" \
   && [ -f "$z/releases/desktop-v0.1.102/_latest" ] && [ ! -f "$z/releases/desktop-v0.1.100/_latest" ] \
   && grep -q "nicht die höchste Version" "$z/ausgabe"; then
  ok "alter Stand wird nicht Latest, auch wenn vollständig"
else nein "alter Stand: $(cat "$z/ausgabe")"; fi

# 11. Fremde Tags (Self-Host v1.0.0) in der Liste: weder Quelle noch Versionsvergleich.
z="$(neu 11)"
for t in desktop-v0.1.100 v1.0.0 v9.9.9; do mkdir -p "$z/releases/$t"; echo "$t" >> "$z/reihenfolge"; done
printf 'APK-FREMD' > "$z/releases/v9.9.9/Pulse-Android.apk"
printf 'APK-100' > "$z/releases/desktop-v0.1.100/Pulse-Android.apk"
if lauf "$z" 0.1.101 "Pulse-Setup-Windows.exe=$arbeit/setup.exe" \
   && [ "$(cat "$z/releases/desktop-v0.1.101/Pulse-Android.apk")" = APK-100 ]; then
  ok "fremde Tags werden übergangen"
else nein "fremde Tags: $(cat "$z/ausgabe")"; fi

# 12. Wettlauf um die APK: der Android-Bau legt seine frische APK ab, während
#     ein Desktop-Lauf die alte übernehmen will — die frische bleibt.
z="$(neu 12)"
for t in desktop-v0.1.100; do mkdir -p "$z/releases/$t"; echo "$t" >> "$z/reihenfolge"; done
printf 'APK-ALT' > "$z/releases/desktop-v0.1.100/Pulse-Android.apk"
if RENNEN=Pulse-Android.apk lauf "$z" 0.1.101 "Pulse-Setup-Windows.exe=$arbeit/setup.exe" \
   && [ "$(cat "$z/releases/desktop-v0.1.101/Pulse-Android.apk")" = FRISCH ] \
   && grep -q "inzwischen ein anderer Lauf" "$z/ausgabe"; then
  ok "übernommene alte APK überschreibt nie eine frische"
else nein "APK-Wettlauf: $(cat "$z/ausgabe")"; fi

# 13. Ersetzen einer vorhandenen Datei ohne Lücke: erst unter Zwischennamen
#     hoch (die alte wird weiter ausgeliefert), dann löschen, dann umbenennen —
#     direkt hintereinander. Nie ein Upload auf den Namen der alten Datei
#     (das `--clobber` von gh löschte erst und lüde dann 337 MB hoch).
z="$(neu 13)"; t=desktop-v0.1.101; mkdir -p "$z/releases/$t"; echo "$t" >> "$z/reihenfolge"
printf 'ALT' > "$z/releases/$t/Pulse-Setup-Windows.exe"; printf 'ALT-MAP' > "$z/releases/$t/Pulse-Setup-Windows.exe.blockmap"
if lauf "$z" 0.1.101 "Pulse-Setup-Windows.exe=$arbeit/setup.exe" "Pulse-Setup-Windows.exe.blockmap=$arbeit/setup.exe.blockmap" \
   && [ "$(cat "$z/releases/$t/Pulse-Setup-Windows.exe")" = EXE ] \
   && [ "$(cat "$z/releases/$t/Pulse-Setup-Windows.exe.blockmap")" = MAP ] \
   && ! ls "$z/releases/$t" | grep -q '\.neu-' \
   && ! grep -qE "^UPLOAD $t Pulse-Setup-Windows.exe(.blockmap)?$" "$z/protokoll" \
   && [ "$(grep -n -E "^(UPLOAD $t Pulse-Setup-Windows.exe.neu-|DELETE $t Pulse-Setup-Windows.exe$|RENAME $t Pulse-Setup-Windows.exe.neu-.* Pulse-Setup-Windows.exe$)" "$z/protokoll" | cut -d: -f1 | tr '\n' ' ')" = "1 2 3 " ] \
   && [ "$(head -n 3 "$z/protokoll" | cut -d' ' -f1 | tr '\n' ' ')" = "UPLOAD DELETE RENAME " ]; then
  ok "vorhandene Datei: Zwischenname hoch, alte löschen, umbenennen — in genau dieser Reihenfolge, keine Zwischendatei bleibt"
else nein "lückenlos ersetzen: $(cat "$z/ausgabe"; cat "$z/protokoll")"; fi

# 14. Abbruch ZWISCHEN Upload und Umbenennen (die alte lässt sich nicht löschen):
#     die alte Datei bleibt stehen und wird weiter ausgeliefert, die Zwischendatei
#     ist weggeräumt.
z="$(neu 14)"; t=desktop-v0.1.101; mkdir -p "$z/releases/$t"; echo "$t" >> "$z/reihenfolge"
printf 'ALT' > "$z/releases/$t/Pulse-Setup-Windows.exe"
if ! DELETE_SCHEITERT_FUER=Pulse-Setup-Windows.exe lauf "$z" 0.1.101 "Pulse-Setup-Windows.exe=$arbeit/setup.exe" \
   && [ "$(cat "$z/releases/$t/Pulse-Setup-Windows.exe")" = ALT ] \
   && ! ls "$z/releases/$t" | grep -q '\.neu-' && grep -q "die alte Datei\|sie bleibt" "$z/ausgabe"; then
  ok "Abbruch vor dem Löschen: alte Datei bleibt, Zwischendatei weg"
else nein "Abbruch nach Upload: $(cat "$z/ausgabe"; ls "$z/releases/$t")"; fi

# 15. Der Zwischen-Upload selbst scheitert: nichts wurde angefasst.
z="$(neu 15)"; t=desktop-v0.1.101; mkdir -p "$z/releases/$t"; echo "$t" >> "$z/reihenfolge"
printf 'ALT' > "$z/releases/$t/Pulse-Setup-Windows.exe"
if ! UPLOAD_SCHEITERT_MUSTER=.neu- lauf "$z" 0.1.101 "Pulse-Setup-Windows.exe=$arbeit/setup.exe" \
   && [ "$(cat "$z/releases/$t/Pulse-Setup-Windows.exe")" = ALT ] && ! grep -q DELETE "$z/protokoll"; then
  ok "Zwischen-Upload scheitert: alte Datei unangetastet, nichts gelöscht"
else nein "Zwischen-Upload: $(cat "$z/ausgabe")"; fi

# 16. Abbruch NACH dem Löschen, wenn gar nichts mehr geht (Umbenennen scheitert
#     immer, auch der letzte Ausweg „direkt unter dem Endnamen hochladen"): der
#     Endname FEHLT, die neue Datei liegt als Zwischendatei im Release, die
#     Meldung sagt genau das, und der nächste Lauf stellt alles her und räumt auf.
z="$(neu 16)"; t=desktop-v0.1.101; mkdir -p "$z/releases/$t"; echo "$t" >> "$z/reihenfolge"
printf 'ALT' > "$z/releases/$t/Pulse-Setup-Windows.exe"
if ! UMBENENNEN_SCHEITERT=immer UPLOAD_SCHEITERT_ENDNAME=Pulse-Setup-Windows.exe \
        lauf "$z" 0.1.101 "Pulse-Setup-Windows.exe=$arbeit/setup.exe" \
   && [ ! -e "$z/releases/$t/Pulse-Setup-Windows.exe" ] \
   && [ "$(cat "$z/releases/$t"/Pulse-Setup-Windows.exe.neu-*)" = EXE ] \
   && grep -q "Pulse-Setup-Windows.exe FEHLT" "$z/ausgabe" && grep -q "Zuletzt gelesener Stand: .*Pulse-Setup-Windows.exe.neu-" "$z/ausgabe" \
   && lauf "$z" 0.1.101 "Pulse-Setup-Windows.exe=$arbeit/setup.exe" \
   && [ "$(cat "$z/releases/$t/Pulse-Setup-Windows.exe")" = EXE ] && ! ls "$z/releases/$t" | grep -q '\.neu-'; then
  ok "Abbruch beim Umbenennen: Endname fehlt (Meldung sagt es), der nächste Lauf heilt und räumt auf"
else nein "Abbruch beim Umbenennen: $(cat "$z/ausgabe"; ls "$z/releases/$t")"; fi

# 17. Paralleler Lauf (der Fall im Betrieb): beim Umbenennen legt ein anderer
#     Lauf selbst eine Datei dieses Namens an — etwa die Übernahme einer alten
#     APK. Die frisch gebaute gewinnt.
z="$(neu 17)"; t=desktop-v0.1.101; mkdir -p "$z/releases/$t"; echo "$t" >> "$z/reihenfolge"
printf 'APK-ALT' > "$z/releases/$t/Pulse-Android.apk"
if EINDRINGLING=1 lauf "$z" 0.1.101 "Pulse-Android.apk=$arbeit/app.apk" \
   && [ "$(cat "$z/releases/$t/Pulse-Android.apk")" = APK ] && ! ls "$z/releases/$t" | grep -q '\.neu-' \
   && [ "$(grep -c '^DELETE' "$z/protokoll")" = 2 ]; then
  ok "paralleler Lauf legt die Datei beim Umbenennen an: die frische gewinnt, Zwischendatei weg"
else nein "Eindringling: $(cat "$z/ausgabe"; cat "$z/protokoll")"; fi

# 18. Paralleler Lauf bei einer NEUEN Datei: zwischen Auflisten und Hochladen
#     legt ein anderer Lauf sie an — dann gilt der Fall „vorhanden“.
z="$(neu 18)"; t=desktop-v0.1.101; mkdir -p "$z/releases/$t"; echo "$t" >> "$z/reihenfolge"
if RENNEN=Pulse-Setup-Windows.exe lauf "$z" 0.1.101 "Pulse-Setup-Windows.exe=$arbeit/setup.exe" \
   && [ "$(cat "$z/releases/$t/Pulse-Setup-Windows.exe")" = EXE ] && ! ls "$z/releases/$t" | grep -q '\.neu-'; then
  ok "neue Datei, die ein anderer Lauf gerade anlegt: wird ersetzt statt abzubrechen"
else nein "neue Datei im Wettlauf: $(cat "$z/ausgabe"; ls "$z/releases/$t")"; fi

# 19. Zwischendateien früherer, abgebrochener Läufe (anderer Lauf-/Prozessnummer)
#     werden weggeräumt, fremde Dateien nicht.
z="$(neu 19)"; t=desktop-v0.1.101; mkdir -p "$z/releases/$t"; echo "$t" >> "$z/reihenfolge"
printf 'ALT' > "$z/releases/$t/Pulse-Setup-Windows.exe"
printf 'JUNK' > "$z/releases/$t/Pulse-Setup-Windows.exe.neu-99-1"
printf 'ANDERE' > "$z/releases/$t/Pulse-macOS.dmg"
if lauf "$z" 0.1.101 "Pulse-Setup-Windows.exe=$arbeit/setup.exe" \
   && [ ! -e "$z/releases/$t/Pulse-Setup-Windows.exe.neu-99-1" ] && [ -e "$z/releases/$t/Pulse-macOS.dmg" ] \
   && [ "$(cat "$z/releases/$t/Pulse-Setup-Windows.exe")" = EXE ]; then
  ok "alte Zwischendatei wird weggeräumt, andere Dateien bleiben"
else nein "Aufräumen: $(cat "$z/ausgabe"; ls "$z/releases/$t")"; fi

# 20. Aussetzer der API NACH dem Löschen (zwei Aufrufe in Folge scheitern ohne
#     Wirkung: das Umbenennen, dann das Lesen des Zustands): wird wiederholt, die
#     alte Datei wird nur EINMAL gelöscht, am Ende liegt die neue unter dem Namen.
z="$(neu 20)"; t=desktop-v0.1.101; mkdir -p "$z/releases/$t"; echo "$t" >> "$z/reihenfolge"
printf 'ALT' > "$z/releases/$t/Pulse-Setup-Windows.exe"
if NACH_DELETE_AUSSETZER=2 lauf "$z" 0.1.101 "Pulse-Setup-Windows.exe=$arbeit/setup.exe" \
   && [ "$(cat "$z/releases/$t/Pulse-Setup-Windows.exe")" = EXE ] && ! ls "$z/releases/$t" | grep -q '\.neu-' \
   && [ "$(grep -c '^DELETE' "$z/protokoll")" = 1 ] && [ "$(grep -c '^RENAME' "$z/protokoll")" = 1 ]; then
  ok "Aussetzer nach dem Löschen: wiederholt, Datei am Ende da, nichts doppelt gelöscht"
else nein "Aussetzer: $(cat "$z/ausgabe"; cat "$z/protokoll")"; fi

# 21. Die API fällt nach dem Löschen ganz aus (nur die Hochladen-Schnittstelle
#     geht): der letzte Ausweg lädt direkt unter dem Endnamen hoch — der Name ist
#     noch in diesem Lauf wieder da, die Zwischendatei ist weg.
z="$(neu 21)"; t=desktop-v0.1.101; mkdir -p "$z/releases/$t"; echo "$t" >> "$z/reihenfolge"
printf 'ALT' > "$z/releases/$t/Pulse-Setup-Windows.exe"
if NACH_DELETE_AUSSETZER=99 lauf "$z" 0.1.101 "Pulse-Setup-Windows.exe=$arbeit/setup.exe" \
   && [ "$(cat "$z/releases/$t/Pulse-Setup-Windows.exe")" = EXE ] && ! ls "$z/releases/$t" | grep -q '\.neu-' \
   && grep -q "direkt unter dem Endnamen hochgeladen" "$z/ausgabe"; then
  ok "API fällt nach dem Löschen aus: letzter Ausweg stellt den Namen im selben Lauf her"
else nein "letzter Ausweg: $(cat "$z/ausgabe"; ls "$z/releases/$t")"; fi

# 22. Lesen scheitert, BEVOR gelöscht wurde: nichts ist verloren, also sauber
#     abbrechen — die alte Datei bleibt, die Zwischendatei ist weg, nichts gelöscht.
z="$(neu 22)"; t=desktop-v0.1.101; mkdir -p "$z/releases/$t"; echo "$t" >> "$z/reihenfolge"
printf 'ALT' > "$z/releases/$t/Pulse-Setup-Windows.exe"
if ! LESEN_SCHEITERT_VOR_DELETE=1 lauf "$z" 0.1.101 "Pulse-Setup-Windows.exe=$arbeit/setup.exe" \
   && [ "$(cat "$z/releases/$t/Pulse-Setup-Windows.exe")" = ALT ] && ! ls "$z/releases/$t" | grep -q '\.neu-' \
   && ! grep -q '^DELETE desktop-v0.1.101 Pulse-Setup-Windows.exe$' "$z/protokoll" \
   && grep -q "Stand des Release nicht lesen" "$z/ausgabe"; then
  ok "Lesen scheitert vor dem Löschen: alte Datei bleibt, Zwischendatei weg, nichts gelöscht"
else nein "Lesen vor dem Löschen: $(cat "$z/ausgabe"; ls "$z/releases/$t")"; fi

# 23. Das Umbenennen ist gelungen, die ANTWORT geht verloren: das Skript liest den
#     Zustand, sieht den Endnamen mit der ID seiner Zwischendatei und gilt es als
#     Erfolg. Es löscht seine eigene neue Datei NICHT (nur ein Name mit anderer ID
#     gilt als alt).
z="$(neu 23)"; t=desktop-v0.1.101; mkdir -p "$z/releases/$t"; echo "$t" >> "$z/reihenfolge"
printf 'ALT' > "$z/releases/$t/Pulse-Setup-Windows.exe"
if PATCH_ANTWORT_VERLOREN=1 lauf "$z" 0.1.101 "Pulse-Setup-Windows.exe=$arbeit/setup.exe" \
   && [ "$(cat "$z/releases/$t/Pulse-Setup-Windows.exe")" = EXE ] && ! ls "$z/releases/$t" | grep -q '\.neu-' \
   && [ "$(grep -c '^DELETE' "$z/protokoll")" = 1 ] && [ "$(grep -c '^RENAME' "$z/protokoll")" = 1 ]; then
  ok "Antwort auf das Umbenennen verloren: als Erfolg erkannt, eigene Datei bleibt"
else nein "verlorene Antwort: $(cat "$z/ausgabe"; cat "$z/protokoll"; ls "$z/releases/$t")"; fi

# 24. Das Löschen der alten Datei ist gelungen, die ANTWORT geht verloren: ein
#     zweiter Löschversuch fände nichts mehr („asset not found"). Das Skript liest
#     deshalb den Zustand, sieht den Namen fehlen und macht weiter.
z="$(neu 24)"; t=desktop-v0.1.101; mkdir -p "$z/releases/$t"; echo "$t" >> "$z/reihenfolge"
printf 'ALT' > "$z/releases/$t/Pulse-Setup-Windows.exe"
if DELETE_ANTWORT_VERLOREN=1 lauf "$z" 0.1.101 "Pulse-Setup-Windows.exe=$arbeit/setup.exe" \
   && [ "$(cat "$z/releases/$t/Pulse-Setup-Windows.exe")" = EXE ] && ! ls "$z/releases/$t" | grep -q '\.neu-'; then
  ok "Antwort auf das Löschen verloren: Zustand gelesen, Name fehlt, es geht weiter"
else nein "verlorene Lösch-Antwort: $(cat "$z/ausgabe"; ls "$z/releases/$t")"; fi

[ "$fehler" = 0 ] && echo "✓ github-release: alle Fälle wie erwartet" || exit 1
