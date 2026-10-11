#!/usr/bin/env bash
# Bereitet die iOS-Hülle für einen Bau vor (Punkt 46 der iOS-Liste):
# `cap sync ios`, danach die EIGENEN Swift-Plugins in die erzeugte
# `mobile/ios/App/App/capacitor.config.json` eintragen und nachlesen.
# Ersetzt den Hand-Patch aus der Release-Checkliste; lokal wie in CI derselbe
# Aufruf: `bash scripts/ios-huelle-vorbereiten.sh` (braucht `npm ci --prefix
# mobile`).
#
# WARUM ES DAS BRAUCHT. `cap sync` schreibt die Datei bei jedem Lauf neu:
# erst die Konfiguration aus `mobile/capacitor.config.json`, dann
# `packageClassList` — und die setzt es ERSATZLOS auf die Klassen der
# npm-Plugins (`writePluginJSON` in `@capacitor/cli/dist/util/iosplugin.js`,
# 8.4.0 nachgelesen). Die Plugins im App-Target kennt es nicht. Eine Liste in
# `mobile/capacitor.config.json` zu führen hilft deshalb nicht: sie wird
# überschrieben, nicht ergänzt. Ohne diesen Schritt baut alles grün, und erst
# am Gerät fällt auf, dass die eigenen Plugins nichts tun. Die erzeugte Datei
# ist gitignored — auf einem frischen Klon fehlt sie ganz, nach einem nackten
# `cap sync` ist ihre Liste unvollständig.
#
# WARUM KEIN npm-Haken (`capacitor:sync:after` in mobile/package.json), obwohl
# die CLI Haken kennt: sie ruft `generateIOSPackageJSON` im Update-Schritt
# OHNE `await` auf (`@capacitor/cli/dist/ios/update.js`). Das Überschreiben
# kann also nach einem Haken landen und den Eintrag still zurücknehmen. Fest
# steht die Datei erst, wenn der Prozess beendet ist — deshalb trägt dieses
# Skript danach ein, als eigener Schritt.
#
# Die Adresse (`server.url`) reicht es UNVERÄNDERT durch — lokal also die
# Dev-Adresse, wenn sie in `mobile/capacitor.config.json` steht. Ob sie für
# einen Store-Bau stimmt, prüft `ios-release-check.sh` (Schritt 1). Eine
# Vorbereitung, die die Adresse still umbiegt, verdeckte eine falsch
# eingecheckte Datei.
set -euo pipefail
cd "$(dirname "$0")/.."
ZIEL=mobile/ios/App/App/capacitor.config.json

if [ ! -x mobile/node_modules/.bin/cap ]; then
  echo "✗ mobile/node_modules fehlt — zuerst: npm ci --prefix mobile" >&2
  exit 1
fi

echo "── cap sync ios ──"
( cd mobile && ./node_modules/.bin/cap sync ios )

eigene=$(bash scripts/ios-eigene-plugins.sh)
if [ -z "$eigene" ]; then
  echo "✗ keine eigenen Plugins gefunden — stimmt der Pfad mobile/ios/App/App noch?" >&2
  exit 1
fi

echo "── Eigene Plugins in packageClassList ──"
# Erst schreiben, dann FRISCH von der Platte lesen und vergleichen — nicht dem
# eigenen Schreibvorgang glauben. Die npm-Plugins bleiben vorn und in ihrer
# Reihenfolge, die eigenen kommen sortiert dahinter; ein zweiter Lauf des
# Skripts ergibt dieselbe Datei.
# shellcheck disable=SC2086  # eine Klasse je Wort, Namen ohne Leerzeichen
python3 - "$ZIEL" $eigene <<'PY'
import json, sys

pfad, eigene = sys.argv[1], sys.argv[2:]
with open(pfad, encoding="utf-8") as f:
    daten = json.load(f)
liste = daten.get("packageClassList") or []
neu = [k for k in eigene if k not in liste]
daten["packageClassList"] = liste + neu
with open(pfad, "w", encoding="utf-8") as f:
    json.dump(daten, f, indent="\t", ensure_ascii=False)
    f.write("\n")

with open(pfad, encoding="utf-8") as f:
    gelesen = json.load(f).get("packageClassList") or []
fehlt = [k for k in eigene if k not in gelesen]
for k in eigene:
    zeichen = "✗" if k in fehlt else "✓"
    zusatz = " (eingetragen)" if k in neu else ""
    print(f"  {zeichen} {k}{zusatz}")
if fehlt:
    sys.exit(f"✗ {len(fehlt)} eigene(s) Plugin(s) fehlen nach dem Schreiben in {pfad}")
print(f"✓ {len(eigene)} eigene Plugins in packageClassList ({len(neu)} neu eingetragen)")
PY
