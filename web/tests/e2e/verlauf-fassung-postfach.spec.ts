import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Fassungswechsel ohne verlorene Zustellung (Gegenprüfung 2026-10-12, R3).
 *
 * Der Fall aus `verlauf-fassung.spec.ts`, diesmal mit dem Postfach dahinter:
 * ein Tab fährt noch den alten Code, ein zweiter Tab mit neuerem Code hebt die
 * Verlaufs-Datenbank an. Der alte Tab kann danach nichts mehr ablegen — bis
 * 2026-10-12 entschlüsselte er eingehende Zustellungen trotzdem, sicherte die
 * weitergedrehte Olm-Sitzung (in `pulse-identity`, das der Fassungswechsel
 * nicht berührt), scheiterte am Ablegen und quittierte nicht. Danach konnte
 * KEIN Tab den Umschlag mehr öffnen: die Nachricht war weg.
 *
 * Nachgestellt mit zwei Seiten in EINEM Browser-Kontext (dasselbe Gerät, eine
 * IndexedDB, wie zwei Tabs). Die „neuere App-Fassung" ist die echte App, nur
 * mit einer um eins höheren `DB_VERSION`: `neueFassung` schreibt die Zahl in
 * der Vite-Antwort für `verlauf/schema.ts` um, nur für diese Seite. Der
 * Schalter für verschlüsselte DMs und die Electron-Brücke werden wie in
 * `e2e-dm.spec.ts` vorgetäuscht.
 *
 * Gegenprobe: mit dem Stand vor dem Riegel (`web/src` von d28d6ff7) öffnet der
 * alte Tab die zweite Nachricht und zeigt sie an, und der neue kann sie nie
 * mehr öffnen — ihre Zustellung bleibt auf dem Server liegen, bis die Frist
 * sie räumt. Angezeigt bekommt der neue Tab sie trotzdem, über das
 * Server-Archiv (`archiv/lesen.ts`); deshalb zählt hier die Quittung, nicht
 * die Anzeige.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../../..');

const ts = Date.now();
const ALICE = {
  username: `alice_fassung_${ts}`,
  email: `alice_fassung_${ts}@dcc-test.example.com`,
  password: 'sup3r-secret-pass'
};
const BOB = {
  username: `bob_fassung_${ts}`,
  email: `bob_fassung_${ts}@dcc-test.example.com`,
  password: 'sup3r-secret-pass'
};

async function schalterEinschalten(ctx: BrowserContext): Promise<void> {
  await ctx.route('**/krypto/schalter.ts*', async (route) => {
    const antwort = await route.fetch();
    const text = await antwort.text();
    const gepatcht = text.replace('E2E_DMS_ENABLED = false', 'E2E_DMS_ENABLED = true');
    if (gepatcht === text && !text.includes('E2E_DMS_ENABLED = true')) {
      throw new Error('Weder "E2E_DMS_ENABLED = false" noch "= true" in schalter.ts gefunden');
    }
    await route.fulfill({ response: antwort, body: gepatcht });
  });
}

/** Die Electron-Brücke, gekürzt aus `e2e-dm.spec.ts` (Begründung dort). */
async function alsElektronGeraetAusgeben(ctx: BrowserContext): Promise<void> {
  await ctx.addInitScript(() => {
    const leer = async () => undefined;
    const abmelden = () => () => undefined;
    (window as unknown as { pulse: unknown }).pulse = {
      platform: 'electron',
      appVersion: '0.0.0-e2e-stub',
      store: { get: leer, getAll: async () => ({}), getAllSync: () => ({}), set: leer, setAll: leer },
      notify: { show: async () => 'stub', onClick: abmelden }
    };
  });
}

/** Diese Seite fährt eine neuere App-Fassung: `DB_VERSION` um eins höher.
 *  Ohne Bedingungs-Kopfzeilen geholt (sonst käme ein leeres 304 zurück) und
 *  ohne Zwischenspeicher ausgeliefert, damit kein anderer Tab die
 *  umgeschriebene Fassung aus dem Cache bekommt. */
