/**
 * Server-Knopf unten in der Leiste (nur Desktop) und „Umbenennen“ auf der Seite
 * „Meine Server“.
 *
 * Der Knopf bündelt, was vorher an zwei Stellen stand: „Eigenen Server
 * einrichten“ (Plus der Leiste) und „Meine Server“ (Konto-Menü). Die Server
 * sind hier ERFUNDEN: die Antwort auf `GET /me/instances` kommt aus
 * `page.route`, die Server selbst gibt es nicht (Anfragen an sie werden sofort
 * abgewiesen). Das reicht, weil die Oberfläche nur die Liste der Cloud und den
 * Eintrag in der lokalen Serverliste (`serversStore`) liest, den die Liste
 * anlegt.
 *
 * Der Dialog „Eigenen Server einrichten“ selbst steht in eigener-server.spec.ts,
 * der Umbenennen-Dialog (Rechtsklick, Handy) in server-umbenennen.spec.ts.
 */
import {
  test,
  expect,
  type Browser,
  type BrowserContext,
  type Page,
  type Route
} from '@playwright/test';

const PW = 'Passwort123!';
const TAG = Date.now().toString(36);
const RECHNER = { width: 1440, height: 900 };
const TABLET = { width: 834, height: 1112 };

const ATELIER = '7300000000000000021';
const FAMILIE = '7300000000000000022';
const WERKSTATT = '7300000000000000023';
const NEU = '7300000000000000024';
const FREMD = '7300000000000000025';
const HOST = (id: string) => `s${id.slice(-2)}.dcc-test.example.com`;

type Vorgabe = {
  id: string;
  name: string | null;
  status?: 'active' | 'suspended';
  role?: 'owner' | 'member';
  set_up?: boolean;
};

function instanz(v: Vorgabe) {
  return {
    id: v.id,
    hostname: HOST(v.id),
    client_id: `c-${v.id}`,
    worker_id_chat: null,
    worker_id_voice: null,
    worker_id_media: null,
    status: v.status ?? 'active',
    origin: 'vps',
    ohne_freigabe: true,
    registered_at: '2026-10-10T12:00:00Z',
    notification_mode: 'all',
    role: v.role ?? 'owner',
    set_up: v.set_up ?? true,
    anzeigename: v.name,
    online: null,
    uebernahme_frist_bis: null
  };
}

/** Die Cloud-Antwort auf `GET /me/instances`; die Server dahinter gibt es nicht. */
async function instanzenVortaeuschen(ctx: BrowserContext, liste: Vorgabe[]): Promise<void> {
  await ctx.route('**/api/auth/me/instances', (route) =>
    route.fulfill({ json: liste.map(instanz) })
  );
  await ctx.route(/https:\/\/s\d\d\.dcc-test\.example\.com\/.*/, (route) => route.abort());
}

/** Vier eigene Server (zwei benannt und aktiv, einer ohne Namen und gesperrt,
 *  einer noch nicht eingerichtet) und ein fremder, dem man nur beigetreten ist. */
const VIELE: Vorgabe[] = [
  { id: ATELIER, name: 'Atelier' },
  { id: FAMILIE, name: 'Familie' },
  { id: WERKSTATT, name: null, status: 'suspended' },
  { id: NEU, name: 'Neu', set_up: false },
  { id: FREMD, name: 'Fremd', role: 'member' }
];

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

/** Kontext mit Finger-Zeiger: die Geräteklasse hängt am ZEIGER
 *  (geraetKlasse.ts), ohne Emulation wäre jede Breite nur ein schmales
 *  Desktop-Fenster. */
function fingerKontext(browser: Browser, groesse: { width: number; height: number }) {
  return browser.newContext({
    viewport: groesse,
    locale: 'de-DE',
    isMobile: true,
    hasTouch: true,
    serviceWorkers: 'block'
  });
}

/** Die Leiste zeigt die erfundenen Server erst, wenn die Liste aus der Cloud
 *  eingearbeitet ist — vorher stünde in der Server-Liste des Geräts noch nichts. */
async function warteAufServerLeiste(page: Page, namen: string[]): Promise<void> {
  for (const name of namen) {
    await expect(page.getByRole('button', { name, exact: true })).toBeVisible({ timeout: 15_000 });
  }
}

async function menueOeffnen(page: Page) {
  await page.getByTestId('rail-server-button').click();
  const menue = page.getByTestId('rail-server-menu');
  await expect(menue).toBeVisible();
  return menue;
}

