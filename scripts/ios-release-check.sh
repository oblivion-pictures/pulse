#!/usr/bin/env bash
# Release-Vorprüfung der iOS-Hülle (Punkt 14 der iOS-Liste; Schritt 5 seit
# Punkt 41, der Teilen-Erweiterung; Schritt 6 seit Punkt 46, der CI-Lane).
#
#   bash scripts/ios-release-check.sh                     # Quellen, vor dem Bau
#   bash scripts/ios-release-check.sh --produkt <App.app> # zusätzlich das Gebaute
#
# Schritte 1–5 lesen Quellen und die von `cap sync` erzeugte Datei; was
# tatsächlich im Bündel landet, sieht erst Schritt 6 (`--produkt`, so in
# `.github/workflows/ios-build.yml`). Die Lücke dazwischen ist echt: eine
# Bau-Einstellung von der Kommandozeile (Build-Nummer der CI) oder ein Bau in
# Xcode ohne neues `cap sync` steht in keiner Quelle.
#
# WARUM ALS SKRIPT. Dieselbe Liste stand als Prosa in
# `docs/plans/ios-roadmap.md`, und sie veraltete genau so, wie dieses Repo es
# an anderer Stelle schon teuer gelernt hat: sie nannte ZWEI eigene
# Swift-Plugins, während vier im Baum lagen (2026-10-08). Die beiden fehlenden
# hätte ein `cap sync` lautlos aus `packageClassList` geworfen — alles baut
# durch, und erst am Gerät fällt auf, dass Audio-Steuerung, Lagen-Riegel,
# Wachhalten oder Bewertungsfrage nichts tun.
#
# Deshalb LEITET dieses Skript die Plugin-Liste aus dem Quellcode AB, statt sie
# zu behaupten. Eine neue Swift-Datei mit `CAPBridgedPlugin` wird damit
# automatisch mitgeprüft, ohne dass jemand eine Liste nachzieht.
#
# Kein Gate in `gate.sh`: diese Prüfung gilt vor einem STORE-/TestFlight-Bau,
# nicht vor jedem Commit. Die geprüfte Datei `mobile/capacitor.config.json`
# steht im Alltag absichtlich auf einer Dev-URL (so arbeiten wir), ein
# Alltags-Gate wäre dauerhaft rot und damit wirkungslos.
set -u

produkt=""
case "${1:-}" in
  "") ;;
  # Vor dem `cd` absolut machen: ein relativer Pfad meint das Verzeichnis des
  # Aufrufers, nicht die Wurzel des Repos. Der fehlende Pfad wird HIER
  # abgefangen, nicht mit `${2:?}` in der Ersetzung unten — dort beendete der
  # Fehler nur die Subshell, und das Skript prüfte das Arbeitsverzeichnis.
  --produkt)
    [ -n "${2:-}" ] || { echo "--produkt braucht den Pfad zu App.app" >&2; exit 2; }
    produkt="$2"
    ort=$(cd "$(dirname "$2")" 2>/dev/null && pwd) && produkt="$ort/$(basename "$2")" ;;
  *) echo "Aufruf: $0 [--produkt <App.app>]" >&2; exit 2 ;;
esac
cd "$(dirname "$0")/.."
IOS=mobile/ios/App/App
PROD=https://howispulse.com/app
fehler=0
meld() { printf '  %s %s\n' "$1" "$2"; }
schlecht() { meld "✗" "$1"; fehler=$((fehler + 1)); }
gut() { meld "✓" "$1"; }
# Felder einer Capacitor-Konfiguration; leer, wenn Datei oder Feld nicht lesbar ist.
server_url() { python3 -c "import json;print(json.load(open('$1'))['server']['url'])" 2>/dev/null; }
klassenliste() { python3 -c "import json;print(' '.join(json.load(open('$1'))['packageClassList']))" 2>/dev/null; }
nummern_von() {  # "<Version> (<Build>)" aus einer Info.plist, auch binär
  echo "$(plutil -extract CFBundleShortVersionString raw -o - "$1" 2>/dev/null) ($(plutil -extract CFBundleVersion raw -o - "$1" 2>/dev/null))"
}

