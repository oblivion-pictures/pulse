import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ABO_WIEDERHOLBARE_FEHLER,
  BUMP_NACHSCHAU_MS,
  NACHHOL_STUFEN_MS,
  naechsteWartezeit,
  wiederholerErzeugen,
  type Planer
} from '../src/lib/ws/nachholTakt.ts';
import { bumpWacheErzeugen } from '../src/lib/ws/bumpWache.ts';
import { AboWiederholung } from '../src/lib/ws/aboWiederholung.ts';
import { PongSchranke } from '../src/lib/ws/pongSchranke.ts';

/**
 * Die Rechnungen hinter „im offenen Chat kommt manchmal nichts an"
 * (Push-Bughunt, Nachrichten-Verlust). Verdrahtung: `nachhol-verdrahtung`.
 */

/** Künstliche Uhr: `vor(ms)` lässt fällige Aufträge in Zeitordnung laufen. */
function kunstUhr(): { planer: Planer; vor(ms: number): void; offen(): number } {
  let jetzt = 0;
  let naechste = 0;
  const auftraege = new Map<number, { zeit: number; fn: () => void }>();
  return {
    planer: {
      planen(fn, ms) {
        naechste += 1;
        auftraege.set(naechste, { zeit: jetzt + ms, fn });
        return naechste;
      },
      abbrechen(griff) {
        auftraege.delete(griff as number);
      }
    },
    vor(ms) {
      const ziel = jetzt + ms;
      for (;;) {
        const faellig = [...auftraege]
          .filter(([, a]) => a.zeit <= ziel)
          .sort((x, y) => x[1].zeit - y[1].zeit)[0];
        if (!faellig) break;
        auftraege.delete(faellig[0]);
        jetzt = faellig[1].zeit;
        faellig[1].fn();
      }
      jetzt = ziel;
    },
    offen: () => auftraege.size
  };
}

test('Stufen: 2 s, 5 s, 15 s, danach Schluss', () => {
  assert.deepEqual(NACHHOL_STUFEN_MS, [2_000, 5_000, 15_000]);
  assert.equal(naechsteWartezeit(1), 2_000);
  assert.equal(naechsteWartezeit(2), 5_000);
  assert.equal(naechsteWartezeit(3), 15_000);
  assert.equal(naechsteWartezeit(4), null);
  assert.equal(naechsteWartezeit(0), null);
});

test('Wiederholbar sind nur vorübergehende Abo-Fehler', () => {
  assert.ok(ABO_WIEDERHOLBARE_FEHLER.has(5000));
  assert.ok(ABO_WIEDERHOLBARE_FEHLER.has(4004));
  // 4003 = kaputte Kanal-ID, 4012 = kein Leserecht: Wiederholen ändert nichts.
  assert.ok(!ABO_WIEDERHOLBARE_FEHLER.has(4003));
  assert.ok(!ABO_WIEDERHOLBARE_FEHLER.has(4012));
});

test('Bump-Wache: liegt die Nachricht nach der Frist vor, passiert nichts', () => {
  const uhr = kunstUhr();
  const store = new Set<string>();
  const geholt: string[] = [];
  const wache = bumpWacheErzeugen({
    liegtVor: (_k, id) => store.has(id),
    nachholen: (k, sid) => geholt.push(`${sid}/${k}`),
    fristMs: BUMP_NACHSCHAU_MS,
    planer: uhr.planer
  });
  wache.melden('k1', 'm1', 's');
  store.add('m1'); // das `message`-Ereignis kam kurz nach dem Bump
  uhr.vor(BUMP_NACHSCHAU_MS);
  assert.deepEqual(geholt, []);
});

test('Bump-Wache: fehlt die Nachricht nach der Frist, holt sie genau einmal nach', () => {
  const uhr = kunstUhr();
  const geholt: string[] = [];
  const wache = bumpWacheErzeugen({
    liegtVor: () => false,
    nachholen: (k, sid) => geholt.push(`${sid}/${k}`),
    fristMs: BUMP_NACHSCHAU_MS,
    planer: uhr.planer
  });
  wache.melden('k1', 'm1', 's');
  uhr.vor(BUMP_NACHSCHAU_MS - 1);
  assert.deepEqual(geholt, [], 'nicht vor der Frist');
  uhr.vor(1);
  assert.deepEqual(geholt, ['s/k1']);
});

test('Bump-Wache: eine Welle von Bumps ergibt höchstens einen Abruf je Kanal', () => {
  const uhr = kunstUhr();
  const store = new Set(['m1', 'm2']);
  const geholt: string[] = [];
  const wache = bumpWacheErzeugen({
    liegtVor: (_k, id) => store.has(id),
    nachholen: (k) => geholt.push(k),
    fristMs: BUMP_NACHSCHAU_MS,
    planer: uhr.planer
  });
  wache.melden('k1', 'm1', 's');
  uhr.vor(500);
  wache.melden('k1', 'm2', 's');
  wache.melden('k1', 'm3', 's'); // nur diese fehlt
  wache.melden('k2', 'x1', 's');
  uhr.vor(10_000);
  assert.deepEqual(geholt.sort(), ['k1', 'k2']);
  assert.equal(uhr.offen(), 0);
});