test.describe('Server-Knopf — Rechner, mit eigenen Servern', () => {
  // Eine Sitzung für alle Tests der Gruppe (ein Konto, eine Liste); die übrigen
  // Gruppen bauen sich je Test ihren eigenen Kontext und laufen unabhängig.
  test.describe.configure({ mode: 'serial' });

  let ctx: BrowserContext;
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    ctx = await browser.newContext({ viewport: RECHNER, locale: 'de-DE', serviceWorkers: 'block' });
    await instanzenVortaeuschen(ctx, VIELE);
    page = await ctx.newPage();
    await registrieren(page, `sk_mit_${TAG}`);
    await warteAufServerLeiste(page, ['Atelier', 'Familie']);
  });

  // Jeder Test beginnt auf einer frisch geladenen Seite: kein offenes Menü, kein
  // Dialog aus dem vorigen. (Der aktive Server bleibt über das Neuladen erhalten
  // — deshalb stehen die Tests, die ihn wechseln, ganz am Ende.)
  test.beforeEach(async () => {
    await page.goto('/app/friends');
    await expect(page.getByTestId('rail-server-button')).toBeVisible({ timeout: 15_000 });
  });

  test.afterAll(async () => {
    await ctx.close();
  });

  test('der Knopf sitzt in der Leiste und heißt „Server“, auch als Tooltip', async () => {
    const knopf = page.getByTestId('rail-server-button');
    await expect(knopf).toHaveAttribute('aria-label', 'Server');
    // Unten in der Leiste, in der Spalte der Leiste selbst.
    const leiste = await page.getByTestId('guild-rail').boundingBox();
    const box = await knopf.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(leiste!.x);
    expect(box!.x + box!.width).toBeLessThanOrEqual(leiste!.x + leiste!.width);
    expect(box!.y).toBeGreaterThan(leiste!.y + leiste!.height / 2);

    await knopf.hover();
    await expect(page.locator('[data-slot="tooltip-content"]').first()).toHaveText('Server');
  });

  test('das Menü listet die EIGENEN Server mit Name, Adresse und Status — ohne „Verwalten“ je Zeile', async () => {
    const menue = await menueOeffnen(page);
    await expect(menue.getByText('Meine Server', { exact: true })).toBeVisible();

    // Eigene Server: die vier, nicht der fremde (Mitglied).
    await expect(menue.locator('[data-testid^="rail-server-row-"]')).toHaveCount(4);
    await expect(page.getByTestId(`rail-server-row-${FREMD}`)).toHaveCount(0);

    const atelier = page.getByTestId(`rail-server-row-${ATELIER}`);
    await expect(page.getByTestId(`rail-server-name-${ATELIER}`)).toHaveText('Atelier');
    await expect(page.getByTestId(`rail-server-adresse-${ATELIER}`)).toHaveText(HOST(ATELIER));
    await expect(atelier).toContainText('Aktiv');
    await expect(page.getByTestId(`rail-server-row-${FAMILIE}`)).toContainText('Aktiv');

    // Ohne Namen steht die Adresse einmal vorn, nicht noch einmal darunter.
    await expect(page.getByTestId(`rail-server-name-${WERKSTATT}`)).toHaveText(HOST(WERKSTATT));
    await expect(page.getByTestId(`rail-server-adresse-${WERKSTATT}`)).toHaveCount(0);
    await expect(page.getByTestId(`rail-server-row-${WERKSTATT}`)).toContainText('Gesperrt');

    // Verwaltet wird einmal für alle, unten — nicht je Zeile.
    await expect(menue.getByRole('button', { name: /verwalten/i })).toHaveCount(0);
    await expect(menue.getByRole('menuitem', { name: /verwalten/i })).toHaveCount(1);
    await expect(atelier.getByRole('button')).toHaveCount(0);
  });

  test('„Server verwalten“ öffnet die Seite „Meine Server“', async () => {
    await menueOeffnen(page);
    await page.getByTestId('rail-server-verwalten').click();
    await page.waitForURL(/\/app\/server/);
    await expect(page.getByTestId(`instance-row-${ATELIER}`)).toBeVisible();
    await expect(page.getByTestId(`instance-row-${FAMILIE}`)).toBeVisible();
  });

  test('„Eigenen Server einrichten …“ öffnet den Dialog, und der ist bedienbar', async () => {
    await menueOeffnen(page);
    await expect(page.getByTestId('rail-server-einrichten')).toHaveText(
      /Eigenen Server einrichten …/
    );
    await page.getByTestId('rail-server-einrichten').click();
    const dialog = page.getByTestId('eigener-server-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('self-host-install-command')).toBeVisible();
    // Schließen per Knopf IM Dialog: belegt, dass der aus dem Menü geöffnete
    // Dialog bedienbar ist.
    await dialog.getByTestId('eigener-server-schliessen').click();
    await expect(page.getByTestId('eigener-server-dialog')).toHaveCount(0);
  });

  test('das Plus der Leiste bietet nur noch Erstellen und Beitreten an', async () => {
    const plus = page.locator('[data-testid^="guild-create-menu-"]').first();
    // Die Beschriftung nennt nicht mehr, was das Menü nicht mehr anbietet.
    await expect(plus).not.toHaveAttribute('aria-label', /Server einrichten/);
    await plus.click();
    await expect(page.getByTestId('guild-join')).toBeVisible();
    await expect(page.getByTestId('guild-eigener-server')).toHaveCount(0);
    await expect(page.getByRole('menuitem', { name: /Server einrichten/ })).toHaveCount(0);
  });

  test('das Konto-Menü am Rechner hat kein „Meine Server“ mehr', async () => {
    await page.getByTestId('user-footer-trigger').first().click();
    await expect(page.getByTestId('open-settings')).toBeVisible();
    await expect(page.getByTestId('user-footer-meine-server')).toHaveCount(0);
    await expect(page.getByRole('menuitem', { name: 'Meine Server' })).toHaveCount(0);
  });

  test('eine Zeile ohne Eintrag auf diesem Gerät führt zur Seite „Meine Server“', async () => {
    // „Neu“ ist bei der Cloud eingetragen, aber noch nicht eingerichtet: in der
    // Leiste steht er nicht, in der Liste des Menüs schon.
    await expect(page.getByRole('button', { name: 'Neu', exact: true })).toHaveCount(0);
    await menueOeffnen(page);
    await page.getByTestId(`rail-server-row-${NEU}`).click();
    await page.waitForURL(/\/app\/server/);
    await expect(page.getByTestId(`instance-row-${NEU}`)).toBeVisible();
  });

  test('eine Zeile mit Eintrag in der Leiste wechselt zu diesem Server', async () => {
    const leistenKnopf = page.getByRole('button', { name: 'Familie', exact: true });
    await menueOeffnen(page);
    await page.getByTestId(`rail-server-row-${FAMILIE}`).click();
    await expect(leistenKnopf).toHaveAttribute('data-active', 'true');
    await expect(page.getByTestId('rail-server-menu')).toHaveCount(0);
    // Der Wechsel bleibt, wo man ist: kein Sprung auf die Verwaltungsseite.
    await expect(page).not.toHaveURL(/\/app\/server/);

    await menueOeffnen(page);
    await page.getByTestId(`rail-server-row-${ATELIER}`).click();
    await expect(page.getByRole('button', { name: 'Atelier', exact: true })).toHaveAttribute(
      'data-active',
      'true'
    );
    await expect(leistenKnopf).toHaveAttribute('data-active', 'false');
  });
});

