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

type Satz = {
  nachrichtId: string;
  autorId: string;
  geloescht: boolean;
  inhalt: string;
  kryptoId: string | null;
  anhaenge: { id: string }[];
  antwortAufId: string | null;
};

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
    // @ts-expect-error - Vite-served path resolved at browser runtime
    w.__kopplung = await import('/src/lib/kopplung/empfangen.ts');
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
  saetze: {
    id: string;
    autor: string;
    kryptoId?: string;
    inhalt?: string;
    verschluesselt?: boolean;
    geloescht?: boolean;
    anhaenge?: { id: string }[];
    antwortAuf?: string;
    /** Archiv-Bestandszeile ohne geprüften Autor (`verlauf/herkunft.ts`). */
    ungeprueft?: boolean;
  }[]
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
            ...(s.geloescht ? { deleted_at: '2026-10-12T00:00:01Z' } : {}),
            ...(s.anhaenge ? { attachments: s.anhaenge } : {}),
            ...(s.antwortAuf ? { reply_to_id: s.antwortAuf } : {}),
            ...(s.ungeprueft ? { archiv_ungeprueft: true } : {})
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

/** Meldet das Konto KONTO an und führt KANAL als Direktnachricht mit Bob —
 *  ohne Server, nur die beiden Stores, an denen `verlauf/loeschen.ts` hängt
 *  (`aktuellesKonto`, `istLokalerKanal`). Lädt `loeschen.ts` dazu. Mit
 *  `gespraech: false` bleibt der Kanal unbekannt — wie nach einem Neuladen,
 *  bevor die Gesprächsliste da ist. */
async function alsKontoImGespraech(page: Page, gespraech = true): Promise<void> {
  await page.evaluate(
    async ({ kontoId, kanalId, bob, gespraech }) => {
      const w = window as unknown as Record<string, unknown>;
      // @ts-expect-error - Vite-served path resolved at browser runtime
      const { auth } = await import('/src/lib/stores/auth.svelte.ts');
      // @ts-expect-error - Vite-served path resolved at browser runtime
      const { directMessages } = await import('/src/lib/stores/directMessages.svelte.ts');
      auth.user = { id: kontoId };
      if (gespraech) {
        directMessages.seed([
          { id: kanalId, other_user_id: bob, last_message_id: null, created_at: '2026-10-12T00:00:00Z' }
        ]);
      }
      // @ts-expect-error - Vite-served path resolved at browser runtime
      w.__loeschen = await import('/src/lib/verlauf/loeschen.ts');
    },
    { kontoId: KONTO, kanalId: KANAL, bob: BOB, gespraech }
  );
}

/** Eine gebundene Löschung über den echten Weg (`loeschen.ts`), samt Folgen. */
async function gebundenGeloescht(page: Page, kennung: string, autor: string): Promise<string[]> {
  return page.evaluate(
    ({ kanalId, kennung, autor }) =>
      (window as unknown as { __loeschen: { verlaufGebundenGeloescht: Function } }).__loeschen
        .verlaufGebundenGeloescht(kanalId, kennung, autor),
    { kanalId: KANAL, kennung, autor }
  );
}

/** Legt Bytes für einen Anhang ab (`anhangBytesSichern`). */
async function anhangBytesAblegen(page: Page, id: string): Promise<void> {
  await page.evaluate(
    ({ id, kanalId }) =>
      (window as unknown as { __db: Record<string, Function> }).__db.anhangBytesSichern({
        id,
        kanalId,
        daten: new Blob(['bild']),
        vorschau: null
      }),
    { id, kanalId: KANAL }
  );
}

/** Liegen die Bytes unter dieser Anhang-ID noch im Geräte-Cache? */
async function anhangDa(page: Page, id: string): Promise<boolean> {
  return page.evaluate(
    async (id) =>
      (await (window as unknown as { __db: Record<string, Function> }).__db.anhangBytesLesen(id)) !==
      undefined,
    id
  );
}

