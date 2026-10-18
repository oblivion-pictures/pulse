/**
 * Native Brücke in die Mobil-Hüllen: Android zeigt eine
 * Full-Screen-Intent-Notification über dem Sperrbildschirm
 * (`mobile/android …/AnrufPlugin.java`, Anrufe-Epic E), iOS seit dem
 * 2026-10-08 den System-Anrufbildschirm (`mobile/ios …/AnrufPlugin.swift`,
 * Punkt 40) und seit Etappe 4 den ganzen Raum (`nativerAnrufRaum.ts`). Beide
 * Seiten tragen denselben Vertrag: gleicher JS-Name, gleiche Methoden,
 * gleiches `aktion`-Ereignis.
 *
 * Annehmen, Ablehnen und Auflegen kommen als `aktion`-Ereignis zurück
 * (`nativeAktionVerarbeiten`), weil die Signalisierung
 * (anrufAnnehmen/anrufAblehnen) im Klienten lebt. In Browser/Electron No-op.
 *
 * Aus `anruf.svelte.ts` herausgelöst (Grössen-Policy).
 */

import { toast } from 'svelte-sonner';

import { anrufAblehnen, anrufAuflegen } from '$lib/api/anrufe';
import { m } from '$lib/paraglide/messages.js';
import { anrufNativ, type AnrufAktion, type AnrufEndgrund } from '$lib/platform/anrufNativ';
import { anrufwegVeraltet, nativerAnrufwegDa } from '$lib/platform/anrufNativWeiche';
import { mitFrist, SPRACHE_FRIST_SOFORT_MS } from '$lib/platform/brueckenFrist';
import { isCapacitorAndroid, isCapacitorIOS } from '$lib/platform/runtime';
import type { AnrufStore } from './anruf.svelte';
import { ohneRaumPlan } from './ohneRaumPlan';

/** Gibt es hier überhaupt eine native Anrufanzeige? An EINER Stelle, weil
 *  die Antwort drei Riegel in dieser Datei bedient — ein Riegel, der die
 *  neue Hülle vergisst, fällt sonst nur auf dem Gerät auf. */
function nativeHuelle(): boolean {
  return isCapacitorAndroid() || isCapacitorIOS();
}

/** Läuft der Raum eines Anrufs nativ (iOS, Etappe 4)? Die Weiche fragt den
 *  installierten Bau (`anrufNativWeiche.ts`). */
export function nativerAnrufweg(): boolean {
  return isCapacitorIOS() && nativerAnrufwegDa();
}

/** Eingehenden Anruf nativ anzeigen (No-op außerhalb der Mobil-Hüllen).
 *
 *  Auf iOS kann derselbe Anruf ZWEIMAL hier ankommen: einmal über die
 *  WebSocket (dieser Weg) und einmal über den VoIP-Push. Die native Seite
 *  prüft deshalb die Kennung und meldet keinen zweiten Bildschirm für
 *  denselben Anruf. Ein Anruf beginnt immer ohne Kamera — einen
 *  „Videoanruf" als eigene Art gibt es nicht (Bughunt G3). */
export async function nativAnkommen(callId: string, gegenstelle: string): Promise<void> {
  if (!nativeHuelle()) return;
  try {
    await anrufNativ.ankommen({ callId, gegenstelle, video: false });
  } catch (e) {
    console.warn('[anruf] native Klingel-Anzeige fehlgeschlagen', e);
  }
}

/** Native Anzeige entfernen (No-op außerhalb der Mobil-Hüllen). Auf iOS
 *  beendet das den CallKit-Anruf samt nativem Raum — ohne diesen Ruf
 *  klingelte das Telefon weiter, nachdem der Anruf im Web vorbei ist.
 *  `grund` bestimmt, was CallKit in den Anrufverlauf schreibt; ältere
 *  Hüllen und Android übergehen ihn.
 *
 *  `callId`: nur DIESEN Anruf beenden. Ohne beendet die Hülle jeden, den sie
 *  führt — und hat sie einen klingelnden Anruf inzwischen durch einen neuen
 *  desselben Kanals abgelöst (R1), räumte das Aufräumen des alten den neuen
 *  gleich mit ab. Eine ältere Hülle und Android übergehen das Feld. */
