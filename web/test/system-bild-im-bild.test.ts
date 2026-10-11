/**
 * Gegenprobe zu `$lib/stream/systemBildImBild.ts` (iOS-Roadmap Punkt 29).
 *
 * Geprüft wird die Wahl des Weges und das Umschalten — gegen nachgestellte
 * Video-Objekte, nicht gegen WebKit. Ob WebKit am Telefon ein Video mit
 * `MediaStream` wirklich ins System-Bild-in-Bild lässt, sagt diese Datei
 * NICHT; der Simulator kann es nicht zeigen (Begründung im Kopf der Quelle).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  bildImBildAktiv,
  bildImBildUmschalten,
  bildImBildWeg,
  type BildImBildDokument,
  type BildImBildVideo
} from '../src/lib/stream/systemBildImBild.ts';

/** Ein Video mit WebKits eigenem Weg; `kann` ist die Antwort auf die Fähigkeit. */
function webkitVideo(kann: boolean): BildImBildVideo & { gesetzt: string[] } {
  const v = {
    gesetzt: [] as string[],
    webkitPresentationMode: 'inline',
    webkitSupportsPresentationMode: (m: string) => kann && m === 'picture-in-picture',
    webkitSetPresentationMode(m: string) {
      v.gesetzt.push(m);
      v.webkitPresentationMode = m;
    }
  };
  return v;
}

describe('bildImBildWeg', () => {
  test('ohne Video gibt es keinen Weg', () => {
    assert.equal(bildImBildWeg(null, { pictureInPictureEnabled: true }), null);
  });

  test('der Standardweg hat Vorrang, wenn das Dokument ihn freigibt', () => {
    const v = { ...webkitVideo(true), requestPictureInPicture: async () => ({}) };
    assert.equal(bildImBildWeg(v, { pictureInPictureEnabled: true }), 'standard');
  });

  test('gesperrtes Dokument: der WebKit-Weg trägt, wenn das Video ihn kann', () => {
    const v = { ...webkitVideo(true), requestPictureInPicture: async () => ({}) };
    assert.equal(bildImBildWeg(v, { pictureInPictureEnabled: false }), 'webkit');
  });

  test('der Simulator-Fall: Dokument UND Video sagen nein — kein Knopf', () => {
    // Genau so am 2026-10-11 im iPhone-Simulator gelesen (Hülle und Safari).
    const v = { ...webkitVideo(false), requestPictureInPicture: async () => ({}) };
    assert.equal(bildImBildWeg(v, { pictureInPictureEnabled: false }), null);
  });

  test('disablePictureInPicture sperrt beide Wege', () => {
    const v = { ...webkitVideo(true), requestPictureInPicture: async () => ({}), disablePictureInPicture: true };
    assert.equal(bildImBildWeg(v, { pictureInPictureEnabled: true }), null);
  });

  test('ein Browser ohne beide Schnittstellen (Android-WebView) hat keinen Weg', () => {
    assert.equal(bildImBildWeg({}, {}), null);
  });
});

describe('bildImBildAktiv', () => {
  test('erkennt beide Wege', () => {
    const v = webkitVideo(true);
    assert.equal(bildImBildAktiv(v, {}), false);
    v.webkitPresentationMode = 'picture-in-picture';
    assert.equal(bildImBildAktiv(v, {}), true);
    const s: BildImBildVideo = {};
    assert.equal(bildImBildAktiv(s, { pictureInPictureElement: s }), true);
  });
});

describe('bildImBildUmschalten', () => {
  test('Standardweg: an, und mit offenem Fenster wieder aus', async () => {
    const doc: BildImBildDokument = { pictureInPictureEnabled: true };
    const v: BildImBildVideo = {
      requestPictureInPicture: async () => {
        doc.pictureInPictureElement = v;
        return {};
      }
    };
    doc.exitPictureInPicture = async () => {
      doc.pictureInPictureElement = null;
    };
    assert.deepEqual(await bildImBildUmschalten(v, doc), { ergebnis: 'an' });
    assert.equal(bildImBildAktiv(v, doc), true);
    assert.deepEqual(await bildImBildUmschalten(v, doc), { ergebnis: 'aus' });
    assert.equal(bildImBildAktiv(v, doc), false);
  });

  test('WebKit-Weg: setzt den Modus hin und zurück', async () => {
    const v = webkitVideo(true);
    assert.deepEqual(await bildImBildUmschalten(v, {}), { ergebnis: 'an' });
    assert.deepEqual(await bildImBildUmschalten(v, {}), { ergebnis: 'aus' });
    assert.deepEqual(v.gesetzt, ['picture-in-picture', 'inline']);
  });

  test('eine Ablehnung des Systems kommt mit Grund zurück, statt verschluckt zu werden', async () => {
    const v: BildImBildVideo = {
      requestPictureInPicture: async () => {
        throw new DOMException('The Picture-in-Picture mode is not supported.', 'NotSupportedError');
      }
    };
    const r = await bildImBildUmschalten(v, { pictureInPictureEnabled: true });
    assert.equal(r.ergebnis, 'fehler');
    assert.match(r.ergebnis === 'fehler' ? r.grund : '', /^NotSupportedError: /);
  });

  test('ohne Weg passiert nichts', async () => {
    assert.deepEqual(await bildImBildUmschalten(webkitVideo(false), {}), { ergebnis: 'kein-weg' });
  });
});
