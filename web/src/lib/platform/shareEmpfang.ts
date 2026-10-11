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
 * Ablage: ``freigabeStore`` (importfrei, s. dort). Verbraucher ist die
 * Composer-Seite — sie leert die Freigabe, sobald sie sie in den
 * Composer übernommen hat.
 */
import { App as CapApp } from '@capacitor/app';
import { registerPlugin } from '@capacitor/core';
import { isCapacitorAndroid, isCapacitorIOS } from './runtime';
import { freigabeAnkommen } from '$lib/freigabe/freigabeStore';

interface ShareReceiverPlugin {
  getPending(): Promise<{ text?: string; imageBase64?: string; imageMime?: string }>;
}

const ShareReceiver = registerPlugin<ShareReceiverPlugin>('ShareReceiver');

async function hole(): Promise<void> {
  try {
    const paket = await ShareReceiver.getPending();
    const text = typeof paket.text === 'string' && paket.text !== '' ? paket.text : null;
    const bild =
      typeof paket.imageBase64 === 'string' && paket.imageBase64 !== ''
        ? { base64: paket.imageBase64, mime: paket.imageMime ?? 'image/jpeg' }
        : null;
    if (!text && !bild) return;
    freigabeAnkommen({ text, bild });
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
