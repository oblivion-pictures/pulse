/**
 * Vorschaubild-Rückfall: Browser, die kein WebP kodieren (Safari, jeder
 * iOS-Browser), dürfen den Upload nicht zum Scheitern bringen.
 *
 * `canvas.toBlob(…, 'image/webp')` liefert dort still ein PNG, und das kann
 * größer sein, als der Server pro Vorschaubild annimmt (413 „thumbnail too
 * large"; der ganze Upload bricht dann ab). Der Klient behält das PNG, solange
 * es die Serverlinie einhält (so lief Safari bis heute, die Zeitleiste zeigt
 * dann kein Original von bis zu 25 MiB), und lässt nur ein Vorschaubild über
 * der Grenze weg. Der Safari-Fall wird nachgestellt, indem `toBlob` für WebP
 * ein PNG-Blob liefert.
 *
 * Dazu die kleine Dateigrenze einer Community (hier 0,5 MB): das Vorschaubild
 * ist dann größer als die Grenze, aber kleiner als die feste Linie von 4 MiB.
 * Der Server lehnt es mit eigener 413 ab (`thumbnail too large`), und der Klient
 * fragt genau einmal ohne Vorschaubild neu. Eine 413 „Datei zu groß“ löst
 * keinen Neuversuch aus.
 */

import { test, expect, type Page } from '@playwright/test';

const ts = Date.now();
const USER = {
  username: `vorschau_${ts}`,
  email: `vorschau_${ts}@dcc-test.example.com`,
  password: 'sup3r-secret-pass'
};

// 1x1 transparentes PNG.
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4' +
    '890000000a49444154789c63000100000500010d0a2db40000000049454e44ae' +
    '426082',
  'hex'
);