test.describe('Server-Knopf — Rechner, ohne eigenen Server', () => {
  test('der Knopf ist da, das Menü sagt es und bietet nur das Einrichten an', async ({
    browser
  }) => {
    const ctx = await browser.newContext({
      viewport: RECHNER,
      locale: 'de-DE',
      serviceWorkers: 'block'
    });
    // Ein Konto mit Mitgliedschaft auf einem fremden Server, aber ohne eigenen.
    await instanzenVortaeuschen(ctx, [{ id: FREMD, name: 'Fremd', role: 'member' }]);
    const page = await ctx.newPage();
    await registrieren(page, `sk_ohne_${TAG}`);
    await warteAufServerLeiste(page, ['Fremd']);

    const menue = await menueOeffnen(page);
    await expect(page.getByTestId('rail-server-empty')).toHaveText(
      'Du hast noch keinen eigenen Server.'
    );
    await expect(menue.locator('[data-testid^="rail-server-row-"]')).toHaveCount(0);
    await expect(page.getByTestId('rail-server-einrichten')).toBeVisible();
    await expect(page.getByTestId('rail-server-verwalten')).toHaveCount(0);
    await ctx.close();
  });

  test('ein Server, den die Cloud führt und das Gerät noch nicht, schaltet „Server verwalten“ frei', async ({
    browser
  }) => {
    // Die Liste des Geräts nimmt nur eingerichtete Server auf (`set_up`); das
    // Menü zeigt die frisch geladene Liste der Cloud — und mit ihr den Eintrag.
    const ctx = await browser.newContext({
      viewport: RECHNER,
      locale: 'de-DE',
      serviceWorkers: 'block'
    });
    await instanzenVortaeuschen(ctx, [{ id: NEU, name: 'Neu', set_up: false }]);
    const page = await ctx.newPage();
    await registrieren(page, `sk_neu_${TAG}`);

    await menueOeffnen(page);
    await expect(page.getByTestId(`rail-server-row-${NEU}`)).toBeVisible();
    await expect(page.getByTestId('rail-server-verwalten')).toBeVisible();
    await expect(page.getByTestId('rail-server-empty')).toHaveCount(0);
    await ctx.close();
  });

  test('scheitert das Laden der Liste, behauptet das Menü nicht, es gäbe keinen Server', async ({
    browser
  }) => {
    const ctx = await browser.newContext({
      viewport: RECHNER,
      locale: 'de-DE',
      serviceWorkers: 'block'
    });
    // Erst die Anmeldung mit leerer Liste, dann fällt die Cloud aus.
    const page = await ctx.newPage();
    await registrieren(page, `sk_fehler_${TAG}`);
    await ctx.route('**/api/auth/me/instances', (route: Route) => route.abort('connectionrefused'));

    const menue = await menueOeffnen(page);
    // Erst wenn das Laden vorbei ist, sagt das Fehlen des Hinweises etwas.
    await expect(menue.getByText('Lade…')).toHaveCount(0);
    await expect(page.getByTestId('rail-server-einrichten')).toBeVisible();
    await expect(page.getByTestId('rail-server-empty')).toHaveCount(0);
    await ctx.close();
  });
});

