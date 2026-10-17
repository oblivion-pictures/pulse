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
// s. CLAUDE.md) — geprüft wird deshalb am Quelltext, dass die Meldung an einem
// Halter hängt, der Sprachkanal UND Anruf zählt (und den Vorhalt). Hinge sie
// am Kanal allein, öffnete der Test während eines nativen Anrufs ein Mikrofon.
//
// Seit dem 2026-10-17 ist es ein EIGENER Halter neben dem für WebKits
// `ambient`: der native Stream-Ton (`streamton`) braucht `ambient`, nimmt aber
// nicht auf — er darf das Mikrofon der WebView nicht sperren.
test('gemeldet von einem Halter aller Räume, ohne den Stream-Ton', () => {
  const quelle = readFileSync(
    new URL('../src/lib/platform/iosSprache.ts', import.meta.url),
    'utf8'
  );
  const rueckruf = /new TonHalter\(\(gehalten\) => \{([\s\S]*?)\n\}\);/.exec(quelle)?.[1] ?? '';
  assert.match(rueckruf, /webSessionTyp\(/);
  assert.match(quelle, /const mikroHalter = new TonHalter\(mikrofonBeiDerHuelleMelden\)/);
  const halten = /export function nativerTonHalten\([\s\S]*?\n\}/.exec(quelle)?.[0] ?? '';
  assert.match(halten, /halter\.setzen\(wer, an\)/);
  assert.match(halten, /if \(wer !== 'streamton'\) mikroHalter\.setzen\(wer, an\)/);
});
