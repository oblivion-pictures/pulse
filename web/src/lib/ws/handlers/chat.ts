/**
 * Chat-domain handlers: `message`, `message_update`, `message_delete`,
 * `reaction_add`, `reaction_remove`, `channel_bump`, `dm_bump`,
 * `mention_added`, `stream_chat_message`, `watch_chat_message`.
 *
 * Sound + read-state logic lives here because every chat-shaped event
 * touches the same two: bump the channel's last-seen pointer, optionally
 * play a notification chime, optionally surface a toast / in-page
 * notification. Mention suppression is shared with this module so the
 * chime + bump sound don't double up.
 */
import { messages } from '$lib/stores/messages.svelte';
import { directMessages } from '$lib/stores/directMessages.svelte';
import { verlaufSpeichern, verlaufNachrichtGeloescht } from '$lib/verlauf';
import { E2E_DMS_ENABLED, PRIVATE_GRUPPEN_ENABLED } from '$lib/krypto/schalter';
import { ABLAGE_KANAL_ENABLED } from '$lib/featureFlags';
import { privateGruppen } from '$lib/stores/privateGruppen.svelte';
import { streamChat } from '$lib/stores/streamChat.svelte';
import { watchChat } from '$lib/stores/watchChat.svelte';
import { readState } from '$lib/stores/readState.svelte';
import { quittungen } from '$lib/stores/quittungen.svelte';
import { siehtHin } from '$lib/nachrichten/hinschauen';
import { badgeMeldungFreigeben, badgeNachZustellung } from '$lib/platform/badgeMelden';
import { typing } from '$lib/stores/typing.svelte';
import { userCache } from '$lib/stores/users.svelte';
import { dispatchingUserId } from '$lib/stores/currentServerUser';
import { guilds } from '$lib/stores/guilds.svelte';
import { fireInPageNotification, isDnd } from '$lib/notifications/inPage';
import { sounds } from '$lib/sounds/engine';
import { neueNachrichtToast } from './postfachBenachrichtigung';
import { zustellungenVerbuchen } from './postfachVerbuchen';
import type { Message } from '$lib/api/types';
import { registerWsHandler } from '../handler-registry';
import { serversStore } from '$lib/api/servers.svelte';
import { dispatchingServerId } from '$lib/ws/gateway-connection';
import { isRecentMention, markRecentMention } from './_mentionSuppression';
import { bumpNachschauen, postfachWiederholerErzeugen } from './nachholNetz';
import { page } from '$app/state';
import { mitteilungsAnlassMelden } from '$lib/platform/mitteilungsAnlass';
import type { HandlerContext } from './context';
import { m } from '$lib/paraglide/messages.js';

// Vorschau-Auffrischung nach dm_bump: der Bump-Envelope trägt bewusst keinen
// Inhalt (Privacy-Design für E2EE), also kann `upsertFromBump` nur die
// Reihenfolge reparieren — Vorschautext und Uhrzeit kämen erst beim nächsten
// hydrate. Statt den Inhalt in den Event zu ziehen (und damit die
// Inhalt-Freiheit des Envelopes aufzugeben), wird hier die Liste nachgeladen,
// entprellt: wer schnell hintereinander schreibt, löst EINEN Request aus.
let dmVorschauTimer: ReturnType<typeof setTimeout> | null = null;
function dmVorschauAuffrischen(): void {
  if (dmVorschauTimer) clearTimeout(dmVorschauTimer);
  dmVorschauTimer = setTimeout(() => {
    dmVorschauTimer = null;
    void directMessages.hydrate();
  }, 1500);
}

/** Bughunt Runde 19: notification_mode=none des Servers schaltet beide
 *  Chimes stumm (Nachricht + Mention), nicht nur den OS-Toast. */
function serverStumm(): boolean {
  const sid = dispatchingServerId();
  return sid ? serversStore.servers.find((s) => s.id === sid)?.notification_mode === 'none' : false;
}

/** Schon verbuchte Abhol-Ergebnisse (s. `postfachAbholenUndAnzeigen`). */
const verbucht = new WeakSet<readonly Message[]>();

