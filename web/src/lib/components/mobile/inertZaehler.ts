/**
 * Referenzzähler für Elemente, die die Fokusfalle eines Blattes `inert` setzt.
 * Importfrei, damit Nodes Läufer ihn prüfen kann.
 *
 * Beim Übergang Blatt A → Blatt B legt B seine Falle an, bevor oder nachdem A
 * die seine löst; ohne Zähler hob A das `inert` auf, das B noch brauchte (oder
 * B hielt das von A gesetzte `inert` für fremd und ließ es nach dem Schließen
 * stehen).
 */

/** Zählt einen Halter mehr; `true`, wenn es der erste ist (dann `inert` setzen). */
export function belegen<K>(zaehler: Map<K, number>, schluessel: K): boolean {
  const n = zaehler.get(schluessel) ?? 0;
  zaehler.set(schluessel, n + 1);
  return n === 0;
}

/** Zählt einen Halter weniger; `true`, wenn es der letzte war (dann `inert` lösen). */
export function freigeben<K>(zaehler: Map<K, number>, schluessel: K): boolean {
  const n = zaehler.get(schluessel);
  if (n === undefined) return false;
  if (n > 1) {
    zaehler.set(schluessel, n - 1);
    return false;
  }
  zaehler.delete(schluessel);
  return true;
}
