/**
 * Was das App-Layout (`routes/app/+layout.svelte`) über die Lage des Geräts
 * entscheidet: welche Leisten stehen und wie die Hülle zum Stream steht.
 * Herausgelöst, damit das Layout unter der Größen-Grenze bleibt; **Verhalten
 * unverändert**. Aufzurufen beim Anlegen der Komponente (die `$effect`s hängen
 * sich an sie).
 */
import { page } from '$app/state';
import { guilds } from '$lib/stores/guilds.svelte';
import { voice } from '$lib/voice/livekit.svelte';
import { openedTiles } from '$lib/stream/openedTiles.svelte';
import { kachelVollbildLage } from '$lib/stream/kachelVollbildLage.svelte';
import { huellenLage } from '$lib/platform/huellenLage.svelte';
import { orientierungSperren } from '$lib/platform/orientation';
import { isCapacitorIOS } from '$lib/platform/runtime';
import { istDetailScreen } from './tabs';
import { kanalAusPfad, istAktiverSprachKanal } from './kanalBildschirm';

/** Die Geräte-Frage beantwortet die Route (`scripts/geraete-trennung.sh`) und
 *  reicht sie als Getter herein. */
export function layoutLage(frage: {
  hydrated: () => boolean;
  handy: () => boolean;
  tablet: () => boolean;
}) {
  const { hydrated, handy, tablet } = frage;
  // Die eine Regel, die entscheidet, wer auf welcher Bildschirmgroesse
  // navigiert. Steht bewusst NUR hier: die Leisten rendern sich nicht selbst
  // weg, sonst gaebe es zwei Stellen mit derselben Bedingung.
  //
  //   Handy   : Bereichs-Leiste unten, ausser auf einem Detail-Bildschirm
  //   Tablet  : Bereichs-Spalte links
  //   Desktop : keines von beidem — das Drei-Spalten-Layout bleibt unberuehrt
  //
  // Auf einem Detail-Bildschirm (offenes Gespraech, Kanal, Einstellungsseite)
  // verschwindet die Leiste, damit der Bildschirm dem Inhalt gehoert; zurueck
  // fuehrt der Pfeil oder die System-Geste.
  //
  // AUSNAHME Sprachkanal: der ist laufender Zustand, nicht ein Durchgangs-
  // Bildschirm — die Leiste bleibt (2026-08-25, Nutzerwunsch), der Stream
  // füllt die Fläche, Teilnehmer und Controls schweben darüber. Ein TEXTkanal
  // ist die Ausnahme ausdrücklich NICHT: dort stünden Zurück-Pfeil und
  // Bereichs-Leiste gleichzeitig da, und der Verfasser verlöre die Höhe.
  let kanalAufSchirm = $derived(kanalAusPfad(page.url.pathname));
  let istSprachBildschirm = $derived.by(() => {
    const k = kanalAufSchirm;
    if (!k) return false;
    return (guilds.channelsByGuild[k.guildId] ?? []).some(
      (c) => c.id === k.channelId && c.type === 1
    );
  });
  // Quer-Handy MIT offenem Stream: reines Stream-Vollbild — Bereichs-Leiste
  // und Voice-Dock bleiben aus (Steuerung schwebt auf dem Bild). Ohne Stream
  // bleibt quer alles wie hochkant: die normale mobile Ansicht, nur breiter.
  //
  // Geprüft wird der Kanal, in dem der Stream WIRKLICH läuft. „Irgendein
  // Kanal-Bildschirm" genügte nicht: wer aus dem Sprachkanal mit Stream in
  // einen Textkanal wechselt und dann kippt, verlöre sonst Leiste, Dock,
  // Community-Leiste und Kanalliste gleichzeitig — auf einem Textchat, der
  // von dem Stream gar nichts weiss.
  // `streamAngedockt` ist die Viewport-unabhängige Kernbedingung, die auch die
  // Orientierungs-Sperre unten nutzt (dort ohne die Viewport-Anteile).
  let streamAngedockt = $derived(
    voice.connected &&
      istAktiverSprachKanal(page.url.pathname, voice.channelId) &&
      openedTiles.hasAny(voice.channelId!)
  );
  // **Nur iOS-Hülle.** Der alte Ausdruck `istHandy && !isMobile` verglich seit
  // der Geräteklassen-Vereinheitlichung (2026-09-04) dieselbe Klasse mit ihrer
  // eigenen Negation und war immer falsch; Android bleibt dabei. `quer` rechnet
  // wie die Querformat-Wache der HQ-Kachel (`istQuer`) — nach der
  // BILDSCHIRMGRÖSSE, nicht nach der Fensterbreite (die Geräteklasse bleibt im
  // Querformat `handy`). Quer bekommt der Stream die Fläche: Tab-Leiste,
  // Voice-Dock und Kopfzeile weichen.
  const istIosHuelle = isCapacitorIOS();
  let kanalQuerStream = $derived(
    istIosHuelle && handy() && huellenLage.quer && streamAngedockt
  );
  let zeigeDockUnten = $derived(
    handy() && !kanalQuerStream && (voice.connected || voice.connecting)
  );
  let zeigeLeisteUnten = $derived(
    hydrated() &&
      handy() &&
      !kanalQuerStream &&
      (!istDetailScreen(page.url.pathname) || istSprachBildschirm)
  );
  // Nur die Tablet-Klasse traegt die linke Navigations-Spalte — die Partition
  // im Store schliesst handy wie desktop bereits aus, keine zweite Bedingung.
  let zeigeSpalteLinks = $derived(hydrated() && tablet());

  // Mobil-Hüllen (Android und iOS): Querformat nur mit ANGEDOCKTEM Stream ODER
  // Kachel-Vollbild. Ein Stream im Popup-Eckfenster (Corner-Mode: man hat den
  // Kanal verlassen) lockt trotzdem auf Hochformat — quer ist nur fürs
  // Stream-Vollbild auf dem Kanal-Bildschirm gedacht. Bedingung = kanalQuerStream
  // OHNE die Viewport-Anteile (die hängen am aktuellen Format und würden die
  // Sperre sonst selbst blockieren: gesperrtes Hochformat ⇒ nie breit ⇒ nie frei).
  // Das KACHEL-VOLLBILD zählt seit 2026-10-19 mit: dort ohne Freigabe drehte
  // das Gerät nicht (Nutzerbefund „Vollbild + kippen passiert nichts“).
  $effect(() => {
    void orientierungSperren(!(streamAngedockt || kachelVollbildLage.offen > 0));
  });

  // iOS-Hülle: Quer-/Tastatur-Lage beobachten (`huellenLage`), und die Kopfzeile
  // des Kanals weicht dem Stream, solange er quer die Fläche bekommt.
  $effect(() => huellenLage.starten());
  $effect(() => {
    const wurzel = document.documentElement;
    wurzel.toggleAttribute('data-quer-stream', kanalQuerStream);
    return () => wurzel.removeAttribute('data-quer-stream');
  });

  return {
    get zeigeDockUnten() {
      return zeigeDockUnten;
    },
    get zeigeLeisteUnten() {
      return zeigeLeisteUnten;
    },
    get zeigeSpalteLinks() {
      return zeigeSpalteLinks;
    }
  };
}
