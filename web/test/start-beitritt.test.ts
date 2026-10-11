import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { herkunftEinordnen, nurPfad } from '../src/lib/navigation/herkunft.ts';
import { abgleichEntscheiden, vomNutzerAufgelegt } from '../src/lib/voice/nativAbgleich.ts';
import { resumePlan, routeBeitritt } from '../src/lib/voice/startBeitritt.ts';

// iOS-Bughunt 2 vom 2026-10-11 — N1, D1, B1/D2, F4: wann ein Sprachkanal
// ohne Tipp auf „Beitreten" betreten wird.

const kanal = '/app/guilds/1/channels/42';

test('Herkunft: nur eine Navigation IN der App ist ein Tipp in der App', () => {
  assert.equal(herkunftEinordnen('goto', kanal, null), 'app');
  assert.equal(herkunftEinordnen('link', kanal, null), 'app');
  // Erste Seite des Dokuments: Kaltstart, Neuladen, WebContent-Absturz (N1, D2).
  assert.equal(herkunftEinordnen('enter', kanal, null), 'start');
  // Zurück im Verlauf ist kein Tipp auf den Kanal.
  assert.equal(herkunftEinordnen('popstate', kanal, null), 'zurueck');
});

test('D1: ein als „von aussen" angemeldetes Ziel landet als aussen', () => {
  assert.equal(herkunftEinordnen('goto', kanal, kanal), 'aussen');
  // Query und Anker ändern den Bildschirm nicht.
  assert.equal(herkunftEinordnen('goto', kanal, `${kanal}?x=1#y`), 'aussen');
  // Gewann eine andere Navigation, gilt die Marke nicht für sie.
  assert.equal(herkunftEinordnen('goto', '/app/@me/7', kanal), 'app');
  // Zurück bleibt zurück, auch mit Marke.
  assert.equal(herkunftEinordnen('popstate', kanal, kanal), 'zurueck');
  assert.equal(nurPfad('/app/@me/1?ab=2#x'), '/app/@me/1');
  assert.equal(nurPfad('/app'), '/app');
});

const offen = { startFertig: true, gesperrt: false, imKanal: false };

test('Route: beitreten nur nach einem Tipp in der App', () => {
  // Ohne App-Sperre ändert sich für einen Tipp in der App nichts (F4).
  assert.equal(routeBeitritt({ herkunft: 'app', ...offen }), 'ja');
  for (const herkunft of ['start', 'aussen', 'zurueck'] as const) {
    assert.equal(routeBeitritt({ herkunft, ...offen }), 'nein', herkunft);
  }
});

test('N1: vor dem Abgleich wartet die Route, statt „nicht verbunden" zu glauben', () => {
  // Genau die Lage vom Fund: Hülle hält den Raum, die Seite weiss es noch
  // nicht (`imKanal` false) — ein Beitritt jetzt verdrängte ihn.
  assert.equal(routeBeitritt({ herkunft: 'app', ...offen, startFertig: false }), 'warten');
  // Nach dem Abgleich ist der übernommene Raum da: kein zweiter Beitritt.
  assert.equal(routeBeitritt({ herkunft: 'app', ...offen, imKanal: true }), 'nein');
});

test('F4: hinter der App-Sperre tritt niemand bei, auch nicht nach dem Start', () => {
  assert.equal(routeBeitritt({ herkunft: 'app', ...offen, gesperrt: true }), 'warten');
  // Eine Landung, die gar nicht beitritt, muss nicht auf das Tor warten.
  assert.equal(routeBeitritt({ herkunft: 'aussen', ...offen, gesperrt: true }), 'nein');
});

const eintrag = {
  serverId: 'cloud',
  channelId: '42',
  channelName: 'Lounge',
  muted: true,
  deafened: true,
  micBeforeDeafen: true
};

test('Resume: Stumm und Taub reisen mit', () => {
  assert.deepEqual(
    resumePlan({ abgleich: 'nichts', resume: eintrag, aktiverServer: 'cloud', imKanal: false }),
    {
      beitreten: true,
      kanalId: '42',
      kanalName: 'Lounge',
      optionen: { startMuted: true, startDeafened: true, micBeforeDeafen: true }
    }
  );
});

test('Resume: ein übernommener Raum wird nicht neu betreten (N1)', () => {
  assert.deepEqual(
    resumePlan({ abgleich: 'uebernehmen', resume: eintrag, aktiverServer: 'cloud', imKanal: true }),
    { beitreten: false, eintragLoeschen: false }
  );
});

test('B1: in der Hülle aufgelegt — der Eintrag wird verworfen, nicht befolgt', () => {
  assert.deepEqual(
    resumePlan({ abgleich: 'verwerfen', resume: eintrag, aktiverServer: 'cloud', imKanal: false }),
    { beitreten: false, eintragLoeschen: true }
  );
});

test('Resume: ein Tipp während des Abgleichs gewinnt, der Eintrag bleibt', () => {
  for (const [abgleich, imKanal] of [
    ['ueberholt', false],
    ['nichts', true]
  ] as const) {
    assert.deepEqual(
      resumePlan({ abgleich, resume: eintrag, aktiverServer: 'cloud', imKanal }),
      { beitreten: false, eintragLoeschen: false }
    );
  }
});

test('Resume: nur im selben Server-Kontext, und nur mit Eintrag', () => {
  assert.equal(
    resumePlan({ abgleich: 'nichts', resume: eintrag, aktiverServer: 'selfhost-7', imKanal: false })
      .beitreten,
    false
  );
  assert.equal(
    resumePlan({ abgleich: 'verlassen', resume: null, aktiverServer: 'cloud', imKanal: false })
      .beitreten,
    false
  );
});

const resume = { serverId: 'cloud', channelId: '42' };

test('B1: die Hülle meldet „Sitzung N vom Nutzer aufgelegt" — Abgleich verwirft', () => {
  const huelle = { kanalId: '', sitzung: 5, aufgelegtSitzung: 5 };
  assert.equal(vomNutzerAufgelegt(huelle), true);
  assert.equal(abgleichEntscheiden({ huelle, resume, aktiverServer: 'cloud' }), 'verwerfen');
});

test('B1: seit dem Auflegen kam ein Beitritt — die Meldung ist alt', () => {
  const huelle = { kanalId: '', sitzung: 6, aufgelegtSitzung: 5 };
  assert.equal(vomNutzerAufgelegt(huelle), false);
  assert.equal(abgleichEntscheiden({ huelle, resume, aktiverServer: 'cloud' }), 'nichts');
});

test('B1: ein alter App-Bau ohne das Feld heisst „unbekannt", nie „aufgelegt"', () => {
  assert.equal(vomNutzerAufgelegt({ sitzung: 5 }), false);
  assert.equal(vomNutzerAufgelegt({ sitzung: 5, aufgelegtSitzung: null }), false);
  // Ohne `sitzung` (ganz alter Bau) auch nicht.
  assert.equal(vomNutzerAufgelegt({ aufgelegtSitzung: 0 }), false);
  assert.equal(
    abgleichEntscheiden({ huelle: { kanalId: '' }, resume, aktiverServer: 'cloud' }),
    'nichts'
  );
});

test('B1: hält die Hülle einen Raum, zählt die Meldung nicht', () => {
  // Kann eigentlich nicht zusammen auftreten (jeder Beitritt zählt `sitzung`
  // hoch) — falls doch, entscheidet der Raum.
  const huelle = { kanalId: '42', sitzung: 5, aufgelegtSitzung: 5 };
  assert.equal(abgleichEntscheiden({ huelle, resume, aktiverServer: 'cloud' }), 'uebernehmen');
});
