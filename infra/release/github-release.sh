#!/usr/bin/env bash
# Legt Dateien einer Pulse-Version als GitHub-Release ab — aufgerufen von den
# Bau-Workflows (win-build, win-build-server, mac-build, android-build).
#
#   bash infra/release/github-release.sh <version> <Zielname>=<Datei> [...]
#
# Ein Release je Desktop-Version (Tag `desktop-v<version>`, Version aus
# desktop/package.json), in dem ALLE Downloads unter FESTEN Namen liegen:
# Pulse-Setup-Windows.exe, Pulse-macOS.dmg, Pulse-Android.apk, … Feste Namen,
# weil die Download-Links dann über GitHubs
# `releases/latest/download/<Name>` auf die jeweils neueste Fassung zeigen,
# ohne dass irgendwer die Versionsnummer kennen muss.
#
# Die Workflows laufen parallel; wer zuerst kommt, legt das Release an, die
# anderen hängen ihre Dateien an. Ein `create`, das scheitert, weil ein anderer
# Lauf schneller war, ist deshalb kein Fehler.
#
# Ein Neubau derselben Version ERSETZT die Dateien (wie bisher auf dem netcup-
# Server) — und zwar die, auf die der Update-Feed der installierten Apps zeigt.
# `gh release upload --clobber` löscht das alte Asset zuerst und lädt dann hoch
# (gh, pkg/cmd/release/shared/upload.go: uploadWithDelete); bei 337 MB bekäme
# jeder Client, der in dieser Zeit prüft, ein 404. Deshalb:
#   1. die neue Fassung unter einem Zwischennamen hochladen
#      (`<Name>.neu-<Lauf>-<PID>`; die alte wird währenddessen weiter ausgeliefert),
#   2. die Asset-ID der Zwischendatei lesen (bleibt beim Umbenennen gleich),
#   3. die alte löschen,
#   4. die Zwischendatei per Asset-API in den Endnamen umbenennen.
# Die Lücke, in der der Name fehlt (404, auch für `releases/latest/download/…`),
# ist damit der Abstand zwischen 3 und 4: im Normalfall EIN API-Aufruf (das
# Umbenennen), bei Aussetzern mit Wiederholungen länger, statt der Dauer des
# Uploads — aber nicht null.
#
# Jeder Aufruf zwischen dem Zwischen-Upload und der Fertigstellung (Auflistung lesen,
# alte löschen, umbenennen, Zustand lesen) wird wiederholt (drei- bis viermal, Pause
# GITHUB_RELEASE_PAUSE), und vor jedem Folgeschritt wird der Ist-Zustand des
# Releases neu gelesen, statt dem Exit-Code zu glauben: ein Aufruf kann
# serverseitig gelungen sein und die Antwort verloren gehen. NICHT wiederholt
# werden der Zwischen-Upload selbst (gh wiederholt Netzfehler und 5xx intern), der
# Upload einer neuen Datei, die Dateiliste (`gh release view`), die APK-Übernahme
# und `gh release edit --latest`; keiner davon liegt in der Lücke. Löschen gilt als gelungen, wenn der Name danach fehlt;
# Umbenennen, wenn der Endname die ID der Zwischendatei trägt. Gelöscht wird unter
# dem Endnamen nur ein Asset mit ANDERER ID (z. B. die Übernahme einer alten APK
# durch einen anderen Lauf; die frisch gebaute gewinnt). Erschöpfen sich die
# Versuche beim Umbenennen, lädt das Skript als letzten Ausweg die Datei direkt
# unter dem Endnamen hoch (dauert so lange wie der Upload, heilt aber in diesem
# Lauf).
#
# Was bei einem Abbruch im Release liegt:
#   - vor jedem Löschversuch (Upload scheitert, ID nicht lesbar): die ALTE Datei
#     ist sicher noch da und bleibt; die Zwischendatei wird weggeräumt, soweit
#     erreichbar, sonst räumt sie der nächste Lauf;
#   - das Löschen der alten Datei scheitert: ob es doch gewirkt hat (Antwort
#     verloren, Lesen hinkt hinterher), lässt sich nicht sicher sagen. Die
#     Zwischendatei bleibt deshalb LIEGEN: lieber eine überzählige Datei als ein
#     leeres Release. Der nächste Lauf lädt seinen eigenen Bau hoch (unter dem
#     Endnamen, falls der fehlt) und räumt die Zwischendatei weg;
#   - nach dem Löschen und erschöpften Versuchen, auch dem letzten Ausweg: kann
#     der Release gelesen werden, FEHLT der Endname (404 für Update-Clients und
#     `latest/download`) und die neue Fassung liegt als Zwischendatei dort; kann
#     er nicht gelesen werden, sagt die Meldung "Zustand UNBEKANNT" (der Endname
#     kann fehlen oder, wenn das Umbenennen gewirkt hat, schon richtig da sein).
#     Die Meldung nennt den zuletzt gelesenen Stand. Der Workflow ist rot; der
#     nächste Lauf stellt den Namen her und räumt die Zwischendatei weg. Bei der
#     Windows-Server-App kommt der nächste Lauf mit dem nächsten Backend-Push,
#     beim Client nur von Hand.
# Rechte: Löschen und Umbenennen eines Assets verlangen wie das Hochladen
# „Contents: write“ (REST-Doku „Update a release asset“ / „Delete a release
# asset“), also reicht das GITHUB_TOKEN mit `contents: write`, das die Workflows
# ohnehin haben.
#
# Android baut nur, wenn sich mobile/ ändert — ein NEUES Release übernimmt die
# APK deshalb aus dem jüngsten Vorgänger, sonst fehlte sie nach jedem
# Versionssprung bis zum nächsten Android-Bau.
#
# „Latest“ (worauf `releases/latest/download/…` zeigt) wird ein Release erst,
# wenn ALLE Downloads drin sind und es die höchste Version ist — nicht beim
# Anlegen: sonst führten die Links ins Leere, solange die anderen Bauten noch
# laufen, und nach einem gescheiterten Bau dauerhaft. Bis dahin bleibt der
# vollständige Vorgänger Latest.
#
# Braucht: gh (auf allen GitHub-Runnern vorinstalliert), GH_TOKEN mit
# contents:write, GITHUB_REPOSITORY, GITHUB_SHA.
set -euo pipefail

