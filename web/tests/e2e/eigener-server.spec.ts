/**
 * „Eigenen Server einrichten“ (Spec 2026-10-09-selfhost-ohne-freigabe-design.md
 * §5): Einstieg im Plus jeder Server-Gruppe (Rechner) und im Menü der Räume
 * (Handy), ein Dialog bzw. ein Blatt von unten mit den Wegen Server-App,
 * gemieteter Server und „Von Pulse gehostet (Bald)“.
 *
 * Ersetzt heim-server.spec.ts: dessen Prüfungen (Download ohne Sperre, kein
 * Antragsformular) stehen jetzt hier am Dialog statt auf /app/server.
 */
import { test, expect, type BrowserContext, type Page } from '@playwright/test';

const PW = 'Passwort123!';
const TAG = Date.now().toString(36);
const RECHNER = { width: 1440, height: 900 };
const HANDY = { width: 390, height: 844 };
const HOST = 'meine-server.dcc-test.example.com';
const INSTANZ = '7300000000000000001';

/** Täuscht einen eigenen, verbundenen Server in der Konto-Serverliste vor.
 *  Den Server selbst gibt es nicht — Anfragen an ihn werden sofort
 *  abgewiesen, statt in die Zeitüberschreitung zu laufen.
 *
 *  `zustand.fristBis`: Fristende eines Übernahme-Antrags am Eintrag (Nachtrag
 *  2026-10-11); wird bei JEDER Antwort neu gelesen, damit ein Test die Liste
 *  zwischen zwei Abrufen ändern kann. */
async function eigenerServerVortaeuschen(
  ctx: BrowserContext,
  zustand: { fristBis: string | null } = { fristBis: null }
): Promise<void> {
  await ctx.route('**/api/auth/me/instances', (route) =>
    route.fulfill({
      json: [
        {
          id: INSTANZ,
          hostname: HOST,
          client_id: 'c-e2e',
          worker_id_chat: null,
          worker_id_voice: null,
          worker_id_media: null,
          status: 'active',
          origin: 'vps',
          ohne_freigabe: true,
          registered_at: '2026-10-10T12:00:00Z',
          notification_mode: 'all',
          role: 'owner',
          set_up: true,
          anzeigename: null,
          online: null,
          uebernahme_frist_bis: zustand.fristBis
        }
      ]
    })
  );
  await ctx.route(`https://${HOST}/**`, (route) => route.abort());
}

async function registrieren(page: Page, name: string): Promise<void> {
  await page.goto('/register');
  await page.getByTestId('reg-username').fill(name);
  await page.getByTestId('reg-email').fill(`${name}@dcc-test.example.com`);
  await page.getByTestId('reg-password').fill(PW);
  await page.getByTestId('reg-submit').click();
  await page.waitForURL(/\/app/);
  await page
    .locator('[data-testid=backup-onboarding-skip-btn]')
    .click({ timeout: 2500 })
    .catch(() => undefined);
}

test.describe.configure({ mode: 'serial' });

