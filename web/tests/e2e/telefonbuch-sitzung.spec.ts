/**
 * Telefonbuch-Abfrage nur mit Cloud-Sitzung (Konsolen-401 auf
 * `GET /api/auth/me/instances/{id}/direct-endpoint`).
 *
 * Das `pulse_session`-Cookie läuft 30 Minuten nach der letzten ERNEUERUNG ab
 * (Max-Age wird nur beim Anmelden und bei `/session/renew` gesetzt, die
 * Server-Seite verlängert allein die Datenbankzeile). Die Abfrage der
 * App-Host-Anwesenheit nahm bis dahin ein nacktes `fetch(…, credentials:
 * 'include')` und bekam in zwei Lagen 401, das als rote Zeile in der Konsole
 * stand, obwohl die App es als „unbekannt“ wegsteckt:
 *  1. App-Start mit abgelaufenem Cookie: der erste Takt läuft der Erneuerung
 *     aus `auth.hydrate()` davon.
 *  2. Ein Tab, der länger als 30 Minuten offen ist: der 2-Minuten-Takt trifft
 *     auf ein Cookie, das der Browser längst gelöscht hat.
 *
 * Die Server-Einträge sind ERFUNDEN (lokale Liste, `origin: 'app_host'`); die
 * Cloud kennt die Instanz nicht und antwortet 404 — das genügt, denn geprüft
 * wird allein, ob die Abfrage mit einer Sitzung ankommt (404/200) oder ohne
 * (401).
 */
import { test, expect, type BrowserContext, type Page } from '@playwright/test';

const PW = 'Passwort123!';
const TAG = Date.now().toString(36);
const INSTANZ = '777400';

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

/** Ein erfundener App-Host-Server in der lokalen Liste (überlebt den Reload). */
async function appHostEintragen(page: Page): Promise<void> {
  await page.evaluate((instanz) => {
    const liste = JSON.parse(localStorage.getItem('pulse.servers') ?? '[]') as { id: string }[];
    if (!liste.some((s) => s.id === 'e2e-telefonbuch-apphost')) {
      liste.push({
        id: 'e2e-telefonbuch-apphost',
        hostname: 'https://telefonbuch.e2e.invalid',
        label: 'https://telefonbuch.e2e.invalid',
        server_name: null,
        instance_id: instanz,
        origin: 'app_host',
        isCloud: false,
        je_verbunden: true,
        role: 'member',
        notification_mode: 'mentions',
        added_at: Date.now()
      } as never);
    }
    localStorage.setItem('pulse.servers', JSON.stringify(liste));
  }, INSTANZ);
}

/** Alle Antworten auf das Telefonbuch dieser Instanz, in Reihenfolge. */
function telefonbuchAntworten(page: Page): number[] {
  const stati: number[] = [];
  page.on('response', (r) => {
    if (r.url().includes(`/me/instances/${INSTANZ}/direct-endpoint`)) stati.push(r.status());
  });
  return stati;
}

test.describe.configure({ mode: 'serial' });

test.describe('Telefonbuch-Abfrage braucht eine Cloud-Sitzung', () => {
  let ctx: BrowserContext;
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: 'de-DE',
      serviceWorkers: 'block'
    });
    // Changelog-Toast steht unten rechts und frisst Klicks.
    await ctx.route('**/changelog.json', (route) => route.fulfill({ json: { entries: [] } }));
    page = await ctx.newPage();
    await registrieren(page, `tb_${TAG}`);
    await appHostEintragen(page);
  });

  test.afterAll(async () => {
    await ctx.close();
  });

  test('App-Start nach abgelaufenem Cookie: erst die Erneuerung, dann das Telefonbuch', async () => {
    // Die Erneuerung künstlich langsam: der erste Takt kann ihr nicht
    // zufällig nachlaufen, er MUSS auf sie warten.
    await ctx.route('**/api/auth/session/renew', async (route) => {
      await new Promise((r) => setTimeout(r, 2500));
      await route.continue();
    });
    // Der Browser hat das Cookie nach 30 Minuten gelöscht.
    await ctx.clearCookies({ name: 'pulse_session' });

    const stati = telefonbuchAntworten(page);
    await page.reload();
    await expect.poll(() => stati.length, { timeout: 20_000 }).toBeGreaterThan(0);

    expect(stati, 'kein 401 auf dem Telefonbuch (Cloud kennt die Instanz nicht → 404)').not.toContain(
      401
    );
    expect(stati[0]).toBe(404);
    await ctx.unroute('**/api/auth/session/renew');
  });

  test('Tab länger als 30 Minuten offen: der Takt erneuert, bevor er fragt', async () => {
    // Vor dem Laden installieren, damit auch das setInterval der Anwesenheit
    // unter der gefälschten Uhr steht.
    await page.clock.install();
    await page.reload();
    const stati = telefonbuchAntworten(page);
    await expect.poll(() => stati.length, { timeout: 20_000 }).toBeGreaterThan(0);
    const davor = stati.length;

    // 31 Minuten vergehen; der Browser wirft das Cookie weg.
    await ctx.clearCookies({ name: 'pulse_session' });
    const erneuert = page.waitForRequest((r) => r.url().includes('/api/auth/session/renew'), {
      timeout: 20_000
    });
    await page.clock.fastForward('31:00');
    await erneuert;

    await expect.poll(() => stati.length, { timeout: 20_000 }).toBeGreaterThan(davor);
    expect(stati, 'auch nach dem Ablauf kein 401').not.toContain(401);
  });
});
