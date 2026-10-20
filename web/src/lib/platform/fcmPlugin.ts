/**
 * Das Firebase-Messaging-Plugin der Hüllen (`@capacitor-firebase/messaging`
 * 8.5.x) — schmaler Ausschnitt der Oberfläche, nur was der Klient ruft.
 *
 * Die Capacitor-App lädt diese Web-App remote; das native Plugin ist nur in
 * `mobile/` installiert und deshalb hier NICHT als Paket-Import erreichbar. Es
 * wird wie beim Share-Empfang über `window.Capacitor.Plugins` angesprochen
 * (Typen lokal, an `definitions.d.ts` des Plugins abgelesen).
 *
 * Aus `fcm.ts` herausgelöst (2026-10-20), weil die zugestellten Meldungen
 * (`zugestellteMeldungen.ts`) dasselbe Plugin brauchen.
 */
import type { PluginListenerHandle } from '@capacitor/core';

/** Eine Meldung, wie das Plugin sie liefert. `tag` gibt es nur auf Android;
 *  `data` fehlt dort bei `getDeliveredNotifications` (laut Plugin-Doku). */
export interface FcmMeldung {
  id?: string;
  tag?: string;
  title?: string;
  body?: string;
  data?: unknown;
}

export interface FcmPlugin {
  getToken(): Promise<{ token: string }>;
  checkPermissions(): Promise<{ receive: 'granted' | 'denied' | 'prompt' }>;
  requestPermissions(): Promise<{ receive: 'granted' | 'denied' | 'prompt' }>;
  createChannel(options: {
    id: string;
    name: string;
    importance?: number;
    visibility?: number;
  }): Promise<void>;
  getDeliveredNotifications(): Promise<{ notifications: FcmMeldung[] }>;
  removeDeliveredNotifications(options: { notifications: FcmMeldung[] }): Promise<void>;
  removeAllDeliveredNotifications(): Promise<void>;
  addListener(
    eventName: 'notificationActionPerformed',
    listenerFunc: (event: {
      notification: FcmMeldung;
      /** Bezeichner der getippten Aktion; `tap` = auf die Meldung selbst. */
      actionId?: string;
      /** Text aus dem Antwort-Feld der Meldung (nur bei `antworten`). */
      inputValue?: string;
    }) => void
  ): Promise<PluginListenerHandle>;
  /** Ein neuer FCM-Token (Erstvergabe oder Rotation). */
  addListener(
    eventName: 'tokenReceived',
    listenerFunc: (event: { token: string }) => void
  ): Promise<PluginListenerHandle>;
}

export function fcmPlugin(): FcmPlugin | null {
  if (typeof window === 'undefined') return null;
  const cap = (window as Window & { Capacitor?: { Plugins?: Record<string, unknown> } })
    .Capacitor;
  return (cap?.Plugins?.FirebaseMessaging as FcmPlugin | undefined) ?? null;
}
