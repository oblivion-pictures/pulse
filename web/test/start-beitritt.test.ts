import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { herkunftEinordnen, nurPfad } from '../src/lib/navigation/herkunft.ts';
import {
  abgleichEntscheiden,
  istPruefraum,
  vomNutzerAufgelegt
} from '../src/lib/voice/nativAbgleich.ts';
import {
  autoConnectNachAbgleich,
  resumePlan,
  routeBeitritt
} from '../src/lib/voice/startBeitritt.ts';

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

const aussen = (ziel: string) => ({ ziel, herkunft: 'aussen' as const });

test('D1: ein als „von aussen" angemeldetes Ziel landet als aussen', () => {
  assert.equal(herkunftEinordnen('goto', kanal, aussen(kanal)), 'aussen');
  // Query und Anker ändern den Bildschirm nicht.
  assert.equal(herkunftEinordnen('goto', kanal, aussen(`${kanal}?x=1#y`)), 'aussen');
  // Gewann eine andere Navigation, gilt die Marke nicht für sie.
  assert.equal(herkunftEinordnen('goto', '/app/@me/7', aussen(kanal)), 'app');
  // Zurück bleibt zurück, auch mit Marke.
  assert.equal(herkunftEinordnen('popstate', kanal, aussen(kanal)), 'zurueck');
  assert.equal(nurPfad('/app/@me/1?ab=2#x'), '/app/@me/1');
  assert.equal(nurPfad('/app'), '/app');
});

const offen = { startFertig: true, gesperrt: false, imKanal: false };

test('S1: die Weiterleitung von /app auf das Auto-Connect-Ziel ist kein Tipp', () => {
  // Bis zur Nachprüfung war das ein blosses `goto` → `app` → die Route trat
  // nach dem Tor bei, auch wo der Auto-Connect mit Absicht nicht beitrat.
  const marke = { ziel: kanal, herkunft: 'weiterleitung' as const };
  assert.equal(herkunftEinordnen('goto', kanal, marke), 'weiterleitung');
  assert.equal(routeBeitritt({ herkunft: 'weiterleitung', ...offen }), 'nein');
  // Ein Tipp danach auf einen anderen Kanal ist wieder einer.
  assert.equal(herkunftEinordnen('link', '/app/guilds/1/channels/43', marke), 'app');
});

test('Route: beitreten nur nach einem Tipp in der App', () => {
  // Ohne App-Sperre ändert sich für einen Tipp in der App nichts (F4).
  assert.equal(routeBeitritt({ herkunft: 'app', ...offen }), 'ja');
  for (const herkunft of ['start', 'aussen', 'zurueck', 'weiterleitung'] as const) {
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

test('S4: nach einem Auflegen in der Hülle tritt auch der Auto-Connect nicht bei', () => {
  assert.equal(autoConnectNachAbgleich('verwerfen'), false);
  for (const abgleich of ['nichts', 'verlassen', 'uebernehmen', 'ueberholt', null] as const) {
    assert.equal(autoConnectNachAbgleich(abgleich), true, String(abgleich));
  }
});

test('Prüfraum: der Start-Abgleich lässt den Raum eines Prüfpfads stehen', () => {
  // Abnahme-Checkliste 0.8: die Prüfpfade treten mit `probe` bzw.
  // `probe-kanal` bei, ohne Eintrag — bisher verliess der Abgleich sie.
  for (const kanalId of ['probe', 'probe-kanal']) {
    assert.equal(istPruefraum(kanalId), true, kanalId);
    const huelle = { kanalId, sitzung: 1, aufgelegtSitzung: null };
    assert.equal(abgleichEntscheiden({ huelle, resume: null, aktiverServer: 'cloud' }), 'pruefraum');
  }
  // Weder Resume noch Auto-Connect treten darüber bei.
  assert.deepEqual(
    resumePlan({ abgleich: 'pruefraum', resume: eintrag, aktiverServer: 'cloud', imKanal: false }),
    { beitreten: false, eintragLoeschen: false }
  );
  assert.equal(autoConnectNachAbgleich('pruefraum'), false);
});

test('Prüfraum: nur die Prüfkennungen — ein echter Kanal ohne Eintrag wird verlassen', () => {
  for (const kanalId of ['42', '1234567890123456789', 'proben', 'kanal-probe']) {
    assert.equal(istPruefraum(kanalId), false, kanalId);
  }
  assert.equal(
    abgleichEntscheiden({ huelle: { kanalId: '42' }, resume: null, aktiverServer: 'cloud' }),
    'verlassen'
  );
});
