/**
 * Abbestellte Kacheln: ein Bildschirm, den der Steuernde gerade geschlossen hat,
 * darf nicht automatisch wieder aufgehen, solange der Server ihn noch als
 * laufend führt (bis zu 3 s, Poller von media-svc). Ohne Sperre öffnete die
 * Automatik in `VoiceChannelView.svelte` („weiterer Bildschirm desselben
 * Streamers") sein Fenster drei- bis sechsmal neu, jedes Mal mit WHEP 404
 * (Live-Lauf 2026-10-16, 0.1.118).
 *
 * Ausgeführt mit Nodes eingebautem Testläufer: `pnpm test:unit`. Das Modul
 * unter Prüfung importiert bewusst nichts.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ABBESTELLT_MS, Abbestellungen } from '../src/lib/stream/abbestellt.ts';

describe('Abbestellungen', () => {
  it('sperrt die Kachel, solange ihr Strom noch gelistet ist', () => {
    const a = new Abbestellungen();
    a.abbestellen('k', 'u:1', 0);
    a.abgleichen('k', new Set(['u:0', 'u:1']));
    assert.equal(a.gesperrt('k', 'u:1', 1_000), true);
    assert.equal(a.gesperrt('k', 'u:0', 1_000), false, 'andere Kacheln unberührt');
    assert.equal(a.gesperrt('x', 'u:1', 1_000), false, 'anderer Kanal unberührt');
  });

  /** Verschwindet der Strom aus der Liste, ist er beendet — ein späterer auf
   *  demselben Platz ist ein NEUER Strom und darf wieder von selbst aufgehen. */
  it('fällt, sobald der Strom aus der Liste verschwunden ist', () => {
    const a = new Abbestellungen();
    a.abbestellen('k', 'u:1', 0);
    a.abgleichen('k', new Set(['u:0']));
    a.abgleichen('k', new Set(['u:0', 'u:1']));
    assert.equal(a.gesperrt('k', 'u:1', 1_000), false);
  });

  it('wer den Bildschirm ausdrücklich wieder holt, hebt die Sperre auf', () => {
    const a = new Abbestellungen();
    a.abbestellen('k', 'u:1', 0);
    a.aufheben('k', 'u:1');
    assert.equal(a.gesperrt('k', 'u:1', 1), false);
  });

  /** Sicherheitsnetz: meldet der Server das Ende nie (Neustart, verpasstes
   *  Ereignis), darf die Kachel nicht für immer gesperrt bleiben. */
  it('läuft nach ABBESTELLT_MS von selbst ab', () => {
    const a = new Abbestellungen();
    a.abbestellen('k', 'u:1', 0);
    assert.equal(a.gesperrt('k', 'u:1', ABBESTELLT_MS - 1), true);
    assert.equal(a.gesperrt('k', 'u:1', ABBESTELLT_MS), false);
  });
});
