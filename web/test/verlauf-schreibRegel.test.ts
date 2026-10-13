/**
 * Zwei Konten in einem Browserprofil (Bestand 2026-10-14, Hinweis): der
 * Schlüssel eines Satzes enthält kein Konto, und der Nachschub schrieb den
 * Satz eines anderen Kontos blind über, als läge dort nichts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  liegtFremdesKonto,
  nachschubFassung,
  serverWegDarfSchreiben
} from '../src/lib/verlauf/schreibRegel.ts';
import { zuSatz } from '../src/lib/verlauf/satz.ts';
import type { Satz } from '../src/lib/verlauf/schema';

const K = '1760000000000123456';

function satz(kontoId: string, mit: Record<string, unknown> = {}): Satz {
  const s = zuSatz(
    '999',
    { id: K, author_id: '42', content: 'Hallo', created_at: '2026-10-14T00:00:00.000Z', ...mit },
    kontoId
  );
  assert.ok(s);
  return s as Satz;
}

test('der Nachschub lässt den Satz eines anderen Kontos stehen', () => {
  const vonA = satz('konto-a', { content: 'von A' });
  const fuerB = satz('konto-b', { content: 'für B' });
  for (const herkunft of ['sicherung', 'kopplung', 'archiv'] as const) {
    assert.equal(nachschubFassung(vonA, fuerB, 'konto-b', herkunft), null, herkunft);
  }
});

test('der Nachschub ergänzt einen eigenen Satz und schreibt über Altbestand ohne Konto', () => {
  const eigen = satz('konto-b', { content: 'liegt' });
  const neu = satz('konto-b', { content: 'neu', krypto_id: K });
  assert.equal(nachschubFassung(eigen, neu, 'konto-b', 'sicherung')?.inhalt, 'liegt');
  const ohneKonto = { ...eigen, kontoId: undefined as unknown as string };
  assert.equal(nachschubFassung(ohneKonto, neu, 'konto-b', 'sicherung'), neu);
  assert.equal(nachschubFassung(undefined, neu, 'konto-b', 'archiv'), neu);
});

test('der Server-Weg schreibt nicht über den Satz eines anderen Kontos', () => {
  const vonA = satz('konto-a');
  assert.equal(serverWegDarfSchreiben(vonA, satz('konto-b')), false);
  // Wie bisher: nicht über einen eigenen verschlüsselten, wohl über eigenen Klartext.
  assert.equal(serverWegDarfSchreiben(satz('konto-b', { verschluesselt: true }), satz('konto-b')), false);
  assert.equal(serverWegDarfSchreiben(satz('konto-b'), satz('konto-b')), true);
  assert.equal(serverWegDarfSchreiben(undefined, satz('konto-b')), true);
});

test('ein leeres oder fehlendes Konto ist kein fremdes', () => {
  assert.equal(liegtFremdesKonto({ kontoId: '' }, 'konto-b'), false);
  assert.equal(liegtFremdesKonto({ kontoId: undefined as unknown as string }, 'konto-b'), false);
  assert.equal(liegtFremdesKonto({ kontoId: 'konto-b' }, 'konto-b'), false);
});