/** Der Abo-Blick des `postfach_neu`-Weckrufs, gesetzt in `register` — der
 *  Hintergrund-Takt nimmt denselben (`postfachImHintergrundAbholen`). */
let weckrufAboBlick: ((kanalId: string) => boolean) | null = null;

/**
 * Eine Runde des Hintergrund-Takts (`krypto/hintergrundTakt.ts`): derselbe
 * Weg wie der Weckruf, nur stumm. Vor dem ersten Gateway-Aufbau gibt es noch
 * keinen Abo-Blick; dann gilt nichts als offen — im Hintergrund schaut ohnehin
 * niemand hin (`siehtHin`), also zaehlt alles als ungelesen.
 */
export function postfachImHintergrundAbholen(): void {
  postfachAbholenUndAnzeigen(weckrufAboBlick ?? (() => false), { stumm: true });
}

/**
 * Abholen aus der App heraus, ohne eigenen Abo-Blick — derselbe Anzeige-Weg
 * wie der Weckruf, mit Ton und Meldung. Für Aufrufer ausserhalb der
 * WS-Handler (Annehmen eines Anrufs, `anrufe/anrufSchluesselweg.ts`).
 * **Nie `postfachAbholenUndEntschluesseln` direkt:** ein Zyklus gibt sein
 * Ergebnis nur dem zurück, der ihn startete (`krypto/postfachNachlauf.ts`) —
 * startet ihn ein anderer, liegen die Nachrichten abgelegt und quittiert im
 * Verlauf, erscheinen aber nicht im offenen Gespräch und zählen nicht als
 * ungelesen (Test: `push-bughunt-verdrahtung`).
 */
export function postfachAbholenAusDerApp(): void {
  postfachAbholenUndAnzeigen(weckrufAboBlick ?? (() => false));
}

/** Nach einem gescheiterten Zyklus (nicht stumm) erneut über den Anzeige-Weg
 *  abholen: 2 s, 5 s, 15 s, dann bis zum nächsten Auslöser Ruhe
 *  (`../nachholTakt.ts`). Bis 2026-10-21 holte im Vordergrund erst das
 *  nächste `postfach_neu`/`ready` wieder ab. */
const postfachWiederholung = postfachWiederholerErzeugen(() => postfachAbholenAusDerApp());

/**
 * Holt offene Postfach-Zustellungen ab, entschluesselt sie und zeigt sie an
 * — geteilt zwischen den Ausloesern (Bughunt-Runde 3, FIX 1): dem `postfach_
 * neu`-Weckruf hier unten UND `ws/handlers/ready.ts` (jeder Connect/Reconnect
 * — bis Runde 3 gab es dort GAR KEINEN Abholversuch, sodass eine waehrend
 * der Abwesenheit zugestellte Nachricht nie abgefragt wurde, wenn Tab-Schluss/
 * Verbindungsabriss/ein verlorener Redis-Weckruf den einzigen Ausloeser
 * verpasste — s. `docs/superpowers/plans/2026-08-28-etappe-d2-klient-
 * verschluesselt.md`, „Auf `postfach_neu` (WS) und beim Start abholen"). Das
 * eigentliche Einzeltakt-Gate (`mitNachlaufBeiWeckung`, s.
 * `postfachNachlauf.ts`) sitzt in `empfangen.ts` — die Ausloeser haengen
 * sich bei Ueberlappung an denselben (oder einen vorgemerkten Nachlauf-)
 * Zyklus an, statt ihn doppelt zu fahren. Dritter Ausloeser seit 2026-10-20:
 * der Hintergrund-Takt (`postfachImHintergrundAbholen`, mit `stumm`). Das
 * Verbuchen steht in `./postfachVerbuchen.ts`.
 *
 * `istAboniert` entscheidet, ob eine neue Nachricht sofort als gelesen gilt
 * (der Kanal ist gerade offen) oder den Ungelesen-Zaehler erhoeht — sowohl
 * der `postfach_neu`-Aufrufer als auch der `ready`-Aufrufer reichen dafuer
 * denselben Live-Blick auf `subs` durch (`ctx.subs` bzw. `ctx.getSubs()`,
 * s. `ready.ts`), keiner der beiden faellt mehr auf "nie abonniert" zurueck.
 */
