import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  darfGeraetSteuern,
  darfGeraetZusehen,
  istGeraetestrom,
  ohneVerborgene,
  verborgenePlaetze,
  zeilenZustand,
  type GeraetSicht,
} from '../src/lib/devices/zugang.ts';

// Drei Betrachter wie im Entwurf „Remote-Rechner: wer darf was":
// der Besitzer, jemand auf der Freigabeliste und jemand, der nur den Kanal sieht.
const BESITZER = 'besitzer';
const LENA = 'lena'; // freigegeben
const TOM = 'tom'; // sieht nur den Kanal

function geraet(state: GeraetSicht['state'], fuer: string, extra: Partial<GeraetSicht> = {}): GeraetSicht {
  // `steuerbar` rechnet der Server je Betrachter: für lena wahr, für tom und
  // den Besitzer falsch.
  return { state, owner_user_id: BESITZER, steuerbar: fuer === LENA, ...extra };
}

describe('zeilenZustand — Kanalliste je Rolle und Zustand', () => {
  test('freigegeben, niemand steuert: klickbar, grün, kein LIVE', () => {
    assert.deepEqual(zeilenZustand(geraet('ready', LENA), LENA, false), {
      klickbar: true,
      punkt: 'bereit',
      live: false,
    });
  });

  test('nur Kanal, niemand steuert: gesperrt, neutraler Punkt', () => {
    assert.deepEqual(zeilenZustand(geraet('ready', TOM), TOM, false), {
      klickbar: false,
      punkt: 'online',
      live: false,
    });
  });

  test('geweckt, aber keine Zusage: LIVE für niemanden außer dem Besitzer', () => {
    assert.equal(zeilenZustand(geraet('ready', LENA), LENA, true).live, false);
    assert.equal(zeilenZustand(geraet('ready', TOM), TOM, true).live, false);
    assert.equal(zeilenZustand(geraet('ready', BESITZER), BESITZER, true).live, true);
  });

  test('jemand steuert: LIVE für alle, Zeile bleibt für tom gesperrt', () => {
    assert.deepEqual(zeilenZustand(geraet('busy', TOM), TOM, true), {
      klickbar: false,
      punkt: 'belegt',
      live: true,
    });
    assert.deepEqual(zeilenZustand(geraet('busy', LENA), LENA, true), {
      klickbar: true,
      punkt: 'belegt',
      live: true,
    });
  });

  test('belegt, aber kein Strom: kein LIVE', () => {
    assert.equal(zeilenZustand(geraet('busy', TOM), TOM, false).live, false);
  });

  test('offline: grauer Punkt, Klickbarkeit folgt weiter der Freigabe', () => {
    assert.deepEqual(zeilenZustand(geraet('offline', LENA), LENA, false), {
      klickbar: true,
      punkt: 'offline',
      live: false,
    });
    assert.deepEqual(zeilenZustand(geraet('offline', TOM), TOM, false), {
      klickbar: false,
      punkt: 'offline',
      live: false,
    });
  });

  test('Besitzer: klickbar und grün, obwohl er nicht steuern darf', () => {
    assert.deepEqual(zeilenZustand(geraet('ready', BESITZER), BESITZER, false), {
      klickbar: true,
      punkt: 'bereit',
      live: false,
    });
  });

  test('fehlendes steuerbar (älterer Server, frisch gemeldetes Gerät) gilt als nein', () => {
    const d: GeraetSicht = { state: 'ready', owner_user_id: BESITZER };
    assert.equal(zeilenZustand(d, LENA, false).klickbar, false);
    assert.equal(zeilenZustand(d, LENA, false).punkt, 'online');
  });

  test('ohne bekannte eigene Kennung ist niemand Besitzer', () => {
    assert.equal(zeilenZustand(geraet('ready', TOM), null, true).klickbar, false);
    assert.equal(zeilenZustand(geraet('ready', TOM), null, true).live, false);
  });
});

describe('darfGeraetSteuern / darfGeraetZusehen', () => {
  test('der Besitzer steuert nie — auch nicht bei einem falschen steuerbar', () => {
    assert.equal(darfGeraetSteuern({ ...geraet('ready', LENA) }, BESITZER), false);
  });

  test('Zusehen: Besitzer immer, sonst nur belegt', () => {
    assert.equal(darfGeraetZusehen(geraet('ready', BESITZER), BESITZER), true);
    assert.equal(darfGeraetZusehen(geraet('ready', LENA), LENA), false);
    assert.equal(darfGeraetZusehen(geraet('busy', TOM), TOM), true);
  });
});

describe('verborgenePlaetze / ohneVerborgene — Nebenwege', () => {
  const stroeme = [
    { user_id: BESITZER, slot: 0 }, // von Hand übertragen
    { user_id: BESITZER, slot: 1 }, // Gerät
    { user_id: BESITZER, slot: 2 }, // Gerät
  ];

  test('nicht belegtes Gerät: seine Plätze sind für Dritte verborgen, der eigene Strom nicht', () => {
    const verborgen = verborgenePlaetze([geraet('ready', TOM, { stream_slots: [1, 2] })], TOM);
    assert.deepEqual([...verborgen].sort(), [1, 2]);
    assert.deepEqual(ohneVerborgene(stroeme, verborgen).map((s) => s.slot), [0]);
  });

  test('belegtes Gerät: nichts verborgen', () => {
    const verborgen = verborgenePlaetze([geraet('busy', TOM, { stream_slots: [1, 2] })], TOM);
    assert.equal(verborgen.size, 0);
  });

  test('der Besitzer sieht seine Geräte immer', () => {
    const verborgen = verborgenePlaetze([geraet('ready', BESITZER, { stream_slots: [1] })], BESITZER);
    assert.equal(verborgen.size, 0);
  });

  test('mehrere Geräte im Kanal: nur das nicht belegte verbirgt', () => {
    const verborgen = verborgenePlaetze(
      [geraet('busy', TOM, { stream_slots: [1] }), geraet('ready', TOM, { stream_slots: [2] })],
      TOM,
    );
    assert.deepEqual([...verborgen], [2]);
  });

  test('ein Gerät ohne gemeldete Plätze verbirgt nichts', () => {
    assert.equal(verborgenePlaetze([geraet('ready', TOM)], TOM).size, 0);
  });
});

describe('istGeraetestrom — Anfrage-Knopf im Player', () => {
  test('Platz eines Geräts', () => {
    assert.equal(istGeraetestrom([geraet('busy', TOM, { stream_slots: [1, 2] })], 2), true);
  });
  test('anderer Platz oder keine Geräte', () => {
    assert.equal(istGeraetestrom([geraet('busy', TOM, { stream_slots: [1] })], 0), false);
    assert.equal(istGeraetestrom([], 0), false);
  });
});
