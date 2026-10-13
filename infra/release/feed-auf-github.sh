#!/usr/bin/env bash
# Schreibt einen electron-builder-Update-Feed (latest.yml / latest-mac.yml) so
# um, dass seine Dateien aus dem GitHub-Release kommen, und prüft danach, ob
# diese Adressen wirklich abrufbar sind — aufgerufen von den Bau-Workflows
# (win-build, win-build-server, mac-build):
#
#   1. umschreiben:  VOR `github-release.sh`. Das Skript braucht nur die lokalen
#      Dateien; ein Prüfabbruch darf nie erst eintreten, nachdem github-release.sh
#      Dateien im Release ersetzt hat, auf die der LIVE-Feed noch zeigt.
#   2. --pruefen:    NACH `github-release.sh`, VOR dem Hochladen des Feeds.
#
#   GITHUB_REPOSITORY=o/r bash infra/release/feed-auf-github.sh \
#       <version> <Feed-Datei> <Fester Name>=<lokale Datei> [...]
#   bash infra/release/feed-auf-github.sh --pruefen <Feed-Datei>
#
# electron-builder schreibt relative Adressen (`url: Pulse-Setup-0.1.101.exe`),
# die electron-updater gegen die Adresse des Feeds auflöst — also gegen den
# netcup-Ordner. Die Dateien liegen aber unter FESTEN Namen im Release
# `desktop-v<version>` (Mechanik: github-release.sh). Dieses Skript ersetzt jede
# `url:` unter `files:` und das `path:` durch
#   https://github.com/<repo>/releases/download/desktop-v<version>/<Fester Name>
# Der Feed selbst bleibt auf netcup: nur dort kennen die installierten Apps ihn
# (`app-update.yml`).
#
# Die Adresse trägt die VERSION (`releases/download/desktop-v<version>/…`), nie
# `releases/latest/download/…`. Erstens leitet electron-updater für Clients OHNE
# zwischengespeicherte Blockmap (Erstinstallation von Hand, geleerter Cache) die
# Blockmap der alten Fassung aus der Versionsnummer im Pfad ab, indem er die neue
# durch die alte ersetzt (Provider.getBlockMapFiles); sonst nimmt er
# `current.blockmap` aus dem Update-Cache (AppUpdater.js:695-699). Gab es zu einer
# älteren Fassung kein Release, lädt ein Client ohne Cache für diesen einen
# Schritt voll. Zweitens wäre `latest` ein Wettlauf: das Release wird erst
# „Latest“, wenn alle Bauten fertig sind, der Feed gilt aber ab dem Upload.
#
# Die Zuordnung ist dieselbe Liste, die github-release.sh bekommt: der Workflow
# baut sie einmal und reicht sie an beide weiter, damit die Adressen im Feed auf
# genau die Dateien zeigen, die hochgeladen wurden. Zugeordnet wird über den
# Dateinamen der lokalen Datei (so steht er im Feed). Angaben, die der Feed nicht
# nennt (`.blockmap`), sind erlaubt und werden übergangen.
#
# Vor dem ersten Schreiben wird alles geprüft; bei jeder Abweichung bricht das
# Skript ab und lässt den Feed unverändert:
#   - `version:` im Feed ist die übergebene Version,
#   - jeder Eintrag hat eine Zuordnung, eine lokale Datei, und deren sha512
#     (base64, wie electron-builder) und Größe stimmen mit dem Feed überein,
#   - `path:` nennt einen der Einträge, das sha512 darüber dessen sha512,
#   - keine Adresse ist schon absolut (der Feed wäre schon umgeschrieben, oder
#     jemand hat eine andere Quelle eingetragen — beides soll auffallen).
# Zeilenenden werden dabei auf LF gebracht; sonst bleibt jede Zeile, wie sie war.
#
# --pruefen fragt jede `url:` des (schon umgeschriebenen) Feeds ANONYM ab
# (`curl -fsIL`, ohne Token) und vergleicht die Content-Length der LETZTEN Antwort
# (aus den Köpfen gelesen, nicht per `-w`; Begründung an der Funktion) mit `size:`.
# github-release.sh sieht nur den Exit-Code von `gh`, mit Token: ein Entwurf
# gleichen Tags, ein privat gestelltes Repo oder ein falscher Eigentümer in
# GITHUB_REPOSITORY blieben unbemerkt und gäben bei allen Clients ein 404. Drei
# Versuche mit Pause (FEED_PRUEFEN_PAUSE, Vorgabe 5 s); scheitert es, wird der
# Feed nicht hochgeladen. Bei einem Neubau derselben Version steht dann im
# Release schon die neue Datei, und der Live-Feed nennt noch das sha512 der alten
# — bis zum nächsten grünen Lauf scheitern Updates mit „sha512 checksum mismatch“
# (sicher, aber vergeblich).
#
# Geschrieben für die Runner der Workflows: Git Bash mit gawk (Windows) und
# macOS mit bash 3.2 und BSD-awk. Deshalb keine bash-4-Funktionen (`mapfile`,
# `declare -A`) und awk nur im POSIX-Umfang (keine Zeichenklassen, keine gawk-
# Erweiterungen). Braucht openssl, awk und (für --pruefen) curl; kein yq. Die
# Fälle in tests/feed-auf-github-faelle.sh laufen mit dem awk der Maschine, auf
# der man sie startet (gawk, auch mit --posix und --traditional). Eine
# unabhängige Prüfung am 2026-10-13 fuhr sie zusätzlich mit Apples awk
# 20200816 (dem der macOS-Runner) und unter bash 3.2 mit BusyBox-awk grün.
set -euo pipefail

