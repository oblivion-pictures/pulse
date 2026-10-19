/**
 * macOS-Systemfreigaben der Fernsteuerung (Host-Seite): die Adressen der
 * beiden Listen in den Systemeinstellungen.
 *
 * Auf dem Mac braucht der Host **zwei** Freigaben — Bedienungshilfen zum
 * Einspielen, Eingabeüberwachung zum Mithören (Vorrang des Hosts); Begründung
 * in `streaming/mac-hq-sidecar/src/berechtigung.rs`. Windows braucht keine,
 * das Op gehört dort zum Programm.
 *
 * **Angefragt wird im Sidecar, nicht hier** (Op `freigabe_anfragen`, nur auf
 * Klick): TCC ordnet die Abfrage dem VERANTWORTLICHEN Prozess zu, der Dialog
 * heißt also „Pulse", auch wenn der Sidecar fragt (gemessen,
 * `intern/docs/plans/2026-08-23-macos-eingabe-messungen.md`, Messung 1). Der
 * Hauptprozess hätte für die Eingabeüberwachung ohnehin keinen Weg —
 * Electron kennt nur `isTrustedAccessibilityClient`, kein `IOHIDRequestAccess`.
 *
 * Hier liegt nur das Öffnen der Liste, für den Fall, dass macOS keinen Dialog
 * mehr zeigt (Eingabeüberwachung nach einem Nein). **Der Renderer reicht einen
 * Schlüssel, nie eine Adresse** — `shell.openExternal` gäbe jede Adresse an
 * das Betriebssystem weiter.
 */

const ADRESSEN: Record<string, string> = {
  bedienungshilfen:
    'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  eingabeueberwachung:
    'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent',
};

/** Die Adresse zu einem Schlüssel aus `web/src/lib/remote/freigabeText.ts`
 *  (`FreigabeEinstellung`), oder `null` — unbekannter Schlüssel, kein Mac. */
export function freigabeEinstellungAdresse(art: unknown, platform: string): string | null {
  if (platform !== 'darwin' || typeof art !== 'string') return null;
  return Object.hasOwn(ADRESSEN, art) ? ADRESSEN[art] : null;
}
