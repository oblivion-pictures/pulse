/**
 * Self-Host umbenennen — Rechtsklick am Rechner, Antippen am Handy.
 *
 * Der Server ist hier ein ERFUNDENER Eintrag der lokalen Serverliste
 * (`*.e2e.invalid`, Muster wie `e2e-dm-hintergrund-hetzner.spec.ts`); seine
 * Antworten kommen aus `page.route`. Geprüft wird damit, was die Oberfläche
 * tut: wer den Eintrag sieht, was an den Server hinausgeht (Name, Server-
 * Sitzung, nicht die Cloud) und was danach in der Leiste steht. Dass der
 * Server den Namen speichert, verteilt und der Cloud meldet, prüfen die
 * Backend-Tests (`test_instance_name_cloud.py`, `test_instance_status.py`).
 *
 * Dass ein ANDERES Mitglied den Namen sieht, ist hier nicht abgebildet: das
 * Ereignis `instance_status` kommt über die Cloud-WebSocket, die der Test nicht
 * fälschen kann. Seine Wirkung auf den Eintrag deckt `server-umbenennen.test.ts`
 * (Node-Läufer) ab.
 */
import { test, expect, type BrowserContext, type Page, type Route } from '@playwright/test';

const PW = 'Passwort123!';
const TAG = Date.now().toString(36);
const HOST = 'https://umbenennen.e2e.invalid';
const EIGENER = 'e2e-umbenennen-eigener';
const FREMDER = 'e2e-umbenennen-fremder';
const FREMDER_HOST = 'https://fremd.e2e.invalid';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': '*'
};

type Spur = { patches: { body: { instance_name?: string }; auth: string | undefined }[] };

/** Die Antworten des erfundenen Servers und der Cloud-Ticket-Route. */
async function serverErfinden(ctx: BrowserContext): Promise<Spur> {
  const spur: Spur = { patches: [] };
  await ctx.route('**/api/auth/me/server-ticket', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ticket: 'ticket-e2e', expires_in: 60, instance_id: '777000' })
    })
  );
  await ctx.route(`${HOST}/**`, async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: CORS });
    }
    if (url.pathname === '/api/chat/session') {
      return route.fulfill({
        status: 200,
        headers: CORS,
        contentType: 'application/json',
        body: JSON.stringify({ session_token: 'sitzung-e2e', expires_in: 3600 })
      });
    }
    if (url.pathname === '/api/chat/admin/permissions' && req.method() === 'PATCH') {
      const body = req.postDataJSON() as { instance_name?: string };
      spur.patches.push({ body, auth: req.headers()['authorization'] });
      return route.fulfill({
        status: 200,
        headers: CORS,
        contentType: 'application/json',
        // Der Server liefert den bereinigten Stand zurück; leer wird NULL.
        body: JSON.stringify({ instance_name: body.instance_name?.trim() || null })
      });
    }
    // Alles Übrige (WebSocket-Vorprüfung, Server-Info, …): der Server ist „weg“.
    return route.abort('connectionrefused');
  });
  return spur;
}