die() { echo "feed-auf-github: $*" >&2; exit 1; }

# Beide awk-Programme brauchen denselben Zugriff auf den Wert einer Zeile
# (`key: wert` oder `- key: wert`, ohne Rand und ohne umgebende Anführungszeichen
# — YAML erlaubt beide Schreibweisen). Er steht deshalb nur einmal hier und wird
# jedem Programm vorangestellt.
read -r -d '' AWK_WERT <<'AWK' || true
function wert(z, k,   v) {
  v = z
  sub("^[ \t]*(-[ \t]+)?" k ":[ \t]*", "", v)
  sub(/[ \t]+$/, "", v)
  if (v ~ /^".*"$/ || v ~ /^'.*'$/) v = substr(v, 2, length(v) - 2)
  return v
}
AWK

# Feed zerlegen. Ausgabe je Zeile, Felder durch das Zeichen 0x1F getrennt (kein
# Leerraum, damit leere Felder nicht zusammenfallen):
#   VERSION  <v>          PATH  <p>          SHA512  <s>
#   DATEI    <url> <sha512> <size>           FEHLER  <text>
read -r -d '' AWK_LESEN <<'AWK' || true
function offen_ausgeben() {
  if (offen) print "DATEI" S url S sha S size
  offen = 0
}
BEGIN { S = "\037" }
{ z = $0; sub(/\r$/, "", z) }
z ~ /^[^ \t#]/ {
  offen_ausgeben()
  infiles = 0
  if (z ~ /^version:/)       print "VERSION" S wert(z, "version")
  else if (z ~ /^path:/)     print "PATH" S wert(z, "path")
  else if (z ~ /^sha512:/)   print "SHA512" S wert(z, "sha512")
  else if (z ~ /^files:[ \t]*$/) infiles = 1
  next
}
infiles && z ~ /^[ \t]*-[ \t]/ {
  offen_ausgeben()
  if (z !~ /^[ \t]*-[ \t]+url:/) { print "FEHLER" S "Eintrag in files: beginnt nicht mit url: — " z; next }
  url = wert(z, "url"); sha = ""; size = ""; offen = 1
  next
}
infiles && offen && z ~ /^[ \t]+sha512:/ { sha = wert(z, "sha512"); next }
infiles && offen && z ~ /^[ \t]+size:/   { size = wert(z, "size"); next }
END { offen_ausgeben() }
AWK

# Umschreiben: Zeilen unverändert bis auf den Wert von `url:` unter files: und
# `path:`. Die Ersetzungen kommen als Datei "alt<TAB>neu" (Namen enthalten
# Leerzeichen, aber nie Tabulatoren).
read -r -d '' AWK_SCHREIBEN <<'AWK' || true
BEGIN {
  while ((getline l < ersetzungen) > 0) { split(l, p, "\t"); neu[p[1]] = p[2] }
}
{ z = $0; sub(/\r$/, "", z) }
z ~ /^[^ \t#]/ {
  infiles = (z ~ /^files:[ \t]*$/)
  if (z ~ /^path:/) {
    match(z, /^path:[ \t]*/)
    print substr(z, 1, RLENGTH) neu[wert(z, "path")]
    next
  }
}
infiles && z ~ /^[ \t]*-[ \t]+url:/ {
  match(z, /^[ \t]*-[ \t]+url:[ \t]*/)
  print substr(z, 1, RLENGTH) neu[wert(z, "url")]
  next
}
{ print z }
AWK