test.describe.serial('Vorschaubild-Rückfall', () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext();
    await ctx.route('**/changelog.json', (route) => route.fulfill({ json: { entries: [] } }));
    page = await ctx.newPage();
  });

  test.afterAll(async () => {
    await page?.context().close();
  });

  async function hochladen(name: string) {
    const [anfrage] = await Promise.all([
      page.waitForRequest(
        (r) => r.url().includes('/attachments/upload-url') && r.method() === 'POST'
      ),
      page.getByTestId('attachment-file-input').setInputFiles({
        name,
        mimeType: 'image/png',
        buffer: TINY_PNG
      })
    ]);
    return anfrage.postDataJSON() as Record<string, unknown>;
  }

  /** Sammelt Ticket-Anfragen und -Antworten, solange der Test läuft. */
  function ticketBeobachter() {
    const anfragen: Array<Record<string, unknown>> = [];
    const antworten: Array<{ status: number; detail: string | null }> = [];
    const beiAnfrage = (r: import('@playwright/test').Request) => {
      if (r.url().includes('/attachments/upload-url') && r.method() === 'POST') {
        anfragen.push(r.postDataJSON() as Record<string, unknown>);
      }
    };
    const beiAntwort = async (r: import('@playwright/test').Response) => {
      if (r.url().includes('/attachments/upload-url') && r.request().method() === 'POST') {
        const body = (await r.json().catch(() => null)) as { detail?: string } | null;
        antworten.push({ status: r.status(), detail: body?.detail ?? null });
      }
    };
    page.on('request', beiAnfrage);
    page.on('response', beiAntwort);
    return {
      anfragen,
      antworten,
      stop: () => {
        page.off('request', beiAnfrage);
        page.off('response', beiAntwort);
      }
    };
  }

  /** `toBlob` liefert für WebP ein PNG-Blob der gegebenen Größe (Safari). */
  async function safariVorschau(bytes: number) {
    await page.evaluate((groesse) => {
      const w = window as unknown as { __toBlobEcht?: HTMLCanvasElement['toBlob'] };
      const echt = (w.__toBlobEcht ??= HTMLCanvasElement.prototype.toBlob);
      HTMLCanvasElement.prototype.toBlob = function (cb, typ, qualitaet) {
        if (typ === 'image/webp') {
          cb(new Blob([new Uint8Array(groesse)], { type: 'image/png' }));
        } else {
          echt.call(this, cb, typ, qualitaet);
        }
      };
    }, bytes);
  }

  test('Vorbereitung: Konto und Community', async () => {
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
    await page.locator('[data-testid^="guild-create-menu-"]').first().click();
    await page.getByTestId('guild-create').click();
    await page.getByTestId('create-guild-name').fill('Vorschau-Rueckfall');
    await page.getByTestId('create-guild-submit').click();
    await page.waitForURL(/\/app\/guilds\/\d+\/channels\/\d+/);
    await expect(page.getByTestId('active-channel-name')).toHaveText('general');
  });

  test('Browser mit WebP-Encoder: das Vorschaubild geht mit', async () => {
    const rumpf = await hochladen('normal.png');
    expect(rumpf.has_thumb).toBe(true);
    expect(rumpf.thumb_size).toBeGreaterThan(0);
    await expect(page.getByTestId('message-send')).toBeEnabled({ timeout: 15_000 });
    await page.getByTestId('message-send').click();
    await expect(page.getByTestId('attachment-image')).toHaveCount(1, { timeout: 5_000 });
  });

  test('Browser ohne WebP-Encoder (PNG unter der Grenze): das Vorschaubild bleibt', async () => {
    // Safari-Verhalten nachgestellt: für 'image/webp' kommt ein PNG zurück —
    // hier 2 MB, größer als ein WebP je würde, aber unter der Serverlinie.
    await page.evaluate(() => {
      const echt = HTMLCanvasElement.prototype.toBlob;
      (window as unknown as { __toBlobEcht: typeof echt }).__toBlobEcht = echt;
      HTMLCanvasElement.prototype.toBlob = function (cb, typ, qualitaet) {
        if (typ === 'image/webp') {
          cb(new Blob([new Uint8Array(2 * 1024 * 1024)], { type: 'image/png' }));
        } else {
          echt.call(this, cb, typ, qualitaet);
        }
      };
    });

    const rumpf = await hochladen('safari.png');
    expect(rumpf.has_thumb).toBe(true);
    expect(rumpf.thumb_size).toBe(2 * 1024 * 1024);
    await expect(page.getByTestId('message-send')).toBeEnabled({ timeout: 15_000 });
    await page.getByTestId('message-send').click();
    await expect(page.getByTestId('attachment-image')).toHaveCount(2, { timeout: 5_000 });
  });

  test('Vorschaubild über der Serverlinie: Upload gelingt ohne Vorschaubild', async () => {
    // Absichtlich über 4 MiB, wie es kein 720-px-Bild ergibt: der Klient lässt
    // das Vorschaubild weg, statt den ganzen Upload an einem 413 scheitern zu
    // lassen.
    await page.evaluate(() => {
      const echt = (window as unknown as { __toBlobEcht: HTMLCanvasElement['toBlob'] })
        .__toBlobEcht;
      HTMLCanvasElement.prototype.toBlob = function (cb, typ, qualitaet) {
        if (typ === 'image/webp') {
          cb(new Blob([new Uint8Array(5 * 1024 * 1024)], { type: 'image/png' }));
        } else {
          echt.call(this, cb, typ, qualitaet);
        }
      };
    });

    const rumpf = await hochladen('zu-gross.png');
    expect(rumpf.has_thumb).toBe(false);
    expect(rumpf.thumb_size ?? null).toBeNull();
    // Die Maße der Datei gehen trotzdem mit.
    expect(rumpf.width).toBe(1);
    expect(rumpf.height).toBe(1);
    // Und der Upload endet in „fertig" statt in einem Fehler.
    await expect(page.getByTestId('message-send')).toBeEnabled({ timeout: 15_000 });
    await page.getByTestId('message-send').click();
    await expect(page.getByTestId('attachment-image')).toHaveCount(3, { timeout: 5_000 });
  });

  test.describe('kleine Dateigrenze der Community (0,5 MB)', () => {
    test.beforeAll(async () => {
      const guildId = /\/guilds\/(\d+)\//.exec(page.url())?.[1];
      expect(guildId).toBeTruthy();
      const status = await page.evaluate(async (id) => {
        const token = localStorage.getItem('dcc.tokens.access');
        const r = await fetch(`/api/chat/guilds/${id}/limits`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ limits: { attachment_max_size_bytes: 500_000 } })
        });
        return r.status;
      }, guildId);
      expect(status).toBe(200);
    });

    test('Vorschaubild über der Dateigrenze: genau ein Neuversuch ohne Vorschaubild', async () => {
      // 600 kB: unter der festen Linie von 4 MiB (der Klient schickt es), aber
      // über der Dateigrenze dieser Community (der Server lehnt es ab).
      await safariVorschau(600_000);
      const beobachter = ticketBeobachter();
      try {
        await page.getByTestId('attachment-file-input').setInputFiles({
          name: 'retry.png',
          mimeType: 'image/png',
          buffer: TINY_PNG
        });
        // Der Upload endet in „fertig“ statt in einem Fehler.
        await expect(page.getByTestId('message-send')).toBeEnabled({ timeout: 15_000 });
        await expect(page.getByTestId('attachment-error')).toHaveCount(0);
        await expect.poll(() => beobachter.antworten.length).toBe(2);
        expect(beobachter.anfragen).toHaveLength(2); // genau einmal wiederholt
        expect(beobachter.anfragen[0].has_thumb).toBe(true);
        expect(beobachter.anfragen[0].thumb_size).toBe(600_000);
        expect(beobachter.anfragen[1].has_thumb).toBe(false);
        expect(beobachter.anfragen[1].thumb_size ?? null).toBeNull();
        expect(beobachter.antworten[0]).toEqual({ status: 413, detail: 'thumbnail too large' });
        expect(beobachter.antworten[1].status).toBe(201);
      } finally {
        beobachter.stop();
      }
      await page.getByTestId('message-send').click();
      await expect(page.getByTestId('attachment-preview')).toHaveCount(0);
    });

    test('„Datei zu groß“ löst keinen Neuversuch aus', async () => {
      // Ein Bild über der Dateigrenze (TINY_PNG plus Füllbytes hinter dem
      // Bildende, der Browser dekodiert es weiter), Vorschaubild klein genug.
      await safariVorschau(100_000);
      const beobachter = ticketBeobachter();
      try {
        await page.getByTestId('attachment-file-input').setInputFiles({
          name: 'gross.png',
          mimeType: 'image/png',
          buffer: Buffer.concat([TINY_PNG, Buffer.alloc(600_000)])
        });
        await expect(page.getByTestId('attachment-error').first()).toBeVisible({
          timeout: 15_000
        });
        await expect.poll(() => beobachter.antworten.length).toBe(1);
        // Zeit für einen (falschen) zweiten Versuch lassen, dann zählen.
        await page.waitForTimeout(1_500);
        expect(beobachter.anfragen).toHaveLength(1);
        expect(beobachter.anfragen[0].has_thumb).toBe(true);
        expect(beobachter.antworten).toHaveLength(1);
        expect(beobachter.antworten[0].status).toBe(413);
        expect(beobachter.antworten[0].detail).toMatch(/^file too large \(/);
      } finally {
        beobachter.stop();
      }
      await page.getByTestId('attachment-remove').first().click();
    });
  });
});
