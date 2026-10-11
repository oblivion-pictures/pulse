import { untrack } from 'svelte';
import type { Herkunft } from '$lib/navigation/herkunft';
import { navigationsHerkunft } from '$lib/navigation/navigationsHerkunft';
import { appSperre } from '$lib/platform/appSperre.svelte';
import { voice } from './livekit.svelte';
import { routeBeitritt } from './startBeitritt';
import { startTor } from './startTor.svelte';

/**
 * Der Auto-Beitritt der Kanal-Route am Handy: wer in der App auf einen
 * Sprachkanal tippt, sitzt danach darin (eine Vollbild-Seite ohne Verbindung
 * zeigte sonst nur „nicht verbunden"; spiegelt das frühere
 * `VoiceChannelView.onMount`-Auto-Join). Die Entscheidung steht geprüft in
 * `startBeitritt.ts::routeBeitritt` — **nur nach einem Tipp in der App, und
 * erst wenn der Start durch ist.** Bis zum 2026-10-11 trat die Route bei
 * JEDER Landung bei: nach einem Link von aussen (D1), nach einem Neuladen
 * vor dem Abgleich mit der Hülle (N1) und nach einem Auflegen in der Hülle
 * (D2). Nach einem Neuladen stellt der Resume-Eintrag den Kanal wieder her,
 * nicht die Adresse.
 *
 * **Nur EINMAL je Landung** (`entschieden`) — nicht reaktiv auf einen
 * Verbindungsabbruch, sonst träte man nach „Verlassen" sofort wieder bei.
 * Die Herkunft wird beim ersten Blick auf den Kanal festgehalten: ein
 * `warten` fragt später erneut, und bis dahin kann längst eine andere
 * Navigation die letzte sein.
 *
 * Aus der Route herausgelöst (Grössen-Policy); während der Initialisierung
 * einer Komponente zu rufen. `kanal` liefert den Sprachkanal, auf dem die
 * Route gerade steht, sonst `null`.
 */
export function routenBeitrittVerdrahten(kanal: () => { id: string; name: string } | null): void {
  let entschieden = '';
  let landung: { kanal: string; herkunft: Herkunft } = { kanal: '', herkunft: 'start' };
  $effect(() => {
    const ch = kanal();
    if (!ch || entschieden === ch.id) return;
    if (landung.kanal !== ch.id) landung = { kanal: ch.id, herkunft: navigationsHerkunft() };
    const antwort = routeBeitritt({
      herkunft: landung.herkunft,
      startFertig: startTor.fertig,
      gesperrt: appSperre.gesperrt,
      imKanal: untrack(() => voice.connected || voice.connecting)
    });
    if (antwort === 'warten') return;
    entschieden = ch.id;
    if (antwort === 'ja') untrack(() => void voice.connect(ch.id, ch.name));
  });
}