# ── --pruefen <Feed> ─────────────────────────────────────────────────────────
# Content-Length der letzten Antwort aus den Köpfen auf dem Standard-Eingang. Bewusst
# KEIN `curl -w '%{…}'`: die passende Variable (`%header{content-length}`, curl >= 7.84)
# gibt es auf älteren curl-Fassungen nicht, und `%{content_length_download}` gibt es gar
# nicht (curl meldet "unknown --write-out variable", druckt nichts und endet mit Exit 0).
# Jede Statuszeile (`HTTP/…`) beginnt eine neue Antwort; Kopfnamen sind je nach
# HTTP-Version groß oder klein geschrieben (HTTP/2: klein), Zeilenenden CRLF.
laenge_der_letzten_antwort() {
  awk '{ z = $0; sub(/\r$/, "", z); l = tolower(z) }
       l ~ /^http\// { len = ""; next }
       l ~ /^content-length:/ { v = substr(z, 16); gsub(/[ \t]/, "", v); len = v }
       END { print len }'
}
if [ "${1:-}" = "--pruefen" ]; then
  feed="${2:-}"
  [ -n "$feed" ] && [ -f "$feed" ] || die "Feed-Datei fehlt: '${feed}'"
  command -v curl >/dev/null 2>&1 || die "curl fehlt"
  pause="${FEED_PRUEFEN_PAUSE:-5}"
  geprueft=0
  while IFS=$'\037' read -r art a b c; do
    case "$art" in
      FEHLER) die "$feed: $a" ;;
      DATEI)
        case "$a" in
          https://*) ;;
          *) die "Eintrag '$a' ist keine https-Adresse — Feed nicht umgeschrieben?" ;;
        esac
        [ -n "$c" ] || die "Eintrag '$a': der Feed nennt keine Größe"
        versuch=1
        while :; do
          # Köpfe ALLER Stufen nach den Weiterleitungen, ohne Token, mit leerem
          # Standard-Eingang. Ausgewertet wird die Content-Length der LETZTEN
          # Antwort (die 302 davor trägt ihre eigene, meist 0).
          if koepfe="$(curl -fsIL --max-time 60 "$a" < /dev/null)"; then
            laenge="$(printf '%s\n' "$koepfe" | laenge_der_letzten_antwort)"
            [ "$laenge" = "$c" ] && break
            if [ -z "$laenge" ]; then
              grund="die letzte Antwort hat keine Content-Length"
            else
              grund="Content-Length ${laenge} weicht von size: ${c} ab"
            fi
          else
            grund="nicht anonym abrufbar (curl-Exit $?) — Entwurf, privates Repo oder falscher Eigentümer?"
          fi
          [ "$versuch" -lt 3 ] || die "Eintrag '$a': $grund"
          versuch=$((versuch + 1)); sleep "$pause"
        done
        geprueft=$((geprueft + 1)) ;;
    esac
  done < <(awk "$AWK_WERT"$'\n'"$AWK_LESEN" "$feed")
  [ "$geprueft" -gt 0 ] || die "$feed enthält keine Einträge unter files:"
  echo "feed-auf-github: ${geprueft} Adressen aus ${feed} sind anonym abrufbar, Größen stimmen"
  exit 0
fi

version="${1:-}"
feed="${2:-}"
shift 2 2>/dev/null || true
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "keine gültige Version: '${version}'"
[ -n "$feed" ] && [ -f "$feed" ] || die "Feed-Datei fehlt: '${feed}'"
[ $# -gt 0 ] || die "keine Dateien angegeben (<Fester Name>=<Datei>)"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY fehlt}"
[[ "$GITHUB_REPOSITORY" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || die "GITHUB_REPOSITORY ist nicht <Eigentümer>/<Name>: '${GITHUB_REPOSITORY}'"
command -v openssl >/dev/null 2>&1 || die "openssl fehlt"
basis="https://github.com/${GITHUB_REPOSITORY}/releases/download/desktop-v${version}"

# Zuordnung lesen: FESTE[i] ist der Name im Release, LOKAL[i] die Datei dazu.
FESTE=(); LOKAL=()
for paar in "$@"; do
  name="${paar%%=*}"
  datei="${paar#*=}"
  [ -n "$name" ] && [ "$name" != "$paar" ] || die "Angabe ohne '=': '$paar'"
  [[ "$name" =~ ^[A-Za-z0-9._-]+$ ]] || die "Zielname mit unerlaubten Zeichen: '$name'"
  [ -f "$datei" ] || die "Datei fehlt: '$datei' (für $name)"
  for schon in "${FESTE[@]+"${FESTE[@]}"}"; do
    [ "$schon" != "$name" ] || die "Zielname doppelt: '$name'"
  done
  FESTE+=("$name"); LOKAL+=("$datei")
done

sha512_b64() { openssl dgst -sha512 -binary "$1" | openssl base64 -A; }

# Relativ zum Checkout, nicht unter /tmp (Begründung: github-release.sh).
arbeit="$(mktemp -d ./.feed-auf-github.XXXXXX)"
trap 'rm -rf "$arbeit"' EXIT

feedversion=""; feedpath=""; feedsha=""
URLS=(); SHAS=(); GROESSEN=()
while IFS=$'\037' read -r art a b c; do
  case "$art" in
    VERSION) feedversion="$a" ;;
    PATH)    feedpath="$a" ;;
    SHA512)  feedsha="$a" ;;
    DATEI)   URLS+=("$a"); SHAS+=("$b"); GROESSEN+=("$c") ;;
    FEHLER)  die "$feed: $a" ;;
  esac