/** Zwei erfundene Server in die lokale Liste: einen eigenen, einen fremden. */
async function serverEintragen(page: Page): Promise<void> {
  await page.evaluate(
    ({ eigener, fremder, host, fremderHost }) => {
      const liste = JSON.parse(localStorage.getItem('pulse.servers') ?? '[]') as { id: string }[];
      const basis = {
        je_verbunden: true,
        server_name: null,
        origin: 'vps',
        isCloud: false,
        notification_mode: 'mentions',
        added_at: Date.now()
      };
      const neu = [
        { ...basis, id: eigener, hostname: host, label: host, instance_id: '777000', role: 'owner' },
        {
          ...basis,
          id: fremder,
          hostname: fremderHost,
          label: fremderHost,
          instance_id: '777001',
          role: 'member'
        }
      ];
      for (const s of neu) if (!liste.some((x) => x.id === s.id)) liste.push(s);
      localStorage.setItem('pulse.servers', JSON.stringify(liste));
    },
    { eigener: EIGENER, fremder: FREMDER, host: HOST, fremderHost: FREMDER_HOST }
  );
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

test.describe('Server umbenennen — Rechner', () => {
  let ctx: BrowserContext;
  let page: Page;
  let spur: Spur;

  test.beforeAll(async ({ browser }) => {
    ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: 'de-DE',
      serviceWorkers: 'block'
    });
    spur = await serverErfinden(ctx);
    page = await ctx.newPage();
    await registrieren(page, `umb_${TAG}`);
    await serverEintragen(page);
    await page.reload();
    await expect(page.getByTestId(`server-${EIGENER}`)).toBeVisible({ timeout: 15_000 });
  });

  test.afterAll(async () => {
    await ctx.close();
  });

  test('ohne Namen zeigt die Leiste die Adresse', async () => {
    await expect(page.getByTestId(`server-${EIGENER}`)).toHaveAttribute(
      'aria-label',
      'umbenennen.e2e.invalid'
    );
  });

  test('Rechtsklick auf den eigenen Server bietet „Umbenennen“ an', async () => {
    await page.getByTestId(`server-${EIGENER}`).click({ button: 'right' });
    await expect(page.getByTestId('server-rename-menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('server-rename-menu')).toBeHidden();
  });

  test('ein fremder Server (Mitglied) bietet es nicht an', async () => {
    await page.getByTestId(`server-${FREMDER}`).click({ button: 'right' });
    // Das Menü ist offen (Benachrichtigungen gibt es immer) ...
    await expect(page.getByRole('menuitem').first()).toBeVisible();
    // ... aber ohne „Umbenennen“.
    await expect(page.getByTestId('server-rename-menu')).toHaveCount(0);
    await page.keyboard.press('Escape');
  });

  test('Name eingeben: geht mit der Server-Sitzung an den Server, die Leiste zeigt ihn', async () => {
    await page.getByTestId(`server-${EIGENER}`).click({ button: 'right' });
    await page.getByTestId('server-rename-menu').click();
    const dialog = page.getByTestId('server-rename-dialog');
    await expect(dialog).toBeVisible();
    // Ohne gesetzten Namen bleibt das Feld leer (die Adresse gehört nicht hinein).
    await expect(page.getByTestId('server-rename-name')).toHaveValue('');
    await page.getByTestId('server-rename-name').fill('  Michaels Server ');
    await page.getByTestId('server-rename-submit').click();
    await expect(dialog).toBeHidden();

    // Gespeichert wird beim SERVER, mit dessen Sitzung — nicht bei der Cloud.
    expect(spur.patches).toHaveLength(1);
    expect(spur.patches[0].body).toEqual({ instance_name: 'Michaels Server' });
    expect(spur.patches[0].auth).toBe('Bearer sitzung-e2e');

    await expect(page.getByTestId(`server-${EIGENER}`)).toHaveAttribute(
      'aria-label',
      'Michaels Server'
    );
    // Der andere Server ist unberührt.
    await expect(page.getByTestId(`server-${FREMDER}`)).toHaveAttribute(
      'aria-label',
      'fremd.e2e.invalid'
    );
  });

  test('der Name übersteht ein Neuladen, und der Dialog zeigt ihn vorbelegt', async () => {
    await page.reload();
    await expect(page.getByTestId(`server-${EIGENER}`)).toHaveAttribute(
      'aria-label',
      'Michaels Server'
    );
    await page.getByTestId(`server-${EIGENER}`).click({ button: 'right' });
    await page.getByTestId('server-rename-menu').click();
    await expect(page.getByTestId('server-rename-name')).toHaveValue('Michaels Server');
  });

  test('unverändert speichern schickt nichts', async () => {
    await page.getByTestId('server-rename-submit').click();
    await expect(page.getByTestId('server-rename-dialog')).toBeHidden();
    expect(spur.patches).toHaveLength(1);
  });

  test('leer speichern setzt auf die Adresse zurück', async () => {
    await page.getByTestId(`server-${EIGENER}`).click({ button: 'right' });
    await page.getByTestId('server-rename-menu').click();
    await page.getByTestId('server-rename-name').fill('');
    await page.getByTestId('server-rename-submit').click();
    await expect(page.getByTestId('server-rename-dialog')).toBeHidden();
    // Leer geht als "" hinaus — null hieße im Server „nicht ändern“.
    expect(spur.patches).toHaveLength(2);
    expect(spur.patches[1].body).toEqual({ instance_name: '' });
    await expect(page.getByTestId(`server-${EIGENER}`)).toHaveAttribute(
      'aria-label',
      'umbenennen.e2e.invalid'
    );
  });
});

test.describe('Server umbenennen — Handy', () => {
  const HANDY = { width: 390, height: 844 };
  let ctx: BrowserContext;
  let page: Page;
  let spur: Spur;

  test.beforeAll(async ({ browser }) => {
    ctx = await browser.newContext({
      viewport: HANDY,
      locale: 'de-DE',
      isMobile: true,
      hasTouch: true,
      serviceWorkers: 'block'
    });
    spur = await serverErfinden(ctx);
    page = await ctx.newPage();
    await registrieren(page, `umbm_${TAG}`);
    await serverEintragen(page);
    await page.goto('/app/rooms');
    await expect(page.getByTestId('rooms-page')).toBeVisible({ timeout: 15_000 });
  });

  test.afterAll(async () => {
    await ctx.close();
  });

  test('die Zeile des eigenen Servers ist antippbar, die des fremden nur eine Überschrift', async () => {
    const zeile = page.getByTestId(`rooms-server-rename-${EIGENER}`);
    await expect(zeile).toBeVisible();
    await expect(zeile).toContainText('umbenennen.e2e.invalid');
    await expect(page.getByTestId(`rooms-server-rename-${FREMDER}`)).toHaveCount(0);
    await expect(page.getByText('fremd.e2e.invalid')).toBeVisible();
    // Treffsichere Fläche: mindestens 48 dp hoch.
    const box = await zeile.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(48);
  });

  test('Antippen öffnet den Dialog, Speichern zeigt den Namen in der Zeile', async () => {
    await page.getByTestId(`rooms-server-rename-${EIGENER}`).tap();
    await expect(page.getByTestId('server-rename-dialog')).toBeVisible();
    await page.getByTestId('server-rename-name').fill('Handy-Server');
    await page.getByTestId('server-rename-submit').tap();
    await expect(page.getByTestId('server-rename-dialog')).toBeHidden();
    expect(spur.patches.at(-1)?.body).toEqual({ instance_name: 'Handy-Server' });
    await expect(page.getByTestId(`rooms-server-rename-${EIGENER}`)).toContainText('Handy-Server');
  });
});