test.describe('Server-Knopf — Tablet', () => {
  test('ohne Leiste kein Server-Knopf: „Meine Server“ bleibt im Konto-Menü', async ({ browser }) => {
    const ctx = await fingerKontext(browser, TABLET);
    await instanzenVortaeuschen(ctx, [{ id: ATELIER, name: 'Atelier' }]);
    const page = await ctx.newPage();
    await registrieren(page, `sk_tab_${TAG}`);

    await page.goto('/app/friends');
    await expect(page.getByTestId('user-footer-trigger').first()).toBeVisible({ timeout: 15_000 });
    // Die Leiste gehört allein zur Desktop-Klasse: da, aber ausgeblendet — und
    // mit ihr der Server-Knopf und das Plus.
    await expect(page.getByTestId('guild-rail')).toBeHidden();
    await expect(page.getByTestId('rail-server-button')).toBeHidden();
    await expect(page.locator('[data-testid^="guild-create-menu-"]').first()).toBeHidden();

    // Das Konto-Menü ist dort der einzige Weg zur Seite — der Eintrag bleibt.
    // (Der Eintrag erscheint erst, wenn die Liste der Cloud eingearbeitet ist.)
    await page.getByTestId('user-footer-trigger').first().click();
    await expect(page.getByTestId('user-footer-meine-server')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('user-footer-meine-server').click();
    await page.waitForURL(/\/app\/server/);
    await expect(page.getByTestId(`instance-row-${ATELIER}`)).toBeVisible();
    await ctx.close();
  });
});

// ---------------------------------------------------------------------------
// „Meine Server“: Umbenennen und der Name, der der Leiste folgt.
// ---------------------------------------------------------------------------

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': '*'
};

