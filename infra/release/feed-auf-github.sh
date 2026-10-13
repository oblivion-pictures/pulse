#!/usr/bin/env bash
# Schreibt einen electron-builder-Update-Feed (latest.yml / latest-mac.yml) so
# um, dass seine Dateien aus dem GitHub-Release kommen — aufgerufen von den
# Bau-Workflows (win-build, win-build-server, mac-build) NACH
# `github-release.sh` und VOR dem Hochladen des Feeds.
#
#   GITHUB_REPOSITORY=o/r bash infra/release/feed-auf-github.sh \
#       <version> <Feed-Datei> <Fester Name>=<lokale Datei> [...]
#
# electron-builder schreibt relative Adressen (`url: Pulse-Setup-0.1.101.exe`),
# die electron-updater gegen die Adresse des Feeds auflöst — also gegen den
# netcup-Ordner. Die Dateien liegen aber unter FESTEN Namen im Release
# `desktop-v<version>` (Mechanik: github-release.sh). Dieses Skript ersetzt jede
# `url:` unter `files:` und das `path:` durch
#   https://github.com/<repo>/releases/download/desktop-v<version>/<Fester Name>
# Der Feed selbst bleibt auf netcup: nur dort kennen die installierten Apps ihn
# (`app-update.yml`), und er ist das Letzte, was bei einem Bau umspringt.
#
# Die Adresse trägt die VERSION (`releases/download/desktop-v<version>/…`), nie
# `releases/latest/download/…`: für das Delta-Update leitet electron-updater die
# Blockmap der alten Fassung ab, indem er die neue Versionsnummer im Pfad durch
# die alte ersetzt (Provider.getBlockMapFiles). Ohne Version im Pfad gäbe es
# keine alte Blockmap, und `latest` wäre obendrein ein Wettlauf zwischen den
# parallelen Bau-Workflows. Gab es zu einer älteren Fassung kein Release (und
# damit keine Blockmap), fällt der Client für diesen einen Schritt auf den
# vollen Download zurück.
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
# Läuft auf Ubuntu, macOS (bash 3.2) und in der Git Bash unter Windows. Braucht
# openssl (liegt auf allen dreien) und awk; kein yq.
set -euo pipefail

die() { echo "feed-auf-github: $*" >&2; exit 1; }

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

# Feed zerlegen. Ausgabe je Zeile, Felder durch das Zeichen 0x1F getrennt (kein
# Leerraum, damit leere Felder nicht zusammenfallen):
#   VERSION  <v>          PATH  <p>          SHA512  <s>
#   DATEI    <url> <sha512> <size>           FEHLER  <text>
read -r -d '' AWK_LESEN <<'AWK' || true
function wert(z, k,   v) {
  v = z
  sub("^[ \t]*(-[ \t]+)?" k ":[ \t]*", "", v)
  sub(/[ \t]+$/, "", v)
  if (v ~ /^".*"$/ || v ~ /^'.*'$/) v = substr(v, 2, length(v) - 2)
  return v
}
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
function wert(z, k,   v) {
  v = z
  sub("^[ \t]*(-[ \t]+)?" k ":[ \t]*", "", v)
  sub(/[ \t]+$/, "", v)
  if (v ~ /^".*"$/ || v ~ /^'.*'$/) v = substr(v, 2, length(v) - 2)
  return v
}
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
done < <(awk "$AWK_LESEN" "$feed")

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
awk -v ersetzungen="$arbeit/ersetzungen" "$AWK_SCHREIBEN" "$feed" > "$arbeit/neu"
cat "$arbeit/neu" > "$feed"
echo "feed-auf-github: ${feed} zeigt jetzt auf ${basis}/ (Einträge: ${#URLS[@]} — $(cut -f2 "$arbeit/ersetzungen" | sed "s#^${basis}/##" | tr '\n' ' '))"