# Schritt 6, nur mit --produkt. Läuft nach 2 und 5 und liest deren `eigene`
# (Plugin-Klassen) und `nummern` (Targets des Projekts).
produkt_pruefen() {
  [ -d "$produkt" ] || { schlecht "$produkt gibt es nicht"; return; }
  local cfg="$produkt/capacitor.config.json" purl pliste fehlend="" k app_nr name nr
  purl=$(server_url "$cfg")
  [ "$purl" = "$PROD" ] && gut "im Bündel: server.url = $purl" \
    || schlecht "im Bündel: server.url = ${purl:-?} (erwartet $PROD)"
  pliste=$(klassenliste "$cfg")
  for k in $eigene; do
    case " $pliste " in *" $k "*) ;; *) fehlend="$fehlend $k" ;; esac
  done
  if [ -n "$eigene" ] && [ -n "$pliste" ] && [ -z "$fehlend" ]; then
    gut "im Bündel: alle $(echo "$eigene" | wc -l | tr -d ' ') eigenen Plugins in packageClassList"
  else
    schlecht "im Bündel fehlen in packageClassList:${fehlend:- (Liste nicht lesbar)}"
  fi
  [ -f "$produkt/PrivacyInfo.xcprivacy" ] && gut "im Bündel: PrivacyInfo.xcprivacy" \
    || schlecht "im Bündel fehlt PrivacyInfo.xcprivacy (App-Store-Pflicht)"
  # Die Nummern, die WIRKLICH eingebaut sind — eine Build-Nummer von der
  # Kommandozeile (CI) steht in keiner Projektdatei, Schritt 5 sieht sie nicht.
  app_nr=$(nummern_von "$produkt/Info.plist")
  while read -r name _; do
    case "$name" in "" | App) continue ;; esac
    if [ ! -f "$produkt/PlugIns/$name.appex/Info.plist" ]; then
      schlecht "im Bündel fehlt die Erweiterung $name (PlugIns/$name.appex)"
      continue
    fi
    nr=$(nummern_von "$produkt/PlugIns/$name.appex/Info.plist")
    [ "$nr" = "$app_nr" ] && gut "im Bündel: $name $nr wie die App" \
      || schlecht "im Bündel: $name $nr, die App $app_nr"
  done <<< "$nummern"
}

echo "── 1. Hülle zeigt auf die Produktion ──"
url=$(server_url mobile/capacitor.config.json)
# Fehlt der Schlüssel, ist das KORREKT — Capacitors Vorgabe ist `false`.
# Eine erste Fassung verlangte ihn ausdrücklich und hätte die saubere Datei rot
# gemeldet; ein Prüfskript, das Richtiges beanstandet, wird abgeschaltet.
klar=$(python3 -c "import json;print(json.load(open('mobile/capacitor.config.json'))['server'].get('cleartext', False))" 2>/dev/null)
[ "$url" = "$PROD" ] && gut "server.url = $url" || schlecht "server.url = ${url:-?} (erwartet $PROD)"
[ "$klar" = "False" ] && gut "cleartext ist aus" || schlecht "cleartext = ${klar:-?} (erwartet false oder weggelassen)"
# Ins Bündel kommt nicht diese Datei, sondern ihre von `cap sync` erzeugte
# Kopie. Wer die Quelle zurückdreht und in Xcode baut, ohne neu zu
# synchronisieren, liefert weiter die Dev-Adresse aus — bei grüner Quelle.
if [ -f "$IOS/capacitor.config.json" ]; then
  kopie=$(server_url "$IOS/capacitor.config.json")
  [ "$kopie" = "$PROD" ] && gut "erzeugte Kopie: server.url = $kopie" \
    || schlecht "erzeugte Kopie $IOS/capacitor.config.json: server.url = ${kopie:-?} — neu: bash scripts/ios-huelle-vorbereiten.sh"
fi

echo "── 2. Eigene Swift-Plugins in packageClassList ──"
# Aus dem Quellcode abgeleitet — dieselbe Ableitung, mit der
# `ios-huelle-vorbereiten.sh` einträgt (Regel in `ios-eigene-plugins.sh`).
eigene=$(bash scripts/ios-eigene-plugins.sh)
if [ -z "$eigene" ]; then
  schlecht "keine eigenen Plugins gefunden — stimmt der Pfad $IOS noch?"
