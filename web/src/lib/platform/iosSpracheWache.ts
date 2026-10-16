/**
 * Der Mikrofon-Wächter der iOS-Hülle (`SpracheMikroWache.swift`) aus Sicht des
 * Webs: seine Ereignisse und die Diagnose-Abfrage. Nur an einem Bau, der ihn
 * hat (`nativeWacheDa`, Begründung an `SpracheWachePlugin` in
 * `iosSpracheTypen.ts`). Aus `iosSprache.ts` herausgelöst (Grössen-Policy).
 */

import { iosTonMelden } from '$lib/diagnose/iosTonDiagnose';
import { mitFrist, SPRACHE_FRIST_SOFORT_MS } from './brueckenFrist';
import { huelle, webkitNeuErklaeren } from './iosSprache';
import { nativeWacheDa } from './iosSpracheWeiche';

/** Die Diagnose-Felder der Hülle jetzt (`null` ohne Wächter im Bau). */
export async function spracheDiagnose(): Promise<Record<string, string | number | boolean> | null> {
  if (!nativeWacheDa()) return null;
  const p = huelle();
  return p ? mitFrist(p.diagnose(), SPRACHE_FRIST_SOFORT_MS, 'diagnose') : null;
}

/**
 * Die Ereignisse des Mikrofon-Wächters (`SpracheMikroWache.swift`) — nur an
 * einem Bau, der ihn hat. Diagnose-Zeilen der Hülle landen hier im Ring;
 * `mikroAusfall` (Stufe 1 der Leiter) erklärt WebKit neu, bevor der Aufrufer
 * davon hört. Gibt den Abmelder zurück.
 */
export function spracheWacheBeobachten(h: {
  bereit: () => void;
  tot: (tot: boolean) => void;
}): () => void {
  const p = huelle();
  if (!p || !nativeWacheDa()) return () => undefined;
  const griffe = [
    p.addListener('mikroBereit', () => h.bereit()),
    p.addListener('mikroAusfall', (e) => {
      iosTonMelden('wache_ausfall', { stufe: e.stufe });
      webkitNeuErklaeren('wache');
    }),
    p.addListener('mikroTot', (e) => {
      if (e.tot) iosTonMelden('mikro_tot');
      h.tot(e.tot);
    }),
    p.addListener('diagnose', (e) => iosTonMelden(e.art, e.felder))
  ];
  return () => {
    for (const g of griffe) void g.then((x) => x.remove()).catch(() => undefined);
  };
}
