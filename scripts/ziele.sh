# SSH-Ziele der Pulse-Rechner auflösen — zum Einbinden mit `source`.
#
#   source "$(dirname "${BASH_SOURCE[0]}")/ziele.sh"
#   HOST="$(ziel PULSE_PROD_HOST)"
#
# Reihenfolge: die gleichnamige Umgebungsvariable, sonst die Zeile in
# intern/ziele.env (privates Repo pulse-intern, eingehängt per
# scripts/intern-einhaengen.sh). Die Adressen stehen bewusst nicht im
# öffentlichen Repo. Fehlt beides, bricht der Aufruf mit einem Hinweis ab.
ziel() {
  local name="$1" wert="${!1:-}" datei
  if [ -z "$wert" ]; then
    # --git-common-dir statt --show-toplevel: in einem Worktree zeigt es auf
    # den Hauptklon, und nur dort ist intern/ eingehängt.
    datei="$(dirname "$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)")/intern/ziele.env"
    # tr/sed: eine unter Windows gespeicherte Datei (CRLF) oder ein Wert in
    # Anführungszeichen ergäbe sonst ein Ziel, das ssh nicht kennt.
    [ -f "$datei" ] && wert="$(sed -n "s/^${name}=//p" "$datei" | head -n 1 | tr -d '\r' | sed "s/^[\"']//; s/[\"']\$//")"
  fi
  if [ -z "$wert" ]; then
    echo "✗ ${name} ist nicht gesetzt. Entweder exportieren oder das private Repo einhängen: bash scripts/intern-einhaengen.sh" >&2
    return 1
  fi
  printf '%s\n' "$wert"
}
