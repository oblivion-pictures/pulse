/**
 * Die Dateien eines geteilten Pakets (iOS) für den Composer holen — mit
 * Fortschrittsanzeige, und nur, solange der Chat derselbe bleibt: das Laden
 * dauert bei vielen oder großen Dateien spürbar, und wer währenddessen den
 * Chat wechselt, soll sie nicht im falschen Chat vorfinden (sonst ginge ein
 * privates Foto an die falsche Gegenseite).
 */
import { toast } from 'svelte-sonner';
import { m } from '$lib/paraglide/messages.js';
import type { GeteilteDatei } from './freigabeRechnung';

/** `gleicherChat`: liefert `false`, sobald der Composer einen anderen Kanal
 *  trägt als beim Start. `uebersprungen`: schon vorab aussortierte Dateien,
 *  sie zählen im Hinweis zu den nicht übernommenen. Ergebnis: die zu
 *  übernehmenden Dateien (leer, wenn der Chat gewechselt wurde). */
export async function geteilteDateienHolen(
  paketId: string,
  dateien: GeteilteDatei[],
  uebersprungen: number,
  gleicherChat: () => boolean
): Promise<File[]> {
  const { dateienLaden } = await import('./freigabeDateien');
  const toastId = toast.loading(m.freigabe_laedt({ aktuell: 0, gesamt: dateien.length }));
  try {
    const { dateien: geladen, fehlgeschlagen } = await dateienLaden(paketId, dateien, (aktuell) =>
      toast.loading(m.freigabe_laedt({ aktuell, gesamt: dateien.length }), { id: toastId })
    );
    if (!gleicherChat()) {
      toast.info(m.freigabe_chat_gewechselt());
      return [];
    }
    const nichtUebernommen = fehlgeschlagen + uebersprungen;
    if (nichtUebernommen > 0) toast.info(m.freigabe_nicht_uebernommen({ anzahl: nichtUebernommen }));
    return geladen;
  } finally {
    toast.dismiss(toastId);
  }
}