done < <(awk "$AWK_WERT"$'\n'"$AWK_LESEN" "$feed")

[ "$feedversion" = "$version" ] || die "$feed nennt Version '${feedversion}', übergeben wurde '${version}'"
[ "${#URLS[@]}" -gt 0 ] || die "$feed enthält keine Einträge unter files:"

: > "$arbeit/ersetzungen"
pfad_gefunden=0
i=0
while [ "$i" -lt "${#URLS[@]}" ]; do
  url="${URLS[$i]}"; sha="${SHAS[$i]}"; groesse="${GROESSEN[$i]}"
  case "$url" in
    http://*|https://*) die "Eintrag '$url' ist schon eine absolute Adresse — Feed schon umgeschrieben?" ;;
    *$'\t'*|'') die "Eintrag mit leerem oder unzulässigem Namen: '$url'" ;;
  esac

  # Zuordnung über den Dateinamen der lokalen Datei.
  treffer=-1; j=0
  while [ "$j" -lt "${#LOKAL[@]}" ]; do
    if [ "${LOKAL[$j]##*/}" = "$url" ]; then
      [ "$treffer" -lt 0 ] || die "Eintrag '$url' passt auf mehrere Angaben (${FESTE[$treffer]}, ${FESTE[$j]})"
      treffer=$j
    fi
    j=$((j + 1))
  done
  [ "$treffer" -ge 0 ] || die "Eintrag '$url' im Feed hat keine Zuordnung (<Fester Name>=<Datei mit diesem Namen>)"
  datei="${LOKAL[$treffer]}"

  [ -n "$sha" ] || die "Eintrag '$url': der Feed nennt kein sha512"
  [ -n "$groesse" ] || die "Eintrag '$url': der Feed nennt keine Größe"
  ist_sha="$(sha512_b64 "$datei")"
  [ "$ist_sha" = "$sha" ] || die "Eintrag '$url': sha512 weicht ab (Feed ${sha}, Datei ${ist_sha})"
  ist_groesse="$(wc -c < "$datei" | tr -d '[:space:]')"
  [ "$ist_groesse" = "$groesse" ] || die "Eintrag '$url': Größe weicht ab (Feed ${groesse}, Datei ${ist_groesse})"

  printf '%s\t%s\n' "$url" "${basis}/${FESTE[$treffer]}" >> "$arbeit/ersetzungen"
  if [ -n "$feedpath" ] && [ "$feedpath" = "$url" ]; then
    pfad_gefunden=1
    [ -z "$feedsha" ] || [ "$feedsha" = "$sha" ] || die "sha512 über path: weicht von dem des Eintrags '$url' ab"
  fi
  i=$((i + 1))
done

if [ -n "$feedpath" ]; then
  case "$feedpath" in
    http://*|https://*) die "path: '$feedpath' ist schon eine absolute Adresse — Feed schon umgeschrieben?" ;;
  esac
  [ "$pfad_gefunden" = 1 ] || die "path: '$feedpath' ist keiner der Einträge unter files:"
fi

# Erst jetzt wird geschrieben.
awk -v ersetzungen="$arbeit/ersetzungen" "$AWK_WERT"$'\n'"$AWK_SCHREIBEN" "$feed" > "$arbeit/neu"
cat "$arbeit/neu" > "$feed"
echo "feed-auf-github: ${feed} zeigt jetzt auf ${basis}/ (Einträge: ${#URLS[@]} — $(cut -f2 "$arbeit/ersetzungen" | sed "s#^${basis}/##" | tr '\n' ' '))"
