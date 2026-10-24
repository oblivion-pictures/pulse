/**
 * Absender-Bindung der Aktions-Frames (Security-Fix 2026-10-24): Reaktions-,
 * Bearbeitungs- und Anruf-Schlüssel-Frames trugen bis dahin KEIN
 * `absenderNutzer`/`absenderGeraet` — Nachrichten und Lösch-Frames taten es
 * (Bughunt 2026-09-23). Der Gruppen-Empfangsweg fiel bei fehlenden Feldern auf
 * die Server-Metadaten zurück, die der Server frei setzt: ein zurückgehaltener
 * Frame eines Mitglieds liess sich unter fremdem Konto zustellen
 * (Fremd-Bearbeitung im Namen des Original-Autors, Reaktionen unter falschem
 * Namen).
 *
 * Zwei Hälften wie bei den anderen Krypto-Tests: die echten Rechnungen der
 * Nutzlast (Builder, Erkennung) und — weil `gruppe/empfangen.ts` WASM und
 * IndexedDB nach sich zieht, die Nodes Testläufer nicht lädt — die Verdrahtung
 * per Quelltext-Lesen (denselbe Stil wie `postfach-ankunft-verdrahtung`).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  baueReaktionsNutzlast,
  baueBearbeitungsNutzlast,
  baueAnrufSchluesselNutzlast,
  baueLoeschNutzlast,
  baueNachrichtNutzlast,
  leseNachrichtNutzlast,
  aktionsRahmenUngebunden
} from '../src/lib/krypto/nachrichtNutzlast.ts';

const ABSENDER = { nutzer: 'user-9', geraet: 'geraet-7' };
/** Eine Kennung wie jede echte: Ziffernfolge (`verlauf/identitaet.ts`). */
const ZIEL = '1760000000000000009';
const enc = new TextEncoder();

// --- Nutzlast: die drei Builder tragen die Bindung --------------------------

describe('Aktions-Frames tragen die Absender-Bindung', () => {
  test('Reaktions-Frame: Hin- und Rueckweg mit Konto und Geraet', () => {
    const gelesen = leseNachrichtNutzlast(
      baueReaktionsNutzlast(ZIEL, '👍', false, ABSENDER)
    );
    assert.deepEqual(gelesen.reaktion, { ziel: ZIEL, emoji: '👍' });
    assert.equal(gelesen.absenderNutzer, 'user-9');
    assert.equal(gelesen.absenderGeraet, 'geraet-7');
    assert.equal(aktionsRahmenUngebunden(gelesen), false);
  });

  test('Bearbeitungs-Frame: Hin- und Rueckweg mit Konto und Geraet', () => {
    const gelesen = leseNachrichtNutzlast(
      baueBearbeitungsNutzlast(ZIEL, 'Neuer Text', ABSENDER)
    );
    assert.deepEqual(gelesen.bearbeitung, { ziel: ZIEL, inhalt: 'Neuer Text' });
    assert.equal(gelesen.absenderNutzer, 'user-9');
    assert.equal(gelesen.absenderGeraet, 'geraet-7');
    assert.equal(aktionsRahmenUngebunden(gelesen), false);
  });

  test('Anruf-Schluessel-Frame: Hin- und Rueckweg mit Konto und Geraet', () => {
    const gelesen = leseNachrichtNutzlast(
      baueAnrufSchluesselNutzlast('anruf-1', 'AAAAschluessel', ABSENDER)
    );
    assert.deepEqual(gelesen.anrufSchluessel, {
      anrufId: 'anruf-1',
      schluessel: 'AAAAschluessel'
    });
    assert.equal(gelesen.absenderNutzer, 'user-9');
    assert.equal(gelesen.absenderGeraet, 'geraet-7');
    assert.equal(aktionsRahmenUngebunden(gelesen), false);
  });
});

// --- Erkennung: ungebundene Aktions-Frames ----------------------------------

