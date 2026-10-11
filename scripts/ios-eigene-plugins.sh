#!/usr/bin/env bash
# Die eigenen Swift-Plugins der iOS-Hülle, eine Klasse je Zeile — aus dem
# Quellcode abgeleitet, nicht aufgezählt (Begründung im Kopf von
# `ios-release-check.sh`: die Aufzählung in Prosa nannte zwei, während vier im
# Baum lagen).
#
# EINE Ableitung für zwei Leser: `ios-release-check.sh` (Schritt 2, prüft) und
# `ios-huelle-vorbereiten.sh` (trägt ein). Stünde die Regel in beiden, könnten
# sie auseinanderlaufen — dann trüge die Vorbereitung eine andere Liste ein,
# als die Prüfung verlangt, und beide wären grün an verschiedenen Dingen.
#
# Regel: jede Swift-Datei unter mobile/ios/App/App mit `CAPBridgedPlugin`, der
# Name aus `@objc(...)`. Unter genau diesem Namen sucht Capacitor die Klasse,
# wenn es `packageClassList` abarbeitet. Leere Ausgabe = nichts gefunden; die
# Aufrufer werten das als Fehler (stimmt der Pfad noch?).
set -u
cd "$(dirname "$0")/.."
grep -l "CAPBridgedPlugin" mobile/ios/App/App/*.swift 2>/dev/null \
  | xargs -r grep -ho '@objc([A-Za-z0-9_]*)' \
  | sed 's/@objc(//; s/)//' | sort -u