test.describe('Meine Server — Umbenennen', () => {
  type Spur = { patches: { instance_name?: string }[] };

  /** Der erfundene Server nimmt die Sitzung und den Namen an. */
  async function serverAntwortenLassen(ctx: BrowserContext, id: string): Promise<Spur> {
    const spur: Spur = { patches: [] };
    await ctx.route('**/api/auth/me/server-ticket', (route) =>
      route.fulfill({
        json: { ticket: 'ticket-e2e', expires_in: 60, instance_id: id }
      })
    );
    // Gilt vor der allgemeinen Abweisung aus `instanzenVortaeuschen` (zuletzt
    // eingetragene Route zuerst).
    await ctx.route(`https://${HOST(id)}/**`, async (route: Route) => {
      const req = route.request();
      const url = new URL(req.url());
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
      if (url.pathname === '/api/chat/session') {
        return route.fulfill({
          status: 200,
          headers: CORS,
          json: { session_token: 'sitzung-e2e', expires_in: 3600 }
        });
      }
      if (url.pathname === '/api/chat/admin/permissions' && req.method() === 'PATCH') {
        const body = req.postDataJSON() as { instance_name?: string };
        spur.patches.push(body);
        return route.fulfill({
          status: 200,
          headers: CORS,
          json: { instance_name: body.instance_name?.trim() || null }
        });
      }
      return route.abort('connectionrefused');
    });
    return spur;
  }

  test('„Umbenennen“ öffnet den Dialog, und der neue Name steht sofort in der Zeile', async ({
    browser
  }) => {
    const ctx = await browser.newContext({
      viewport: RECHNER,
      locale: 'de-DE',
      serviceWorkers: 'block'
    });
    await instanzenVortaeuschen(ctx, [
      { id: ATELIER, name: null },
      { id: NEU, name: 'Neu', set_up: false }
    ]);
    const spur = await serverAntwortenLassen(ctx, ATELIER);
    const page = await ctx.newPage();
    await registrieren(page, `sk_umb_${TAG}`);
    await warteAufServerLeiste(page, [HOST(ATELIER)]);

    await page.goto('/app/server');
    await expect(page.getByTestId(`instance-row-${ATELIER}`)).toBeVisible();
    // Ohne Namen: die Adresse steht vorn und nicht noch einmal darunter.
    await expect(page.getByTestId(`instance-name-${ATELIER}`)).toHaveText(HOST(ATELIER));
    await expect(page.getByTestId(`instance-adresse-${ATELIER}`)).toHaveCount(0);

    // Den Knopf gibt es nur für einen Server, den diese Liste kennt: „Neu“ ist
    // noch nicht eingerichtet und steht nicht in der Serverliste des Geräts.
    await expect(page.getByTestId(`instance-row-${NEU}`)).toBeVisible();
    await expect(page.getByTestId(`instance-rename-btn-${NEU}`)).toHaveCount(0);
    await expect(page.getByTestId(`instance-delete-btn-${NEU}`)).toBeVisible();

    const knopf = page.getByTestId(`instance-rename-btn-${ATELIER}`);
    await expect(knopf).toHaveText('Umbenennen');
    await knopf.click();
    const dialog = page.getByTestId('server-rename-dialog');
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('server-rename-name')).toHaveValue('');
    await page.getByTestId('server-rename-name').fill('Michaels Atelier');
    await page.getByTestId('server-rename-submit').click();
    await expect(dialog).toBeHidden();

    // Gespeichert wird beim Server; die Liste der Cloud (hier unverändert, ohne
    // Namen) kommt nicht neu — der Name stammt aus der Leiste.
    expect(spur.patches).toEqual([{ instance_name: 'Michaels Atelier' }]);
    await expect(page.getByTestId(`instance-name-${ATELIER}`)).toHaveText('Michaels Atelier');
    await expect(page.getByTestId(`instance-adresse-${ATELIER}`)).toHaveText(HOST(ATELIER));
    await expect(
      page.getByRole('button', { name: 'Michaels Atelier', exact: true })
    ).toBeVisible();

    // Zurück zur Adresse: leer speichern.
    await knopf.click();
    await expect(page.getByTestId('server-rename-name')).toHaveValue('Michaels Atelier');
    await page.getByTestId('server-rename-name').fill('');
    await page.getByTestId('server-rename-submit').click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId(`instance-name-${ATELIER}`)).toHaveText(HOST(ATELIER));
    await expect(page.getByTestId(`instance-adresse-${ATELIER}`)).toHaveCount(0);
    await ctx.close();
  });

  test('das Menü des Server-Knopfs zeigt denselben Namen wie die Leiste', async ({ browser }) => {
    const ctx = await browser.newContext({
      viewport: RECHNER,
      locale: 'de-DE',
      serviceWorkers: 'block'
    });
    await instanzenVortaeuschen(ctx, [{ id: ATELIER, name: 'Alter Name' }]);
    const spur = await serverAntwortenLassen(ctx, ATELIER);
    const page = await ctx.newPage();
    await registrieren(page, `sk_folge_${TAG}`);
    await warteAufServerLeiste(page, ['Alter Name']);

    await page.goto('/app/server');
    await page.getByTestId(`instance-rename-btn-${ATELIER}`).click();
    await page.getByTestId('server-rename-name').fill('Neuer Name');
    await page.getByTestId('server-rename-submit').click();
    await expect(page.getByTestId('server-rename-dialog')).toBeHidden();
    expect(spur.patches).toEqual([{ instance_name: 'Neuer Name' }]);

    // Die Cloud-Liste (die das Menü frisch lädt) nennt noch den alten Namen; die
    // Zeile folgt dem Eintrag in der Leiste.
    await menueOeffnen(page);
    await expect(page.getByTestId(`rail-server-name-${ATELIER}`)).toHaveText('Neuer Name');
    await expect(page.getByTestId(`rail-server-adresse-${ATELIER}`)).toHaveText(HOST(ATELIER));
    await ctx.close();
  });
});
