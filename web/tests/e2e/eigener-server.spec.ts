/**
 * „Eigenen Server einrichten“ (Spec 2026-10-09-selfhost-ohne-freigabe-design.md
 * §5): Einstieg im Plus jeder Server-Gruppe (Rechner) und im Menü der Räume
 * (Handy), ein Dialog bzw. ein Blatt von unten mit den Wegen Server-App,
 * gemieteter Server und „Von Pulse gehostet (Bald)“.
 *
 * Ersetzt heim-server.spec.ts: dessen Prüfungen (Download ohne Sperre, kein
 * Antragsformular) stehen jetzt hier am Dialog statt auf /app/server.
 */
import { test, expect, type Page } from '@playwright/test';

const PW = 'Passwort123!';
const TAG = Date.now().toString(36);
const RECHNER = { width: 1440, height: 900 };
const HANDY = { width: 390, height: 844 };

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
});
