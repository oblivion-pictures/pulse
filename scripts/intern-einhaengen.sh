#!/usr/bin/env bash
# Hängt das private Repo mit den internen Arbeitsdokumenten ein.
#
#   bash scripts/intern-einhaengen.sh
#
# Klont github.com/oblivion-pictures/pulse-intern nach ./intern/ (vom
# öffentlichen Repo ignoriert, s. .gitignore) bzw. aktualisiert es, und
# verknüpft CLAUDE.md im Wurzelordner mit intern/CLAUDE.md, damit Claude Code
# die Projekt-Anweisungen dort findet, wo es sie sucht.
#
# Zugang zu pulse-intern hat nur, wer in der Organisation dafür freigeschaltet
# ist; ohne Zugang bricht der Klon mit einer Meldung von GitHub ab.
#
# Windows (Git Bash): eine echte Verknüpfung braucht den Entwicklermodus
# (oder Admin-Rechte). Ohne ihn legt `ln -s` eine Kopie an; dann zeigt das
# Skript, dass es eine Kopie ist, und Änderungen gehören nach intern/CLAUDE.md.
set -euo pipefail

wurzel="$(git rev-parse --show-toplevel)"
cd "$wurzel"
quelle="${PULSE_INTERN_URL:-https://github.com/oblivion-pictures/pulse-intern.git}"

if [ -d intern/.git ]; then
  echo "→ intern/ vorhanden, hole den neuesten Stand"
  git -C intern pull --ff-only
else
  if [ -e intern ]; then
    echo "✗ ./intern existiert, ist aber kein Git-Repo — bitte selbst ansehen." >&2
    exit 1
  fi
  echo "→ klone ${quelle} nach intern/"
  git clone "$quelle" intern
fi

if [ -L CLAUDE.md ]; then
  echo "✓ CLAUDE.md ist schon mit $(readlink CLAUDE.md) verknüpft"
elif [ -e CLAUDE.md ]; then
  # Eine echte Datei hier ist entweder ein alter Stand aus der Zeit vor dem
  # Auslagern oder eigene Arbeit — beides wird nicht stillschweigend ersetzt.
  echo "✗ CLAUDE.md liegt als eigene Datei im Wurzelordner." >&2
  echo "  Vergleiche sie mit intern/CLAUDE.md, übernimm Änderungen dorthin," >&2
  echo "  lösche sie und starte das Skript erneut." >&2
  exit 1
else
  ln -s intern/CLAUDE.md CLAUDE.md
  if [ -L CLAUDE.md ]; then
    echo "✓ CLAUDE.md → intern/CLAUDE.md verknüpft"
  else
    echo "⚠  Keine Verknüpfung möglich (Windows ohne Entwicklermodus?) — CLAUDE.md ist eine KOPIE." >&2
    echo "   Änderungen gehören nach intern/CLAUDE.md, dort committen und pushen." >&2
  fi
fi