export function postfachAbholenUndAnzeigen(
  istAboniert: (kanalId: string) => boolean,
  { stumm = false }: { stumm?: boolean } = {}
): void {
  // Solange ALLE DREI Schalter aus sind (s. `$lib/krypto/schalter.ts` +
  // `$lib/featureFlags.ts`), bleibt dieser Weckruf wirkungslos und jede DM
  // laeuft ueber `message` weiter. **Alle drei, nicht nur der DM-Schalter**:
  // das Postfach traegt seit Etappe G auch Gruppen-Umschlaege (private
  // Gruppen UND Ablage-Kanaele, s. `zustellungOeffnen.ts`), und die haben
  // keinen Klartext-Weg, auf den man ausweichen koennte. Stuende hier
  // weiter nur `E2E_DMS_ENABLED`, waere eine allein freigeschaltete Gruppe
  // bzw. ein allein freigeschalteter Ablage-Kanal stumm — verschluesselt
  // zugestellt, aber nie abgeholt.
  if (!E2E_DMS_ENABLED && !PRIVATE_GRUPPEN_ENABLED && !ABLAGE_KANAL_ENABLED) {
    // Nichts abzuholen heisst trotzdem: die Lage ist geladen. Ohne diese
    // Freigabe bliebe die Badge-Meldung einer Hülle ohne Krypto für immer
    // stumm (s. `platform/badgeDrossel.ts`).
    badgeMeldungFreigeben();
    return;
  }
  // Dynamischer Import: der Krypto-Kern (WASM) soll nicht in jedem
  // Session-Start geladen werden, wenn er nie gebraucht wird.
  void import('$lib/krypto/empfangen')
    .then(({ postfachAbholenUndEntschluesseln }) => postfachAbholenUndEntschluesseln())
    // Abgelegt hat `empfangen.ts` schon selbst; hier kommt nur noch die
    // Anzeige dazu. **Jedes Ergebnis genau einmal:** `mitNachlaufBeiWeckung`
    // gibt allen Aufrufern, die sich an denselben Nachlauf haengen (Weckruf,
    // `ready`, Hintergrund-Takt), DIESELBE Liste zurueck. Verbuchte jeder sie,
    // zaehlte „ungelesen" jede Nachricht doppelt. Also verbucht, wer die Liste
    // zuerst sieht — mit SEINEM `stumm`. Gemischt kommt das nur vor, wenn sich
    // ein Weckruf an eine Runde des Hintergrund-Takts haengt; die App ist
    // dann hinten, und gezaehlt wird so oder so.
    .then((neue) => {
      postfachWiederholung.erfolgreich();
      if (verbucht.has(neue)) return;
      verbucht.add(neue);
      zustellungenVerbuchen(neue, istAboniert, { stumm });
    })
    .catch((err: unknown) => {
      // Bis 2026-09-03 stand hier ein leeres `catch` — ein Fehler beim
      // Abholen verschwand spurlos und sah aus wie "nichts da".
      console.warn('[postfach] Abholen fehlgeschlagen', {
        fehler: err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      });
      // Der Hintergrund-Takt (`stumm`) hat seinen eigenen 60-s-Rhythmus.
      if (!stumm) postfachWiederholung.fehlgeschlagen();
    })
    // **Ganz am Ende der Kette, nicht früher.** Ab hier darf der Klient seine
    // Ungelesen-Zahl an den Server melden (s. `platform/badgeDrossel.ts`) —
    // und das gilt erst, wenn die Umschläge dieses Durchlaufs VERBUCHT sind,
    // nicht schon, wenn sie geholt wurden. Zwischen Holen und Verbuchen liegt
    // ein Microtask, in dem die Zähler noch leer sind; eine dort gemeldete 0
    // hiesse „alles gelesen" und löschte den richtigen Serverstand. `finally`,
    // weil auch ein gescheiterter Durchlauf die Meldung nicht für den Rest
    // der Sitzung stumm stellen darf.
    .finally(badgeMeldungFreigeben);
}

