import { test } from 'node:test';
import assert from 'node:assert/strict';

import { androidLaedtDirekt } from '../src/lib/platform/speicherWeg.ts';

// iOS-Bughunt 2, F2: auf Android holte die App auch für Klartext-Anhänge
// erst einen Blob, und die Hülle verwirft `blob:`-Downloads — es geschah
// nichts. Echte Adressen gehen wieder als Anker an den Download-Manager.

test('Klartext-Adressen lädt der Download-Manager direkt', () => {
  assert.equal(androidLaedtDirekt('https://howispulse.com/pulse-attachments/a.pdf?X-Amz=1'), true);
  assert.equal(androidLaedtDirekt('http://127.0.0.1:9000/pulse-attachments/a.pdf'), true);
});

test('blob: und data: kann er nicht — die bleiben beim Teilen-Weg', () => {
  assert.equal(androidLaedtDirekt('blob:https://howispulse.com/1234'), false);
  assert.equal(androidLaedtDirekt('data:application/pdf;base64,AAAA'), false);
  assert.equal(androidLaedtDirekt('/relativ/pfad'), false);
});
