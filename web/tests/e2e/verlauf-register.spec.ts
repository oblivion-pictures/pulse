import { test, expect, type Page } from '@playwright/test';

/**
 * Das Grabstein-Register und die Lösch-Wege des lokalen Verlaufs gegen die
 * ECHTE IndexedDB (Gegenprüfung 2026-10-12, Funde 1 und 9).
 *
 * Nodes Testläufer hat kein `indexedDB`, und eine Ersatz-Bibliothek gibt es
 * im Repo nicht. Die bisherigen Tests der Autor-Bindung stubbten deshalb den
 * Verlaufszugriff und wandten die Regel selbst an — ob `verlauf/db.ts` sie
 * wirklich anwendet, sah keiner. Hier laufen die echten Module im Browser,
 * über den Vite-Pfad (`/src/lib/...`, wie `wake-lock.spec.ts`), ohne
 * Anmeldung: jede Funktion bekommt ihr Konto als Argument. Jeder Test hat
 * seinen eigenen Browser-Kontext und damit eine leere Datenbank.
 */

const KONTO = '700000000000000001';
const KANAL = '700000000000000100';
const ALICE = '700000000000000011';
const BOB = '700000000000000012';
/** Kennung K (vom Verfasser gewählt) und Zustellungs-ID D einer Nachricht. */
const K = '700000000000005000';
const D = '700000000000009000';

type Satz = { nachrichtId: string; geloescht: boolean; inhalt: string; kryptoId: string | null };

/** Lädt die echten Module ins Fenster und legt einen Satz-Bauer daneben. */
async function vorbereiten(page: Page): Promise<void> {
  await page.goto('/login');
  await page.evaluate(async () => {
    const w = window as unknown as Record<string, unknown>;
    // @ts-expect-error - Vite-served path resolved at browser runtime
    w.__db = await import('/src/lib/verlauf/db.ts');
    // @ts-expect-error - Vite-served path resolved at browser runtime
    w.__satz = await import('/src/lib/verlauf/satz.ts');
    // @ts-expect-error - Vite-served path resolved at browser runtime
    w.__lesen = await import('/src/lib/sicherung/andockLesen.ts');
  });
}

/** Der ganze Kanal, wie ihn der Verlauf liest (Konto-Filter inklusive). */
async function kanal(page: Page): Promise<Satz[]> {
  return page.evaluate(
    ([kanalId, kontoId]) => {
      const db = (window as unknown as { __db: { verlaufLesenSaetze: Function } }).__db;
      return db.verlaufLesenSaetze(kanalId, { anzahl: 100 }, kontoId);
    },
    [KANAL, KONTO]
  );
}

/** Schreibt Sätze über einen Weg von `verlauf/db.ts` — `wie` wählt ihn. */
async function ablegen(
  page: Page,
  wie: 'put' | 'archiv' | 'sicherung',
  saetze: { id: string; autor: string; kryptoId?: string; inhalt?: string; verschluesselt?: boolean; geloescht?: boolean }[]
): Promise<string[] | number> {
  return page.evaluate(
    async ({ wie, saetze, kanalId, kontoId }) => {
      const w = window as unknown as {
        __db: Record<string, Function>;
        __satz: { zuSatz: Function };
      };
      const fertig = saetze.map((s) =>
        w.__satz.zuSatz(
          kanalId,
          {
            id: s.id,
            author_id: s.autor,
            content: s.inhalt ?? 'hallo',
            created_at: '2026-10-12T00:00:00Z',
            ...(s.kryptoId ? { krypto_id: s.kryptoId } : {}),
            ...(s.verschluesselt ? { verschluesselt: true } : {}),
            ...(s.geloescht ? { deleted_at: '2026-10-12T00:00:01Z' } : {})
          },
          kontoId
        )
      );
      if (wie === 'put') return w.__db.verlaufPutSaetze(fertig);
      return w.__db.verlaufSaetzeErgaenzen(fertig, kontoId, wie);
    },
    { wie, saetze, kanalId: KANAL, kontoId: KONTO }
  );
}

