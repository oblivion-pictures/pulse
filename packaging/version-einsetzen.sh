#!/bin/sh
# Setzt die Desktop-Version in package.json und Metainfo eines Flatpaks ein.
#
# Warum: Windows und macOS lesen ihre Version aus `desktop/package.json`
# (electron-builder). Das Flatpak kopierte stattdessen eine eigene
# `packaging/pulse-*.package.json`, die nie hochgezählt wurde — die App meldete
# unter Linux deshalb „0.1.0", die Metainfo zuletzt „0.1.24", während Windows
# und macOS bei 0.1.109 standen. Seit 2026-10-15 gilt EINE Nummer für alle
# Plattformen, und ihre einzige Quelle ist `desktop/package.json`. Die
# Vorlagen unter `packaging/` tragen deshalb absichtlich „0.0.0".
#
# Läuft im Bau beider Flatpaks (com.howispulse.Pulse, …PulseServer).
#
# Benutzung:
#   version-einsetzen.sh <desktop-package.json> <package.json-vorlage> <ziel> \
#                        <metainfo-vorlage> <ziel>
set -eu

desktop=$1 vorlage=$2 ziel=$3 meta_vorlage=$4 meta_ziel=$5

# Die Zeile, die electron-builder auch liest: zweite Ebene, direkt im Wurzelobjekt.
version=$(sed -n 's/^  "version": "\([0-9][0-9.]*\)",$/\1/p' "$desktop")
if [ -z "$version" ]; then
  echo "version-einsetzen: keine Version in $desktop gefunden" >&2
  exit 1
fi

sed "s/\"version\": \"[^\"]*\"/\"version\": \"$version\"/" "$vorlage" > "$ziel"
grep -q "\"version\": \"$version\"" "$ziel"

# Metainfo: die laufende Version als neuesten Eintrag. Fehlt der Block (Server-
# App), entsteht er vor `</component>`. Das Datum ist der Bautag.
datum=$(date -u +%Y-%m-%d)
eintrag="<release version=\"$version\" date=\"$datum\"/>"
if grep -q '<releases>' "$meta_vorlage"; then
  sed "s|<releases>|<releases>\n    $eintrag|" "$meta_vorlage" > "$meta_ziel"
else
  sed "s|</component>|  <releases>\n    $eintrag\n  </releases>\n</component>|" \
    "$meta_vorlage" > "$meta_ziel"
fi
grep -q "release version=\"$version\"" "$meta_ziel"

echo "version-einsetzen: $version"