/** Was `kopplung/empfangen.ts::verlaufUebernehmen` mit einem Stück tut, ohne
 *  Server: der echte `stueckAblegen`, dann der Abgleich mit genau den
 *  übernommenen Grabsteinen. Ergebnis: wie viele Sätze der Abgleich markiert
 *  hat. */
async function kopplungUebernehmen(
  page: Page,
  saetze: {
    id: string;
    autor: string;
    kryptoId?: string;
    inhalt?: string;
    geloescht?: boolean;
    anhaenge?: { id: string }[];
  }[]
): Promise<number> {
  return page.evaluate(
    async ({ saetze, kanalId, kontoId }) => {
      const w = window as unknown as {
        __db: Record<string, Function>;
        __satz: { zuSatz: Function };
        __kopplung: { stueckAblegen: Function };
      };
      const stueck = saetze.map((s) =>
        w.__satz.zuSatz(
          kanalId,
          {
            id: s.id,
            author_id: s.autor,
            content: s.inhalt ?? 'hallo',
            created_at: '2026-10-12T00:00:00Z',
            ...(s.kryptoId ? { krypto_id: s.kryptoId } : {}),
            ...(s.geloescht ? { deleted_at: '2026-10-12T00:00:01Z' } : {}),
            ...(s.anhaenge ? { attachments: s.anhaenge } : {})
          },
          'konto-des-alten-geraets'
        )
      );
      const { grabsteine } = await w.__kopplung.stueckAblegen(stueck, kontoId);
      return w.__db.verlaufRegisterAbgleichen(kontoId, grabsteine);
    },
    { saetze, kanalId: KANAL, kontoId: KONTO }
  );
}

/** Alle Schlüssel des Speichers `nachrichten`, an jedem Leseweg vorbei —
 *  auch die Einträge des Grabstein-Registers. */
