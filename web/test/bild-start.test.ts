import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  aufGesteAbspielen,
  bildDiagnose,
  bildErgebnis,
  type Abspielbar
} from '../src/lib/stream/bildStart.ts';

// Befund 2026-10-17 (TestFlight 8.1): mit nativem Stream-Ton spielt die WebView
// keinen Ton, WebKit verweigert das Bild im Stromsparmodus ohne Geste. Die
// Kachel muss das erkennen und bei der nächsten Berührung erneut starten.

function fehler(name: string): Error {
  const e = new Error(name);
  e.name = name;
  return e;
}

/** Ein Video, dessen `play()` erst nach `erlauben()` gelingt. */
function video() {
  let erlaubt = false;
  let rufe = 0;
  const el: Abspielbar & { paused: boolean } = {
    paused: true,
    readyState: 4,
    videoWidth: 1280,
    videoHeight: 720,
    play() {
      rufe += 1;
      if (!erlaubt) return Promise.reject(fehler('NotAllowedError'));
      el.paused = false;
      return Promise.resolve();
    }
  };
  return {
    el,
    erlauben: () => (erlaubt = true),
    get rufe() {
      return rufe;
    }
  };
}

const ruhe = () => new Promise((r) => setTimeout(r, 0));

test('NotAllowedError ist eine Sperre, AbortError und Rest nicht', () => {
  assert.equal(bildErgebnis(fehler('NotAllowedError')), 'gesperrt');
  assert.equal(bildErgebnis(fehler('AbortError')), 'abgebrochen');
  assert.equal(bildErgebnis(fehler('NotSupportedError')), 'fehler');
  assert.equal(bildErgebnis(null), 'fehler');
  assert.equal(bildErgebnis('kaputt'), 'fehler');
});

test('Diagnose nennt Video-Spur, readyState, Ergebnis und eingeschaltete Tonspuren', () => {
  const { el } = video();
  const strom = {
    getVideoTracks: () => [{ readyState: 'live', muted: false }],
    getAudioTracks: () => [{ enabled: false }]
  };
  assert.deepEqual(bildDiagnose(el, strom, 'gesperrt'), {
    ergebnis: 'gesperrt',
    video_spur: true,
    video_spur_lebt: true,
    video_spur_stumm: false,
    ton_spuren_an: 0,
    ready_state: 4,
    pausiert: true,
    groesse: '1280x720'
  });
  const ohne = bildDiagnose(el, null, 'fehler');
  assert.equal(ohne.video_spur, false);
  assert.equal(ohne.ton_spuren_an, 0);
});

test('nächste Geste startet das Bild, danach hört niemand mehr zu', async () => {
  const v = video();
  const seite = new EventTarget();
  const gemeldet: boolean[] = [];
  aufGesteAbspielen(v.el, seite, (l) => gemeldet.push(l));
  // Eine Geste, die WebKit (noch) nicht als Freigabe gelten lässt: weiter warten.
  seite.dispatchEvent(new Event('pointerdown'));
  await ruhe();
  assert.deepEqual(gemeldet, []);
  v.erlauben();
  seite.dispatchEvent(new Event('touchend'));
  await ruhe();
  assert.deepEqual(gemeldet, [true]);
  const vorher = v.rufe;
  seite.dispatchEvent(new Event('click'));
  await ruhe();
  assert.equal(v.rufe, vorher, 'nach dem Erfolg kein weiterer play()-Ruf');
  assert.deepEqual(gemeldet, [true]);
});

test('Abbauen löst die Zuhörer, ohne zu melden', async () => {
  const v = video();
  const seite = new EventTarget();
  const gemeldet: boolean[] = [];
  const abbauen = aufGesteAbspielen(v.el, seite, (l) => gemeldet.push(l));
  abbauen();
  v.erlauben();
  seite.dispatchEvent(new Event('click'));
  await ruhe();
  assert.equal(v.rufe, 0);
  assert.deepEqual(gemeldet, []);
});

test('läuft das Bild schon (anderer Weg), meldet die Geste nur noch Erfolg', async () => {
  const v = video();
  const seite = new EventTarget();
  const gemeldet: boolean[] = [];
  aufGesteAbspielen(v.el, seite, (l) => gemeldet.push(l));
  v.el.paused = false;
  seite.dispatchEvent(new Event('keydown'));
  await ruhe();
  assert.equal(v.rufe, 0);
  assert.deepEqual(gemeldet, [true]);
});
