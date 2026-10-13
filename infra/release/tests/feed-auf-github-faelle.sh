#!/usr/bin/env bash
# Entscheidungslogik von `feed-auf-github.sh` — mit Feeds in der Form, die
# electron-builder wirklich schreibt (die vier Feeds von howispulse.com, Stand
# 0.1.101), aber erfundenen kleinen Dateien.
#
# Warum es das gibt: das Skript läuft nur in den Bau-Workflows auf main, und
# ein Fehler darin träfe jeden installierten Client auf einmal — ein Feed, der
# auf eine Datei zeigt, die es nicht gibt (oder die ein anderes sha512 hat),
# lässt jedes Update scheitern, ohne dass irgendwo etwas rot wird. Deshalb muss
# jede Abweichung VOR dem Hochladen auffallen, und der Feed darf dabei nie halb
# geschrieben werden.
#
# Die Prüfsummen stehen als feste Werte hier (mit Pythons hashlib berechnet,
# nicht mit dem Werkzeug des Skripts): ein Test, der seine Eingabe mit demselben
# Verfahren erzeugt, prüft nur, dass das Verfahren zu sich selbst passt.
#
# `--pruefen` (Fälle 20 bis 26) fragt die Adressen anonym per curl ab; hier
# antwortet eine curl-Attrappe, damit der Test weder Netz noch ein echtes
# Release braucht. Was die Attrappe NICHT zeigt: dass GitHub einen Entwurf
# anonym wirklich mit 404 beantwortet (steht so in der GitHub-Doku).
#
# Aufruf:  bash infra/release/tests/feed-auf-github-faelle.sh
set -euo pipefail

hier="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
skript="$hier/../feed-auf-github.sh"
arbeit="$(mktemp -d)"
trap 'rm -rf "$arbeit"' EXIT

# Inhalt → (sha512 base64, Größe). Vorgerechnet, s. Kopf.
INH_WIN='WIN-SETUP-0.1.101';            SHA_WIN='Bs/Vj/mtgUxJkZjoWJlWwc8SMvNnoHJu8MkabvG7ZGx7oyj+gWSiUrMxuc3EptbloEAcPStTnY9zmVHZ0FOPpg=='; GR_WIN=17
INH_SWIN='SERVER-WIN-SETUP-0.1.101';    SHA_SWIN='IUOlBCEWndAkHr0cs/HG2dBVD9/wKOcFFxw0viY/Oc9cCtLfuyBO3GbtuZG2xPnNh4bKeffgnmOvVDoySLcdoA=='; GR_SWIN=24
INH_MZIP='MAC-ZIP-0.1.101';             SHA_MZIP='J8FZoijyKSceWyRq7n5GeSz0Q1OqdPBqIGliYGWwuujCIlEmhnOnpUdFm2Kte8bhT0A41OIG0deSEy5QLeNCKg=='; GR_MZIP=15
INH_MDMG='MAC-DMG-0.1.101';             SHA_MDMG='PikTM8cpq1iH8tWLlcMxBwGepEqCzHRpWBxfsU90ZpmMTK/C6rA+5/3Bn84jErik31HkMQmDXyWNhXyDlL+BCQ=='; GR_MDMG=15
INH_SZIP='SRV-MAC-ZIP-0.1.101';         SHA_SZIP='V4hSx0I8poPsLDnzpj/qYqREqiMw6oHFcBkeR0f0vfY38xUqQZCPOe1DhNwICk7C2O43jIva3lZmEudemcZ+uQ=='; GR_SZIP=19
INH_SDMG='SRV-MAC-DMG-0.1.101';         SHA_SDMG='Zznud8ZCPkVM6q/nNklKTLVLPROB7UcI+htZajHHIpG6J66RPRft3VmemuXwnLT45B6E+MfYJZ5Bl76Rlm7uPA=='; GR_SDMG=19
# Zusätzlich die bekannte Antwort aus dem Lehrbuch: SHA-512("abc"), base64.
SHA_ABC='3a81oZNherrMQXNJriBBMRLm+k6JqX6iCp7u5ktV05ohkpkqJ0/BqDa6PCOj/uu9RU1EI2Q86A4qmslPpUyknw=='