async function neueFassung(page: Page): Promise<void> {
  await page.route('**/src/lib/verlauf/schema.ts*', async (route) => {
    const kopf = { ...route.request().headers() };
    delete kopf['if-none-match'];
    delete kopf['if-modified-since'];
    const antwort = await route.fetch({ headers: kopf });
    const text = await antwort.text();
    const treffer = /DB_VERSION = (\d+)/.exec(text);
    if (!treffer) throw new Error('DB_VERSION nicht in schema.ts gefunden');
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      headers: { 'cache-control': 'no-store' },
      body: text.replace(treffer[0], `DB_VERSION = ${Number(treffer[1]) + 1}`)
    });
  });
}

async function register(page: Page, u: typeof ALICE): Promise<void> {
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

async function currentUserId(page: Page): Promise<string> {
  const value = await page.evaluate(() => {
    const raw = localStorage.getItem('dcc.tokens.access');
    if (!raw) return null;
    const payload = JSON.parse(atob(raw.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload.sub as string;
  });
  if (!value) throw new Error('no access token found in localStorage');
  return value;
}

async function api(page: Page, pfad: string, body: unknown): Promise<{ status: number; body: string }> {
  return page.evaluate(
    async ({ pfad, body }) => {
      const token = localStorage.getItem('dcc.tokens.access');
      const r = await fetch(pfad, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body)
      });
      return { status: r.status, body: await r.text() };
    },
    { pfad, body }
  );
}

async function warteAufSchluesselbuendel(page: Page, userId: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const r = await api(page, '/api/chat/keys/claim', { user_ids: [userId] });
        if (r.status !== 200) return null;
        const geraete = (JSON.parse(r.body) as Record<string, { curve25519?: string }[]>)[userId];
        return geraete?.find((g) => g.curve25519) ?? null;
      },
      { timeout: 15_000 }
    )
    .toBeTruthy();
}

