/**
 * Gerätewechsel-Nachweis des 120-Tage-Archivs (2026-10-05): Michaels
 * Szenario „Browser 1 senden/empfangen → Browser zu → Browser 2 anmelden →
 * Verlauf muss da sein". Der Verlauf kommt aus dem verschlüsselten
 * Server-Archiv (Übergabe §5), nicht aus dem lokalen Bestand — Browser 2
 * hat ja keinen.
 *
 * Deckt zwei Vorfalls-Runden vom 05.10. ab: Archiv-Aufrufe müssen an die
 * CLOUD geroutet sein (Self-Host aktiv = 404), und der Abmelde-Wisch darf
 * die frisch erzeugte Identität der Neuanmeldung nicht wegfegen.
 */
import { test, expect, type Page, type BrowserContext } from '@playwright/test';

const ALICE = {
  username: 'gw_a_' + Date.now().toString(36),
  email: `gw_a_${Date.now().toString(36)}@example.org`,
  password: 'repro-gw-1A!'
};
const BOB = {
  username: 'gw_b_' + Date.now().toString(36),
  email: `gw_b_${Date.now().toString(36)}@example.org`,
  password: 'repro-gw-1A!'
};

async function register(page: Page, u: { username: string; email: string; password: string }) {
  await page.goto('/register');
  await page.getByTestId('reg-username').fill(u.username);
  await page.getByTestId('reg-email').fill(u.email);
  await page.getByTestId('reg-password').fill(u.password);
  await page.getByTestId('reg-submit').click();
  await page.waitForURL(/\/app/);
  await page
    .locator('[data-testid=backup-onboarding-skip-btn]')
    .click({ timeout: 2500 })
    .catch(() => undefined);
}

async function login(page: Page, u: { username: string; password: string }) {
  await page.goto('/login');
  await page.getByTestId('login-identifier').fill(u.username);
  await page.getByTestId('login-password').fill(u.password);
  await page.getByTestId('login-submit').click();
  await page.waitForURL(/\/app/);
}

async function currentUserId(page: Page): Promise<string> {
  return page.evaluate(() => {
    const raw = localStorage.getItem('dcc.tokens.access');
    if (!raw) throw new Error('no access token');
    const parts = raw.split('.');
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload.sub as string;
  });
}

async function becomeFriends(pageA: Page, uidA: string, pageB: Page, uidB: string) {
  const send = async (page: Page, targetId: string) => {
    const r = await page.evaluate(async (uid) => {
      const token = localStorage.getItem('dcc.tokens.access');
      const resp = await fetch('/api/chat/friend-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ target_user_id: uid })
      });
      return { status: resp.status, body: await resp.text() };
    }, targetId);
    if (r.status !== 201) throw new Error(`friend-request failed ${r.status}: ${r.body}`);
  };
  await send(pageA, uidB);
  await send(pageB, uidA);
}

async function sendDm(page: Page, text: string) {
  await page.getByTestId('message-input').click();
  await page.getByTestId('message-input').fill(text);
  await page.getByTestId('message-input').press('Enter');
}

/** Wie viele Zeilen das Archiv dieses Kanals hält — die Leseroute, die auch
 *  der Klient nutzt (`api/archiv.ts::archivSeite`). */