UEBERNEHMEN=(Pulse-Android.apk)
VOLLSTAENDIG=(Pulse-Setup-Windows.exe Pulse-Server-Setup-Windows.exe Pulse-macOS.dmg
              Pulse-Server-macOS.dmg Pulse-Android.apk)

die() { echo "github-release: $*" >&2; exit 1; }

version="${1:-}"
shift || true
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "keine gültige Version: '${version}'"
[ $# -gt 0 ] || die "keine Dateien angegeben (<Zielname>=<Datei>)"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY fehlt}"
: "${GITHUB_SHA:?GITHUB_SHA fehlt}"
repo="$GITHUB_REPOSITORY"
tag="desktop-v${version}"

# Erst alle Eingaben prüfen, dann das Release anfassen — ein Tippfehler im
# Workflow soll kein halbes Release hinterlassen.
# Relativ zum Checkout, nicht unter /tmp: unter Windows (Git Bash) hängt die
# Übersetzung absoluter POSIX-Pfade für gh.exe an der Heuristik von MSYS,
# relative Pfade brauchen keine Übersetzung.
arbeit="$(mktemp -d ./.github-release.XXXXXX)"
trap 'rm -rf "$arbeit"' EXIT
mkdir -p "$arbeit/hoch" "$arbeit/alt"
for paar in "$@"; do
  name="${paar%%=*}"
  datei="${paar#*=}"
  [ -n "$name" ] && [ "$name" != "$paar" ] || die "Angabe ohne '=': '$paar'"
  [[ "$name" =~ ^[A-Za-z0-9._-]+$ ]] || die "Zielname mit unerlaubten Zeichen: '$name'"
  [ -f "$datei" ] || die "Datei fehlt: '$datei' (für $name)"
  cp "$datei" "$arbeit/hoch/$name"
done

notizen() {
  cat <<EOF
Pulse ${version}

**Downloads**
- Windows: \`Pulse-Setup-Windows.exe\` — updates itself. On first launch SmartScreen asks: "More info" → "Run anyway".
- macOS (Apple Silicon): \`Pulse-macOS.dmg\`
- Android: \`Pulse-Android.apk\` — allow "Install from unknown sources" during installation.
- Linux: Flatpak from https://howispulse.com/flatpak/com.howispulse.Pulse.flatpakref

**Pulse Server app** (your own server on your computer)
- Windows: \`Pulse-Server-Setup-Windows.exe\` · macOS: \`Pulse-Server-macOS.dmg\`
- Linux: Flatpak from https://howispulse.com/flatpak/com.howispulse.PulseServer.flatpakref

Self-hosting on a server: Docker image \`ghcr.io/oblivion-pictures/pulse\`, guide at https://howispulse.com/self-host/guide

Built from \`main\`. A rebuild of the same version replaces the files here. Files ending in \`.zip\` and \`.blockmap\` are not needed for installing.
EOF
}

if ! gh release view "$tag" --repo "$repo" >/dev/null 2>&1; then
  notizen > "$arbeit/notizen.md"
  if gh release create "$tag" --repo "$repo" --target "$GITHUB_SHA" \
       --title "Pulse ${version}" --notes-file "$arbeit/notizen.md" --latest=false; then
    echo "github-release: ${tag} angelegt"
  elif gh release view "$tag" --repo "$repo" >/dev/null 2>&1; then
    echo "github-release: ${tag} hat ein paralleler Lauf angelegt — hänge an"
  else
    die "konnte ${tag} nicht anlegen"
  fi
fi

# Alle Desktop-Releases, neueste Anlage zuerst. Gefiltert wird hier, nicht per
# --jq: fremde Tags (Self-Host `v1.0.0`) stehen in derselben Liste.
desktop_tags() {
  gh release list --repo "$repo" --limit 100 --json tagName --jq '.[].tagName' \
    | tr -d '\r' | grep '^desktop-v' || true
}
dateien_von() {  # dateien_von <tag>
  gh release view "$1" --repo "$repo" --json assets --jq '.assets[].name' | tr -d '\r'
}

PAUSE="${GITHUB_RELEASE_PAUSE:-2}"   # Sekunden zwischen Wiederholungen (Tests: 0)

# Alle Assets des Release als Zeilen "<numerische REST-ID> <Name>"; Exit-Code != 0,
# wenn gh scheitert (ein leeres Release ist KEIN Fehler). `gh release view --json
# assets` liefert nur die GraphQL-ID, die der REST-Umbenennung nicht genügt.
# Kein führender Schrägstrich im Pfad: die Git Bash unter Windows würde ihn in
# einen Dateipfad umdeuten. Der zuletzt gelesene Stand bleibt in $arbeit/liste,
# damit eine Fehlermeldung ihn nennen kann.
assets_gelistet() {
  local o
  o="$(gh api "repos/${repo}/releases/tags/${tag}" --jq '.assets[] | "\(.id) \(.name)"' | tr -d '\r')" || return 1
  printf '%s\n' "$o" | tee "$arbeit/liste"
}
id_in() {  # id_in <Auflistung> <Name> — ID des Assets, leer wenn es keins dieses Namens gibt
  awk -v n="$2" '$2 == n { print $1; exit }' <<<"$1"
}
asset_weg() {  # asset_weg <name> — löscht ein Asset; Exit-Code von gh
  gh release delete-asset "$tag" "$1" --repo "$repo" --yes
}
wiederholt() {  # wiederholt <Versuche> <Befehl…> — 0, sobald ein Versuch gelingt
  local max="$1" i=1
  shift
  until "$@"; do
    [ "$i" -lt "$max" ] || return 1
    i=$((i + 1)); sleep "$PAUSE"
  done
}
zwischen_weg() {  # Zwischendatei wegräumen, soweit erreichbar (sonst räumt sie der nächste Lauf)
  wiederholt 3 asset_weg "$1" > /dev/null 2>&1 || true
}
stand() {  # zuletzt gelesener Stand des Release, für Fehlermeldungen
  if [ -s "$arbeit/liste" ]; then awk '{ printf "%s ", $2 }' "$arbeit/liste"; else printf '(nicht lesbar)'; fi
}

# Ersetzt ein vorhandenes Asset. Die Lücke, in der der Name fehlt, ist im Normalfall
# ein API-Aufruf lang, beim letzten Ausweg so lang wie ein Upload (Begründung und
# Abbruchverhalten im Kopf).
ersetzen() {  # ersetzen <name>
  local name="$1" zwischen="$1.neu-${GITHUB_RUN_ID:-lokal}-$$" liste id_neu
  mkdir -p "$arbeit/neu"
  cp "$arbeit/hoch/$name" "$arbeit/neu/$zwischen"
  if ! gh release upload "$tag" --repo "$repo" "$arbeit/neu/$zwischen"; then
    zwischen_weg "$zwischen"
    die "konnte ${name} nicht unter dem Zwischennamen hochladen — die alte Datei bleibt"
  fi
  # Ab hier liegt die neue Fassung im Release, die alte wird noch ausgeliefert.
  # Die ID der Zwischendatei jetzt lesen, nicht erst in der Lücke: sie ändert sich
  # durch Löschen und Umbenennen nicht, und scheitert das Lesen, ist noch nichts
  # verloren.
  # Direkt nach dem Hochladen kann ein Lesevorgang die Zwischendatei noch nicht
  # kennen (Verzug): "gelesen UND gelistet" gehört deshalb in die Wiederholung.
  zwischen_sichtbar() {
    local l
    l="$(assets_gelistet)" || return 1
    [ -n "$(id_in "$l" "$zwischen")" ]
  }
  if ! wiederholt 3 zwischen_sichtbar; then
    zwischen_weg "$zwischen"
    die "konnte den Stand des Release nicht lesen (oder die Zwischendatei erscheint nicht) — die alte ${name} bleibt, die Zwischendatei ist weggeräumt, soweit erreichbar"
  fi
  liste="$(cat "$arbeit/liste")"
  id_neu="$(id_in "$liste" "$zwischen")"

  alt_loeschen() {
    asset_weg "$name" && return 0
    # Gescheitert oder Antwort verloren? Der Ist-Zustand entscheidet: fehlt der Name, ist er weg.
    local l
    l="$(assets_gelistet)" || return 1
    [ -z "$(id_in "$l" "$name")" ]
  }
  if [ -n "$(id_in "$liste" "$name")" ] && ! wiederholt 3 alt_loeschen; then
    # KEIN zwischen_weg: hat das Löschen trotz Fehlermeldung gewirkt (Antwort
    # verloren) und hinkt das Lesen hinterher, wäre die Zwischendatei die einzige
    # Kopie. Bleibt die alte wirklich, ist eine überzählige Zwischendatei harmlos;
    # der nächste Lauf räumt sie weg.
    die "konnte die alte ${name} nicht sicher löschen — ob sie noch da ist, ist unklar (zuletzt gelesen: $(stand)). Die Zwischendatei ${zwischen} bleibt liegen; der nächste Lauf lädt ${name} neu hoch, falls er fehlt, und räumt die Zwischendatei weg"
  fi

  umbenennen() {
    gh api --method PATCH "repos/${repo}/releases/assets/${id_neu}" -f "name=${name}" > /dev/null && return 0
    # Gescheitert oder Antwort verloren? Tragen wir den Endnamen schon, war es gelungen.
    local l id_n
    l="$(assets_gelistet)" || return 1
    id_n="$(id_in "$l" "$name")"
    [ "$id_n" = "$id_neu" ] && return 0
    # Eine Datei gleichen Namens mit ANDERER ID hat ein anderer Lauf angelegt (z. B.
    # die Übernahme einer alten APK, s. unten): die gilt als alt, die frisch
    # gebaute gewinnt. Die eigene (gleiche ID) wird nie gelöscht.
    if [ -n "$id_n" ]; then asset_weg "$name" > /dev/null 2>&1 || true; fi
    return 1
  }
  if wiederholt 4 umbenennen; then
    echo "github-release: ${name} ersetzt (über ${zwischen})"
    return 0
  fi

  # Letzter Ausweg: unter dem Endnamen neu hochladen. Dauert so lange wie der
  # Upload, stellt den Namen aber noch in diesem Lauf her. Vorher einmal lesen:
  # trägt der Endname die ID der Zwischendatei, hat das Umbenennen gewirkt (Antwort
  # verloren, frühere Lesevorgänge gescheitert) und alles ist in Ordnung.
  gelesen=nein
  if liste="$(assets_gelistet)"; then gelesen=ja; else liste=""; fi
  if [ "$gelesen" = ja ] && [ "$(id_in "$liste" "$name")" = "$id_neu" ]; then
    echo "github-release: ${name} ersetzt (über ${zwischen}, Umbenennen nachträglich bestätigt)"
    return 0
  fi
  if [ -z "$(id_in "$liste" "$name")" ] \
     && gh release upload "$tag" --repo "$repo" "$arbeit/hoch/$name"; then
    zwischen_weg "$zwischen"
    echo "github-release: ${name} nach erschöpften Umbenennungen direkt unter dem Endnamen hochgeladen"
    return 0
  fi
  if [ "$gelesen" = ja ]; then
    die "konnte ${zwischen} nicht in ${name} umbenennen und ${name} auch nicht neu hochladen — ${name} FEHLT jetzt im Release oder gehört zu einer anderen Fassung (404 für Update-Clients und latest/download), die neue Fassung liegt als ${zwischen}. Zuletzt gelesener Stand: $(stand). Der nächste Lauf stellt ${name} her und räumt die Zwischendatei weg."
  fi
  die "konnte ${zwischen} nicht in ${name} umbenennen, ${name} nicht neu hochladen und den Stand des Release nicht lesen — Zustand UNBEKANNT: ${name} kann fehlen (404 für Update-Clients und latest/download) oder, wenn das Umbenennen gewirkt hat, schon richtig da sein. Zuletzt gelesener Stand: $(stand). Die Zwischendatei ${zwischen} bleibt liegen; der nächste Lauf stellt ${name} her und räumt auf."
}

vorhanden="$(dateien_von "$tag")"
for pfad in "$arbeit"/hoch/*; do
  name="${pfad##*/}"
  if grep -qxF "$name" <<<"$vorhanden"; then
    ersetzen "$name"
  elif ! gh release upload "$tag" --repo "$repo" "$pfad"; then
    # Ein anderer Lauf hat dieselbe Datei in der Zwischenzeit angelegt: dann
    # gilt der Fall „vorhanden“. Sonst ist es ein echter Fehler.
    dateien_von "$tag" | grep -qxF "$name" || die "konnte ${name} nicht hochladen"
    ersetzen "$name"
  fi
done
# Zwischendateien früherer, abgebrochener Läufe wegräumen. Die Workflows eines
# Namens laufen nie gleichzeitig (concurrency), daher gehört keine fremde
# Zwischendatei einem Lauf, der sie noch braucht.
while read -r vorh; do
  for pfad in "$arbeit"/hoch/*; do
    case "$vorh" in "${pfad##*/}".neu-*) asset_weg "$vorh" || true ;; esac
  done
