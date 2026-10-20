/**
 * Die Meldung ueber eine neu entschluesselte Nachricht — Toast, In-Page-
 * Benachrichtigung, Ton.
 *
 * Herausgeloest aus `chat.ts`, als der Gruppen-Zweig (Etappe G) diese sonst
 * ueber die Groessen-Policy getrieben haette.
 *
 * **Am Handy gibt es seit 2026-10-20 ebenfalls einen Toast** — knapp: nur die
 * Kopfzeile (Absender bzw. Gruppe), kein Textausschnitt, oben statt ueber der
 * Bereichs-Leiste. Bis dahin schwieg die App dort ganz, mit der Begruendung,
 * die Chats-Liste sei die Benachrichtigung. Nur sieht man die nicht, solange
 * man in einer ANDEREN Unterhaltung steht, und die iOS-Hülle unterdrückt im
 * Vordergrund das System-Banner (`MitteilungImVordergrund.swift`) — eine neue
 * DM kam dann gar nicht sichtbar an.
 *
 * **Der Text darf hier stehen, weil er schon entschluesselt ist.** Anders als
 * beim Klartext-`dm_bump`, dessen Rahmen bewusst inhaltslos ist, liegt der
 * Inhalt an dieser Stelle bereits im Klienten vor — er verlaesst das Geraet
 * nicht.
 */
import { goto } from '$app/navigation';
import { toast } from 'svelte-sonner';

import { fireInPageNotification, isDnd } from '$lib/notifications/inPage';
import { m } from '$lib/paraglide/messages.js';
import { sichtschutzAktiv } from '$lib/remote/sichtschutz';
import { sounds } from '$lib/sounds/engine';
import { mitteilungsAnlassMelden } from '$lib/platform/mitteilungsAnlass';
import { userCache } from '$lib/stores/users.svelte';
import { viewport } from '$lib/stores/viewport.svelte';
import type { Message } from '$lib/api/types';

/** `gespraechOffen`: das Gespräch steht gerade offen, nur das Fenster hat
 *  keinen Fokus (s. `nachrichten/hinschauen.ts`). Dann kein Toast — er
 *  meldete „Neue Nachricht — Öffnen" neben genau dem Gespräch, in dem sie
 *  schon steht (Befund 2026-10-10). Ton und System-Benachrichtigung bleiben:
 *  wer in einem anderen Fenster arbeitet, soll es trotzdem mitbekommen. */
export function meldeNeueZustellung(
  nachricht: Message,
  gruppenName: string | null,
  gespraechOffen: boolean
): void {
  const cached = userCache.get(nachricht.author_id);
  const senderLabel = cached
    ? m.chat_handler_dm_sender_label({
        sender: '@' + (cached.display_name ?? cached.username)
      })
    : '';
  const snippet = nachricht.content.slice(0, 140);
  // In einer Gruppe sagt „Neue Nachricht von @x" nicht, WO — und der Ort ist
  // dort die eigentliche Auskunft.
  const kopfzeile = gruppenName
    ? m.chat_handler_gruppe_new_message({ gruppe: gruppenName, senderLabel })
    : m.chat_handler_dm_new_message({ senderLabel });
  // Am Handy ohne Ausschnitt: der Toast soll sagen, DASS etwas kam und von
  // wem — lesen kann man es in der Unterhaltung (s. Modulkopf).
  if (!gespraechOffen) {
    neueNachrichtToast(
      kopfzeile,
      nachricht.channel_id,
      viewport.isMobile ? undefined : snippet || undefined
    );
  }
  const senderName = cached?.display_name ?? cached?.username ?? null;
  fireInPageNotification({
    // Weiterhin `dm`: die Benachrichtigungs-Art steuert Ziel und Aussehen,
    // und eine private Gruppe fuehrt an denselben Ort (`/app/@me/<id>`). Eine
    // eigene Art einzufuehren, ohne dass sich etwas daran unterscheidet,
    // waere eine Unterscheidung ohne Unterschied.
    kind: 'dm',
    title: gruppenName ?? senderName ?? m.chat_handler_dm_notification_unknown_sender(),
    body:
      snippet ||
      (gruppenName
        ? m.chat_handler_gruppe_notification_body()
        : m.chat_handler_dm_notification_body()),
    channelId: nachricht.channel_id,
    messageId: nachricht.id,
    guildId: null
  });
  if (!isDnd()) sounds.play('notification.dm');
  // Eine Direktnachricht (keine Gruppe) bei offener App: Anlass für die
  // Mitteilungsfrage, wie im Klartext-Weg (`dm_bump` in `chat.ts`).
  if (!gruppenName) mitteilungsAnlassMelden();
}

/**
 * Der Toast „Neue Nachricht … — Öffnen" für eine DM oder private Gruppe, auch
 * vom Klartext-Weg (`dm_bump` in `chat.ts`) benutzt, damit beide Wege dieselben
 * Riegel haben:
 *
 * - **Nicht stören:** kein Toast.
 * - **Sichtschutz:** kein Toast — sonner rendert mit z-index 999999999 und lag
 *   damit ÜBER dem Riegel des ferngesteuerten Standplatz-Geräts; der Name des
 *   Absenders stand mitten auf dem Bild, das gerade ein Fremder sieht
 *   (`$lib/remote/sichtschutz.ts`).
 * - **Handy:** oben (`top-center`) statt am unteren Rand, wo er die
 *   Bereichs-Leiste überdeckte. Die iOS-Hülle setzt ihre Meldungen ohnehin
 *   oben; den Abstand zur Statusleiste gibt der `Toaster` in
 *   `routes/+layout.svelte` vor.
 *
 * Ob das Gespräch offen ist, prüft der Aufrufer — neben der offenen
 * Unterhaltung soll kein Toast stehen.
 */
export function neueNachrichtToast(titel: string, kanalId: string, beschreibung?: string): void {
  if (isDnd() || sichtschutzAktiv()) return;
  toast.message(titel, {
    description: beschreibung,
    ...(viewport.isMobile ? { position: 'top-center' as const } : {}),
    action: {
      label: m.chat_handler_dm_open(),
      onClick: () => {
        void goto(`/app/@me/${kanalId}`);
      }
    }
  });
}