async function archivZeilen(page: Page, kanalId: string): Promise<number> {
  return page.evaluate(async (kid) => {
    const token = localStorage.getItem('dcc.tokens.access');
    const resp = await fetch(`/api/chat/archiv/${kid}?limit=500`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    return resp.ok ? ((await resp.json()) as unknown[]).length : -1;
  }, kanalId);
}

test.describe.serial('Archiv-Gerätewechsel: Verlauf auf jedem Gerät (§5)', () => {
  test('Browser 1: Unterhaltung, Browser 2: gleicher Nutzer sieht den Verlauf', async ({
    browser
  }) => {
    // Drei frische Browser-Kontexte, zwei Registrierungen, eine Abmeldung und
    // eine Neuanmeldung in EINEM Test: allein die Seitenaufrufe kosten gegen
    // den Vite-Dev-Server je ~3 s, dazu kommen 2 x 2,5 s Wartezeit auf einen
    // Onboarding-Knopf, den es seit 2026-06-28 nicht mehr gibt. Gemessen
    // (2026-10-12): 31,4 s, alle Erwartungen grün — der Standard von 30 s
    // riss den Test im letzten Schritt ab ("Test timeout of 30000ms exceeded"),
    // obwohl nichts Fachliches fehlte. Wie bei den übrigen Mehr-Gerät-Specs
    // ein eigener Rahmen.
    test.setTimeout(90_000);
    const ctxA = await browser.newContext();
    const ctxB1 = await browser.newContext();
    for (const ctx of [ctxA, ctxB1]) {
      await ctx.route('**/changelog.json', (route) => route.fulfill({ json: { entries: [] } }));
    }
    const alice = await ctxA.newPage();
    const bob1 = await ctxB1.newPage();

    await register(alice, ALICE);
    await register(bob1, BOB);
    const uidA = await currentUserId(alice);
    const uidB = await currentUserId(bob1);
    await becomeFriends(alice, uidA, bob1, uidB);

    const r = await alice.evaluate(async (uid) => {
      const token = localStorage.getItem('dcc.tokens.access');
      const resp = await fetch('/api/chat/dm-channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ target_user_id: uid })
      });
      return { status: resp.status, body: await resp.json() };
    }, uidB);
    expect(r.status, `dm-channels: ${JSON.stringify(r.body)}`).toBe(201);
    const dmId = r.body.id;

    // Unterhaltung in Browser 1 — BEIDE Richtungen, damit beide Seiten
    // archivieren (jede Sendung wird vom ABSENDENDEN Gerät archiviert).
    await alice.goto(`/app/@me/${dmId}`);
    await expect(alice.getByTestId('message-input')).toBeVisible({ timeout: 10_000 });
    await sendDm(alice, 'archiv hin');
    await bob1.goto(`/app/@me/${dmId}`);
    await expect(bob1.getByTestId('message-input')).toBeVisible({ timeout: 10_000 });
    await expect(
      bob1.locator('[data-testid="message-content"]', { hasText: 'archiv hin' })
    ).toBeVisible({ timeout: 10_000 });
    await sendDm(bob1, 'archiv rueck');

    // Alice löscht eine eigene Nachricht wieder (Gegenprüfung 2026-10-12): ihr
    // Klient liefert dafür eine Grabstein-Zeile ins Archiv ein. Ohne sie holte
    // jedes Frischgerät die gelöschte Nachricht 120 Tage lang zurück — der
    // Server kann keine Zeile je Nachricht löschen.
    await sendDm(alice, 'archiv weg');
    const weg = (p: Page) =>
      p.locator('[data-testid="message-item"]', { hasText: 'archiv weg' });
    await expect(weg(alice)).toBeVisible({ timeout: 10_000 });
    await expect(weg(bob1)).toBeVisible({ timeout: 10_000 });
    // Erst wenn auch die Nachricht selbst im Archiv liegt, sagt die Löschung
    // etwas: sonst bestünde der Test auch ohne Grabstein-Zeile.
    await expect.poll(() => archivZeilen(alice, dmId), { timeout: 10_000 }).toBe(3);
    await weg(alice).hover();
    await weg(alice).getByTestId('message-action-delete').click();
    await alice.getByTestId('confirm-dialog-confirm').click();
    await expect(weg(alice)).toHaveCount(0, { timeout: 10_000 });
    await expect.poll(() => archivZeilen(alice, dmId), { timeout: 10_000 }).toBe(4);

    // Alice bearbeitet eine eigene Nachricht (main-Prüfbericht, Fund 5): ihr
    // Klient liefert dazu eine Bearbeitungs-Zeile ein. Ohne sie zeigte das
    // Frischgerät den Originaltext, denn die Archiv-Zeile ist die Fassung
    // beim Senden.
    await sendDm(alice, 'archiv alt');
    const alt = alice.locator('[data-testid="message-item"]', { hasText: 'archiv alt' });
    await expect(alt).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => archivZeilen(alice, dmId), { timeout: 10_000 }).toBe(5);
    await alt.hover();
    await alt.getByTestId('message-action-edit').click();
    const edit = alice.getByTestId('message-edit-input');
    await expect(edit).toBeVisible();
    await edit.fill('archiv neu');
    await edit.press('Enter');
    await expect(
      alice.locator('[data-testid="message-content"]', { hasText: 'archiv neu' })
    ).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => archivZeilen(alice, dmId), { timeout: 10_000 }).toBe(6);

    // Abmelden (vollständiger Identitäts-Wisch) + Browser zu.
    await bob1.getByTestId('user-footer-trigger').click();
    await bob1.getByTestId('sign-out').click();
    await bob1.waitForURL(/\/login/);
    await ctxB1.close();

    // Browser 2: frischer Anmeldung, Unterhaltung öffnen — der Verlauf
    // muss aus dem Server-Archiv kommen.
    const ctxB2 = await browser.newContext();
    await ctxB2.route('**/changelog.json', (route) => route.fulfill({ json: { entries: [] } }));
    const bob2 = await ctxB2.newPage();
    await login(bob2, BOB);
    await bob2.goto(`/app/@me/${dmId}`);
    await expect(bob2.getByTestId('message-input')).toBeVisible({ timeout: 10_000 });
    await expect(
      bob2.locator('[data-testid="message-content"]', { hasText: 'archiv hin' })
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      bob2.locator('[data-testid="message-content"]', { hasText: 'archiv rueck' })
    ).toBeVisible({ timeout: 20_000 });

    // Die bearbeitete Nachricht steht mit dem neuen Text da.
    await expect(
      bob2.locator('[data-testid="message-content"]', { hasText: 'archiv neu' })
    ).toBeVisible({ timeout: 20_000 });

    // Die gelöschte Nachricht kommt aus dem Archiv NICHT zurück, der
    // Originaltext der bearbeiteten auch nicht. Feste Wartezeit:
    // `toHaveCount(0)` wäre schon vor dem Nachzug erfüllt.
    await bob2.waitForTimeout(3_000);
    await expect(
      bob2.locator('[data-testid="message-content"]', { hasText: 'archiv weg' })
    ).toHaveCount(0);
    await expect(
      bob2.locator('[data-testid="message-content"]', { hasText: 'archiv alt' })
    ).toHaveCount(0);

    // Und der Zweitgerät-Verlauf bleibt auch nach einem Kanalwechsel erhalten.
    await bob2.goto('/app/@me');
    await bob2.goto(`/app/@me/${dmId}`);
    await expect(
      bob2.locator('[data-testid="message-content"]', { hasText: 'archiv hin' })
    ).toBeVisible({ timeout: 10_000 });

    await ctxA.close();
    await ctxB2.close();
  });
});