B='https://github.com/o/r/releases/download/desktop-v0.1.101'

# curl-Attrappe. Antworten stehen in $CURL_ZUSTAND/antworten, eine je Zeile:
#   <URL><TAB><Größe>            antwortet mit dieser Content-Length
#   <URL><TAB>404                curl-Exit 22 (wie `-f` bei einem 404)
#   <URL><TAB>FLACKERT:<Größe>   erster Aufruf Exit 22, danach die Größe
mkdir -p "$arbeit/bin"
cat > "$arbeit/bin/curl" <<'STUB'
#!/usr/bin/env bash
z="$CURL_ZUSTAND"; echo "$*" >> "$z/aufrufe"
url="${*: -1}"
antwort="$(awk -F'\t' -v u="$url" '$1==u { print $2 }' "$z/antworten")"
[ -n "$antwort" ] || { echo "curl-attrappe: keine Antwort für $url" >&2; exit 6; }
case "$antwort" in
  404) exit 22 ;;
  FLACKERT:*)
    if [ ! -e "$z/flackert-erledigt" ]; then touch "$z/flackert-erledigt"; exit 22; fi
    printf '%s' "${antwort#FLACKERT:}" ;;
  *) printf '%s' "$antwort" ;;
esac
STUB
chmod +x "$arbeit/bin/curl"

fehler=0
ok()   { echo "✓ $1"; }
nein() { echo "✗ $1" >&2; fehler=1; }

# Frisches Arbeitsverzeichnis mit allen erfundenen Installern. Die Namen sind
# die, die electron-builder vergibt — auch der mit Leerzeichen.
neu() {
  local d="$arbeit/f$1"; mkdir -p "$d/release"
  printf '%s' "$INH_WIN"  > "$d/release/Pulse-Setup-0.1.101.exe"
  printf '%s' 'MAP'       > "$d/release/Pulse-Setup-0.1.101.exe.blockmap"
  printf '%s' "$INH_SWIN" > "$d/release/Pulse-Server-Setup-0.1.101.exe"
  printf '%s' "$INH_MZIP" > "$d/release/Pulse-0.1.101-arm64-mac.zip"
  printf '%s' 'MAP'       > "$d/release/Pulse-0.1.101-arm64-mac.zip.blockmap"
  printf '%s' "$INH_MDMG" > "$d/release/Pulse-0.1.101-arm64.dmg"
  printf '%s' "$INH_SZIP" > "$d/release/Pulse Server-0.1.101-arm64-mac.zip"
  printf '%s' 'MAP'       > "$d/release/Pulse Server-0.1.101-arm64-mac.zip.blockmap"
  printf '%s' "$INH_SDMG" > "$d/release/Pulse Server-0.1.101-arm64.dmg"
  echo "$d"
}

feed_win() {
cat <<EOF
version: 0.1.101
files:
  - url: Pulse-Setup-0.1.101.exe
    sha512: ${SHA_WIN}
    size: ${GR_WIN}
path: Pulse-Setup-0.1.101.exe
sha512: ${SHA_WIN}
releaseDate: '2026-10-12T23:45:42.163Z'
EOF
}
feed_swin() {
cat <<EOF
version: 0.1.101
files:
  - url: Pulse-Server-Setup-0.1.101.exe
    sha512: ${SHA_SWIN}
    size: ${GR_SWIN}
path: Pulse-Server-Setup-0.1.101.exe
sha512: ${SHA_SWIN}
releaseDate: '2026-10-12T23:58:06.178Z'
EOF
}
feed_mac() {
cat <<EOF
version: 0.1.101
files:
  - url: Pulse-0.1.101-arm64-mac.zip
    sha512: ${SHA_MZIP}
    size: ${GR_MZIP}
  - url: Pulse-0.1.101-arm64.dmg
    sha512: ${SHA_MDMG}
    size: ${GR_MDMG}
path: Pulse-0.1.101-arm64-mac.zip
sha512: ${SHA_MZIP}
releaseDate: '2026-10-12T23:47:38.653Z'
EOF
}
feed_smac() {
cat <<EOF
version: 0.1.101
files:
  - url: Pulse Server-0.1.101-arm64-mac.zip
    sha512: ${SHA_SZIP}
    size: ${GR_SZIP}
  - url: Pulse Server-0.1.101-arm64.dmg
    sha512: ${SHA_SDMG}
    size: ${GR_SDMG}
path: Pulse Server-0.1.101-arm64-mac.zip
sha512: ${SHA_SZIP}
releaseDate: '2026-10-12T23:42:11.246Z'
EOF
}

