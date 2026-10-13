/**
 * Einen angehaltenen AudioContext fortsetzen (`audio/kontextFortsetzen.ts`).
 *
 * Seit die stummen Anker nicht mehr an LiveKits `startAudio()` hängen, macht
 * dieses auch nicht mehr nebenbei hörbar, was ein angehaltener Kontext
 * zurückhält. Die Gastseite hat keinen „Ton aktivieren“-Knopf; dort muss der
 * Ton von selbst zurückkommen, sobald der Browser es erlaubt: beim nächsten
 * Versuch (Mikrofon steht) oder bei der nächsten Geste auf der Seite.
 * Der Nachweis im Browser (angehaltener Kontext, `resume()` erst nach der Geste
 * erlaubt) steht in `tests/e2e/doppelter-ton.spec.ts`; WebKit gibt es auf dieser
 * Maschine nicht.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { kontextFortsetzen } from '../src/lib/audio/kontextFortsetzen.ts';

type Verhalten = 'ablehnen' | 'offen';

/** Ein Kontext, dessen `resume()` erst gelingt, wenn `erlaubt` gesetzt ist. */
function kontext(state: string, verhalten: Verhalten = 'ablehnen') {
  const k = {
    state,
    erlaubt: false,
    versuche: 0,
    resume(): Promise<void> {
      k.versuche++;
      if (k.erlaubt) {
        k.state = 'running';
        return Promise.resolve();
      }
      return verhalten === 'offen'
        ? new Promise<void>(() => undefined)
        : Promise.reject(new DOMException('nicht erlaubt', 'NotAllowedError'));
    },
  };
  return k;
}

/** Eine Seite, die mitzählt, wer an welchem Ereignis lauscht. */
function seite() {
  const ziel = new EventTarget();
  const lauscher = new Map<string, number>();
  const hinzu = ziel.addEventListener.bind(ziel);
  const weg = ziel.removeEventListener.bind(ziel);
  ziel.addEventListener = ((art: string, fn: never, opt?: never) => {
    lauscher.set(art, (lauscher.get(art) ?? 0) + 1);
    hinzu(art, fn, opt);
  }) as typeof ziel.addEventListener;
  ziel.removeEventListener = ((art: string, fn: never, opt?: never) => {
    lauscher.set(art, (lauscher.get(art) ?? 0) - 1);
    weg(art, fn, opt);
  }) as typeof ziel.removeEventListener;
  const offen = () => [...lauscher.values()].reduce((a, b) => a + b, 0);
  return { ziel, offen };
}

const warte = () => new Promise((r) => setTimeout(r, 5));
const kontextAls = (k: ReturnType<typeof kontext>) => k as never;