async function gebundenLoeschen(page: Page, autor: string, kennungen: string[]) {
  return page.evaluate(
    ({ kanalId, kontoId, autor, kennungen }) => {
      const db = (window as unknown as { __db: { verlaufGebundenLoeschen: Function } }).__db;
      return db
        .verlaufGebundenLoeschen(kanalId, kontoId, autor, kennungen)
        .then((e: { markiert: Satz[]; neuEingetragen: boolean }) => ({
          markiert: e.markiert.map((s) => s.nachrichtId),
          neu: e.neuEingetragen
        }));
    },
    { kanalId: KANAL, kontoId: KONTO, autor, kennungen }
  );
}

/** Wendet einen gelesenen Sicherungs-Stein an (`andockLesen.ts::steinAnwenden`);
 *  `autor: ''` ist der Altstein vor 2026-10-11. */
async function steinAnwenden(page: Page, id: string, autor: string, kryptoId?: string): Promise<void> {
  await page.evaluate(
    async ({ kanalId, kontoId, id, autor, kryptoId }) => {
      const w = window as unknown as { __lesen: { steinAnwenden: Function } };
      const stein = {
        fassung: 1, id, autor, inhalt: '', zeit: '2026-10-12T00:00:00Z',
        bearbeitet: null, antwortAuf: null, anhaenge: [], geloescht: true,
        ...(kryptoId ? { kryptoId } : {})
      };
      await w.__lesen.steinAnwenden(kanalId, stein, kontoId);
    },
    { kanalId: KANAL, kontoId: KONTO, id, autor, kryptoId }
  );
}

function sichtbar(saetze: Satz[]): string[] {
  return saetze.filter((s) => !s.geloescht).map((s) => s.nachrichtId);
}

