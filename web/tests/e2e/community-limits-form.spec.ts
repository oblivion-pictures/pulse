/**
 * Community-Grenzen-Editor (MANAGE_GUILD): speichert nur, was angefasst wurde.
 *
 * Die Anzeige ist gerundet (zwei Nachkommastellen), der gespeicherte Wert nicht:
 * 1.000.000 Byte stehen als „0.95" im Feld. Früher schickte jedes Speichern den
 * VOLLEN Satz zurück und schrieb damit aus einem Klick auf ein ganz anderes
 * Feld still 996.147 Byte in die Dateigröße. Und ein geleertes Dateigrößen-Feld
 * schickte `null` an eine NOT-NULL-Spalte, was als 422 das ganze Speichern
 * abwies. Geprüft wird am Wert, den der Server danach hält — nicht an der Anzeige.
 */

import { test, expect, type Page } from '@playwright/test';

const ts = Date.now();
const USER = {
  username: `limits_form_${ts}`,
  email: `limits_form_${ts}@dcc-test.example.com`,
  password: 'sup3r-secret-pass'
};
const GROESSE_BYTES = 1_000_000; // Anzeige: 0.95

async function api(page: Page, method: string, path: string, body?: unknown) {
  return page.evaluate(
    async ({ method, path, body }) => {
      const token = localStorage.getItem('dcc.tokens.access');
      const r = await fetch(`/api/chat${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      return { status: r.status, json: await r.json() };
    },
    { method, path, body }
  );
}

test.describe.serial('Community-Grenzen-Editor', () => {
  let page: Page;
  let guildId = '';

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext();
    // Der „Was ist neu?"-Toast liegt sonst über den Knöpfen.
    await ctx.route('**/changelog.json', (route) => route.fulfill({ json: { entries: [] } }));
    page = await ctx.newPage();
  });

  test.afterAll(async () => {
    await page?.context().close();
  });

  test('Vorbereitung: Konto, Community, Dateigröße mit gerundeter Anzeige', async () => {
    test.setTimeout(120_000);
    await page.goto('/register');
    await page.getByTestId('reg-username').fill(USER.username);
    await page.getByTestId('reg-email').fill(USER.email);
    await page.getByTestId('reg-password').fill(USER.password);
    await page.getByTestId('reg-submit').click();
    await page.waitForURL(/\/app/);
    await page
      .locator('[data-testid=backup-onboarding-skip-btn]')
      .click({ timeout: 2500 })
      .catch(() => undefined);
    await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 15_000 });

    const g = await api(page, 'POST', '/guilds', { name: `Limits Form ${ts}` });
    expect(g.status).toBe(201);
    guildId = g.json.id as string;

    const r = await api(page, 'PATCH', `/guilds/${guildId}/limits`, {
      limits: { attachment_max_size_bytes: GROESSE_BYTES }
    });
    expect(r.status).toBe(200);
    expect(r.json.limits.attachment_max_size_bytes.value).toBe(GROESSE_BYTES);
  });

  async function limitsTabOeffnen(): Promise<void> {
    await page.goto('/app');
    await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 15_000 });
    // Unter Last baut die Guild-Rail zwischendurch neu auf und reißt das offene
    // Kontextmenü mit ab — dann das Menü neu öffnen.
    for (let versuch = 0; versuch < 4; versuch++) {
      await page.getByTestId(`guild-${guildId}`).click({ button: 'right' });
      try {
        await page.getByTestId('guild-settings').click({ timeout: 2_500 });
        break;
      } catch {
        // Menü wurde abgebaut — neu öffnen.
      }
    }
    await expect(page.getByTestId('guild-settings-dialog')).toBeVisible();
    await page.getByTestId('settings-tab-limits').click();
    await expect(page.getByTestId('guild-limits-editor')).toBeVisible();
  }

  const speichern = () =>
    Promise.all([
      page.waitForResponse(
        (r) => r.url().includes(`/guilds/${guildId}/limits`) && r.request().method() === 'PATCH'
      ),
      page.getByTestId('guild-limits-save').click()
    ]).then(([antwort]) => antwort);

  test('anderes Feld speichern: die Dateigröße bleibt bytegenau', async () => {
    await limitsTabOeffnen();
    const groesse = page.getByTestId('guild-limit-attachment_max_size_bytes');
    await expect(groesse).toHaveValue('0.95');

    await page.getByTestId('guild-limit-max_members').fill('50');
    const antwort = await speichern();
    expect(antwort.status()).toBe(200);

    const stand = await api(page, 'GET', `/guilds/${guildId}/limits`);
    expect(stand.json.limits.max_members.value).toBe(50);
    expect(stand.json.limits.attachment_max_size_bytes.value).toBe(GROESSE_BYTES);
  });

  test('geleertes Dateigrößen-Feld: kein 422, Wert bleibt, anderes Feld wird gespeichert', async () => {
    await limitsTabOeffnen();
    const groesse = page.getByTestId('guild-limit-attachment_max_size_bytes');
    await groesse.fill('');
    await page.getByTestId('guild-limit-attachment_max_count_per_message').fill('');
    await page.getByTestId('guild-limit-max_members').fill('60');
    const antwort = await speichern();
    expect(antwort.status()).toBe(200);

    const stand = await api(page, 'GET', `/guilds/${guildId}/limits`);
    expect(stand.json.limits.max_members.value).toBe(60);
    expect(stand.json.limits.attachment_max_size_bytes.value).toBe(GROESSE_BYTES);
    // Und das Feld zeigt danach wieder den gespeicherten Stand statt leer.
    await expect(groesse).toHaveValue('0.95');
  });

  test('ein bewusst geänderter Wert kommt an', async () => {
    await limitsTabOeffnen();
    await page.getByTestId('guild-limit-attachment_max_size_bytes').fill('2');
    const antwort = await speichern();
    expect(antwort.status()).toBe(200);
    const stand = await api(page, 'GET', `/guilds/${guildId}/limits`);
    expect(stand.json.limits.attachment_max_size_bytes.value).toBe(2 * 1024 * 1024);
  });
});
