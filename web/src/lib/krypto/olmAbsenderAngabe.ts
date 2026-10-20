/**
 * Die beiden Absender-Prüfungen des Olm-Wegs — aus `zustellungOeffnen.ts`
 * herausgelöst (Push-Bughunt 2026-10-21), als die Datei über die
 * Größen-Policy (PLAN.md §12.1) gewachsen war. **Reiner Umzug, kein Verhalten
 * geändert.** Importfrei bis auf Typen.
 */
import type { PostfachZustellung } from '../api/postfach';
import type { NachrichtNutzlast } from './nachrichtNutzlast';

/**
 * Ob die Nutzlast einen anderen Absender nennt als die Metadaten der
 * Zustellung — dann ist eines von beiden gefälscht. Der Aufrufer verwirft
 * die Zustellung als `ohneAblage` (quittierbar), sonst bliebe sie für immer
 * liegen und würde jeden Abholzyklus erneut versucht.
 *
 * **Absender-Bindung (Bughunt 2026-09-23):** die Nutzlast nennt ihr Gerät;
 * die Metadaten (`z.absender_device_pubkey`) setzt der Server frei. Stimmen
 * sie nicht, ist einer der beiden verdreht — genau die
 * Zuschreibungs-Fälschung, gegen die das Feld existiert.
 *
 * **Zweiter Bughunt-Lauf (2026-09-23): dasselbe für das KONTO.** Der
 * Geräte-Check fängt den bösartigen Server — aber ein bösartiges MITGLIED
 * kann in seiner Nutzlast `absenderNutzer` auf ein fremdes Konto setzen
 * (eigenes Gerät = Metadaten passt!) und sich so eine Zuschreibung
 * erschreiben; schlimmer: einen Lösch-Frame mit fremder Nutzer-ID, den
 * `loeschZiel` als berechtigt einstuft. `absender_user_id` füllt der Server
 * aus dem Login — die Diskrepanz ist also immer eine Fälschung. Nutzlasten
 * ohne das Feld (Legacy) fallen durch zum Fallback.
 */
export function absenderAngabeGefaelscht(
  z: PostfachZustellung,
  gelesen: NachrichtNutzlast
): boolean {
  if (gelesen.absenderGeraet !== null && gelesen.absenderGeraet !== z.absender_device_pubkey) {
    console.warn('[postfach] Nachricht mit fremder Absender-Angabe verworfen', {
      nutzlast: gelesen.absenderGeraet,
      zustellung: z.absender_device_pubkey
    });
    return true;
  }
  if (
    gelesen.absenderNutzer !== null &&
    z.absender_user_id !== null &&
    gelesen.absenderNutzer !== z.absender_user_id
  ) {
    console.warn('[postfach] Nachricht mit fremder Absender-Konto-Angabe verworfen', {
      nutzlast: gelesen.absenderNutzer,
      zustellung: z.absender_user_id
    });
    return true;
  }
  return false;
}
