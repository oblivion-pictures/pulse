import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { ohneGesteFortsetzen, ohneNullen } from '../src/lib/stream/iosStreamTon.ts';

// iOS-Hülle: HQ-Stream sofort mit Ton, Knopf „Ton aktivieren" nur als
// Rückfall; „Pause" im Kontrollzentrum speichert keine 0 mehr (2026-10-17).

const lesen = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

function kontext(verhalten: 'laeuft' | 'scheitert' | 'haengt') {
  const k = {
    suspended: true,
    aufrufe: 0,
    resume(): Promise<void> {
      k.aufrufe++;
      if (verhalten === 'laeuft') {
        k.suspended = false;
        return Promise.resolve();
      }
      if (verhalten === 'scheitert') return Promise.reject(new Error('NotAllowedError'));
      return new Promise<void>(() => undefined);
    }
  };
  return k;
}

test('läuft der Kontext schon, wird nichts versucht', async () => {
  const k = kontext('laeuft');
  k.suspended = false;
  assert.equal(await ohneGesteFortsetzen(k), true);
  assert.equal(k.aufrufe, 0);
});

test('Fortsetzen ohne Geste gelingt: kein Knopf', async () => {
  assert.equal(await ohneGesteFortsetzen(kontext('laeuft')), true);
});

test('abgelehnt: Rückfall auf den Knopf', async () => {
  assert.equal(await ohneGesteFortsetzen(kontext('scheitert')), false);
});

test('ein hängendes resume() hält nicht fest', async () => {
  assert.equal(await ohneGesteFortsetzen(kontext('haengt'), 20), false);
});

test('ohneNullen entfernt nur die Nullen', () => {
  assert.deepEqual(ohneNullen({ a: 0, b: 50, c: 150 }), { b: 50, c: 150 });
});

test('Verträge im Manager: Hülle startet ohne Geste, Pause speichert nicht', () => {
  const mgr = lesen('../src/lib/stream/hqStreamManager.svelte.ts');
  assert.match(mgr, /if \(isCapacitorIOS\(\) && this\.#boost\.suspended\) void this\.#ohneGesteStarten\(\);/);
  assert.match(mgr, /if \(befehl === 'stumm' && !stumm\) m\.toggleMute\(false\);/);
  assert.match(mgr, /if \(befehl === 'laut' && stumm\) m\.toggleMute\(false\);/);
  assert.match(mgr, /if \(speichern\) setStreamVolume\(this\.userId, v\);/);
  assert.match(mgr, /if \(isCapacitorIOS\(\)\) fernStummEinmalHeilen\(\);/);
});