# lauf <Verzeichnis> <Argumente…> — Exit-Code des Skripts, Ausgabe nach <Verz>/ausgabe.
# Läuft IM Verzeichnis, weil das Skript seinen Arbeitsordner relativ anlegt.
lauf() {
  local d="$1"; shift
  ( cd "$d" && env GITHUB_REPOSITORY=o/r bash "$skript" "$@" ) > "$d/ausgabe" 2>&1
}
# pruefen <Verzeichnis> <Feed> — `--pruefen` mit der curl-Attrappe; die Antworten
# stehen vorher in <Verz>/curl/antworten.
pruefen() {
  local d="$1"; shift
  mkdir -p "$d/curl"
  ( cd "$d" && env PATH="$arbeit/bin:$PATH" CURL_ZUSTAND="$d/curl" FEED_PRUEFEN_PAUSE=0 \
      bash "$skript" --pruefen "$@" ) > "$d/ausgabe" 2>&1
}
# Arbeitsordner des Skripts dürfen nie liegen bleiben (Erfolg wie Abbruch).
sauber() { ! compgen -G "$1/.feed-auf-github.*" > /dev/null; }
# unveraendert <Datei> <Kopie> — Abbruch heißt: Byte für Byte wie vorher.
unveraendert() { cmp -s "$1" "$2"; }

# 1. Windows-Client.
d="$(neu 1)"; feed_win > "$d/latest.yml"
if lauf "$d" 0.1.101 latest.yml "Pulse-Setup-Windows.exe=$d/release/Pulse-Setup-0.1.101.exe" \
     "Pulse-Setup-Windows.exe.blockmap=$d/release/Pulse-Setup-0.1.101.exe.blockmap" \
   && [ "$(cat "$d/latest.yml")" = "$(cat <<EOF
version: 0.1.101
files:
  - url: ${B}/Pulse-Setup-Windows.exe
    sha512: ${SHA_WIN}
    size: ${GR_WIN}
path: ${B}/Pulse-Setup-Windows.exe
sha512: ${SHA_WIN}
releaseDate: '2026-10-12T23:45:42.163Z'
EOF
)" ] && sauber "$d"; then
  ok "Windows: url und path zeigen auf das Release, alles andere Byte für Byte wie vorher"
else nein "Windows: $(cat "$d/ausgabe"; cat "$d/latest.yml")"; fi
cp "$d/latest.yml" "$arbeit/fall1-ergebnis"

# 2. Windows-Server-App.
d="$(neu 2)"; feed_swin > "$d/latest.yml"
if lauf "$d" 0.1.101 latest.yml "Pulse-Server-Setup-Windows.exe=$d/release/Pulse-Server-Setup-0.1.101.exe" \
   && grep -qxF "  - url: ${B}/Pulse-Server-Setup-Windows.exe" "$d/latest.yml" \
   && grep -qxF "path: ${B}/Pulse-Server-Setup-Windows.exe" "$d/latest.yml" \
   && grep -qxF "    size: ${GR_SWIN}" "$d/latest.yml"; then
  ok "Windows-Server: eigener Name im Release"
else nein "Windows-Server: $(cat "$d/ausgabe"; cat "$d/latest.yml")"; fi