/** Ob die Anzeige unter dieser ID eine verschlüsselte Nachricht zeigt. */
function verschluesseltAngezeigt(kanalId: string, id: string): boolean {
  return messages.for(kanalId).some((m) => m.id === id && m.verschluesselt === true);
}

export function register(ctx: HandlerContext): void {
  registerWsHandler('message', (evt) => {
    messages.upsert(evt.data);
    void verlaufSpeichern(evt.data.channel_id, [evt.data]);
    // A delivered message means the author just stopped typing — drop their
    // "X schreibt …" immediately instead of waiting out the 6s TTL.
    typing.clear(evt.data.channel_id, evt.data.author_id);
    // Own messages don't make a channel unread for ourselves.
    if (evt.data.author_id !== dispatchingUserId()) {
      readState.recordSeen(evt.data.channel_id, evt.data.id);
      // We only get this op for channels we're subscribed to — i.e. the
      // one we're currently viewing — so it's safe to also mark it read.
      if (ctx.subs.has(evt.data.channel_id)) {
        readState.markRead(evt.data.channel_id, evt.data.id);
      }
    }
  });

  // Bearbeiten und Löschen vom Server gelten nur für Klartext (Gegenprüfung
  // 2026-10-12, Fund 4). Eine verschlüsselte Nachricht kennt der Server nicht
  // — ihre Bearbeitung und Löschung reisen als Aktions-Frames durchs Postfach
  // (`krypto/empfangen.ts`). Ein Server-Ereignis mit ihrer ID schrieb bis
  // dahin blind über sie (Grabstein aufgehoben, Kennung und Reaktionen weg)
  // bzw. löschte sie ohne Autorprüfung, samt Stein in der Sicherung, der
  // beim Wiederherstellen jede Kopie traf. Jetzt bleiben Anzeige und
  // Verlauf unangetastet (`verlaufSpeichern` überschreibt keinen
  // verschlüsselten Satz, `nurKlartext` beim Löschen).
  registerWsHandler('message_update', (evt) => {
    if (!verschluesseltAngezeigt(evt.data.channel_id, evt.data.id)) messages.update(evt.data);
    void verlaufSpeichern(evt.data.channel_id, [evt.data]);
  });

  registerWsHandler('message_delete', (evt) => {
    if (!verschluesseltAngezeigt(evt.data.channel_id, evt.data.id)) {
      messages.remove(evt.data.channel_id, evt.data.id);
    }
    verlaufNachrichtGeloescht(evt.data.channel_id, evt.data.id, { nurKlartext: true });
  });

  registerWsHandler('reaction_add', (evt) => {
    messages.applyReaction(evt.data, +1);
  });

  registerWsHandler('reaction_remove', (evt) => {
    messages.applyReaction(evt.data, -1);
  });

  registerWsHandler('pin_update', (evt) => {
    // Angepinnt/gelöst — alle Kanal-Mitglieder bekommen das, damit die
    // Pin-Liste im Kanalkopf ohne Reload aktuell bleibt.
    messages.applyPin(evt.data);
  });

  registerWsHandler('typing', (evt) => {
    // Ephemeral "X schreibt …". The sender gets its own echo back — ignore it.
    if (evt.user_id === dispatchingUserId()) return;
    userCache.queue(evt.user_id); // so we can show their name
    typing.mark(evt.channel_id, evt.user_id);
  });

  registerWsHandler('message_ack', () => {
    // No-op on the dispatcher side: the send/ack flow is handled by the
    // optimistic-send path in messages store, not via the registry.
  });

  registerWsHandler('channel_bump', (evt) => {
    if (evt.author_id !== dispatchingUserId() && guilds.byId[evt.guild_id]) {
      readState.recordSeen(evt.channel_id, evt.message_id);
      // If we're currently viewing this channel the message op already
      // ran the markRead — but in case the bump arrived first, do it
      // again here. markRead is idempotent. Ob die Nachricht selbst
      // angekommen ist, prüft `bumpNachschauen` nach der Frist (`../bumpWache.ts`).
      if (ctx.subs.has(evt.channel_id)) {
        readState.markRead(evt.channel_id, evt.message_id);
        bumpNachschauen(evt.channel_id, evt.message_id);
      } else {
        readState.incUnread(evt.channel_id, evt.message_id);
        if (!isRecentMention(evt.message_id) && !isDnd() && !serverStumm()) {
          sounds.play('notification.message', { guildId: evt.guild_id });
        }
      }
    }
  });

  registerWsHandler('dm_bump', (evt) => {
    // We get this fanned to every connected socket — first decide if
    // we're a member (one of the two user ids). Non-members ignore.
    const me = dispatchingUserId();
    if (!me) return;
    const isMember = evt.user_a_id === me || evt.user_b_id === me;
    if (!isMember) return;
    // Upsert: bumps an existing DM's last_message_id, or creates the
    // record if the other side just opened a new DM with us (we
    // wouldn't have it in the store yet otherwise).
    directMessages.upsertFromBump({
      channel_id: evt.channel_id,
      user_a_id: evt.user_a_id,
      user_b_id: evt.user_b_id,
      message_id: evt.message_id,
      currentUserId: me
    });
    if (evt.author_id !== me) {
      readState.recordSeen(evt.channel_id, evt.message_id);
      const offen = ctx.subs.has(evt.channel_id);
      if (offen) bumpNachschauen(evt.channel_id, evt.message_id);
      if (offen && siehtHin()) {
        // Already viewing this DM — mark read, no toast.
        readState.markRead(evt.channel_id, evt.message_id);
      } else {
        readState.incUnread(evt.channel_id, evt.message_id);
        dmVorschauAuffrischen();
        // Not currently in this DM. Toast the user. We intentionally
        // surface only the sender's name, not the message content,
        // so the UX stays identical when DMs go E2EE in Phase 2.
        // If the sender isn't in cache yet (we've never rendered them
        // anywhere) we just drop the name from the toast rather than
        // show a "…" placeholder.
        const cached = userCache.get(evt.author_id);
        const senderLabel = cached
          ? m.chat_handler_dm_sender_label({ sender: '@' + (cached.display_name ?? cached.username) })
          : '';
        // Kein Toast neben dem offenen Gespräch, dessen Fenster nur den Fokus
        // verloren hat; Sichtschutz, Nicht-stören und die knappe Handy-Form
        // regelt `neueNachrichtToast` (`postfachBenachrichtigung.ts`).
        if (!offen) {
          neueNachrichtToast(m.chat_handler_dm_new_message({ senderLabel }), evt.channel_id);
        }
        // OS-level notification when the window is in the background — the
        // toast above is only visible while Pulse is focused. The helper
        // self-gates on background + DND + the onDM toggle. Body stays
        // content-free (sender name only) to match the toast's privacy stance
        // (DMs go E2EE in Phase 2).
        const senderName = cached?.display_name ?? cached?.username ?? null;
        fireInPageNotification({
          kind: 'dm',
          title: senderName ?? m.chat_handler_dm_notification_unknown_sender(),
          body: m.chat_handler_dm_notification_body(),
          channelId: evt.channel_id,
          messageId: evt.message_id,
          guildId: null
        });
        if (!isRecentMention(evt.message_id) && !isDnd()) {
          sounds.play('notification.dm');
        }
        // Eine Direktnachricht erreicht uns bei offener App: Anlass für die
        // Mitteilungsfrage (nur iOS, nur solange noch nichts entschieden ist).
        mitteilungsAnlassMelden();
      }
    }
  });

  // Gruppen sind DAUERHAFT abonniert (ready abonniert jede) — der rohe
  // Subs-Blick stufte JEDE Gruppennachricht als „gelesen" ein: keine
  // Ungelesen-Marke, kein Ton, kein Toast (Befund 05.10., derselbe Fund
  // wie Bughunt Runde 5 am ready-Pfad — dort gefixt, hier übersehen).
  // Für Gruppen gilt „offen", nicht „abonniert"; DMs/Ablage bleiben bei
  // ihrem Abo-Blick.
  const aboBlick = (kanalId: string): boolean => {
    if (privateGruppen.istGruppe(kanalId)) return page.params.dmChannelId === kanalId;
    return ctx.subs.has(kanalId);
  };
  weckrufAboBlick = aboBlick;
  registerWsHandler('postfach_neu', () => {
    // Der Server hat dafür womöglich an ein iOS-Gerät gepusht und dabei
    // hochgezählt — nach dem Abholen den Stand neu melden (C1).
    badgeNachZustellung();
    postfachAbholenUndAnzeigen(aboBlick);
  });

  registerWsHandler('dm_lesestand', (evt) => {
    // Serverseitiger Lesefortschritt (P0.2). Eigener Stand: andere Geräte
    // des eigenen Kontos löschen damit ihre Ungelesen-Zähler (die eigene
    // markRead-Meldung kommt als Echo wieder und ist durch den Vorwärts-Merge
    // harmlos). Fremder Stand — nur bei beidseitig eingeschalteten
    // Lesebestätigungen geschickt: Lese-Häkchen an der eigenen Bubble.
    const me = dispatchingUserId();
    if (!me) return;
    if (evt.user_id === me) {
      readState.seedOwnLesestand(evt.channel_id, evt.last_read_message_id);
    } else {
      quittungen.gelesenMelden(evt.channel_id, evt.user_id, evt.last_read_message_id);
    }
  });

  registerWsHandler('mention_added', (evt) => {
    // Per-user notification fanned out only to mentioned sockets. We
    // intentionally drive the unread-mention badge from THIS event
    // only (not from `message.mentions`) so the counter logic stays
    // idempotent: the backend deduplicates the recipient set, we
    // don't have to. If the user is actively viewing the channel,
    // the inline `markRead` below clears the counter immediately.
    const { channel_id, message_id, guild_id } = evt.data;
    const viewingMentioned = ctx.subs.has(channel_id);
    readState.incMention(channel_id);
    // Record before the matching channel_bump/dm_bump arrives so the
    // generic sound is suppressed.
    markRecentMention(message_id);
    if (viewingMentioned) {
      // Already looking at the channel — clear the counter, no chime
      // (a sound for the focused channel is just noise).
      readState.markRead(channel_id, message_id);
    } else {
      if (!isDnd() && !serverStumm()) sounds.play('notification.mention', { guildId: guild_id });
    }
    // In-page notification (only fires when tab is in background — the
    // helper gates on visibility + settings). The matching push from the
    // SW collapses on the shared `message_id` tag, so the user sees one
    // popup at most. Look up the message we just received for body text;
    // it may not be in the local store yet if the user has never opened
    // the channel — in that case we fall back to a generic body.
    const msg = messages.for(channel_id).find((m) => m.id === message_id);
    const author = msg ? userCache.get(msg.author_id) ?? null : null;
    const authorName = author?.display_name ?? author?.username ?? m.chat_handler_mention_unknown_author();
    const snippet = msg?.content?.slice(0, 140) ?? m.chat_handler_mention_fallback_body();
    const channelName = (() => {
      if (guild_id) {
        const list = guilds.channelsByGuild[guild_id] ?? [];
        const c = list.find((x) => x.id === channel_id);
        return c?.name ? `#${c.name}` : m.chat_handler_mention_fallback_channel();
      }
      return m.chat_handler_mention_fallback_dm();
    })();
    fireInPageNotification({
      kind: guild_id ? 'mention' : 'dm',
      title: `${authorName} in ${channelName}`,
      body: snippet,
      channelId: channel_id,
      messageId: message_id,
      guildId: guild_id
    });
  });

  registerWsHandler('stream_chat_message', (evt) => {
    streamChat.apply(evt.channel_id, evt.streamer_id, evt.message);
  });

  registerWsHandler('watch_chat_message', (evt) => {
    watchChat.apply(evt.channel_id, evt.party_id, evt.message);
  });

  registerWsHandler('watch_chat_reaction', (evt) => {
    watchChat.applyReaction(evt.data);
  });
}