describe('aktionsRahmenUngebunden', () => {
  test('erkennt alle drei Frame-Arten ohne Bindung — der Angriffsfall', () => {
    // Diese Bytes erzeugt KEIN aktueller Builder mehr — sie stehen für einen
    // Frame eines noch nicht aktualisierten Senders ODER für genau die
    // Luecke: der Server liefert sie mit frei gewählter Metadaten-Zuschreibung.
    const roh = (objekt: Record<string, unknown>) =>
      leseNachrichtNutzlast(enc.encode(JSON.stringify({ v: 1, text: '', ...objekt })));
    assert.equal(aktionsRahmenUngebunden(roh({ reaktion: { ziel: ZIEL, emoji: '👍' } })), true);
    assert.equal(
      aktionsRahmenUngebunden(roh({ bearbeitung: { ziel: ZIEL, inhalt: 'neu' } })),
      true
    );
    assert.equal(
      aktionsRahmenUngebunden(
        roh({ anrufSchluessel: { anrufId: 'anruf-1', schluessel: 'AAAAschluessel' } })
      ),
      true
    );
  });

  test('die halbe Bindung (nur Konto oder nur Geraet) gilt als ungebunden', () => {
    // Nur eines der beiden Felder zu verlangen liesse dem Server die andere
    // Haelfte der Zuschreibung — fail-closed heisst: beide oder keiner.
    const roh = (objekt: Record<string, unknown>) =>
      leseNachrichtNutzlast(enc.encode(JSON.stringify({ v: 1, text: '', ...objekt })));
    assert.equal(
      aktionsRahmenUngebunden(
        roh({ reaktion: { ziel: ZIEL, emoji: '👍' }, absenderNutzer: 'user-9' })
      ),
      true
    );
    assert.equal(
      aktionsRahmenUngebunden(
        roh({ reaktion: { ziel: ZIEL, emoji: '👍' }, absenderGeraet: 'geraet-7' })
      ),
      true
    );
  });

  test('Loesch-Frames bleiben vom Zwang ausgenommen (Rollout + Autor-Bindung)', () => {
    // Gruppen-Loesch-Frames tragen die Felder bis zu diesem Fix nicht —
    // strikt verwerfen wuerde jede Loeschung eines noch nicht aktualisierten
    // Clients brechen. Und anders als bei Reaktion/Bearbeitung faengt das
    // `loeschZiel` eine umetikettierte Loeschung ab: nur der VERFASSER darf
    // loeschen, eine fremde Zuschreibung wird abgewiesen, die richtige ist
    // keine Faelschung.
    const gelesen = leseNachrichtNutzlast(baueLoeschNutzlast(ZIEL));
    assert.equal(gelesen.geloescht, true);
    assert.equal(gelesen.absenderNutzer, null);
    assert.equal(aktionsRahmenUngebunden(gelesen), false);
  });

  test('gewoehnliche Nachrichten und Legacy-Klartext bleiben unberuehrt', () => {
    // Nachrichten behalten ihren dokumentierten Rueckfall (Bughunt
    // 2026-09-23): Legacy-Sender ohne Felder fallen auf die Metadaten zurueck.
    const alt = leseNachrichtNutzlast(baueNachrichtNutzlast('hallo', '123', null));
    assert.equal(alt.absenderNutzer, null);
    assert.equal(aktionsRahmenUngebunden(alt), false);
    const klartext = leseNachrichtNutzlast(enc.encode('kein json'));
    assert.equal(aktionsRahmenUngebunden(klartext), false);
  });
});

// --- Verdrahtung: Sende- und Empfangsseite ----------------------------------

const lies = (pfad: string) => readFileSync(new URL(`../src/${pfad}`, import.meta.url), 'utf8');