test('Wiederholer: 2 s, 5 s, 15 s, dann Ruhe bis zum nächsten Auslöser', () => {
  const uhr = kunstUhr();
  let laeufe = 0;
  const w = wiederholerErzeugen(() => {
    laeufe += 1;
  }, uhr.planer);
  w.fehlgeschlagen();
  w.fehlgeschlagen(); // derselbe Fehlschlag, an mehrere Aufrufer gemeldet
  uhr.vor(1_999);
  assert.equal(laeufe, 0);
  uhr.vor(1);
  assert.equal(laeufe, 1);
  w.fehlgeschlagen();
  uhr.vor(5_000);
  assert.equal(laeufe, 2);
  w.fehlgeschlagen();
  uhr.vor(15_000);
  assert.equal(laeufe, 3);
  w.fehlgeschlagen(); // vierter Fehlschlag: aufhören
  uhr.vor(60_000);
  assert.equal(laeufe, 3);
  // Der nächste Auslöser scheitert wieder: die Leiter beginnt von vorn.
  w.fehlgeschlagen();
  uhr.vor(2_000);
  assert.equal(laeufe, 4);
});

test('Wiederholer: ein Erfolg setzt zurück und bricht die geplante Runde ab', () => {
  const uhr = kunstUhr();
  let laeufe = 0;
  const w = wiederholerErzeugen(() => {
    laeufe += 1;
  }, uhr.planer);
  w.fehlgeschlagen();
  uhr.vor(2_000);
  w.fehlgeschlagen(); // jetzt stünde 5 s an
  w.erfolgreich();
  uhr.vor(60_000);
  assert.equal(laeufe, 1);
  w.fehlgeschlagen();
  uhr.vor(2_000);
  assert.equal(laeufe, 2, 'nach dem Erfolg wieder ab der ersten Stufe');
});

test('Abo-Wiederholung: vorübergehender Fehler → neu abonnieren nach Stufe', () => {
  const uhr = kunstUhr();
  const erneut: string[] = [];
  const abo = new AboWiederholung(uhr.planer, (k, v) => erneut.push(`${k}#${v}`));
  abo.fehler('k1', 5000);
  uhr.vor(2_000);
  assert.deepEqual(erneut, ['k1#1']);
  // Der zweite Versuch scheitert ebenfalls — nächste Stufe.
  abo.fehler('k1', 5000);
  uhr.vor(5_000);
  assert.deepEqual(erneut, ['k1#1', 'k1#2']);
  // Bestätigung des zweiten Versuchs: einmal nachholen, Zustand weg.
  assert.equal(abo.bestaetigt('k1', 2), true);
  assert.equal(abo.bestaetigt('k1', 2), false);
});

test('Abo-Wiederholung: Bestätigung eines überholten Versuchs zählt nicht', () => {
  const uhr = kunstUhr();
  const abo = new AboWiederholung(uhr.planer, () => undefined);
  abo.fehler('k1', 4004);
  uhr.vor(2_000);
  abo.fehler('k1', 4004); // die Antwort auf Versuch 1 war wieder ein Fehler
  assert.equal(abo.bestaetigt('k1', 1), false, 'Versuch 1 ist gescheitert');
});

test('Abo-Wiederholung: dauerhafte Fehler, Aufgeben, Abbestellen', () => {
  const uhr = kunstUhr();
  const erneut: string[] = [];
  const abo = new AboWiederholung(uhr.planer, (k) => erneut.push(k));
  abo.fehler('k1', 4012);
  uhr.vor(60_000);
  assert.deepEqual(erneut, [], 'kein Leserecht: nicht wiederholen');
  for (let i = 0; i < 4; i++) {
    abo.fehler('k2', 5000);
    uhr.vor(60_000);
  }
  assert.deepEqual(erneut, ['k2', 'k2', 'k2'], 'drei Versuche, dann Schluss');
  abo.fehler('k3', 5000);
  abo.vergessen('k3'); // Kanal verlassen, bevor die Stufe fällig war
  abo.fehler('k4', 5000);
  abo.alleVergessen(); // Socket weg — der Nachfolger abonniert ohnehin neu
  uhr.vor(60_000);
  assert.deepEqual(erneut, ['k2', 'k2', 'k2']);
});

test('Pong-Schranke: läuft erst nach dem Pong auf den eigenen Ping', () => {
  const s = new PongSchranke();
  const lauf: string[] = [];
  s.gesendet(); // Herzschlag-Ping, VOR dem Abo verschickt
  s.gesendet(); // unser Ping, nach dem Abo
  s.nach(() => lauf.push('a'));
  s.empfangen(); // Pong auf den Herzschlag — das Abo ist noch nicht durch
  assert.deepEqual(lauf, []);
  s.empfangen();
  assert.deepEqual(lauf, ['a']);
  s.empfangen(); // überzählige Pongs stören nicht
  assert.deepEqual(lauf, ['a']);
});

test('Pong-Schranke: Zurücksetzen verwirft Wartende (neuer Socket)', () => {
  const s = new PongSchranke();
  const lauf: string[] = [];
  s.gesendet();
  s.nach(() => lauf.push('alt'));
  s.zuruecksetzen();
  s.gesendet();
  s.empfangen();
  assert.equal(lauf.length, 0);
  // Alle gezählten Pings sind beantwortet: was VOR ihnen ging, ist durch.
  s.nach(() => lauf.push('sofort'));
  assert.deepEqual(lauf, ['sofort']);
  s.gesendet();
  s.nach(() => lauf.push('spaeter'));
  assert.deepEqual(lauf, ['sofort']);
  s.empfangen();
  assert.deepEqual(lauf, ['sofort', 'spaeter']);
});