# 3. macOS-Client: zip UND dmg stehen im Feed, path ist das zip; die Blockmap
#    steht in der Angabe, aber nicht im Feed — das ist erlaubt.
d="$(neu 3)"; feed_mac > "$d/latest-mac.yml"
if lauf "$d" 0.1.101 latest-mac.yml \
     "Pulse-macOS.dmg=$d/release/Pulse-0.1.101-arm64.dmg" \
     "Pulse-macOS.zip=$d/release/Pulse-0.1.101-arm64-mac.zip" \
     "Pulse-macOS.zip.blockmap=$d/release/Pulse-0.1.101-arm64-mac.zip.blockmap" \
   && [ "$(cat "$d/latest-mac.yml")" = "$(cat <<EOF
version: 0.1.101
files:
  - url: ${B}/Pulse-macOS.zip
    sha512: ${SHA_MZIP}
    size: ${GR_MZIP}
  - url: ${B}/Pulse-macOS.dmg
    sha512: ${SHA_MDMG}
    size: ${GR_MDMG}
path: ${B}/Pulse-macOS.zip
sha512: ${SHA_MZIP}
releaseDate: '2026-10-12T23:47:38.653Z'
EOF
)" ] && sauber "$d"; then
  ok "macOS: zip und dmg zeigen auf ihre festen Namen, path ist das zip"
else nein "macOS: $(cat "$d/ausgabe"; cat "$d/latest-mac.yml")"; fi

# 4. macOS-Server-App: Leerzeichen in den Namen (im Feed, in der Datei, in der Angabe).
d="$(neu 4)"; feed_smac > "$d/latest-mac.yml"
if lauf "$d" 0.1.101 latest-mac.yml \
     "Pulse-Server-macOS.dmg=$d/release/Pulse Server-0.1.101-arm64.dmg" \
     "Pulse-Server-macOS.zip=$d/release/Pulse Server-0.1.101-arm64-mac.zip" \
     "Pulse-Server-macOS.zip.blockmap=$d/release/Pulse Server-0.1.101-arm64-mac.zip.blockmap" \
   && [ "$(cat "$d/latest-mac.yml")" = "$(cat <<EOF
version: 0.1.101
files:
  - url: ${B}/Pulse-Server-macOS.zip
    sha512: ${SHA_SZIP}
    size: ${GR_SZIP}
  - url: ${B}/Pulse-Server-macOS.dmg
    sha512: ${SHA_SDMG}
    size: ${GR_SDMG}
path: ${B}/Pulse-Server-macOS.zip
sha512: ${SHA_SZIP}
releaseDate: '2026-10-12T23:42:11.246Z'
EOF
)" ] && sauber "$d"; then
  ok "macOS-Server: Namen mit Leerzeichen werden zugeordnet und ersetzt"
else nein "macOS-Server: $(cat "$d/ausgabe"; cat "$d/latest-mac.yml")"; fi

# 5. Gleich große Datei mit anderem Inhalt: nur das sha512 kann es merken.
d="$(neu 5)"; feed_win > "$d/latest.yml"; cp "$d/latest.yml" "$d/vorher"
printf '%s' 'WIN-SETUP-0.1.102' > "$d/release/Pulse-Setup-0.1.101.exe"
if ! lauf "$d" 0.1.101 latest.yml "Pulse-Setup-Windows.exe=$d/release/Pulse-Setup-0.1.101.exe" \
   && grep -q "sha512 weicht ab" "$d/ausgabe" && unveraendert "$d/latest.yml" "$d/vorher" && sauber "$d"; then
  ok "falsches sha512 (gleiche Größe): Abbruch, Feed unverändert"
else nein "falsches sha512: $(cat "$d/ausgabe")"; fi

# 6. Richtiges sha512, falsche Größe im Feed.
d="$(neu 6)"; feed_win | sed "s/size: ${GR_WIN}/size: 18/" > "$d/latest.yml"; cp "$d/latest.yml" "$d/vorher"
if ! lauf "$d" 0.1.101 latest.yml "Pulse-Setup-Windows.exe=$d/release/Pulse-Setup-0.1.101.exe" \
   && grep -q "Größe weicht ab" "$d/ausgabe" && unveraendert "$d/latest.yml" "$d/vorher"; then
  ok "falsche Größe: Abbruch, Feed unverändert"
else nein "falsche Größe: $(cat "$d/ausgabe")"; fi

# 7. Der dmg-Eintrag hat keine Zuordnung. Das zip allein umzuschreiben wäre
#    gefährlicher als gar nichts: der Feed zeigte dann zur Hälfte nach netcup.
d="$(neu 7)"; feed_mac > "$d/latest-mac.yml"; cp "$d/latest-mac.yml" "$d/vorher"
if ! lauf "$d" 0.1.101 latest-mac.yml "Pulse-macOS.zip=$d/release/Pulse-0.1.101-arm64-mac.zip" \
   && grep -q "Pulse-0.1.101-arm64.dmg' im Feed hat keine Zuordnung" "$d/ausgabe" && unveraendert "$d/latest-mac.yml" "$d/vorher"; then
  ok "Eintrag ohne Zuordnung: Abbruch, Feed unverändert (auch das zugeordnete zip)"