describe('kontextFortsetzen', () => {
  test('ein laufender oder geschlossener Kontext bleibt unberührt', () => {
    for (const state of ['running', 'closed']) {
      const k = kontext(state);
      const s = seite();
      kontextFortsetzen(kontextAls(k), s.ziel);
      assert.equal(k.versuche, 0, state);
      assert.equal(s.offen(), 0, state);
    }
  });

  test('angehalten: sofort versuchen, und bei der nächsten Geste noch einmal', async () => {
    const k = kontext('suspended');
    const s = seite();
    kontextFortsetzen(kontextAls(k), s.ziel);
    await warte();
    assert.equal(k.versuche, 1, 'der sofortige Versuch');
    assert.equal(k.state, 'suspended', 'ohne Erlaubnis scheitert er');
    assert.ok(s.offen() > 0, 'und es lauscht auf eine Geste');

    k.erlaubt = true; // die Geste erlaubt es jetzt
    s.ziel.dispatchEvent(new Event('pointerdown'));
    await warte();
    assert.equal(k.versuche, 2);
    assert.equal(k.state, 'running');
    assert.equal(s.offen(), 0, 'danach hört niemand mehr zu');

    s.ziel.dispatchEvent(new Event('keydown'));
    await warte();
    assert.equal(k.versuche, 2, 'keine weiteren Versuche');
  });

  test('jede der Gesten setzt fort', async () => {
    for (const art of ['pointerdown', 'pointerup', 'keydown', 'touchend', 'click']) {
      const k = kontext('suspended');
      const s = seite();
      kontextFortsetzen(kontextAls(k), s.ziel);
      await warte();
      k.erlaubt = true;
      s.ziel.dispatchEvent(new Event(art));
      await warte();
      assert.equal(k.state, 'running', art);
    }
  });

  test('bleibt `resume()` offen statt abzulehnen, wird trotzdem auf die Geste gewartet', async () => {
    // Je nach Browser lehnt es ab (nicht erlaubt) oder bleibt einfach offen.
    const k = kontext('suspended', 'offen');
    const s = seite();
    kontextFortsetzen(kontextAls(k), s.ziel);
    await warte();
    assert.ok(s.offen() > 0);
    k.erlaubt = true;
    s.ziel.dispatchEvent(new Event('click'));
    await warte();
    assert.equal(k.state, 'running');
  });

  test('scheitert auch die Geste, lauscht es weiter (Berührung: erst `pointerup` zählt)', async () => {
    const k = kontext('suspended');
    const s = seite();
    kontextFortsetzen(kontextAls(k), s.ziel);
    await warte();
    s.ziel.dispatchEvent(new Event('pointerdown')); // zählt nicht
    await warte();
    assert.equal(k.state, 'suspended');
    assert.ok(s.offen() > 0, 'die Zuhörer sind noch da');
    k.erlaubt = true;
    s.ziel.dispatchEvent(new Event('pointerup')); // zählt
    await warte();
    assert.equal(k.state, 'running');
    assert.equal(s.offen(), 0);
  });

  test('mehrfaches Aufrufen stapelt keine Zuhörer', async () => {
    const k = kontext('suspended');
    const s = seite();
    kontextFortsetzen(kontextAls(k), s.ziel);
    const nach1 = s.offen();
    kontextFortsetzen(kontextAls(k), s.ziel);
    kontextFortsetzen(kontextAls(k), s.ziel);
    await warte();
    assert.equal(s.offen(), nach1);
  });

  test('wird der Kontext inzwischen geschlossen, fasst die Geste ihn nicht mehr an', async () => {
    const k = kontext('suspended');
    const s = seite();
    kontextFortsetzen(kontextAls(k), s.ziel);
    await warte();
    const versuche = k.versuche;
    k.state = 'closed';
    s.ziel.dispatchEvent(new Event('pointerdown'));
    await warte();
    assert.equal(k.versuche, versuche);
    assert.equal(s.offen(), 0, 'und die Zuhörer sind weg');
  });

  test('keine unbehandelte Ablehnung', async () => {
    const unbehandelt: unknown[] = [];
    const merke = (e: unknown) => unbehandelt.push(e);
    process.on('unhandledRejection', merke);
    try {
      const k = kontext('suspended');
      const s = seite();
      kontextFortsetzen(kontextAls(k), s.ziel);
      s.ziel.dispatchEvent(new Event('pointerdown')); // lehnt auch ab
      await warte();
    } finally {
      process.off('unhandledRejection', merke);
    }
    assert.deepEqual(unbehandelt, []);
  });
});

describe('Verdrahtung: wer keinen „Ton aktivieren“-Knopf hat, setzt den Kontext von selbst fort', () => {
  const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  // Ohne Kommentare: die erklären den Weg und nennen dieselben Namen.
  const lies = (pfad: string) =>
    readFileSync(join(webRoot, pfad), 'utf8')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

  test('Gast: nach dem Mikrofon und bei jeder Änderung des Abspielstatus', () => {
    const quelle = lies('src/lib/gast/gastRaum.svelte.ts');
    const mikro = quelle.indexOf('setMicrophoneEnabled(true, this.#aufnahmeVorgaben())');
    const fort = quelle.indexOf('this.#ton.fortsetzen();');
    const filter = quelle.indexOf('await this.#rauschfilterInstallieren(room)');
    assert.ok(mikro >= 0 && fort >= 0 && filter >= 0, 'Marker fehlen');
    assert.ok(mikro < fort && fort < filter, 'fortsetzen() steht zwischen Mikrofon und Rauschfilter');
    assert.ok(
      /RoomEvent\.AudioPlaybackStatusChanged, \(\) => aktiv\(\) && this\.#ton\.fortsetzen\(\)/.test(quelle),
      'der Abspielstatus löst fortsetzen() aus'
    );
  });

  test('Gast-Ton: jeder neue Kontext geht durch kontextFortsetzen (nicht mehr durch ein nacktes resume())', () => {
    const quelle = lies('src/lib/gast/gastTon.ts');
    assert.ok(/kontextFortsetzen\(this\.#tonCtx\)/.test(quelle));
    assert.ok(!/\.resume\(\)/.test(quelle), 'ein nacktes resume() käme ohne Gestenweg aus');
  });

  test('Bildschirmfreigabe-Kachel: ein angehaltener Zug wartet auf die nächste Geste', () => {
    const quelle = lies('src/lib/components/ScreenShareTile.svelte');
    assert.equal(quelle.match(/resumeOnGesture\(\)/g)?.length, 2, 'beim Anschließen und bei jedem Anhalten');
  });
});
