/**
 * Bestätigungsseite /verbinden (Spec 2026-10-09-selfhost-ohne-freigabe-design.md,
 * E5). Die Cloud-Antworten sind vorgetäuscht: der echte Weg verlangt einen
 * Server, der unter seiner Adresse den Nachweis ausliefert (E2) — den gibt es
 * im Testaufbau nicht. Geprüft wird die Seite: Rückweg über Registrieren und
 * Anmelden, Eingabe von Hand, vorausgewähltes Abbrechen, jeder Zustand und
 * jeder Fehlergrund, die Widerspruchsfrist bei einer vergebenen Adresse, die
 * gesperrte Übernahme als Endzustand und das Verkraften einer Bestätigung,
 * deren Antwort nie ankam oder zu spät kam.
 */
import { test, expect, type BrowserContext, type Page } from '@playwright/test';

const ts = Date.now();
const NAME = `verb_${ts}`;
const PW = 'verbinden-secret-pass';
const HOST = 'chat.dcc-test.example.com';
const CODE = 'K7QM-2XDP';

type Antwort = { status: number; body: unknown } | 'abbruch';

const VORGANG = '**/api/auth/me/selfhost/verbinden/vorgang';
const ENTSCHEIDUNG = '**/api/auth/me/selfhost/verbinden/entscheidung';

const vorgangOk = (extra: Record<string, unknown> = {}): Antwort => ({
  status: 200,
  body: { hostname: HOST, gueltig_bis: new Date(Date.now() + 600_000).toISOString(), ...extra }
});

/** Täuscht die beiden Routen der Cloud vor; liefert die gesendeten Aktionen.
 *  `entscheiden` darf eine Liste sein: sie wird der Reihe nach abgearbeitet, die
 *  letzte Antwort gilt weiter. `'abbruch'` reißt die Verbindung ab (die Cloud
 *  hat dann vielleicht trotzdem entschieden — Antwort nach ~30 s verloren).
 *  Prüft nebenbei, dass der Code im Körper reist und nie im Pfad steht
 *  (Vertrag, Nachtrag 2 — Pfade landen in Zugriffsprotokollen). */