else nein "fehlende Zuordnung: $(cat "$d/ausgabe")"; fi

# 8. Version im Feed ≠ übergebene Version.
d="$(neu 8)"; feed_win > "$d/latest.yml"; cp "$d/latest.yml" "$d/vorher"
if ! lauf "$d" 0.1.102 latest.yml "Pulse-Setup-Windows.exe=$d/release/Pulse-Setup-0.1.101.exe" \
   && grep -q "nennt Version '0.1.101', übergeben wurde '0.1.102'" "$d/ausgabe" && unveraendert "$d/latest.yml" "$d/vorher"; then
  ok "Versionskonflikt: Abbruch, Feed unverändert"
else nein "Versionskonflikt: $(cat "$d/ausgabe")"; fi

# 9. Zweiter Lauf auf einen schon umgeschriebenen Feed.
d="$(neu 9)"; cp "$arbeit/fall1-ergebnis" "$d/latest.yml"; cp "$d/latest.yml" "$d/vorher"
if ! lauf "$d" 0.1.101 latest.yml "Pulse-Setup-Windows.exe=$d/release/Pulse-Setup-0.1.101.exe" \
   && grep -q "schon eine absolute Adresse" "$d/ausgabe" && unveraendert "$d/latest.yml" "$d/vorher"; then
  ok "bereits umgeschrieben: Abbruch, Feed unverändert"
else nein "bereits umgeschrieben: $(cat "$d/ausgabe")"; fi

# 10. Die lokale Datei fehlt.
d="$(neu 10)"; feed_win > "$d/latest.yml"; cp "$d/latest.yml" "$d/vorher"
if ! lauf "$d" 0.1.101 latest.yml "Pulse-Setup-Windows.exe=$d/release/gibts-nicht.exe" \
   && grep -q "Datei fehlt" "$d/ausgabe" && unveraendert "$d/latest.yml" "$d/vorher"; then
  ok "fehlende lokale Datei: Abbruch, Feed unverändert"
else nein "fehlende Datei: $(cat "$d/ausgabe")"; fi

# 11. path: nennt etwas, das nicht unter files: steht.
d="$(neu 11)"; feed_win | sed 's/^path: .*/path: Pulse-Setup-0.1.100.exe/' > "$d/latest.yml"; cp "$d/latest.yml" "$d/vorher"
if ! lauf "$d" 0.1.101 latest.yml "Pulse-Setup-Windows.exe=$d/release/Pulse-Setup-0.1.101.exe" \
   && grep -q "keiner der Einträge unter files:" "$d/ausgabe" && unveraendert "$d/latest.yml" "$d/vorher"; then
  ok "path: außerhalb von files: → Abbruch, Feed unverändert"
else nein "path außerhalb: $(cat "$d/ausgabe")"; fi

# 12. Das sha512 über path: gehört zu einer anderen Datei als der Eintrag.
d="$(neu 12)"; feed_win | sed "s#^sha512: .*#sha512: ${SHA_ABC}#" > "$d/latest.yml"; cp "$d/latest.yml" "$d/vorher"
if ! lauf "$d" 0.1.101 latest.yml "Pulse-Setup-Windows.exe=$d/release/Pulse-Setup-0.1.101.exe" \
   && grep -q "sha512 über path: weicht" "$d/ausgabe" && unveraendert "$d/latest.yml" "$d/vorher"; then
  ok "sha512 über path: weicht vom Eintrag ab → Abbruch, Feed unverändert"
else nein "path-sha512: $(cat "$d/ausgabe")"; fi