test.describe('Eigenen Server einrichten', () => {
  test('am Rechner: das Plus öffnet den Dialog mit allen Wegen', async ({ browser }) => {
    const page = await browser.newPage({ viewport: RECHNER });
    await registrieren(page, `es_desk_${TAG}`);

    await page.locator('[data-testid^="guild-create-menu-"]').first().click();
    await page.getByTestId('guild-eigener-server').click();
    const dialog = page.getByTestId('eigener-server-dialog');
    await expect(dialog).toBeVisible();

    await expect(dialog.getByTestId('self-host-install-command')).toHaveText(
      'curl -fsSL https://howispulse.com/install | bash'
    );
    await expect(dialog.getByTestId('self-host-install-guide')).toHaveAttribute(
      'href',
      'https://howispulse.com/self-host/guide'
    );
    // Heim-Server ohne Sperre und ohne Antrag; „Desktop Chrome“ meldet Windows.
    await expect(dialog.getByTestId('server-app-download')).toBeVisible();
    await expect(dialog.getByTestId('server-app-download-windows')).toBeVisible();
    await expect(dialog.getByTestId('eigener-server-gehostet')).toHaveAttribute(
      'aria-disabled',
      'true'
    );
    await expect(page.getByTestId('self-host-application')).toHaveCount(0);

    // Schließen per Knopf IM Dialog: belegt, dass der aus dem Menü geöffnete
    // Dialog bedienbar ist (bits-ui macht sonst den Inhalt still inert).
    await dialog.getByTestId('eigener-server-schliessen').click();
    await expect(page.getByTestId('eigener-server-dialog')).toHaveCount(0);
    await page.close();
  });

  test('am Handy: das Menü der Räume öffnet dasselbe als Blatt', async ({ browser }) => {
    // Geräteklasse hängt am ZEIGER (geraetKlasse.ts): ohne Finger-Emulation
    // wäre jede Breite nur ein schmales Desktop-Fenster.
    const ctx = await browser.newContext({
      viewport: HANDY,
      locale: 'de-DE',
      isMobile: true,
      hasTouch: true
    });
    const page = await ctx.newPage();
    await registrieren(page, `es_handy_${TAG}`);

    await page.goto('/app/rooms');
    await page.getByTestId('rooms-menu').click();
    await page.getByTestId('rooms-eigener-server').click();
    await expect(page.getByTestId('eigener-server-blatt')).toBeVisible();
    await expect(
      page.getByTestId('eigener-server-dialog').getByTestId('self-host-install-command')
    ).toBeVisible();

    // Trefferflächen im Blatt: gemessen wie in mobile-treffflaechen.spec.ts,
    // nicht aus Klassennamen gefolgert (48 dp Höhe, Knopf wie Link).
    const zuKlein = await page.getByTestId('eigener-server-dialog').evaluate((wurzel) => {
      const raus: string[] = [];
      for (const el of wurzel.querySelectorAll<HTMLElement>('button, a[href]')) {
        const hoehe = el.getBoundingClientRect().height;
        if (hoehe > 0 && hoehe < 48) {
          raus.push(`${el.dataset.testid ?? el.tagName}: ${Math.round(hoehe)}px`);
        }
      }
      return raus;
    });
    expect(zuKlein, 'zu kleine Trefferflächen im Blatt').toEqual([]);

    await page.getByTestId('eigener-server-schliessen').click();
    await expect(page.getByTestId('eigener-server-blatt')).toHaveCount(0);
    await ctx.close();
  });

  test('ohne eigenen Server: kein „Meine Server“, kein Server-Knopf', async ({ browser }) => {
    const page = await browser.newPage({ viewport: RECHNER });
    await registrieren(page, `es_ohne_${TAG}`);
    await expect(page.getByTestId('open-self-host')).toHaveCount(0);
    await page.getByTestId('user-footer-trigger').first().click();
    await expect(page.getByTestId('open-settings')).toBeVisible();
    await expect(page.getByTestId('user-footer-meine-server')).toHaveCount(0);
    await page.close();
  });

  test('am Rechner: „Meine Server“ im Konto-Menü führt zur Liste', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: RECHNER, serviceWorkers: 'block' });
    await eigenerServerVortaeuschen(ctx);
    const page = await ctx.newPage();
    await registrieren(page, `es_mit_${TAG}`);

    await page.getByTestId('user-footer-trigger').first().click();
    await page.getByTestId('user-footer-meine-server').click();
    await page.waitForURL(/\/app\/server/);
    await expect(page.getByTestId(`instance-row-${INSTANZ}`)).toBeVisible();
    await expect(page.getByTestId(`instance-delete-btn-${INSTANZ}`)).toBeVisible();
    await expect(page.getByTestId(`instance-setup-btn-${INSTANZ}`)).toHaveCount(0);
    // Kein Übernahme-Antrag, kein Hinweis.
    await expect(page.getByTestId('meine-server-widerspruch')).toHaveCount(0);

    await page.getByTestId('self-host-back').click();
    await page.waitForURL((u) => !u.pathname.startsWith('/app/server'));
    await ctx.close();
  });

  test('am Handy: „Meine Server“ im Du-Bereich, zurück führt dorthin', async ({ browser }) => {
    const handy = { viewport: HANDY, locale: 'de-DE', isMobile: true, hasTouch: true };

    const ohneCtx = await browser.newContext(handy);
    const ohne = await ohneCtx.newPage();
    await registrieren(ohne, `es_hohne_${TAG}`);
    await ohne.goto('/app/rooms');
    await expect(ohne.getByTestId('rooms-page')).toBeVisible();
    await expect(ohne.getByTestId('rooms-open-self-host')).toHaveCount(0);
    await ohne.goto('/app/me');
    await expect(ohne.getByTestId('me-page')).toBeVisible();
    await expect(ohne.getByTestId('me-meine-server')).toHaveCount(0);
    await ohneCtx.close();

    const ctx = await browser.newContext({ ...handy, serviceWorkers: 'block' });
    await eigenerServerVortaeuschen(ctx);
    const page = await ctx.newPage();
    await registrieren(page, `es_hmit_${TAG}`);
    await page.goto('/app/me');
    const eintrag = page.getByTestId('me-meine-server');
    await expect(eintrag).toBeVisible();
    // Trefferfläche wie überall auf schmalen Geräten: mindestens 48 dp.
    expect((await eintrag.boundingBox())!.height).toBeGreaterThanOrEqual(48);
    await eintrag.click();
    await page.waitForURL(/\/app\/server/);
    await expect(page.getByTestId(`instance-row-${INSTANZ}`)).toBeVisible();
    await page.getByTestId('self-host-back').click();
    await page.waitForURL((u) => u.pathname === '/app/me');
    await ctx.close();
  });

  test('Übernahme-Antrag: Hinweis mit Fristende, Widerspruch erst abgewiesen, dann angenommen', async ({
    browser
  }) => {
    // Nachtrag 2026-10-11 (Widerspruchsfrist): die Cloud-Antworten sind gemockt,
    // die Route selbst gehört zu Etappe 1 und liegt hier nicht im Testaufbau.
    const handy = { viewport: HANDY, locale: 'de-DE', isMobile: true, hasTouch: true };
    const ctx = await browser.newContext({ ...handy, serviceWorkers: 'block' });
    const zustand: { fristBis: string | null } = { fristBis: '2031-11-10T12:00:00Z' };
    await eigenerServerVortaeuschen(ctx, zustand);
    let versuche = 0;
    await ctx.route(`**/api/auth/me/instances/${INSTANZ}/uebernahme/widerspruch`, (route) => {
      versuche += 1;
      if (versuche === 1) {
        // Unter der Adresse antwortet gerade nicht dieser Server.
        return route.fulfill({
          status: 409,
          json: { detail: { code: 'widerspruch_ohne_server' } }
        });
      }
      // Danach ist der Antrag erledigt: der Eintrag trägt kein Fristende mehr.
      zustand.fristBis = null;
      return route.fulfill({ status: 204 });
    });
    const page = await ctx.newPage();
    await registrieren(page, `es_uebern_${TAG}`);
    await page.goto('/app/server');

    const hinweis = page.getByTestId(`meine-server-uebernahme-${INSTANZ}`);
    await expect(hinweis).toBeVisible();
    await expect(hinweis).toContainText('Ein anderes Pulse-Konto möchte diesen Server übernehmen');
    await expect(hinweis).toContainText('2031');
    await expect(hinweis).toContainText('Hast du ihn abgegeben, musst du nichts tun');

    const knopf = page.getByTestId('meine-server-widerspruch');
    // Trefferfläche am Handy: mindestens 48 dp.
    expect((await knopf.boundingBox())!.height).toBeGreaterThanOrEqual(48);

    await knopf.click();
    await expect(page.getByTestId('meine-server-widerspruch-fehler')).toContainText(
      'Dein Server antwortet unter dieser Adresse nicht'
    );
    // Der Hinweis bleibt stehen, der Knopf auch: später erneut versuchen.
    await expect(hinweis).toBeVisible();

    await knopf.click();
    await expect(hinweis).toHaveCount(0);
    await expect(page.getByTestId(`instance-row-${INSTANZ}`)).toBeVisible();
    expect(versuche).toBe(2);
    await ctx.close();
  });
});
