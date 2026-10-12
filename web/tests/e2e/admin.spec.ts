/**
 * End-to-end admin-panel flow:
 *   register alice + bob → flip alice's is_admin via SQL bootstrap →
 *   alice re-logs in so the JWT carries the admin claim → opens the
 *   UserFooter dropdown, navigates to /app/admin, checks all five
 *   sections render → changes DM-limits and verifies it persists →
 *   toggles bob's disabled flag → audit-log shows the entry.
 *
 * The is_admin promotion uses the container runtime auto-detected at
 * setup time (docker or podman). ``$DOCKER_CMD`` overrides it.
 */

import { test, expect, type Page } from '@playwright/test';
import { execSync } from 'node:child_process';

function detectExec(): string {
  if (process.env.DOCKER_CMD) return process.env.DOCKER_CMD;
  try {
    execSync('docker --version', { stdio: 'ignore' });
    return 'docker';
  } catch {
    return 'podman';
  }
}
const CONTAINER_EXEC = detectExec();

const ts = Date.now();
const ALICE = {
  username: `admin_${ts}`,
  email: `admin_${ts}@dcc-test.example.com`,
  password: 'sup3r-secret-pass'
};
const BOB = {
  username: `regular_${ts}`,
  email: `regular_${ts}@dcc-test.example.com`,
  password: 'sup3r-secret-pass'
};

async function register(page: Page, u: typeof ALICE) {
  await page.goto('/register');
  await page.getByTestId('reg-username').fill(u.username);
  await page.getByTestId('reg-email').fill(u.email);
  await page.getByTestId('reg-password').fill(u.password);
  await page.getByTestId('reg-submit').click();
  await page.waitForURL(/\/app/);
  // BackupSetupStep poppt nach runIssueFlow auf (s. issue-flow.ts) — der
  // Dialog blockiert sonst die nächsten Klicks per overlay. Best-effort
  // dismiss; wenn der Dialog nicht erscheint (z.B. weil Re-Run im Test
  // ohne fresh-register), schluckt der catch.
  await page
    .locator('[data-testid=backup-onboarding-skip-btn]')
    .click({ timeout: 2500 })
    .catch(() => undefined);
}

async function login(page: Page, identifier: string, password: string) {
  await page.goto('/login');
  await page.getByTestId('login-identifier').fill(identifier);
  await page.getByTestId('login-password').fill(password);
  await page.getByTestId('login-submit').click();
  await page.waitForURL(/\/app/);
  // `waitForURL` kehrt zurück, sobald sich die Adresse ändert — die Oberfläche
  // ist dann noch nicht aufgebaut. Wer direkt danach klickt, trifft eine Leiste,
  // die gleich darauf vom `ready`-Frame neu gerendert wird. `register` hat diese
  // Wartezeit zufällig (der Onboarding-Klick mit 2,5 s Zeitfenster), `login`
  // hatte sie nicht — daher war jeder login-basierte Test racy.
  await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 15_000 });
}

function promoteToAdmin(username: string) {
  execSync(
    `${CONTAINER_EXEC} exec -i dcc_night_postgres psql -U dcc -d dcc_test -c "UPDATE auth.users SET is_admin=true WHERE username='${username}'"`,
    { stdio: 'ignore' }
  );
}