/** Der Rumpf einer Funktion — vom Kopf bis zum nächsten Funktionskopf. */
function rumpf(quelle: string, kopf: string): string {
  const start = quelle.indexOf(kopf);
  assert.ok(start >= 0, `${kopf} fehlt`);
  const ende = quelle.indexOf('\nexport ', start + kopf.length);
  return quelle.slice(start, ende < 0 ? undefined : ende);
}

/** Jeder Aufruf `name(...)` samt Argumenten — Klammerebenen zaehlend, damit
 *  Objekt-Argumente mit eigenen Klammern ganz erfasst werden. */
function rufe(quelle: string, name: string): string[] {
  const funde: string[] = [];
  let i = quelle.indexOf(`${name}(`);
  while (i >= 0) {
    let tiefe = 1;
    let j = i + name.length + 1;
    while (j < quelle.length && tiefe > 0) {
      const c = quelle[j];
      if (c === '(') tiefe++;
      else if (c === ')') tiefe--;
      j++;
    }
    funde.push(quelle.slice(i, j));
    i = quelle.indexOf(`${name}(`, j);
  }
  return funde;
}

describe('Verdrahtung der Sende- und Empfangsseite', () => {
  test('jede Aufrufstelle der drei Builder reicht den Absender durch', () => {
    for (const pfad of ['lib/krypto/senden.ts', 'lib/krypto/gruppe/frameSenden.ts']) {
      const quelle = lies(pfad);
      for (const name of [
        'baueReaktionsNutzlast',
        'baueBearbeitungsNutzlast',
        'baueAnrufSchluesselNutzlast'
      ]) {
        const funde = rufe(quelle, name);
        assert.ok(funde.length > 0, `${pfad} ruft ${name} nicht`);
        for (const ruf of funde) {
          assert.match(ruf, /nutzer:/, `${pfad}: ${name} ohne Absender-Konto`);
          assert.match(ruf, /geraet:/, `${pfad}: ${name} ohne Absender-Geraet`);
        }
      }
    }
  });

  test('auch der Gruppen-Loesch-Frame bindet den Absender (gleiche Luecke)', () => {
    const funde = rufe(lies('lib/krypto/gruppe/frameSenden.ts'), 'baueLoeschNutzlast');
    assert.ok(funde.length > 0);
    for (const ruf of funde) {
      assert.match(ruf, /nutzer:/);
      assert.match(ruf, /geraet:/);
    }
  });

  test('der Gruppen-Empfangsweg verwirft ungebundene Aktions-Frames vor jeder Zuschreibung', () => {
    // `oeffneGruppennachricht` zieht WASM/IndexedDB nach sich — deshalb hier
    // am Quelltext: der Zwang muss VOR `rahmenAusNutzlast` und dem
    // Metadaten-Rueckfall (`gelesen.absenderNutzer ?? autorId`) stehen, sonst
    // kaeme die falsche Zuschreibung trotzdem durch.
    const gruppe = rumpf(
      lies('lib/krypto/gruppe/empfangen.ts'),
      'export async function oeffneGruppennachricht'
    );
    const zwang = gruppe.indexOf('aktionsRahmenUngebunden(');
    assert.ok(zwang >= 0, 'aktionsRahmenUngebunden fehlt im Gruppen-Empfangsweg');
    assert.ok(
      zwang < gruppe.indexOf('rahmenAusNutzlast('),
      'der Zwang muss vor der Rahmen-Erkennung stehen'
    );
    assert.ok(
      zwang < gruppe.indexOf('gelesen.absenderNutzer ?? autorId'),
      'der Zwang muss vor dem Metadaten-Rueckfall stehen'
    );
    // Verworfen wird quittierbar ('ohneAblage'), sonst bliebe der Frame fuer
    // immer liegen und jeder Abholzyklus versuchte den Angriff erneut.
    const verwurf = gruppe.indexOf("'ohneAblage'", zwang);
    assert.ok(verwurf > 0, 'nach dem Zwang folgt ein quittierbarer Verwurf');
  });
});