done < <(dateien_von "$tag")
echo "github-release: hochgeladen nach ${tag}: $(ls "$arbeit/hoch" | tr '\n' ' ')"

# Fehlende Dauer-Dateien (APK) aus dem jüngsten Vorgänger übernehmen.
vorhanden="$(dateien_von "$tag")"
for name in "${UEBERNEHMEN[@]}"; do
  grep -qxF "$name" <<<"$vorhanden" && continue
  quelle=""
  while read -r t; do
    [ -n "$t" ] && [ "$t" != "$tag" ] || continue
    if dateien_von "$t" | grep -qxF "$name"; then quelle="$t"; break; fi
  done < <(desktop_tags)
  if [ -z "$quelle" ]; then
    echo "github-release: ${name} in keinem Vorgänger — bleibt bis zum nächsten Bau leer"
    continue
  fi
  gh release download "$quelle" --repo "$repo" --pattern "$name" --dir "$arbeit/alt" --clobber
  # OHNE --clobber: hat der Android-Bau (oder ein zweiter Lauf, der dieselbe
  # Lücke sah) inzwischen hochgeladen, gewinnt dessen Datei — eine übernommene
  # alte APK darf nie eine frisch gebaute überschreiben.
  if gh release upload "$tag" --repo "$repo" "$arbeit/alt/$name"; then
    echo "github-release: ${name} aus ${quelle} übernommen"
  elif dateien_von "$tag" | grep -qxF "$name"; then
    echo "github-release: ${name} hat inzwischen ein anderer Lauf abgelegt"
  else
    die "konnte ${name} nicht übernehmen"
  fi
done

# Latest erst, wenn vollständig und höchste Version (s. Kopf).
vorhanden="$(dateien_von "$tag")"
for name in "${VOLLSTAENDIG[@]}"; do
  if ! grep -qxF "$name" <<<"$vorhanden"; then
    echo "github-release: ${tag} noch unvollständig (${name} fehlt) — Latest bleibt beim Vorgänger"
    exit 0
  fi
done
hoechster="$(desktop_tags | sed 's/^desktop-v//' | sort -V | tail -n 1)"
if [ "$hoechster" != "$version" ]; then
  echo "github-release: ${tag} ist vollständig, aber nicht die höchste Version (${hoechster}) — Latest unverändert"
  exit 0
fi
gh release edit "$tag" --repo "$repo" --latest
echo "github-release: ${tag} vollständig, jetzt Latest"
