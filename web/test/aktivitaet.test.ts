import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AKTIV_FENSTER_MS,
  EINGABE_EREIGNISSE,
  aktivitaetsUhr,
  beobachten
} from '../src/lib/nachrichten/aktivitaet.ts';

test('ohne jede Eingabe ist niemand aktiv', () => {
  const uhr = aktivitaetsUhr(() => 1_000_000);
  assert.equal(uhr.istAktiv(), false);
});

test('aktiv bis zum Ende des Fensters, danach nicht mehr', () => {
  let jetzt = 1_000_000;
  const uhr = aktivitaetsUhr(() => jetzt);
  uhr.eingabe();
  assert.equal(uhr.istAktiv(), true);
  jetzt += AKTIV_FENSTER_MS;
  assert.equal(uhr.istAktiv(), true);
  jetzt += 1;
  assert.equal(uhr.istAktiv(), false);
  uhr.eingabe();
  assert.equal(uhr.istAktiv(), true);
});

test('beobachten hängt sich an alle Eingaben, ein Skript-Ereignis zählt nicht', () => {
  const rueckrufe = new Map<string, (e: { isTrusted?: boolean }) => void>();
  const ziel = {
    addEventListener(art: string, rueckruf: (e: { isTrusted?: boolean }) => void) {
      rueckrufe.set(art, rueckruf);
    }
  };
  const uhr = aktivitaetsUhr(() => 5);
  beobachten(ziel, uhr);
  assert.deepEqual([...rueckrufe.keys()], [...EINGABE_EREIGNISSE]);
  rueckrufe.get('keydown')!({ isTrusted: false });
  assert.equal(uhr.istAktiv(), false);
  rueckrufe.get('pointermove')!({ isTrusted: true });
  assert.equal(uhr.istAktiv(), true);
});