test.describe('Grabstein-Register im lokalen Verlauf (echte IndexedDB)', () => {
  test.beforeEach(async ({ page }) => {
    await vorbereiten(page);
  });

  test('Fund 1: eine gelöschte Nachricht kommt über Archiv, Sicherung und Empfang nicht zurück', async ({ page }) => {
    // Empfangs-Kopie unter D mit Kennung K liegt, der Lösch-Frame von Alice kommt.
    await ablegen(page, 'put', [{ id: D, autor: ALICE, kryptoId: K, verschluesselt: true }]);
    expect(await gebundenLoeschen(page, ALICE, [K])).toEqual({ markiert: [D], neu: true });

    // Danach kommt die Kopie unter K — aus dem Archiv. Bis 2026-10-12 ein
    // neuer, sichtbarer Satz neben dem Grabstein unter D.
    await ablegen(page, 'archiv', [{ id: K, autor: ALICE, kryptoId: K, verschluesselt: true }]);
    let saetze = await kanal(page);
    expect(sichtbar(saetze)).toEqual([]);
    const kopie = saetze.find((s) => s.nachrichtId === K)!;
    expect(kopie).toMatchObject({ geloescht: true, inhalt: '' });

    // Dasselbe über die Sicherung und über den Empfangsweg (eine spätere
    // Zustellung derselben Nachricht unter einer neuen Zustellungs-ID).
    await ablegen(page, 'sicherung', [{ id: '700000000000009001', autor: ALICE, kryptoId: K }]);
    const alsGrabstein = await ablegen(page, 'put', [
      { id: '700000000000009002', autor: ALICE, kryptoId: K, verschluesselt: true }
    ]);
    expect(alsGrabstein).toEqual(['700000000000009002']);
    saetze = await kanal(page);
    expect(sichtbar(saetze)).toEqual([]);

    // Ein zweites Anwenden derselben Löschung trägt nichts Neues ein.
    expect(await gebundenLoeschen(page, ALICE, [K])).toEqual({ markiert: [], neu: false });
  });

  test('Fund 1: die Löschung gilt auch, wenn die Nachricht vorher nirgends lag', async ({ page }) => {
    expect(await gebundenLoeschen(page, ALICE, [K])).toEqual({ markiert: [], neu: true });
    await ablegen(page, 'archiv', [{ id: K, autor: ALICE, kryptoId: K }]);
    expect(sichtbar(await kanal(page))).toEqual([]);
  });

  test('Autor-Bindung: Bobs Löschung trifft Alices Nachricht nicht, weder liegend noch nachgereicht', async ({ page }) => {
    await ablegen(page, 'put', [{ id: K, autor: ALICE, verschluesselt: true }]);
    expect(await gebundenLoeschen(page, BOB, [K])).toEqual({ markiert: [], neu: true });
    await ablegen(page, 'archiv', [{ id: D, autor: ALICE, kryptoId: K, verschluesselt: true }]);
    expect(sichtbar(await kanal(page))).toEqual([K, D]);
    // Seine eigene Nachricht mit derselben Kennung trifft sie dagegen.
    await ablegen(page, 'archiv', [{ id: '700000000000009003', autor: BOB, kryptoId: K }]);
    expect(sichtbar(await kanal(page))).toEqual([K, D]);
  });

  test('eine gebundene Löschung markiert JEDE lokale Kopie (Zustellungs- und Archiv-Kopie)', async ({ page }) => {
    await ablegen(page, 'put', [
      { id: K, autor: ALICE },
      { id: D, autor: ALICE, kryptoId: K }
    ]);
    const { markiert } = await gebundenLoeschen(page, ALICE, [K]);
    expect(markiert.sort()).toEqual([K, D].sort());
  });

  test('die eigene Löschung nimmt die zweite Kopie mit und trägt ins Register ein', async ({ page }) => {
    await ablegen(page, 'put', [
      { id: K, autor: ALICE },
      { id: D, autor: ALICE, kryptoId: K }
    ]);
    const markiert = await page.evaluate(
      ({ kanalId, kontoId, d }) => {
        const w = window as unknown as { __db: Record<string, Function>; __satz: { sortierSchluessel: Function } };
        return w.__db
          .verlaufSatzLoeschen(w.__satz.sortierSchluessel(kanalId, d), kontoId, false)
          .then((m: Satz[]) => m.map((s) => s.nachrichtId));
      },
      { kanalId: KANAL, kontoId: KONTO, d: D }
    );
    expect(markiert.sort()).toEqual([K, D].sort());
    await ablegen(page, 'archiv', [{ id: '700000000000009004', autor: ALICE, kryptoId: K }]);
    expect(sichtbar(await kanal(page))).toEqual([]);
  });

  test('Fund 4: `nurKlartext` lässt einen verschlüsselten Satz unangetastet', async ({ page }) => {
    await ablegen(page, 'put', [{ id: K, autor: ALICE, verschluesselt: true }]);
    const markiert = await page.evaluate(
      ({ kanalId, kontoId, k }) => {
        const w = window as unknown as { __db: Record<string, Function>; __satz: { sortierSchluessel: Function } };
        return w.__db.verlaufSatzLoeschen(w.__satz.sortierSchluessel(kanalId, k), kontoId, true);
      },
      { kanalId: KANAL, kontoId: KONTO, k: K }
    );
    expect(markiert).toEqual([]);
    expect(sichtbar(await kanal(page))).toEqual([K]);
  });

  test('Fund 9: verlaufMarkiereGeloescht prüft den Autor ein zweites Mal', async ({ page }) => {
    await ablegen(page, 'put', [{ id: K, autor: ALICE }]);
    const ergebnis = await page.evaluate(
      async ({ kanalId, kontoId, k, bob, alice }) => {
        const w = window as unknown as { __db: Record<string, Function>; __satz: { sortierSchluessel: Function } };
        const schluessel = w.__satz.sortierSchluessel(kanalId, k);
        const fremd = await w.__db.verlaufMarkiereGeloescht(schluessel, kontoId, bob);
        const eigen = await w.__db.verlaufMarkiereGeloescht(schluessel, kontoId, alice);
        return { fremd, eigen };
      },
      { kanalId: KANAL, kontoId: KONTO, k: K, bob: BOB, alice: ALICE }
    );
    expect(ergebnis).toEqual({ fremd: false, eigen: true });
  });

  test('Fund 9: verlaufSatzIdsFuerFrame findet beide Formen und bindet an den Autor', async ({ page }) => {
    await ablegen(page, 'put', [
      { id: K, autor: ALICE },
      { id: D, autor: ALICE, kryptoId: K },
      { id: '700000000000009005', autor: BOB, kryptoId: K }
    ]);
    const treffer = await page.evaluate(
      async ({ kanalId, kontoId, k, alice, bob }) => {
        const db = (window as unknown as { __db: Record<string, Function> }).__db;
        return {
          alice: await db.verlaufSatzIdsFuerFrame(kanalId, k, kontoId, alice),
          bob: await db.verlaufSatzIdsFuerFrame(kanalId, k, kontoId, bob),
          ungebunden: await db.verlaufSatzIdsFuerFrame(kanalId, k, kontoId),
          fremdesKonto: await db.verlaufSatzIdsFuerFrame(kanalId, k, '1', alice)
        };
      },
      { kanalId: KANAL, kontoId: KONTO, k: K, alice: ALICE, bob: BOB }
    );
    expect(treffer.alice.sort()).toEqual([K, D].sort());
    expect(treffer.bob).toEqual(['700000000000009005']);
    expect(treffer.ungebunden).toHaveLength(3);
    expect(treffer.fremdesKonto).toEqual([]);
  });

  test('Fund 9: steinAnwenden — mit Autor gebunden und ins Register, ohne Autor nur die eigene ID', async ({ page }) => {
    await ablegen(page, 'put', [
      { id: K, autor: ALICE },
      { id: D, autor: BOB, kryptoId: '700000000000005001' }
    ]);
    // Ein Stein von Alice mit fremder lokaler ID (D, Bobs Nachricht) und
    // ihrer Kennung K: trifft K, nicht D.
    await steinAnwenden(page, D, ALICE, K);
    expect(sichtbar(await kanal(page))).toEqual([D]);
    // Die Löschung steht im Register: eine Archiv-Kopie von K bleibt Grabstein.
    await ablegen(page, 'archiv', [{ id: '700000000000009006', autor: ALICE, kryptoId: K }]);
    expect(sichtbar(await kanal(page))).toEqual([D]);

    // Ein Altstein ohne Autor trifft nur seine lokale ID — und trägt nichts
    // ins Register ein: eine Kopie unter anderer ID bleibt sichtbar.
    await steinAnwenden(page, D, '');
    await ablegen(page, 'archiv', [{ id: '700000000000005001', autor: BOB, kryptoId: '700000000000005001' }]);
    expect(sichtbar(await kanal(page))).toEqual(['700000000000005001']);
  });

  test('Kopplung: übernommene Grabsteine gelten nach dem Abgleich auch für die andere Kopie', async ({ page }) => {
    // Das alte Gerät hatte D gelöscht, die Archiv-Kopie K aber sichtbar.
    await ablegen(page, 'put', [
      { id: D, autor: ALICE, kryptoId: K, geloescht: true },
      { id: K, autor: ALICE }
    ]);
    expect(sichtbar(await kanal(page))).toEqual([K]);
    const markiert = await page.evaluate((kontoId) => {
      const db = (window as unknown as { __db: Record<string, Function> }).__db;
      return db.verlaufRegisterAbgleichen(kontoId);
    }, KONTO);
    expect(markiert).toBe(1);
    expect(sichtbar(await kanal(page))).toEqual([]);
  });

  test('Register-Einträge erscheinen in keinem Leseweg', async ({ page }) => {
    await gebundenLoeschen(page, ALICE, [K]);
    const gelesen = await page.evaluate(
      async ({ kanalId, kontoId }) => {
        const db = (window as unknown as { __db: Record<string, Function> }).__db;
        return {
          alle: (await db.verlaufAlleLesen(kontoId)).length,
          kanal: (await db.verlaufLesenSaetze(kanalId, { anzahl: 100 }, kontoId)).length
        };
      },
      { kanalId: KANAL, kontoId: KONTO }
    );
    expect(gelesen).toEqual({ alle: 0, kanal: 0 });
  });
});