async function cloudVortaeuschen(
  ctx: BrowserContext,
  antworten: { holen?: Antwort; entscheiden?: Antwort | Antwort[] } = {}
): Promise<string[]> {
  const aktionen: string[] = [];
  const reihe = [antworten.entscheiden ?? []].flat();
  await ctx.unroute(VORGANG);
  await ctx.unroute(ENTSCHEIDUNG);
  await ctx.route(VORGANG, async (route) => {
    const { code } = route.request().postDataJSON() as { code: string };
    expect(code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(route.request().url()).not.toContain(code);
    const a = antworten.holen ?? vorgangOk();
    if (a === 'abbruch') return route.abort();
    return route.fulfill({ status: a.status, json: a.body });
  });
  await ctx.route(ENTSCHEIDUNG, async (route) => {
    const { code, aktion } = route.request().postDataJSON() as { code: string; aktion: string };
    expect(code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(route.request().url()).not.toContain(code);
    aktionen.push(aktion);
    const a: Antwort =
      reihe[Math.min(aktionen.length - 1, reihe.length - 1)] ??
      (aktion === 'verbinden'
        ? {
            status: 200,
            body: { status: 'verbunden', hostname: HOST, instance_id: '7300000000000000099' }
          }
        : { status: 200, body: { status: 'abgelehnt' } });
    if (a === 'abbruch') return route.abort();
    return route.fulfill({ status: a.status, json: a.body });
  });
  return aktionen;
}

/** Hält die Antwort auf die Entscheidung an, bis `freigeben()` gerufen wird (die
 *  Cloud bestätigt bis zu ~30 s lang). `abgeliefert` ist erfüllt, sobald die
 *  Antwort an den Browser ging. */
async function entscheidungAnhalten(ctx: BrowserContext, antwort: Antwort) {
  await ctx.unroute(ENTSCHEIDUNG);
  const aktionen: string[] = [];
  let freigeben!: () => void;
  const warten = new Promise<void>((r) => (freigeben = r));
  let geliefert!: () => void;
  const abgeliefert = new Promise<void>((r) => (geliefert = r));
  await ctx.route(ENTSCHEIDUNG, async (route) => {
    const { aktion } = route.request().postDataJSON() as { aktion: string };
    aktionen.push(aktion);
    await warten;
    if (antwort === 'abbruch') await route.abort();
    else await route.fulfill({ status: antwort.status, json: antwort.body });
    geliefert();
  });
  return { aktionen, freigeben, abgeliefert };
}

/** Lässt dem Browser Zeit, eine eben gelieferte Antwort zu verarbeiten. */
const ausschwingen = (page: Page) =>
  page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );

const karte = (page: Page, zustand: string) =>
  page.locator(`[data-testid=verbinden-karte][data-zustand=${zustand}]`);

/** Öffnet die Seite für einen Code und wartet auf die Frage (nicht die des vorigen Falls). */
async function frageOeffnen(page: Page, code: string): Promise<void> {
  await page.goto(`/verbinden#${code}`);
  await expect(page.getByTestId('verbinden-code')).toHaveText(code, { timeout: 15_000 });
  await expect(karte(page, 'bereit')).toBeVisible();
}

test.describe.serial('Bestätigungsseite /verbinden', () => {
  let ctx: BrowserContext;
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    // Ein Service Worker kann Anfragen bedienen, die Playwright-Routen dann nicht sehen.
    ctx = await browser.newContext({ serviceWorkers: 'block' });
    page = await ctx.newPage();
  });

  test.afterAll(async () => {
    await ctx.close();
  });

  test('abgemeldet: Konto erstellen führt zur Frage zurück', async () => {
    const aktionen = await cloudVortaeuschen(ctx);
    await page.goto(`/verbinden#${CODE}`);
    await expect(karte(page, 'abgemeldet')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('verbinden-code')).toHaveText(CODE);

    await page.getByTestId('verbinden-registrieren').click();
    await page.waitForURL(/\/register/);
    await page.getByTestId('reg-username').fill(NAME);
    await page.getByTestId('reg-email').fill(`${NAME}@dcc-test.example.com`);
    await page.getByTestId('reg-password').fill(PW);
    await page.getByTestId('reg-submit').click();
    // Registrieren endet auf /app; die Startseite löst den gemerkten Code ein.
    await page.waitForURL((u) => u.pathname === '/verbinden' && u.hash === `#${CODE}`, {
      timeout: 20_000
    });

    await expect(karte(page, 'bereit')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('verbinden-host')).toHaveText(HOST);
    await expect(page.getByTestId('verbinden-code')).toHaveText(CODE);
    await expect(page.getByTestId('verbinden-warnung')).toBeVisible();
    // Eine freie Adresse braucht keinen Hinweis auf eine Übernahme.
    await expect(page.getByTestId('verbinden-adresse-vergeben')).toHaveCount(0);
    // Schutz gegen untergeschobene Links (E5): Abbrechen ist vorausgewählt.
    await expect(page.getByTestId('verbinden-abbrechen')).toBeFocused();

    // Beide Knöpfe nennen mit ihrem Namen auch Warnung, Adresse und Code — wer sie
    // mit dem Screenreader erreicht, hört, worüber er entscheidet.
    for (const knopf of ['verbinden-abbrechen', 'verbinden-bestaetigen']) {
      const beschreibung = page.getByTestId(knopf);
      await expect(beschreibung).toHaveAccessibleDescription(/Hat dir jemand diesen Link geschickt/);
      await expect(beschreibung).toHaveAccessibleDescription(/Adresse: chat\.dcc-test\.example\.com/);
      await expect(beschreibung).toHaveAccessibleDescription(/Code: K7QM-2XDP/);
    }

    await page.getByTestId('verbinden-bestaetigen').click();
    await expect(karte(page, 'verbunden')).toBeVisible();
    expect(aktionen).toEqual(['verbinden']);
  });

  test('von Hand eingetippt; Enter auf dem vorausgewählten Knopf lehnt ab', async () => {
    const aktionen = await cloudVortaeuschen(ctx);
    await page.goto('/verbinden');
    await expect(karte(page, 'eingabe')).toBeVisible({ timeout: 15_000 });

    await page.getByTestId('verbinden-code-eingabe').fill('abc');
    await page.getByTestId('verbinden-code-weiter').click();
    await expect(page.getByTestId('verbinden-hinweis')).toHaveAttribute('data-fehler', 'eingabe');
    await expect(karte(page, 'eingabe')).toBeVisible();

    await page.getByTestId('verbinden-code-eingabe').fill('k7qm 2xdp');
    await page.getByTestId('verbinden-code-weiter').click();
    await expect(page).toHaveURL(new RegExp(`/verbinden#${CODE}$`));
    await expect(karte(page, 'bereit')).toBeVisible();
    await expect(page.getByTestId('verbinden-abbrechen')).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(karte(page, 'abgelehnt')).toBeVisible();
    expect(aktionen).toEqual(['ablehnen']);
  });

  test('unbekannter oder verbrauchter Code', async () => {
    await cloudVortaeuschen(ctx, { holen: { status: 404, body: { detail: 'unbekannt' } } });
    await page.goto('/verbinden#ZZZZ-ZZZZ');
    await expect(karte(page, 'unbekannt')).toBeVisible({ timeout: 15_000 });
  });

  test('Fehler beim Bestätigen: der Grund steht da, die Frage bleibt', async () => {
    const faelle: { code: string; antwort: Antwort; art: string }[] = [
      {
        code: 'A1B2-C3D4',
        antwort: {
          status: 409,
          body: { detail: { code: 'nachweis_fehlt', befund: 'zertifikat' } }
        },
        art: 'nachweis_fehlt'
      },
      {
        code: 'A1B2-C3D5',
        antwort: { status: 409, body: { detail: 'zu_viele_server' } },
        art: 'zu_viele_server'
      },
      {
        code: 'A1B2-C3D6',
        antwort: { status: 403, body: { detail: 'verbinden_gesperrt' } },
        art: 'verbinden_gesperrt'
      },
      {
        code: 'A1B2-C3D7',
        antwort: { status: 403, body: { detail: 'instance_suspended' } },
        art: 'adresse_gesperrt'
      },
      {
        code: 'A1B2-C3D8',
        antwort: { status: 503, body: { detail: 'verbinden_ausgelastet' } },
        art: 'ausgelastet'
      }
    ];
    for (const fall of faelle) {
      await cloudVortaeuschen(ctx, { entscheiden: fall.antwort });
      await frageOeffnen(page, fall.code);
      await page.getByTestId('verbinden-bestaetigen').click();
      const hinweis = page.getByTestId('verbinden-hinweis');
      await expect(hinweis).toHaveAttribute('data-fehler', fall.art);
      await expect(karte(page, 'bereit')).toBeVisible();
      // Nach der Antwort ist die Frage wieder bedienbar, Abbrechen wieder vorn.
      await expect(page.getByTestId('verbinden-bestaetigen')).toBeEnabled();
      await expect(page.getByTestId('verbinden-abbrechen')).toBeFocused();
      // Der Hinweis steht über den Knöpfen und im Bild, nicht unter der Kontozeile.
      await expect(hinweis).toBeInViewport();
      const hinweisBox = (await hinweis.boundingBox())!;
      const knopfBox = (await page.getByTestId('verbinden-abbrechen').boundingBox())!;
      expect(hinweisBox.y + hinweisBox.height).toBeLessThanOrEqual(knopfBox.y);
    }
  });

  test('gesperrte Übernahme ist ein Endzustand: keine Frage, keine Knöpfe zum Bestätigen', async () => {
    // Die Cloud beendet den Vorgang dabei (Task 1.11); ein zweiter Klick bekäme 404.
    const faelle = [
      { code: 'P1Q2-R3S4', bis: '2031-11-10T12:00:00Z' as string | null },
      { code: 'P1Q2-R3S5', bis: null }
    ];
    for (const { code, bis } of faelle) {
      const aktionen = await cloudVortaeuschen(ctx, {
        entscheiden: { status: 409, body: { detail: { code: 'uebernahme_gesperrt', bis } } }
      });
      await frageOeffnen(page, code);
      await page.getByTestId('verbinden-bestaetigen').click();
      await expect(karte(page, 'uebernahme_gesperrt')).toBeVisible();
      const text = page.getByTestId('verbinden-abschluss-text');
      await expect(text).toContainText('kann gerade nicht übernommen werden');
      if (bis) await expect(text).toContainText('2031');
      else await expect(text).not.toContainText(/\{datum\}|undefined|null/);
      await expect(page.getByTestId('verbinden-bestaetigen')).toHaveCount(0);
      await expect(page.getByTestId('verbinden-abbrechen')).toHaveCount(0);
      await expect(page.getByTestId('verbinden-hinweis')).toHaveCount(0);
      await expect(page.getByTestId('verbinden-zu-pulse')).toBeVisible();
      expect(aktionen).toEqual(['verbinden']);
    }

    // Ein Neuladen findet den Code verbraucht: „nachsehen“, nicht „gilt nicht mehr“.
    await cloudVortaeuschen(ctx, { holen: { status: 404, body: { detail: 'unbekannt' } } });
    await page.reload();
    await expect(karte(page, 'nachsehen')).toBeVisible({ timeout: 15_000 });
  });

  test('vergebene Adresse: Hinweis vor dem Knopf, Bestätigen beantragt nur die Übernahme', async () => {
    const aktionen = await cloudVortaeuschen(ctx, {
      holen: vorgangOk({ adresse_vergeben: true }),
      entscheiden: {
        status: 200,
        body: { status: 'uebernahme_beantragt', hostname: HOST, frist_bis: '2031-11-13T12:00:00Z' }
      }
    });
    await frageOeffnen(page, 'B1C2-D3E4');
    const hinweis = page.getByTestId('verbinden-adresse-vergeben');
    await expect(hinweis).toBeVisible();
    await expect(hinweis).toContainText('72 Stunden');
    // Der Hinweis steht über den Knöpfen, nicht darunter.
    const hinweisBox = (await hinweis.boundingBox())!;
    const knopfBox = (await page.getByTestId('verbinden-abbrechen').boundingBox())!;
    expect(hinweisBox.y).toBeLessThan(knopfBox.y);
    await expect(page.getByTestId('verbinden-abbrechen')).toBeFocused();

    await page.getByTestId('verbinden-bestaetigen').click();
    await expect(karte(page, 'uebernahme_beantragt')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Übernahme beantragt');
    await expect(page.getByTestId('verbinden-abschluss-text')).not.toContainText(
      'Übernahme beantragt'
    );
    await expect(page.getByTestId('verbinden-abschluss-text')).toContainText('2031');
    await expect(page.getByTestId('verbinden-abschluss-text')).toContainText('widersprechen');
    expect(aktionen).toEqual(['verbinden']);
  });

  test('Bestätigung ohne Antwort: der zweite Versuch bekommt 404 und das heißt „nachsehen“', async () => {
    // Die Cloud bestätigt bis zu ~30 s lang. Reißt die Verbindung in dieser Zeit ab,
    // hat der erste Klick trotzdem gewirkt; der zweite findet den Code verbraucht.
    const aktionen = await cloudVortaeuschen(ctx, {
      entscheiden: ['abbruch', { status: 404, body: { detail: 'unbekannt' } }]
    });
    await frageOeffnen(page, 'C1D2-E3F4');
    await page.getByTestId('verbinden-bestaetigen').click();
    const hinweis = page.getByTestId('verbinden-hinweis');
    await expect(hinweis).toHaveAttribute('data-fehler', 'sonst');
    // Der Klick kann gewirkt haben: kein „Etwas ist schiefgegangen“.
    await expect(hinweis).toContainText('Die Antwort kam nicht an');
    await expect(hinweis).toContainText('Konsole deines Servers');
    await expect(karte(page, 'bereit')).toBeVisible();

    await page.getByTestId('verbinden-bestaetigen').click();
    await expect(karte(page, 'nachsehen')).toBeVisible();
    await expect(karte(page, 'unbekannt')).toHaveCount(0);
    expect(aktionen).toEqual(['verbinden', 'verbinden']);
  });

  test('ein erster Klick auf einen abgelaufenen Code bleibt „gilt nicht mehr“', async () => {
    await cloudVortaeuschen(ctx, {
      entscheiden: { status: 404, body: { detail: 'unbekannt' } }
    });
    await frageOeffnen(page, 'D1E2-F3G4');
    await page.getByTestId('verbinden-bestaetigen').click();
    await expect(karte(page, 'unbekannt')).toBeVisible();
  });

  test('Neuladen nach dem Bestätigen: 404 heißt „nachsehen“, nicht „gilt nicht mehr“', async () => {
    await cloudVortaeuschen(ctx);
    await frageOeffnen(page, 'E1F2-G3H4');
    await page.getByTestId('verbinden-bestaetigen').click();
    await expect(karte(page, 'verbunden')).toBeVisible();

    // Der Code ist verbraucht; die Cloud kennt ihn nicht mehr.
    await cloudVortaeuschen(ctx, { holen: { status: 404, body: { detail: 'unbekannt' } } });
    await page.reload();
    await expect(karte(page, 'nachsehen')).toBeVisible({ timeout: 15_000 });
  });

  test('Doppelklick: das Bestätigen geht genau einmal hinaus', async () => {
    await cloudVortaeuschen(ctx);
    // Die Antwort kommt erst nach dem zweiten Klick.
    const { aktionen, freigeben } = await entscheidungAnhalten(ctx, {
      status: 200,
      body: { status: 'verbunden', hostname: HOST, instance_id: '7300000000000000098' }
    });
    await frageOeffnen(page, 'F1G2-H3J4');
    const bestaetigen = page.getByTestId('verbinden-bestaetigen');
    await bestaetigen.click();
    await expect(bestaetigen).toBeDisabled();
    await expect(page.getByTestId('verbinden-abbrechen')).toBeDisabled();
    // Beim Bestätigen spricht die Frage von der Prüfung, nicht vom Abbrechen.
    await expect(bestaetigen).toContainText('Verbinde');
    await expect(page.getByTestId('verbinden-dauert')).toBeVisible();
    await expect(page.getByTestId('verbinden-bricht-ab')).toHaveCount(0);
    await bestaetigen.click({ force: true, noWaitAfter: true }).catch(() => undefined);
    freigeben();
    await expect(karte(page, 'verbunden')).toBeVisible();
    expect(aktionen).toEqual(['verbinden']);
  });

  test('Abbrechen zeigt keinen Verbindungstext', async () => {
    await cloudVortaeuschen(ctx);
    const { aktionen, freigeben } = await entscheidungAnhalten(ctx, {
      status: 200,
      body: { status: 'abgelehnt' }
    });
    await frageOeffnen(page, 'G1H2-J3K4');
    await page.getByTestId('verbinden-abbrechen').click();
    await expect(page.getByTestId('verbinden-bricht-ab')).toBeVisible();
    await expect(page.getByTestId('verbinden-abbrechen')).toBeDisabled();
    // Weder „Verbinde …“ am Bestätigen-Knopf noch der Hinweis auf die 30 s Prüfung.
    await expect(page.getByTestId('verbinden-bestaetigen')).toBeDisabled();
    await expect(page.getByTestId('verbinden-bestaetigen')).not.toContainText('Verbinde');
    await expect(page.getByTestId('verbinden-dauert')).toHaveCount(0);
    freigeben();
    await expect(karte(page, 'abgelehnt')).toBeVisible();
    expect(aktionen).toEqual(['ablehnen']);
  });

  test('eine Antwort für einen inzwischen gewechselten Code wird verworfen', async () => {
    await cloudVortaeuschen(ctx);
    const { aktionen, freigeben, abgeliefert } = await entscheidungAnhalten(ctx, {
      status: 200,
      body: { status: 'verbunden', hostname: HOST, instance_id: '7300000000000000097' }
    });
    await frageOeffnen(page, 'H1J2-K3M4');
    await page.getByTestId('verbinden-bestaetigen').click();
    await expect(page.getByTestId('verbinden-dauert')).toBeVisible();

    // Während die Antwort aussteht, öffnet sich in diesem Tab ein anderer Link.
    await frageOeffnen(page, 'N1P2-Q3R4');
    await expect(page.getByTestId('verbinden-bestaetigen')).toBeEnabled();
    await expect(page.getByTestId('verbinden-dauert')).toHaveCount(0);

    freigeben();
    await abgeliefert;
    await ausschwingen(page);
    // Die späte Antwort gehörte zum alten Code: die neue Frage bleibt, wie sie ist.
    await expect(karte(page, 'bereit')).toBeVisible();
    await expect(page.getByTestId('verbinden-code')).toHaveText('N1P2-Q3R4');
    await expect(page.getByTestId('verbinden-bestaetigen')).toBeEnabled();
    expect(aktionen).toEqual(['verbinden']);
  });

  test('angemeldet mit Code in der Adresse: ein gemerkter Code wird verworfen', async () => {
    // Sonst holte /app ihn später auf einen alten Code zurück.
    await cloudVortaeuschen(ctx);
    const gemerkt = () => page.evaluate(() => localStorage.getItem('pulse.verbinden.gemerkt'));
    await page.evaluate(() =>
      localStorage.setItem(
        'pulse.verbinden.gemerkt',
        JSON.stringify({ code: 'Z1Z2-Z3Z4', gemerktAm: Date.now() })
      )
    );
    expect(await gemerkt()).not.toBeNull();
    await frageOeffnen(page, 'Y1Y2-Y3Y4');
    await expect(page.getByTestId('verbinden-code')).toHaveText('Y1Y2-Y3Y4');
    expect(await gemerkt()).toBeNull();
  });

  test('abgemeldet: Anmelden führt zurück, der Code reist nicht über die Adresse', async ({
    browser
  }) => {
    const zweiter = await browser.newContext({ serviceWorkers: 'block' });
    try {
      await cloudVortaeuschen(zweiter);
      const p = await zweiter.newPage();
      await p.goto(`/verbinden#${CODE}`);
      await expect(karte(p, 'abgemeldet')).toBeVisible({ timeout: 15_000 });
      await p.getByTestId('verbinden-anmelden').click();
      await p.waitForURL(/\/login\?redirect=%2Fverbinden$/);
      // Die Anmeldeseite fordert der Browser beim Server an (Spec E5).
      expect(p.url()).not.toContain('K7QM');
      await p.getByTestId('login-identifier').fill(NAME);
      await p.getByTestId('login-password').fill(PW);
      await p.getByTestId('login-submit').click();
      await p.waitForURL((u) => u.pathname === '/verbinden', { timeout: 20_000 });
      await expect(karte(p, 'bereit')).toBeVisible({ timeout: 15_000 });
      await expect(p.getByTestId('verbinden-code')).toHaveText(CODE);
      // Nach der Anmeldung steht der Code in der Adresse (hinter `#`) und der
      // gemerkte ist verbraucht: ein Neuladen behält die Frage.
      await expect(p).toHaveURL(new RegExp(`/verbinden#${CODE}$`));
      expect(await p.evaluate(() => localStorage.getItem('pulse.verbinden.gemerkt'))).toBeNull();
      await p.reload();
      await expect(karte(p, 'bereit')).toBeVisible({ timeout: 15_000 });
      await expect(p.getByTestId('verbinden-code')).toHaveText(CODE);
    } finally {
      await zweiter.close();
    }
  });
});
