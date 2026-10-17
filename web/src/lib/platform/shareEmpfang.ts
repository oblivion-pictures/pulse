/**
 * Share-Target-Empfang (Übergabe P1.8; iOS: Roadmap Punkt 41): Text/Bilder
 * aus anderen Apps. Diese Brücke pollt einmalig beim App-Start und nach
 * jeder Rückkehr in den Vordergrund — ein Push-Event ist nicht nötig, weil
 * die Weiterverwendung (Composer-Prefill im gewählten Chat) ohnehin einen
 * Nutzer-Klick braucht.
 *
 * Woher das Paket kommt, unterscheidet sich je Plattform, die Antwort von
 * `ShareReceiver.getPending()` nicht:
 *  - Android: ACTION_SEND landet in MainActivity, das es in den
 *    ShareReceiver-Plugin legt.
 *  - iOS: eine Teilen-Erweiterung (eigenes Programm) legt es in den
 *    gemeinsamen Container der App Group; das Plugin gleichen Namens liest
 *    es dort und leert ihn (`mobile/ios/App/App/ShareReceiverPlugin.swift`).
 *
 * Ein älterer iOS-Bau ohne das Plugin lehnt `getPending` mit UNIMPLEMENTED
 * ab: ohne Plugin-Kopf wirft der Methoden-Wrapper des Capacitor-Kerns IM
 * Promise (`createPluginMethodWrapper` → `.then`). `hole()` fängt das still
 * ab wie jeden anderen Fehlschlag — dort gibt es dann eben nichts zu holen.
 *
 * **Mehrere Dateien (iOS):** `getPending({mitDateien: true})` liefert statt
 * Base64 nur das Verzeichnis (`paketId`, `dateien`); die Bytes holt der
 * Composer erst beim Übernehmen Stück für Stück (`freigabe/freigabeDateien.ts`).
 * Eine ältere Hülle (und Android) kennt den Parameter nicht und liefert wie
 * früher `imageBase64` — `inhaltAusAntwort` versteht beides. Umgekehrt
 * bedient die neue Hülle eine ältere Web-App mit dem ersten Bild als Base64.
 *
 * Ablage: ``freigabeStore`` (importfrei, s. dort). Verbraucher ist die
 * Composer-Seite — sie leert die Freigabe, sobald sie sie in den
 * Composer übernommen hat.
 */
import { App as CapApp } from '@capacitor/app';
import { isCapacitorAndroid, isCapacitorIOS } from './runtime';
import { ShareReceiver } from './shareReceiverPlugin';
import { freigabeAnkommen, freigabeHolen } from '$lib/freigabe/freigabeStore';
import { inhaltAusAntwort, paketIdAusAntwort } from '$lib/freigabe/freigabeRechnung';

async function hole(): Promise<void> {
  try {
    // `mitDateien` sagt der Hülle, dass diese Seite das Verzeichnis versteht.
    const roh = await ShareReceiver.getPending({ mitDateien: true });
    const inhalt = inhaltAusAntwort(roh);
    // Ein Paket, aus dem nichts Brauchbares wurde (nur ungültige Einträge),
    // trotzdem abschließen — sonst liegen seine Dateien bis zur Hüllen-Aufräumung.
    const rohId = paketIdAusAntwort(roh);
    if (rohId && rohId !== inhalt?.paketId) {
      void ShareReceiver.abschliessen({ paketId: rohId }).catch(() => {});
    }
    if (!inhalt) return;
    // Ein neues Paket ersetzt ein unübernommenes: dessen Dateien freigeben.
    const alt = freigabeHolen()?.paketId;
    if (alt && alt !== inhalt.paketId) void ShareReceiver.abschliessen({ paketId: alt }).catch(() => {});
    freigabeAnkommen(inhalt);
    window.dispatchEvent(new CustomEvent('pulse-freigabe'));
  } catch {
    // Kein nativer Kontext oder Plugin fehlt (alter Bau) — bewusst still.
  }
}

export function installiereShareEmpfang(): void {
  const ios = isCapacitorIOS();
  if (!ios && !isCapacitorAndroid()) return;
  void hole();
  // Vordergrund-Wechsel (Android: Share-intent über onNewIntent, kein
  // Reload; iOS: zurück aus der Quell-App) — dann liegt das Paket frisch da.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void hole();
  });
  // iOS: zweiter Anlass, dieselbe Begründung wie in `ws/netzwache.ts`. Im
  // Simulator kam `visibilitychange` beim Zurückholen an (2026-10-11, auch
  // nach 45 s in Safari) — nur hat der Simulator die App dabei nicht
  // eingefroren, und ob die WebView nach echtem Einfrieren am Gerät
  // nachliefert, ist nicht gemessen. Ein doppelter Abruf ist harmlos: der
  // erste leert die Ablage, der zweite findet nichts.
  if (ios) {
    void CapApp.addListener('appStateChange', ({ isActive }) => {
      if (isActive) void hole();
    });
  }
}