# 13. Kaputte Aufrufe: nichts davon darf den Feed anfassen.
d="$(neu 13)"; feed_win > "$d/latest.yml"; cp "$d/latest.yml" "$d/vorher"
exe="$d/release/Pulse-Setup-0.1.101.exe"
if ! lauf "$d" '' latest.yml "Pulse-Setup-Windows.exe=$exe" \
   && ! lauf "$d" 0.1 latest.yml "Pulse-Setup-Windows.exe=$exe" \
   && ! lauf "$d" 0.1.101 gibts-nicht.yml "Pulse-Setup-Windows.exe=$exe" \
   && ! lauf "$d" 0.1.101 latest.yml \
   && ! lauf "$d" 0.1.101 latest.yml "$exe" \
   && ! lauf "$d" 0.1.101 latest.yml "a b=$exe" \
   && ! lauf "$d" 0.1.101 latest.yml "Pulse-Setup-Windows.exe=$exe" "Pulse-Setup-Windows.exe=$exe" \
   && ! ( cd "$d" && env -u GITHUB_REPOSITORY bash "$skript" 0.1.101 latest.yml "Pulse-Setup-Windows.exe=$exe" ) >/dev/null 2>&1 \
   && ! ( cd "$d" && env GITHUB_REPOSITORY='ohne-schraegstrich' bash "$skript" 0.1.101 latest.yml "Pulse-Setup-Windows.exe=$exe" ) >/dev/null 2>&1 \
   && unveraendert "$d/latest.yml" "$d/vorher" && sauber "$d"; then
  ok "ungültige Aufrufe (Version, Feed, Angaben, Repo) werden abgewiesen, Feed unverändert"
else nein "ungültige Aufrufe: $(cat "$d/ausgabe")"; fi

# 14. Windows-Zeilenenden im Feed: wird gelesen, Ergebnis ist LF (wie Fall 1).
d="$(neu 14)"; feed_win | sed 's/$/\r/' > "$d/latest.yml"
if lauf "$d" 0.1.101 latest.yml "Pulse-Setup-Windows.exe=$d/release/Pulse-Setup-0.1.101.exe" \
   && unveraendert "$d/latest.yml" "$arbeit/fall1-ergebnis"; then
  ok "CRLF-Feed: gelesen, geschrieben mit LF"
else nein "CRLF: $(cat "$d/ausgabe")"; fi

# 15. Ein Feed ohne path: (electron-builder kann es künftig weglassen) wird umgeschrieben.
d="$(neu 15)"; feed_win | grep -v '^path:' > "$d/latest.yml"
if lauf "$d" 0.1.101 latest.yml "Pulse-Setup-Windows.exe=$d/release/Pulse-Setup-0.1.101.exe" \
   && grep -qxF "  - url: ${B}/Pulse-Setup-Windows.exe" "$d/latest.yml" && ! grep -q '^path:' "$d/latest.yml"; then
  ok "Feed ohne path: wird trotzdem umgeschrieben"
else nein "ohne path: $(cat "$d/ausgabe")"; fi

# 16. Namen in Anführungszeichen (YAML darf das).
d="$(neu 16)"; feed_smac | sed -e "s/url: \(Pulse Server-[^ ]*\)\$/url: '\1'/" -e "s/^path: \(.*\)\$/path: \"\1\"/" > "$d/latest-mac.yml"
if lauf "$d" 0.1.101 latest-mac.yml \
     "Pulse-Server-macOS.dmg=$d/release/Pulse Server-0.1.101-arm64.dmg" \
     "Pulse-Server-macOS.zip=$d/release/Pulse Server-0.1.101-arm64-mac.zip" \
   && grep -qxF "  - url: ${B}/Pulse-Server-macOS.zip" "$d/latest-mac.yml" \
   && grep -qxF "path: ${B}/Pulse-Server-macOS.zip" "$d/latest-mac.yml"; then
  ok "Namen in Anführungszeichen werden gelesen"
else nein "Anführungszeichen: $(cat "$d/ausgabe"; cat "$d/latest-mac.yml")"; fi