/** Wie `e2e-dm.spec.ts::pgQuery` — dieselbe Datenbank wie `_globalSetup.ts`. */
function pgQuery(sql: string): string {
  const dotenv: Record<string, string> = {};
  try {
    for (const line of readFileSync(resolve(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m) dotenv[m[1]] = m[2];
    }
  } catch {
    // .env fehlt -> Vorgaben unten greifen.
  }
  const pgUser = dotenv.POSTGRES_USER ?? 'dcc';
  const datenbank = process.env.PULSE_E2E_DB ?? 'dcc_test';
  return execFileSync(
    'docker',
    ['exec', 'dcc_night_postgres', 'psql', '-U', pgUser, '-d', datenbank, '-tAc', sql],
    { encoding: 'utf8' }
  ).trim();
}

function offeneZustellungen(channelId: string): number {
  return Number(
    pgQuery(
      `SELECT count(*) FROM chat.dm_zustellungen z ` +
        `JOIN chat.dm_nutzlasten n ON n.id = z.nutzlast_id WHERE n.channel_id = ${channelId};`
    )
  );
}

async function schreiben(page: Page, text: string): Promise<void> {
  await page.getByTestId('message-input').click();
  await page.getByTestId('message-input').fill(text);
  await page.getByTestId('message-input').press('Enter');
}

const zeile = (page: Page, text: string) =>
  page.locator('[data-testid="message-content"]', { hasText: text });

test('ein Tab mit altem Code lässt eine Zustellung liegen, der neue bekommt sie', async ({ browser }) => {
  test.setTimeout(120_000);
  const aliceCtx = await browser.newContext();
  const bobCtx = await browser.newContext();
  for (const ctx of [aliceCtx, bobCtx]) {
    await ctx.route('**/changelog.json', (route) => route.fulfill({ json: { entries: [] } }));
    await schalterEinschalten(ctx);
    await alsElektronGeraetAusgeben(ctx);
  }
  const alice = await aliceCtx.newPage();
  const alt = await bobCtx.newPage();
  // Wie oft der alte Tab den Postfach-Weckruf bekam — so ist belegt, dass er
  // seinen Zyklus wirklich gelaufen ist, und nicht bloß nichts geschah.
  let weckrufe = 0;
  alt.on('websocket', (ws) =>
    ws.on('framereceived', (f) => {
      if (String(f.payload).includes('postfach_neu')) weckrufe++;
    })
  );
  try {
    await register(alice, ALICE);
    await register(alt, BOB);
    const aliceId = await currentUserId(alice);
    const bobId = await currentUserId(alt);
    expect((await api(alice, '/api/chat/friend-requests', { target_user_id: bobId })).status).toBe(201);
    expect((await api(alt, '/api/chat/friend-requests', { target_user_id: aliceId })).status).toBe(201);
    await warteAufSchluesselbuendel(alice, aliceId);
    await warteAufSchluesselbuendel(alt, bobId);
    const dm = await api(alice, '/api/chat/dm-channels', { target_user_id: bobId });
    const dmId = (JSON.parse(dm.body) as { id: string }).id;

    // Grundfall: der alte Tab empfängt, solange niemand die Fassung anhebt.
    await alt.goto(`/app/@me/${dmId}`);
    await expect(alt.getByTestId('active-channel-name')).toHaveText(ALICE.username, { timeout: 10_000 });
    await alice.goto(`/app/@me/${dmId}`);
    await schreiben(alice, 'erste, vor dem Wechsel');
    await expect(zeile(alt, 'erste, vor dem Wechsel')).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => offeneZustellungen(dmId), { timeout: 10_000 }).toBe(0);

    // Ein zweiter Tab mit neuerem Code hebt die Datenbank an und schließt
    // wieder — sonst holte er die nächste Zustellung selbst ab, und der alte
    // Tab käme gar nicht dran.
    const neu1 = await bobCtx.newPage();
    await neueFassung(neu1);
    await neu1.goto(`/app/@me/${dmId}`);
    await expect(zeile(neu1, 'erste, vor dem Wechsel')).toBeVisible({ timeout: 15_000 });
    await neu1.close();
    // Der alte Tab hat die Anforderung mitbekommen: das Banner steht, ohne
    // dass er selbst zugegriffen hätte (R4, `onversionchange`).
    await expect(alt.getByTestId('verlauf-neu-laden-banner')).toBeVisible({ timeout: 5_000 });

    // Die zweite Nachricht erreicht nur den alten Tab. Er bekommt den
    // Weckruf und läuft seinen Zyklus — und darf dabei nichts anrühren.
    const vorher = weckrufe;
    await schreiben(alice, 'zweite, nach dem Wechsel');
    await expect.poll(() => weckrufe, { timeout: 10_000 }).toBeGreaterThan(vorher);
    await alt.waitForTimeout(4_000);
    expect(offeneZustellungen(dmId), 'die Zustellung muss auf dem Server liegen bleiben').toBe(1);

    // Eigenes Senden ist im alten Tab gesperrt: die Nachricht ginge hinaus,
    // ihre einzige eigene Kopie aber nirgends hin (R3).
    await schreiben(alt, 'aus dem alten Tab');
    await alt.waitForTimeout(3_000);
    await expect(zeile(alice, 'aus dem alten Tab')).toHaveCount(0);

    // Das Banner steht auf jedem Bildschirm: hier eine andere Seite, mit dem
    // alten Code neu geladen — der Riegel kommt dann vom ersten Zugriff
    // (`VersionError`), und der Zyklus beim Start lässt die Zustellung liegen.
    await alt.goto('/app/friends');
    await expect(alt.getByTestId('verlauf-neu-laden-banner')).toBeVisible({ timeout: 15_000 });
    await alt.waitForTimeout(2_000);
    expect(offeneZustellungen(dmId), 'der neu geladene alte Tab hat quittiert').toBe(1);

    // Der neue Tab holt sie ab und kann sie öffnen. Sichtbar wäre sie auch
    // über das Server-Archiv — geöffnet hat er sie erst, wenn er quittiert.
    const neu2 = await bobCtx.newPage();
    await neueFassung(neu2);
    await neu2.goto(`/app/@me/${dmId}`);
    await expect(zeile(neu2, 'zweite, nach dem Wechsel')).toBeVisible({ timeout: 20_000 });
    await expect
      .poll(() => offeneZustellungen(dmId), { timeout: 10_000, message: 'der neue Tab hat nicht quittiert' })
      .toBe(0);
    // Der alte Tab hat sie nicht geöffnet: er hat nichts angerührt.
    await expect(zeile(alt, 'zweite, nach dem Wechsel')).toHaveCount(0);
  } finally {
    await aliceCtx.close();
    await bobCtx.close();
  }
});
