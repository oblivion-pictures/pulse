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
# Lauf schneller war, ist deshalb kein Fehler. `--clobber`: ein Neubau
# derselben Version ersetzt die Dateien (wie bisher auf dem netcup-Server).
#
# Android baut nur, wenn sich mobile/ ändert — ein NEUES Release übernimmt die
# APK deshalb aus dem jüngsten Vorgänger, sonst fehlte sie nach jedem
# Versionssprung bis zum nächsten Android-Bau.
#
# Braucht: gh (auf allen GitHub-Runnern vorinstalliert), GH_TOKEN mit
# contents:write, GITHUB_REPOSITORY, GITHUB_SHA.
set -euo pipefail

UEBERNEHMEN=(Pulse-Android.apk)

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

Built from \`main\` at ${GITHUB_SHA}. A rebuild of the same version replaces the files here. The \`.zip\` and \`.blockmap\` files are used by the apps' auto-update.
EOF
}

if ! gh release view "$tag" --repo "$repo" >/dev/null 2>&1; then
  notizen > "$arbeit/notizen.md"
  if gh release create "$tag" --repo "$repo" --target "$GITHUB_SHA" \
       --title "Pulse ${version}" --notes-file "$arbeit/notizen.md" --latest; then
    echo "github-release: ${tag} angelegt"
  elif gh release view "$tag" --repo "$repo" >/dev/null 2>&1; then
    echo "github-release: ${tag} hat ein paralleler Lauf angelegt — hänge an"
  else
    die "konnte ${tag} nicht anlegen"
  fi
fi

gh release upload "$tag" --repo "$repo" --clobber "$arbeit"/hoch/*
echo "github-release: hochgeladen nach ${tag}: $(ls "$arbeit/hoch" | tr '\n' ' ')"

# Fehlende Dauer-Dateien (APK) aus dem jüngsten Vorgänger übernehmen.
vorhanden="$(gh release view "$tag" --repo "$repo" --json assets --jq '.assets[].name')"
for name in "${UEBERNEHMEN[@]}"; do
  grep -qxF "$name" <<<"$vorhanden" && continue
  quelle=""
  while read -r t; do
    [ -n "$t" ] && [ "$t" != "$tag" ] || continue
    if gh release view "$t" --repo "$repo" --json assets --jq '.assets[].name' | grep -qxF "$name"; then
      quelle="$t"; break
    fi
  done < <(gh release list --repo "$repo" --limit 50 --json tagName \
             --jq '.[].tagName | select(startswith("desktop-v"))')
  if [ -z "$quelle" ]; then
    echo "github-release: ${name} in keinem Vorgänger — bleibt bis zum nächsten Bau leer"
    continue
  fi
  gh release download "$quelle" --repo "$repo" --pattern "$name" --dir "$arbeit/alt" --clobber
  gh release upload "$tag" --repo "$repo" --clobber "$arbeit/alt/$name"
  echo "github-release: ${name} aus ${quelle} übernommen"
done