test.describe.serial('admin-panel E2E', () => {
  let page: Page;

  /** Öffnet einen Reiter des Admin-Panels. Nötig, weil `+page.svelte` nur den
   *  AKTIVEN Reiter rendert — und nach jedem `page.reload()` steht das Panel
   *  wieder auf „Übersicht". */
  async function openAdminTab(tab: string): Promise<void> {
    await page.getByTestId(`admin-tab-${tab}`).click();
  }

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext();
    page = await ctx.newPage();
  });

  test('register both users', async () => {
    // Burn the bootstrap-admin slot first: on a freshly-truncated dcc_test
    // the FIRST registrant becomes a global admin (COUNT(*)==1 rule). Without
    // this throwaway user, ALICE would arrive as an admin and the "non-admin"
    // assertion below — plus the explicit promotion test — would be moot.
    const bootCtx = await page.context().browser()!.newContext();
    const bootPage = await bootCtx.newPage();
    await register(bootPage, {
      username: `bootstrap_${ts}`,
      email: `bootstrap_${ts}@dcc-test.example.com`,
      password: 'sup3r-secret-pass'
    });
    await bootCtx.close();

    await register(page, ALICE);
    // Bob registers in the same context — easier than juggling two pages
    // for this flow; we don't need to act as Bob, just to have him exist.
    const bobCtx = await page.context().browser()!.newContext();
    const bobPage = await bobCtx.newPage();
    await register(bobPage, BOB);
    await bobCtx.close();
  });

  test('non-admin does not see the Server-Admin entry', async () => {
    // Server-Admin is a standalone sidebar button now (no longer a menu entry)
    // — it must not render at all for a regular user.
    await expect(page.getByTestId('open-admin')).toHaveCount(0);
  });

  test('admin promotion makes the entry appear after re-login', async () => {
    promoteToAdmin(ALICE.username);
    // The current access-token was issued *before* the flip — to pick up
    // `admin: true` we need a fresh token (i.e. log in again).
    await page.goto('/login');
    await page.evaluate(() => localStorage.clear());
    await login(page, ALICE.username, ALICE.password);

    // Der Server-Admin-Button steht jetzt direkt in der Sidebar (kein Menü).
    await expect(page.getByTestId('open-admin')).toBeVisible();
  });

  test('navigating opens the panel with the cloud-admin sections', async () => {
    await page.getByTestId('open-admin').click();
    await page.waitForURL(/\/app\/admin/);
    await expect(page.getByTestId('admin-panel')).toBeVisible();
    // Das Panel ist eine Reiter-Schale (`+page.svelte` rendert NUR den aktiven
    // Reiter) — jede Sektion also erst nach dem Klick auf ihren Reiter prüfen.
    // Früher lagen alle Sektionen auf einer langen Seite; dieser Test hing noch
    // an dem Stand und scheiterte an der ersten Sektion hinter einem Reiter.
    const sectionsByTab: Record<string, string[]> = {
      overview: ['admin-overview'],
      settings: ['admin-attachments', 'admin-registration', 'admin-smtp'],
      users: ['admin-users'],
      applications: ['admin-instances'],
      complaints: ['admin-complaints'],
      audit: ['admin-audit-log']
    };
    for (const [tab, ids] of Object.entries(sectionsByTab)) {
      await page.getByTestId(`admin-tab-${tab}`).click();
      for (const id of ids) {
        await expect(page.getByTestId(id)).toBeVisible();
      }
    }

    // Seit dem Wegfall der Freigabe (2026-10): Reiter „Server“ ohne Zähler,
    // kein Unterreiter „Ausstehend“.
    await page.getByTestId('admin-tab-applications').click();
    await expect(page.getByTestId('admin-tab-applications').locator('span')).toHaveCount(0);
    await expect(page.getByTestId('instances-tab-pending')).toHaveCount(0);
    await expect(page.getByTestId('instances-tab-active')).toBeVisible();
  });

  test('a submitted abuse report appears in the complaints section', async () => {
    // Public endpoint, no auth — file a complaint straight through the proxy.
    const resp = await page.request.post('/api/auth/reports', {
      data: {
        body: 'E2E complaint: this content needs a moderator review.',
        target_url: `https://e2e-abuse-${ts}.example.com/post`
      }
    });
    expect(resp.status()).toBe(201);

    await page.reload();
    await openAdminTab('complaints');
    // The "new" tab is the default; the freshly-filed report must show up.
    await expect(page.getByTestId('complaints-new-badge')).toBeVisible({ timeout: 5_000 });
    // Scope to the section so the prefix can't catch the portal dialogs.
    const card = page
      .getByTestId('admin-complaints')
      .locator('[data-testid^="complaint-"]')
      .first();
    await expect(card).toBeVisible();

    // Resolve it and confirm it leaves the "new" list.
    await card.getByText('Als erledigt markieren').click();
    const dialog = page.getByTestId('complaint-resolve-dialog');
    await dialog.getByRole('textbox').fill('Handled in E2E.');
    await dialog.getByText('Erledigt', { exact: true }).click();
    await expect(page.getByTestId('admin-complaints').locator('[data-testid^="complaint-"]')).toHaveCount(
      0,
      { timeout: 5_000 }
    );
  });

  test('SMTP-Config PATCH flips the status badge to "Aktiv"', async () => {
    await openAdminTab('settings');
    // Fresh DB: smtp_settings starts unconfigured → "Nicht eingerichtet".
    await expect(page.getByTestId('smtp-status-inactive')).toBeVisible();
    // Pick the Custom preset so host/port stay editable, fill creds.
    // The provider field is a popover select: click the trigger, then the
    // entry — "Eigener SMTP-Server" is the visible label of 'custom'
    // (SMTP_PRESETS in smtpProviders.ts).
    await page.getByTestId('smtp-provider').click();
    await page.getByRole('option', { name: 'Eigener SMTP-Server' }).click();
    await page.getByTestId('smtp-host').fill('smtp.test.example');
    await page.getByTestId('smtp-from').fill('noreply@test.example');
    await page.getByTestId('smtp-pass').fill('secret-not-tested');
    await page.getByTestId('smtp-save').click();
    // After save the row has host+from_email → configured=true.
    await expect(page.getByTestId('smtp-status-configured')).toBeVisible({
      timeout: 5_000
    });
    // Revert to unconfigured. A configured SMTP singleton activates the
    // email-verification gate — without this revert every register flow in
    // every test file after admin.spec bounces to /verify-email-required.
    // Doubles as coverage of the un-configure path (configured → false).
    await page.getByTestId('smtp-host').fill('');
    await page.getByTestId('smtp-save').click();
    await expect(page.getByTestId('smtp-status-inactive')).toBeVisible({
      timeout: 5_000
    });
  });

  test('DM-limits PATCH persists', async () => {
    await openAdminTab('settings');
    const sizeInput = page.getByTestId('dm-max-size-input');
    await expect(sizeInput).toHaveValue('25', { timeout: 5_000 });
    await sizeInput.fill('40');
    await page.getByTestId('dm-limits-save').click();
    // Toast confirms; refresh and verify the new value.
    await page.reload();
    await openAdminTab('settings');
    await expect(page.getByTestId('dm-max-size-input')).toHaveValue('40', { timeout: 5_000 });
  });

  test('audit-log shows the DM-limits change', async () => {
    await openAdminTab('audit');
    // The merged log fetches both auth+chat. After our PATCH there must
    // be at least one entry mentioning the dm_limits action.
    await page.getByTestId('admin-audit-refresh').click();
    await expect(
      page.locator('[data-testid="audit-entry"]', { hasText: 'DM-Limits' })
    ).toHaveCount(1, { timeout: 5_000 });
  });

  test('Server-Liste: Vermerk „ohne Freigabe“, Secret rotieren nur bei freigegebenen', async () => {
    const FREI = '7300000000000000011';
    const OHNE = '7300000000000000012';
    const eintrag = (id: string, hostname: string, ohne_freigabe: boolean) => ({
      id,
      hostname,
      client_id: `c-${id}`,
      worker_id_chat: ohne_freigabe ? null : 1,
      worker_id_voice: ohne_freigabe ? null : 2,
      worker_id_media: ohne_freigabe ? null : 3,
      status: 'active',
      registered_at: '2026-10-10T12:00:00Z',
      registrar_username: ALICE.username,
      origin: 'vps',
      ohne_freigabe
    });
    const liste = /\/api\/auth\/admin\/instances\?status=active$/;
    await page.route(liste, (route) =>
      route.fulfill({
        json: [
          eintrag(FREI, 'frei.dcc-test.example.com', false),
          eintrag(OHNE, 'ohne.dcc-test.example.com', true)
        ]
      })
    );
    await page.reload();
    await openAdminTab('applications');
    await expect(
      page.getByTestId(`active-instance-${OHNE}`).getByTestId('admin-instance-ohne-freigabe')
    ).toBeVisible();
    await expect(
      page.getByTestId(`active-instance-${FREI}`).getByTestId('admin-instance-ohne-freigabe')
    ).toHaveCount(0);
    await expect(page.getByTestId(`admin-instance-rotate-${FREI}`)).toBeVisible();
    await expect(page.getByTestId(`admin-instance-rotate-${OHNE}`)).toHaveCount(0);
    await expect(page.getByTestId(`admin-instance-suspend-${OHNE}`)).toBeVisible();
    await page.unroute(liste);
  });

  test('Nutzerliste: „Darf Server verbinden“ statt Hosting-Schalter', async () => {
    // Das Feld `server_verbinden_gesperrt` kommt aus Etappe 1 (Cloud-Routen), die
    // auf diesem Zweig noch nicht liegt: das Backend liefert es hier weder in
    // der Liste noch im PATCH mit und lässt es im PATCH fallen. Beide Antworten
    // kommen deshalb weiter vom echten Backend (`route.fetch()`); NUR ein
    // FEHLENDES Feld wird ergänzt, und zwar aus dem, was die Oberfläche gesendet
    // hat. Sobald Etappe 1 im Baum ist, fehlt nichts mehr, die Ergänzung greift
    // nicht, und der Test prüft das echte Verhalten — dann darf der Block samt
    // `unroute` entfallen.
    const gesperrt = new Map<string, boolean>();
    let patchBody: Record<string, unknown> | null = null;
    const liste = /\/api\/auth\/admin\/users\?/;
    const einzeln = /\/api\/auth\/admin\/users\/[^/?]+$/;
    const ergaenzt = (n: Record<string, unknown>) =>
      'server_verbinden_gesperrt' in n
        ? n
        : { ...n, server_verbinden_gesperrt: gesperrt.get(String(n.id)) ?? false };
    await page.route(liste, async (route) => {
      const antwort = await route.fetch();
      const nutzer = (await antwort.json()) as Record<string, unknown>[];
      await route.fulfill({ status: antwort.status(), json: nutzer.map(ergaenzt) });
    });
    await page.route(einzeln, async (route) => {
      if (route.request().method() !== 'PATCH') return route.fallback();
      patchBody = route.request().postDataJSON() as Record<string, unknown>;
      const antwort = await route.fetch();
      if (!antwort.ok()) return route.fulfill({ response: antwort });
      const nutzer = (await antwort.json()) as Record<string, unknown>;
      gesperrt.set(String(nutzer.id), patchBody.server_verbinden_gesperrt === true);
      await route.fulfill({ status: antwort.status(), json: ergaenzt(nutzer) });
    });

    await openAdminTab('users');
    await expect(page.getByTestId('admin-users-filter-self_host')).toHaveCount(0);
    await page.getByTestId('admin-users-search').fill(BOB.username);
    const zeile = page.getByTestId('admin-user-row').filter({ hasText: BOB.username });
    await expect(zeile).toHaveCount(1, { timeout: 5_000 });
    await expect(zeile.getByTestId('badge-selfhost')).toHaveCount(0);

    await zeile.getByTestId('admin-user-actions').click();
    await expect(page.getByTestId('toggle-selfhost-btn')).toHaveCount(0);
    const schalter = page.getByTestId('toggle-verbinden-btn');
    await expect(schalter).toHaveAttribute('data-erlaubt', 'ja');
    await schalter.click();
    // Die Zeile rendert aus der Antwort von PATCH /admin/users/{id} neu.
    await expect(schalter).toHaveAttribute('data-erlaubt', 'nein', { timeout: 5_000 });
    expect(patchBody).toEqual({ server_verbinden_gesperrt: true });

    await page.unroute(liste);
    await page.unroute(einzeln);
  });
});
