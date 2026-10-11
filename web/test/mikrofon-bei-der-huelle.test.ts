import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  mikrofonBeiDerHuelle,
  mikrofonBeiDerHuelleBeobachten,
  mikrofonBeiDerHuelleMelden
} from '../src/lib/platform/mikrofonBeiDerHuelle.ts';

// Solange die iOS-Hülle einen nativen Raum hält, darf die WebView kein
// Mikrofon öffnen — der Mikrofon-Test in den Einstellungen nähme der Hülle
// sonst die Audio-Session weg (platform/mikrofonBeiDerHuelle.ts).

test('Hörer hören nur den Wechsel, und abgemeldet nichts mehr', () => {
  const gehoert: boolean[] = [];
  const ab = mikrofonBeiDerHuelleBeobachten((an) => gehoert.push(an));
  assert.equal(mikrofonBeiDerHuelle(), false);
  mikrofonBeiDerHuelleMelden(true);
  mikrofonBeiDerHuelleMelden(true);
  assert.equal(mikrofonBeiDerHuelle(), true);
  mikrofonBeiDerHuelleMelden(false);
  ab();
  mikrofonBeiDerHuelleMelden(true);
  assert.deepEqual(gehoert, [true, false]);
  mikrofonBeiDerHuelleMelden(false); // Ausgangsstand für den nächsten Test
});

test('ein Hörer, der sich beim Melden abmeldet, hält die übrigen nicht auf', () => {
  const gehoert: string[] = [];
  const ab = mikrofonBeiDerHuelleBeobachten(() => {
    gehoert.push('erster');
    ab();
  });
  const ab2 = mikrofonBeiDerHuelleBeobachten(() => gehoert.push('zweiter'));
  mikrofonBeiDerHuelleMelden(true);
  mikrofonBeiDerHuelleMelden(false);
  ab2();
  assert.deepEqual(gehoert, ['erster', 'zweiter', 'zweiter']);
});

// `iosSprache.ts` lässt sich unter Node nicht laden (erweiterungslose Importe,
// s. CLAUDE.md) — geprüft wird deshalb am Quelltext, dass die Meldung an der
// EINEN Stelle hängt, an der auch WebKits `ambient` kippt: dem Halter, der
// Sprachkanal UND Anruf zählt. Hinge sie am Kanal allein, öffnete der Test
// während eines nativen Anrufs ein Mikrofon.
test('gemeldet wird im Rückruf des Halters, neben WebKits Session-Typ', () => {
  const quelle = readFileSync(
    new URL('../src/lib/platform/iosSprache.ts', import.meta.url),
    'utf8'
  );
  const rueckruf = /new TonHalter\(\(gehalten\) => \{([\s\S]*?)\n\}\);/.exec(quelle)?.[1] ?? '';
  assert.match(rueckruf, /webSessionTyp\(/);
  assert.match(rueckruf, /mikrofonBeiDerHuelleMelden\(gehalten\)/);
});