# 17. Zwei Angaben mit demselben Dateinamen aus verschiedenen Ordnern: der Feed
#     kann nicht sagen, welche gemeint ist.
d="$(neu 17)"; feed_win > "$d/latest.yml"; cp "$d/latest.yml" "$d/vorher"
mkdir -p "$d/zweit"; cp "$d/release/Pulse-Setup-0.1.101.exe" "$d/zweit/"
if ! lauf "$d" 0.1.101 latest.yml "Pulse-Setup-Windows.exe=$d/release/Pulse-Setup-0.1.101.exe" \
     "Pulse-Setup-Zweit.exe=$d/zweit/Pulse-Setup-0.1.101.exe" \
   && grep -q "passt auf mehrere Angaben" "$d/ausgabe" && unveraendert "$d/latest.yml" "$d/vorher"; then
  ok "mehrdeutige Zuordnung: Abbruch, Feed unverändert"
else nein "mehrdeutig: $(cat "$d/ausgabe")"; fi

# 18. Ein Listeneintrag, der nicht mit url: beginnt, ist eine Form, die das Skript
#     nicht kennt — lieber Abbruch als stilles Überspringen.
d="$(neu 18)"; feed_win | sed 's/^  - url: \(.*\)$/  - sha512: x\n    url: \1/' > "$d/latest.yml"; cp "$d/latest.yml" "$d/vorher"
if ! lauf "$d" 0.1.101 latest.yml "Pulse-Setup-Windows.exe=$d/release/Pulse-Setup-0.1.101.exe" \
   && grep -q "beginnt nicht mit url:" "$d/ausgabe" && unveraendert "$d/latest.yml" "$d/vorher"; then
  ok "unbekannte Eintragsform: Abbruch, Feed unverändert"
else nein "unbekannte Form: $(cat "$d/ausgabe")"; fi

# 19. Bekannte Antwort: SHA-512("abc") steht fest im Lehrbuch. Beweist, dass das
#     Skript base64 des ROHEN Digests vergleicht (nicht Hex, nicht mit Zeilenumbruch).
d="$(neu 19)"; printf '%s' abc > "$d/release/abc.bin"
printf 'version: 0.1.101\nfiles:\n  - url: abc.bin\n    sha512: %s\n    size: 3\npath: abc.bin\nsha512: %s\n' "$SHA_ABC" "$SHA_ABC" > "$d/latest.yml"
if lauf "$d" 0.1.101 latest.yml "Pulse-X.bin=$d/release/abc.bin" \
   && grep -qxF "path: ${B}/Pulse-X.bin" "$d/latest.yml"; then
  ok "bekannte Antwort SHA-512(\"abc\") stimmt mit dem Digest des Skripts überein"
else nein "bekannte Antwort: $(cat "$d/ausgabe")"; fi

# ── --pruefen ───────────────────────────────────────────────────────────────

# 20. Alle Adressen abrufbar, Größen stimmen: grün. Der Aufruf ist `curl -fsIL`
#     (Kopfabfrage, folgt Weiterleitungen, Fehler bei 4xx) ohne jeden Zugang.
d="$(neu 20)"; cp "$arbeit/fall1-ergebnis" "$d/latest.yml"; mkdir -p "$d/curl"
printf '%s\t%s\n' "${B}/Pulse-Setup-Windows.exe" "$GR_WIN" > "$d/curl/antworten"
if pruefen "$d" latest.yml \
   && [ "$(wc -l < "$d/curl/aufrufe" | tr -d ' ')" = 1 ] \
   && grep -q -- "-fsIL" "$d/curl/aufrufe" && grep -qF -- "${B}/Pulse-Setup-Windows.exe" "$d/curl/aufrufe" \
   && ! grep -qiE -- "authorization|--header| -H |--user| -u |token" "$d/curl/aufrufe"; then
  ok "--pruefen: Adresse abrufbar, Größe stimmt, anonymer Aufruf"
else nein "--pruefen ok: $(cat "$d/ausgabe"; cat "$d/curl/aufrufe" 2>&1)"; fi

# 21. Content-Length weicht von size: ab (falsche Datei im Release).
d="$(neu 21)"; cp "$arbeit/fall1-ergebnis" "$d/latest.yml"; mkdir -p "$d/curl"
printf '%s\t%s\n' "${B}/Pulse-Setup-Windows.exe" "$((GR_WIN + 1))" > "$d/curl/antworten"
if ! pruefen "$d" latest.yml && grep -q "weicht von size" "$d/ausgabe" \
   && [ "$(wc -l < "$d/curl/aufrufe" | tr -d ' ')" = 3 ]; then
  ok "--pruefen: falsche Größe → Abbruch (nach drei Versuchen)"