export async function nativBeenden(grund: AnrufEndgrund, callId?: string): Promise<void> {
  if (!nativeHuelle()) return;
  try {
    await anrufNativ.beenden(callId ? { grund, callId } : { grund });
  } catch (e) {
    console.warn('[anruf] native Klingel-Anzeige entfernen fehlgeschlagen', e);
  }
}

/** Veralteter iOS-Bau ohne nativen Anruf-Raum (E6): Hinweis zeigen, der Aufrufer
 *  bricht ab. Mit `eingehendeId` (ein klingelnder Anruf) räumt es nur die
 *  lokale Anzeige weg — den Anruf NICHT am Server ablehnen, das beendete ihn
 *  für alle Geräte des Kontos. */
export function veralteteHuelleMelden(eingehendeId?: string): boolean {
  if (!anrufwegVeraltet()) return false;
  toast.error(m.anruf_ios_app_veraltet());
  if (eingehendeId) void nativBeenden('fehler', eingehendeId);
  return true;
}

/**
 * **Nach einem Reload aufnehmen, was die Hülle noch hält.** Ein Gespräch mit
 * Raum übernimmt die Seite (`nativUebernehmen`); einen Anruf ohne Raum
 * (`ohneRaum`) zeigt sie wieder an, setzt seine Annahme fort, lehnt ihn ab
 * oder beendet ihn (`ohneRaumPlan.ts`, Bughunt 2, A10). Ein Ereignis, das
 * inzwischen den Zustand gesetzt hat (eine aufbewahrte Aktion), gewinnt.
 */
async function nativAufnehmen(anrufe: AnrufStore): Promise<void> {
  if (anrufe.aktiv || !nativerAnrufweg()) return;
  const z = await mitFrist(anrufNativ.raumZustand(), SPRACHE_FRIST_SOFORT_MS, 'raumZustand')
    .catch(() => null);
  if (!z || anrufe.aktiv) return;
  if (z.kennung && z.zustand !== 'disconnected') {
    anrufe.nativUebernehmen(z);
    return;
  }
  const plan = ohneRaumPlan(z.ohneRaum);
  if (!plan) return;
  if (!('anruf' in plan)) {
    const amServer = plan.tun === 'ablehnen' ? anrufAblehnen : anrufAuflegen;
    void amServer(plan.kennung).catch(() => {});
    void nativBeenden('fehler', plan.kennung);
    return;
  }
  anrufe.eingehend(plan.anruf, plan.name, { ton: false });
  if (plan.tun === 'annehmen') void anrufe.annehmen(plan.name);
}

/**
 * Die native Anzeige an den Anruf-Zustand anbinden (`anruf.svelte.ts`, beim
 * Laden): Annehmen/Ablehnen/Auflegen kommen als `aktion`-Ereignis
 * (`nativeAktionVerarbeiten`), und nach einem Reload nimmt die Seite auf, was
 * die Hülle noch hält (`nativAufnehmen`).
 *
 * **Der Riegel ist PFLICHT:** der Web-Stub von registerPlugin wirft beim
 * addListener ("not implemented on web") und riss sonst das komplette Boot
 * mit — die Login-Seite blieb im Browser weiß (Befund 2026-09-09).
 */
export function nativAnbinden(anrufe: AnrufStore): void {
  if (!nativeHuelle()) return;
  void anrufNativ.addListener('aktion', (daten) => nativeAktionVerarbeiten(anrufe, daten));
  void nativAufnehmen(anrufe);
}

/**
 * Eine Aktion aus der nativen Anzeige (Android: Notification, iOS: CallKit)
 * am Anruf-Zustand ausführen — `nativAnbinden` hängt das an das
 * `aktion`-Ereignis. Gehört sie nicht zum laufenden Anruf (verspäteter Tap
 * auf eine alte Klingel-Notification), bleibt der Zustand unberührt.
 */
