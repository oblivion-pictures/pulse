/**
 * „Diesen Bildschirm schließen" (Fernsteuerung, Standplatz-Geräte): die reinen
 * Regeln — welcher Platz in einem `schirm_zu`-Signal steht, und dass Eingaben
 * an einen gerade schließenden Platz verworfen statt als Fehler gewertet werden.
 *
 * Ausgeführt mit Nodes eingebautem Testläufer: `pnpm test:unit`. Das Modul
 * unter Prüfung importiert bewusst nichts (`pnpm test:unit`-Falle).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Abschiede, ABSCHIED_MS, slotAusSignal } from '../src/lib/remote/schirmZuRegel.ts';

describe('slotAusSignal', () => {
  it('nimmt eine ganze Platznummer im erlaubten Bereich', () => {
    assert.equal(slotAusSignal({ slot: 0 }, 4), 0);
    assert.equal(slotAusSignal({ slot: 3 }, 4), 3);
  });

  it('weist alles andere ab — das Signal kommt von der Gegenseite', () => {
    for (const daten of [
      { slot: 4 },
      { slot: -1 },
      { slot: 1.5 },
      { slot: '1' },
      {},
      null,
      'x',
    ]) {
      assert.equal(slotAusSignal(daten, 4), null, JSON.stringify(daten));
    }
  });
});

describe('Abschiede', () => {
  /** Der Fehlerfall dahinter: unter Windows endet der Sidecar eines Platzes
   *  nach `stop` von selbst, und ein Eingabe-Frame, der genau dann ankommt,
   *  wird abgewiesen — `ws/handlers/remote.ts` beendet daraufhin die GANZE
   *  Sitzung. Der Klick auf „schließen" kommt aus genau diesem Fenster, solche
   *  Frames sind also wahrscheinlich unterwegs. */
  it('verwirft Eingaben an einen schließenden Platz bis zum Ablauf der Frist', () => {
    const a = new Abschiede();
    a.markieren(2, 1_000);
    assert.equal(a.verwirft(2, 1_000), true);
    assert.equal(a.verwirft(2, 1_000 + ABSCHIED_MS - 1), true);
    assert.equal(a.verwirft(2, 1_000 + ABSCHIED_MS), false, 'danach wieder normal');
  });

  it('lässt andere Plätze unberührt', () => {
    const a = new Abschiede();
    a.markieren(2, 0);
    assert.equal(a.verwirft(1, 0), false);
  });

  /** Wird derselbe Bildschirm gleich wieder geholt, bekommt er womöglich
   *  denselben Platz — dessen Eingaben dürfen dann nicht im Nichts landen. */
  it('ein neu belegter Platz kann den Abschied vorzeitig aufheben', () => {
    const a = new Abschiede();
    a.markieren(2, 0);
    a.aufheben(2);
    assert.equal(a.verwirft(2, 1), false);
  });
});