async function rohSchluessel(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      new Promise<string[]>((fertig, fehler) => {
        const offen = indexedDB.open('pulse-verlauf');
        offen.onsuccess = () => {
          const anfrage = offen.result.transaction('nachrichten').objectStore('nachrichten').getAllKeys();
          anfrage.onsuccess = () => {
            offen.result.close();
            fertig(anfrage.result.map(String));
          };
          anfrage.onerror = () => fehler(anfrage.error);
        };
        offen.onerror = () => fehler(offen.error);
      })
  );
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
    // Hier liegt die Archiv-Kopie K sichtbar; das alte Gerät hatte die
    // Empfangs-Kopie D gelöscht und schickt deren Grabstein.
    await ablegen(page, 'put', [{ id: K, autor: ALICE }]);
    const markiert = await kopplungUebernehmen(page, [{ id: D, autor: ALICE, kryptoId: K, geloescht: true }]);
    expect(markiert).toBe(1);
    expect(sichtbar(await kanal(page))).toEqual([]);
  });

  test('Fund 7 (zweite Gegenprüfung): der Abgleich macht keine liegende Altlöschung zur Identitätslöschung', async ({ page }) => {
    // Ein Sicherungs-Stein ohne Autor hat hier D markiert — nur D, ohne
    // Register (`steinAnwenden`). Die Archiv-Kopie K derselben Nachricht
    // bleibt sichtbar; so will es die Regel für Steine ohne Autor.
    await ablegen(page, 'put', [
      { id: D, autor: ALICE, kryptoId: K },
      { id: K, autor: ALICE }
    ]);
    await steinAnwenden(page, D, '');
    expect(sichtbar(await kanal(page))).toEqual([K]);
    // Eine Kopplung, die nur eine andere Nachricht mitbringt: bis 2026-10-12
    // trug der Abgleich JEDEN liegenden Grabstein ein und nahm K mit.
    const andere = '700000000000005003';
    expect(await kopplungUebernehmen(page, [{ id: andere, autor: BOB }])).toBe(0);
    expect(sichtbar(await kanal(page))).toEqual([K, andere]);
  });

  test('Fund 7 (zweite Gegenprüfung): die Kopplung ergänzt, statt Grabstein und Bearbeitung zu überschreiben', async ({ page }) => {
    // Hier ist D gelöscht (ohne Register, wie oben) und K bearbeitet. Das alte
    // Gerät kennt beide noch im alten Stand.
    await ablegen(page, 'put', [
      { id: D, autor: BOB, inhalt: 'gelöscht' },
      { id: K, autor: ALICE, inhalt: 'bearbeitet' }
    ]);
    await steinAnwenden(page, D, '');
    await kopplungUebernehmen(page, [
      { id: D, autor: BOB, inhalt: 'gelöscht' },
      { id: K, autor: ALICE, inhalt: 'alt', anhaenge: [{ id: '700000000000007004' }] }
    ]);
    const saetze = await kanal(page);
    expect(saetze.find((s) => s.nachrichtId === D)).toMatchObject({ geloescht: true });
    // Der Text dieses Geräts bleibt, ein fehlender Anhang kommt dazu (eigene
    // Wahrheit wie die Sicherung).
    expect(saetze.find((s) => s.nachrichtId === K)).toMatchObject({
      inhalt: 'bearbeitet',
      anhaenge: [{ id: '700000000000007004' }]
    });
  });

  test('Fund 8: eine Kopie, die ein Tab mit altem Code nach der Löschung ablegt, fällt beim nächsten Anwenden', async ({ page }) => {
    expect(await gebundenLoeschen(page, ALICE, [K])).toEqual({ markiert: [], neu: true });
    // Ein Tab mit dem Code von vor dem Register schreibt ohne Prüfung — hier
    // nachgestellt mit einem rohen `put` an der App vorbei.
    await page.evaluate(
      async ({ kanalId, kontoId, k, alice }) => {
        const w = window as unknown as { __satz: { zuSatz: Function } };
        const satz = w.__satz.zuSatz(
          kanalId,
          { id: k, author_id: alice, content: 'zurück', created_at: '2026-10-12T00:00:00Z' },
          kontoId
        );
        await new Promise<void>((fertig, fehler) => {
          const offen = indexedDB.open('pulse-verlauf');
          offen.onsuccess = () => {
            const tx = offen.result.transaction('nachrichten', 'readwrite');
            tx.objectStore('nachrichten').put(satz);
            tx.oncomplete = () => {
              offen.result.close();
              fertig();
            };
            tx.onerror = () => fehler(tx.error);
          };
        });
      },
      { kanalId: KANAL, kontoId: KONTO, k: K, alice: ALICE }
    );
    expect(sichtbar(await kanal(page))).toEqual([K]);
    // Das nächste Anwenden derselben Löschung (Archiv und Sicherung tun das
    // bei jedem Lesen) sieht unter der Kennung nach, auch ohne neuen Eintrag.
    expect(await gebundenLoeschen(page, ALICE, [K])).toEqual({ markiert: [K], neu: false });
    expect(sichtbar(await kanal(page))).toEqual([]);
  });

  test('Fund 2/9: aus dem Archiv kommen keine fremden Anhänge an die eigene Nachricht, aus der Sicherung schon', async ({ page }) => {
    // Der echte Archivweg (`verlaufSaetzeErgaenzen` mit `archiv`) gegen die
    // echte Datenbank: eine Zeile mit Namen und Kennung meiner Nachricht,
    // dazu ein fremdes Bild und ein Antwortbezug.
    await ablegen(page, 'put', [{ id: K, autor: ALICE, inhalt: 'echt', verschluesselt: true }]);
    const zeileMitAnhang = {
      id: K,
      autor: ALICE,
      kryptoId: K,
      inhalt: 'gefälscht',
      verschluesselt: true,
      anhaenge: [{ id: 'bild-des-partners' }],
      antwortAuf: '700000000000000999'
    };
    await ablegen(page, 'archiv', [zeileMitAnhang]);
    const [ausArchiv] = await kanal(page);
    expect(ausArchiv).toMatchObject({ inhalt: 'echt', kryptoId: K, anhaenge: [], antwortAufId: null });

    // Dieselbe Angabe aus der EIGENEN Sicherung ergänzt Anhang und Bezug.
    await ablegen(page, 'sicherung', [zeileMitAnhang]);
    const [ausSicherung] = await kanal(page);
    expect(ausSicherung.inhalt).toBe('echt');
    expect(ausSicherung.anhaenge.map((a) => a.id)).toEqual(['bild-des-partners']);
    expect(ausSicherung.antwortAufId).toBe('700000000000000999');
  });

  test('Fund 1 (zweite Gegenprüfung): eine Kennung, die keine ist, trägt nichts ein und legt nichts ab', async ({ page }) => {
    // Ein Lösch-Frame oder eine Grabstein-Zeile mit `"x"`: bis hierher ein
    // Register-Eintrag und ein Stein in der Sicherung, an dem jede
    // Wiederherstellung des Kanals scheiterte.
    for (const kennung of ['x', '0123', '1'.repeat(21)]) {
      expect(await gebundenLoeschen(page, ALICE, [kennung])).toEqual({ markiert: [], neu: false });
    }
    // Eine Kopie mit einer solchen ID wird gar nicht erst ein Satz (`zuSatz`).
    const satz = await page.evaluate(
      ({ kanalId, kontoId, alice }) =>
        (window as unknown as { __satz: { zuSatz: Function } }).__satz.zuSatz(
          kanalId,
          { id: 'x', author_id: alice, content: 'x', created_at: '2026-10-12T00:00:00Z' },
          kontoId
        ),
      { kanalId: KANAL, kontoId: KONTO, alice: ALICE }
    );
    expect(satz).toBeNull();
    expect(await rohSchluessel(page)).toEqual([]);
    // Gegenprobe: eine echte Kennung trägt ein.
    expect(await gebundenLoeschen(page, ALICE, [K])).toEqual({ markiert: [], neu: true });
    expect(await rohSchluessel(page)).toHaveLength(1);
  });

  test('Fund 2 (zweite Gegenprüfung): eine fremde Löschung nimmt keine Anhang-Bytes mit, die ein anderer Satz trägt', async ({ page }) => {
    await alsKontoImGespraech(page);
    const BILD = '700000000000007001';
    const BOBS_ZEILE = '700000000000005002';
    await anhangBytesAblegen(page, BILD);
    // Alices Nachricht mit ihrem Bild. Daneben eine Zeile, die Bob mit
    // derselben Anhang-ID eingeliefert hat — er kennt sie, er hat das Bild
    // von ihr bekommen.
    await ablegen(page, 'put', [
      { id: K, autor: ALICE, verschluesselt: true, anhaenge: [{ id: BILD }] },
      { id: BOBS_ZEILE, autor: BOB, kryptoId: BOBS_ZEILE, verschluesselt: true, anhaenge: [{ id: BILD }] }
    ]);
    // Bob löscht seine Zeile, gebunden an ihn und über den echten Weg
    // (`verlauf/loeschen.ts`). Bis 2026-10-12 nahm das Alices Bytes mit.
    expect(await gebundenGeloescht(page, BOBS_ZEILE, BOB)).toEqual([BOBS_ZEILE]);
    // Die Folgen laufen nach dem Markieren nebenher.
    await page.waitForTimeout(1_000);
    expect(await anhangDa(page, BILD)).toBe(true);
    // Löscht Alice ihre Nachricht, trägt kein sichtbarer Satz das Bild mehr:
    // jetzt gehen die Bytes.
    expect(await gebundenGeloescht(page, K, ALICE)).toEqual([K]);
    await expect.poll(() => anhangDa(page, BILD)).toBe(false);
  });

  test('Fund 2 (zweite Gegenprüfung): ein vergessenes Gespräch nimmt keine Bytes eines anderen mit', async ({ page }) => {
    const BILD = '700000000000007002';
    const ANDERER_KANAL = '700000000000000200';
    await anhangBytesAblegen(page, BILD);
    // Bobs Zeile in unserem Gespräch trägt die ID eines Bildes aus einem
    // anderen Gespräch.
    await ablegen(page, 'put', [{ id: D, autor: BOB, anhaenge: [{ id: BILD }] }]);
    await page.evaluate(
      ({ kanalId, kontoId, k, alice, bild }) => {
        const w = window as unknown as { __db: Record<string, Function>; __satz: { zuSatz: Function } };
        const satz = w.__satz.zuSatz(
          kanalId,
          { id: k, author_id: alice, content: 'mein Bild', created_at: '2026-10-12T00:00:00Z', attachments: [{ id: bild }] },
          kontoId
        );
        return w.__db.verlaufPutSaetze([satz]);
      },
      { kanalId: ANDERER_KANAL, kontoId: KONTO, k: K, alice: ALICE, bild: BILD }
    );
    await page.evaluate(
      ({ kanalId, kontoId }) =>
        (window as unknown as { __db: Record<string, Function> }).__db.verlaufKanalVergessen(kanalId, kontoId),
      { kanalId: KANAL, kontoId: KONTO }
    );
    expect(await kanal(page)).toEqual([]);
    expect(await anhangDa(page, BILD)).toBe(true);
  });

  /** Sichtbare Sätze als `ID Autor Kennung Inhalt`. */
  async function belegung(page: Page): Promise<string[]> {
    return (await kanal(page))
      .filter((s) => !s.geloescht)
      .map((s) => {
        const autor = s.autorId === ALICE ? 'alice' : 'bob';
        return `${s.nachrichtId} ${autor} ${s.kryptoId} ${s.inhalt}`;
      });
  }

  // Fund 3 der zweiten Gegenprüfung, offen (Kopf von `archiv/zeile.ts`): eine
  // Archiv-Zeile liegt unter ihrer eigenen ID `i`, und die wählt der
  // Einliefernde frei. Was gilt: ein Satz eines anderen Autors unter
  // derselben ID überschreibt nie einen liegenden Satz, über keinen Weg.

  test('Fund 3 (offen): ein Satz unter fremder ID überschreibt keinen liegenden Satz', async ({ page }) => {
    const bobUnterK = { id: K, autor: BOB, kryptoId: K, inhalt: 'bob' };
    await ablegen(page, 'put', [{ id: K, autor: ALICE, kryptoId: K, inhalt: 'echt' }]);
    await ablegen(page, 'archiv', [bobUnterK]);
    await ablegen(page, 'sicherung', [bobUnterK]);
    // Die Kopplung legte bis 2026-10-12 blind über den Schlüssel.
    await kopplungUebernehmen(page, [bobUnterK]);
    expect(await belegung(page)).toEqual([`${K} alice ${K} echt`]);
  });

  test('Fund 3 (offen): im selben Nachschub gewinnt der erste Satz unter einem Schlüssel', async ({ page }) => {
    await ablegen(page, 'archiv', [
      { id: K, autor: ALICE, kryptoId: K, inhalt: 'echt' },
      { id: K, autor: BOB, kryptoId: K, inhalt: 'bob' }
    ]);
    expect(await belegung(page)).toEqual([`${K} alice ${K} echt`]);
  });

  test('Fund 3 (offen): liegt Bobs Satz zuerst, holt die eigene Sicherung den Schlüssel nicht zurück', async ({ page }) => {
    // Die bekannte Lücke, festgehalten, damit ihre Behebung hier auffällt:
    // wer Fund 3 löst, dreht diese Erwartung um.
    await ablegen(page, 'archiv', [{ id: K, autor: BOB, kryptoId: K, inhalt: 'bob' }]);
    await ablegen(page, 'sicherung', [{ id: K, autor: ALICE, inhalt: 'aus der Sicherung' }]);
    expect(await belegung(page)).toEqual([`${K} bob ${K} bob`]);
  });

  test('Fund 4 (zweite Gegenprüfung): eine ungeprüfte Archiv-Kopie weicht der eigenen Sicherung, nie umgekehrt', async ({ page }) => {
    // Eine Bestandszeile ohne Einlieferer nennt Alice als Autorin, Inhalt und
    // Anhang hat ein anderer geschrieben. Bis 2026-10-12 gewann der liegende
    // Satz, und die Sicherung ergänzte ihn höchstens.
    const ungepruefteKopie = {
      id: K,
      autor: ALICE,
      kryptoId: K,
      inhalt: 'gefälscht',
      ungeprueft: true,
      anhaenge: [{ id: '700000000000007003' }]
    };
    await ablegen(page, 'archiv', [ungepruefteKopie]);
    let [satz] = await kanal(page);
    expect(satz).toMatchObject({ inhalt: 'gefälscht', ungeprueft: true });
    await ablegen(page, 'sicherung', [{ id: K, autor: ALICE, inhalt: 'echt' }]);
    [satz] = await kanal(page);
    expect(satz).toMatchObject({ inhalt: 'echt', kryptoId: K, anhaenge: [] });
    expect(satz).not.toHaveProperty('ungeprueft');
    // Eine weitere ungeprüfte Kopie ändert am geprüften Satz nichts mehr.
    await ablegen(page, 'archiv', [ungepruefteKopie]);
    [satz] = await kanal(page);
    expect(satz).toMatchObject({ inhalt: 'echt', anhaenge: [] });
  });

  test('Fund 6 (zweite Gegenprüfung): ein Lösch-Frame für einen noch unbekannten Kanal wirkt trotzdem', async ({ page }) => {
    // Nach einem Neuladen liegt die Nachricht in der Datenbank, die
    // Gesprächsliste ist aber noch nicht da. Der Postfach-Zyklus quittiert
    // den Frame trotzdem; bis 2026-10-12 blieb er dabei ohne Register-Eintrag
    // und ohne Markieren.
    await alsKontoImGespraech(page, false);
    await ablegen(page, 'put', [{ id: D, autor: ALICE, kryptoId: K, verschluesselt: true }]);
    expect(await gebundenGeloescht(page, K, ALICE)).toEqual([D]);
    expect(sichtbar(await kanal(page))).toEqual([]);
    // Und eine Kopie, die erst danach kommt, landet als Grabstein.
    await ablegen(page, 'archiv', [{ id: K, autor: ALICE, kryptoId: K }]);
    expect(sichtbar(await kanal(page))).toEqual([]);
  });

  test('R6 (dritte Gegenprüfung): der Medien-Index überspringt eine Altzeile ohne Kennung und ordnet nach Zeit', async ({ page }) => {
    // Bis 2026-10-12 sortierte `medienLesen` mit `BigInt(id)`: die Altzeile
    // "x" warf, und das Medien-Archiv blieb leer. Die lokale 19-stellige ID
    // ist älter (2023) als die Snowflake (2026), numerisch aber größer.
    const lokalAelter = '1700000000000123456';
    const serverNeuer = String(5000n * 4194304n);
    const gelesen = await page.evaluate(
      async ({ kontoId, kanalId, ids }) => {
        const db = (window as unknown as { __db: Record<string, Function> }).__db;
        const zeile = (id: string) => ({
          id, kontoId, kanalId, autorId: kontoId, erstelltAm: '2026-10-12T00:00:00Z',
          dateiname: null, mime: null, size: 1, verschluesselt: true, hatThumb: false,
          schluessel: null, laufwerkVerteilt: false
        });
        await db.medienSchreiben(ids.map(zeile));
        return ((await db.medienLesen(kontoId)) as { id: string }[]).map((z) => z.id);
      },
      { kontoId: KONTO, kanalId: KANAL, ids: [lokalAelter, 'x', serverNeuer] }
    );
    expect(gelesen).toEqual([serverNeuer, lokalAelter]);
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