function nativeAktionVerarbeiten(anrufe: AnrufStore, daten: AnrufAktion): void {
  const { aktion, callId } = daten;
  let anruf = anrufe.aktiv;
  // **Der kalt gestartete Anruf ist der Fall, der hier leicht fehlt.** Wird
  // ein Anruf per VoIP-Push auf dem Sperrbildschirm angenommen, hat das Web
  // nie ein `call_klingelt` gesehen: `aktiv` ist leer, und ein blosses
  // „Kennung passt nicht" verwürfe die Annahme. Der Push trägt den Kanal
  // mit, also wird der Zustand hier nachgezogen — erst danach annehmen.
  // `anruf_art` ist `dm`/`gruppe`; bis zum 2026-10-11 stand hier ein
  // Rückfall auf das ungültige `audio` (Bughunt G3).
  // Ohne DM-Ton: CallKit hat schon geklingelt und angenommen (A9).
  if (!anruf && aktion === 'annehmen' && daten.channel_id) {
    anrufe.eingehend(
      {
        call_id: callId,
        art: daten.anruf_art === 'gruppe' ? 'gruppe' : 'dm',
        channel_id: daten.channel_id,
        einleiter_id: daten.einleiter_id ?? ''
      },
      daten.einleiter_name ?? 'Pulse',
      { ton: false }
    );
    anruf = anrufe.aktiv;
  }
  if (aktion === 'beendet') {
    // **Die Hülle hat den Anruf selbst geschlossen** — ein Abbruch-Push kam,
    // oder ein neuer Anruf desselben Kanals hat ihn abgelöst (R1, R3). Am
    // Server ist er schon vorbei, also kein Ruf dorthin; hier nur abräumen,
    // was die Oberfläche noch zeigt. Bis zur Nachprüfung der Fix-Runden
    // erfuhr sie davon nichts: ein nach einem Neuladen wieder angezeigtes
    // Klingeln stand bis zu 45 s weiter da und lehnte jeden neuen Anruf ab.
    // `ende` mit einem Grund, den der Server nie schickt: keine Systemzeile,
    // kein Hinweis — WARUM es vorbei ist, weiss die Hülle nicht.
    if (anruf?.id === callId) anrufe.ende(callId, 'beendet', 0);
    return;
  }
  if (!anruf || anruf.id !== callId) {
    // **Ein Ende, das die Oberfläche nicht kennt** — sie war eingefroren
    // oder neu geladen, während im System-Bildschirm aufgelegt oder
    // abgelehnt wurde oder der native Raum wegbrach. Der Server muss es
    // trotzdem erfahren, sonst sitzt die Gegenseite in einem Anruf mit
    // niemandem. Dafür genügt die Kennung; der Kontext (`channel_id`, …)
    // zählt nur für eine Annahme (oben) und fehlt bei einem Anruf, den die
    // Hülle ohne CallKit führte (`vonDerHuelleBeendet`, Anrufverwaltung).
    // `getrennt` fiel hier bis zum 2026-10-11 still durch — ein bekannter
    // Anruf legt dafür auf (`auflegen('fehler')` unten), ein unbekannter tat
    // nichts.
    if (aktion === 'auflegen' || aktion === 'getrennt') void anrufAuflegen(callId).catch(() => {});
    else if (aktion === 'ablehnen') void anrufAblehnen(callId).catch(() => {});
    return;
  }
  switch (aktion) {
    case 'annehmen':
      void anrufe.annehmen(anruf.gegenstelle);
      break;
    case 'auflegen':
      void anrufe.auflegen();
      break;
    case 'getrennt':
      // Der native Raum ist weg — wie ein Abbruch im Web-Weg. Der Server
      // bekommt das Auflegen mit, damit die Gegenseite nicht wartet.
      toast.error(m.anruf_verbindung_verloren());
      void anrufe.auflegen('fehler');
      break;
    default:
      // **`ablehnen` aus CallKit gilt nur für einen KLINGELNDEN Anruf** (M5):
      // ein laufender wird über `auflegen` beendet. Eine ältere Hülle schickt
      // für beides `ablehnen` — dann entscheidet hier der eigene Zustand.
      if (anruf.zustand === 'klingelt') void anrufe.ablehnen();
      else void anrufe.auflegen();
  }
}