else nein "--pruefen Größe: $(cat "$d/ausgabe")"; fi

# 22. 404 (Entwurf, privates Repo, falscher Eigentümer).
d="$(neu 22)"; cp "$arbeit/fall1-ergebnis" "$d/latest.yml"; mkdir -p "$d/curl"
printf '%s\t%s\n' "${B}/Pulse-Setup-Windows.exe" 404 > "$d/curl/antworten"
if ! pruefen "$d" latest.yml && grep -q "nicht anonym abrufbar (curl-Exit 22)" "$d/ausgabe"; then
  ok "--pruefen: 404 → Abbruch mit Hinweis auf Entwurf/privat/Eigentümer"
else nein "--pruefen 404: $(cat "$d/ausgabe")"; fi

# 23. Der Feed wurde nie umgeschrieben (relative Adressen): Abbruch, ohne dass
#     curl auch nur gestartet wird.
d="$(neu 23)"; feed_win > "$d/latest.yml"; mkdir -p "$d/curl"; : > "$d/curl/antworten"
if ! pruefen "$d" latest.yml && grep -q "keine https-Adresse" "$d/ausgabe" && [ ! -s "$d/curl/aufrufe" ]; then
  ok "--pruefen: nicht umgeschriebener Feed → Abbruch ohne Abfrage"
else nein "--pruefen relativ: $(cat "$d/ausgabe")"; fi

# 24. Ein Aussetzer beim ersten Versuch ist kein Abbruchgrund.
d="$(neu 24)"; cp "$arbeit/fall1-ergebnis" "$d/latest.yml"; mkdir -p "$d/curl"
printf '%s\tFLACKERT:%s\n' "${B}/Pulse-Setup-Windows.exe" "$GR_WIN" > "$d/curl/antworten"
if pruefen "$d" latest.yml && [ "$(wc -l < "$d/curl/aufrufe" | tr -d ' ')" = 2 ]; then
  ok "--pruefen: erster Versuch scheitert, zweiter geht durch"
else nein "--pruefen Aussetzer: $(cat "$d/ausgabe")"; fi

# 25. macOS: BEIDE Einträge (zip und dmg) werden abgefragt, und die falsche
#     Größe des zweiten genügt zum Abbruch.
d="$(neu 25)"; feed_mac > "$d/latest-mac.yml"
lauf "$d" 0.1.101 latest-mac.yml "Pulse-macOS.dmg=$d/release/Pulse-0.1.101-arm64.dmg" \
  "Pulse-macOS.zip=$d/release/Pulse-0.1.101-arm64-mac.zip" > /dev/null
mkdir -p "$d/curl"
printf '%s\t%s\n%s\t%s\n' "${B}/Pulse-macOS.zip" "$GR_MZIP" "${B}/Pulse-macOS.dmg" "$GR_MDMG" > "$d/curl/antworten"
ok_zwei=0; pruefen "$d" latest-mac.yml && [ "$(wc -l < "$d/curl/aufrufe" | tr -d ' ')" = 2 ] && ok_zwei=1
rm -f "$d/curl/aufrufe"
printf '%s\t%s\n%s\t%s\n' "${B}/Pulse-macOS.zip" "$GR_MZIP" "${B}/Pulse-macOS.dmg" "$((GR_MDMG - 1))" > "$d/curl/antworten"
if [ "$ok_zwei" = 1 ] && ! pruefen "$d" latest-mac.yml && grep -q "Pulse-macOS.dmg" "$d/ausgabe"; then
  ok "--pruefen macOS: zip und dmg werden abgefragt, die falsche Größe des dmg bricht ab"
else nein "--pruefen mac: $(cat "$d/ausgabe")"; fi

# 26. Aufruf ohne Feed / mit fehlender Datei.
d="$(neu 26)"
if ! pruefen "$d" && ! pruefen "$d" gibts-nicht.yml; then
  ok "--pruefen: fehlender Feed wird abgewiesen"
else nein "--pruefen ohne Feed: $(cat "$d/ausgabe")"; fi

[ "$fehler" = 0 ] && echo "✓ feed-auf-github: alle Fälle wie erwartet" || exit 1
