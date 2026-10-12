import { test, expect, type Page } from '@playwright/test';

/**
 * Fassungs-Stau ohne Datenverlust (Gegenprüfung 2026-10-12, Fund 5).
 *
 * Von 2026-09-22 bis 2026-10-12 löschte `verlauf/verbindung.ts` die ganze
 * Verlaufs-Datenbank, sobald das Öffnen eine HÖHERE Fassung vorfand. Der
 * Fall dahinter ist kein exotischer: ein Tab fährt nach einem Deploy noch
 * den alten Code, ein zweiter Tab mit dem neuen Code hebt die Fassung an —
 * und der alte löschte beim nächsten Zugriff den Verlauf, für verschlüsselte
 * Nachrichten die einzige Kopie.
 *
 * Nachgestellt mit zwei Seiten in EINEM Browser-Kontext: nur sie teilen sich
 * eine IndexedDB, wie zwei Tabs desselben Profils (zwei getrennte Kontexte
 * hätten je ihre eigene). Die „neuere App-Fassung" ist ein rohes
 * `indexedDB.open` mit höherer Nummer und einem zusätzlichen Speicher, das
 * sich bei `versionchange` schließt — wie die App selbst. Läuft über den
 * Vite-Pfad der echten Module, ohne Anmeldung (Muster `verlauf-register.spec.ts`).
 */

const KONTO = '700000000000000001';
const KANAL = '700000000000000100';
const ALICE = '700000000000000011';
const K = '700000000000005000';

async function moduleLaden(page: Page): Promise<void> {
  await page.goto('/login');
  await page.evaluate(async () => {
    const w = window as unknown as Record<string, unknown>;
    // @ts-expect-error - Vite-served path resolved at browser runtime
    w.__db = await import('/src/lib/verlauf/db.ts');
    // @ts-expect-error - Vite-served path resolved at browser runtime
    w.__satz = await import('/src/lib/verlauf/satz.ts');
    // @ts-expect-error - Vite-served path resolved at browser runtime
    w.__zustand = await import('/src/lib/verlauf/zustand.svelte.ts');
  });
}

test('ein Tab mit altem Code löscht den Verlauf nicht, wenn ein anderer die Fassung anhebt', async ({
  context
}) => {
  const alt = await context.newPage();
  await moduleLaden(alt);
  await alt.evaluate(
    async ({ kanalId, kontoId, k, alice }) => {
      const w = window as unknown as { __db: Record<string, Function>; __satz: { zuSatz: Function } };
      const satz = w.__satz.zuSatz(
        kanalId,
        { id: k, author_id: alice, content: 'einzige Kopie', created_at: '2026-10-12T00:00:00Z', verschluesselt: true },
        kontoId
      );
      await w.__db.verlaufPutSaetze([satz]);
    },
    { kanalId: KANAL, kontoId: KONTO, k: K, alice: ALICE }
  );

  // Der zweite Tab, eine neuere App-Fassung: hebt die Datenbank an und hält
  // seine Verbindung offen, bis jemand anders eine Änderung verlangt.
  const neu = await context.newPage();
  await neu.goto('/login');
  const neueFassung = await neu.evaluate(
    () =>
      new Promise<number>((fertig, fehler) => {
        const blick = indexedDB.open('pulse-verlauf');
        blick.onsuccess = () => {
          const fassung = blick.result.version + 1;
          blick.result.close();
          const offen = indexedDB.open('pulse-verlauf', fassung);
          offen.onupgradeneeded = () => offen.result.createObjectStore('zukunft');
          offen.onsuccess = () => {
            const db = offen.result;
            db.onversionchange = () => db.close();
            (window as unknown as Record<string, unknown>).__neueDb = db;
            fertig(fassung);
          };
          offen.onerror = () => fehler(offen.error);
        };
        blick.onerror = () => fehler(blick.error);
      })
  );

  // Der alte Tab greift wieder zu. Seine Verbindung hat er beim Anheben
  // geschlossen; das neue Öffnen mit seiner Fassung trifft `VersionError`.
  const imAltenTab = await alt.evaluate(
    async ({ kanalId, kontoId }) => {
      const w = window as unknown as {
        __db: Record<string, Function>;
        __zustand: { verlaufZustand: { melde(err: unknown): void; grund: string | null } };
      };
      try {
        await w.__db.verlaufLesenSaetze(kanalId, { anzahl: 10 }, kontoId);
        return { fehler: null, grund: null };
      } catch (err) {
        // Dieselbe Meldung, die `verlauf/index.ts` an dieser Stelle macht.
        w.__zustand.verlaufZustand.melde(err);
        return { fehler: (err as Error).name, grund: w.__zustand.verlaufZustand.grund };
      }
    },
    { kanalId: KANAL, kontoId: KONTO }
  );

  // Kein Datenverlust: die Datenbank steht in der neuen Fassung, mit dem
  // Speicher des neuen Tabs und der Nachricht von vorher. (Vor der Prüfung
  // der Meldung unten, damit eine Gegenprobe mit dem alten Code den Verlust
  // zeigt und nicht erst die fehlende Meldung.)
  const bestand = await neu.evaluate(
    () =>
      new Promise<{ fassung: number; speicher: string[]; schluessel: string[] }>((fertig, fehler) => {
        const offen = indexedDB.open('pulse-verlauf');
        offen.onsuccess = () => {
          const db = offen.result;
          const anfrage = db.transaction('nachrichten').objectStore('nachrichten').getAllKeys();
          anfrage.onsuccess = () => {
            fertig({
              fassung: db.version,
              speicher: [...db.objectStoreNames],
              schluessel: anfrage.result.map(String)
            });
            db.close();
          };
          anfrage.onerror = () => fehler(anfrage.error);
        };
        offen.onerror = () => fehler(offen.error);
      })
  );
  expect(bestand.fassung).toBe(neueFassung);
  expect(bestand.speicher).toContain('zukunft');
  expect(bestand.schluessel).toHaveLength(1);
  expect(bestand.schluessel[0]).toContain(K);

  // Der alte Tab läuft ohne lokalen Verlauf weiter und bittet um ein Neuladen.
  expect(imAltenTab.fehler).toBe('VersionError');
  expect(imAltenTab.grund).toContain('Bitte neu laden');

  // Und der neue Tab hält seine Verbindung noch: niemand hat eine Löschung
  // verlangt.
  const nochOffen = await neu.evaluate(() => {
    const db = (window as unknown as { __neueDb: IDBDatabase }).__neueDb;
    try {
      db.transaction('zukunft').abort();
      return true;
    } catch {
      return false;
    }
  });
  expect(nochOffen).toBe(true);
});