else
  liste=$(klassenliste "$IOS/capacitor.config.json")
  if [ -z "$liste" ]; then
    schlecht "$IOS/capacitor.config.json fehlt oder hat keine packageClassList (gitignored, auf einer frischen Maschine IMMER unvollständig) — bash scripts/ios-huelle-vorbereiten.sh"
  else
    for k in $eigene; do
      case " $liste " in
        *" $k "*) gut "$k" ;;
        *) schlecht "$k fehlt in packageClassList — das Plugin tut am Gerät nichts (bash scripts/ios-huelle-vorbereiten.sh)" ;;
      esac
    done
  fi
fi

echo "── 3. Store-Pflichtangaben ──"
[ -f "$IOS/PrivacyInfo.xcprivacy" ] && gut "PrivacyInfo.xcprivacy" || schlecht "PrivacyInfo.xcprivacy fehlt (App-Store-Pflicht)"
grep -q "NSLocalNetworkUsageDescription" "$IOS/Info.plist" \
  && gut "NSLocalNetworkUsageDescription" \
  || schlecht "NSLocalNetworkUsageDescription fehlt (Self-Host im Heimnetz wird still blockiert)"

echo "── 4. Nichts Lokales im Bundle ──"
# Mit Schrägstrich am Ende: die Regel in `.gitignore` lautet `web/.cert/` und
# gilt nur für Verzeichnisse. Ohne Schrägstrich kann git das nur wissen, wenn
# das Verzeichnis existiert — auf einem frischen Klon (CI) meldete dieser
# Schritt deshalb „NICHT gitignored“, obwohl alles stimmte.
git check-ignore -q web/.cert/ 2>/dev/null \
  && gut "web/.cert ist gitignored" \
  || schlecht "web/.cert ist NICHT gitignored — mkcert-Zertifikat darf nie mitreisen"

echo "── 5. Erweiterungen tragen die Nummern der App ──"
# Version und Build-Nummer stehen je Target im Projekt, also mehrfach. Wer sie
# in Xcode nur bei der App hochsetzt, liefert eine eingebettete Erweiterung mit
# alten Nummern aus. Der Bau meldet das nur als WARNUNG („must match that of
# its containing parent app“) und läuft durch — deshalb hier. Aus dem Projekt
# gelesen, nicht aufgezählt: ein neues Erweiterungs-Target (Widget, Live
# Activity) wird damit ohne Nachpflege mitgeprüft.
nummern=$(plutil -convert json -o - mobile/ios/App/App.xcodeproj/project.pbxproj 2>/dev/null | python3 -c '
import json, sys
o = json.load(sys.stdin)["objects"]
for t in o.values():
    if t.get("isa") == "PBXNativeTarget" and t.get("productType") in (
            "com.apple.product-type.application", "com.apple.product-type.app-extension"):
        for k in o[t["buildConfigurationList"]]["buildConfigurations"]:
            if o[k]["name"] == "Release":
                s = o[k]["buildSettings"]
                print(t["name"], s.get("MARKETING_VERSION", "?"), s.get("CURRENT_PROJECT_VERSION", "?"))
' 2>/dev/null)
app=$(echo "$nummern" | awk '$1 == "App" { print $2 " (" $3 ")" }')
if [ -z "$app" ]; then
  schlecht "Nummern der App nicht lesbar — stimmt der Pfad zum Projekt noch?"
else
  while read -r name version bau; do
    case "$name" in "" | App) continue ;; esac
    [ "$version ($bau)" = "$app" ] \
      && gut "$name: $version ($bau) wie die App" \
      || schlecht "$name: $version ($bau), die App hat $app — beide Targets hochsetzen"
  done <<< "$nummern"
fi

if [ -n "$produkt" ]; then
  echo "── 6. Gebautes Produkt: $produkt ──"
  produkt_pruefen
fi

echo
if [ "$fehler" -eq 0 ]; then
  echo "✓ Release-Vorprüfung grün."
else
  echo "✗ $fehler Punkt(e) offen — NICHT bauen."
fi
exit "$fehler"
