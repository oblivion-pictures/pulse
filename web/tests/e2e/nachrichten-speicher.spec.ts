import { test, expect, type Page } from '@playwright/test';

/**
 * Nachrichten-Speicher des Klienten (`stores/messages.svelte.ts` mit
 * `nachrichten/{listenKern,kanalCache,grabsteine}.ts`).
 *
 * 1. LRU-Deckel: der gerade geöffnete Kanal darf nie geräumt werden, auch wenn
 *    der Cache voll von Kanälen ist, die nur `upsert` angelegt hat
 *    (Postfach-Abholung für ungeöffnete verschlüsselte Unterhaltungen,
 *    `ws/handlers/chat.ts`). Vorher: leerer Kanal und über 100 Abrufe je
 *    Sekunde in einer Schleife.
 * 2. Grabstein: eine gelöschte Nachricht kehrt nicht zurück, auch wenn das
 *    Kappen der Liste (5000) die Dublettenmengen neu aufgebaut hat.
 *
 * Der Store wird über den Vite-Modulpfad geholt (dieselbe Modulinstanz wie die
 * App); die fremden Kanäle sind frei erfunden und existieren nur im Speicher.
 */

const ts = Date.now();
const USER = {
	username: `speicher_${ts}`,
	email: `speicher_${ts}@dcc-test.example.com`,
	password: 'sup3r-secret-pass'
};

async function register(page: Page) {
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
}

async function rest(page: Page, pfad: string, body: unknown): Promise<{ id: string }> {
	return page.evaluate(
		async ([p, b]) => {
			const token = localStorage.getItem('dcc.tokens.access');
			const r = await fetch(`/api/chat${p}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
				body: JSON.stringify(b)
			});
			if (r.status !== 201 && r.status !== 200) throw new Error(`${p}: ${r.status}`);
			return r.json();
		},
		[pfad, body] as const
	);
}

/** Legt `anzahl` Kanäle an, die nur `upsert` kennt (nie geöffnet, nie angehoben). */
async function fremdeKanaeleEinliefern(page: Page, anzahl: number) {
	await page.evaluate(async ([pfad, n]) => {
		const { messages } = await import(pfad as string);
		for (let i = 0; i < (n as number); i++) {
			messages.upsert({
				id: String(100000000000000100n + BigInt(i)),
				channel_id: `fremd-${i}`,
				author_id: 'x',
				content: `fremd ${i}`,
				nonce: null,
				created_at: '2026-01-01T00:00:00Z'
			});
		}
	}, [STORE, anzahl] as const);
}

/** Der Store der laufenden App: Vite liefert ihn unter seinem Quellpfad, es ist
 *  dieselbe Modulinstanz. Als Variable, damit der Typprüfer den Pfad nicht auflöst. */
const STORE = '/src/lib/stores/messages.svelte.ts';

const nachrichtText = (page: Page, text: string) =>
	page.locator('[data-testid=message-content]', { hasText: text });

test('ein Cache voller Hintergrund-Kanäle räumt den geöffneten Kanal nicht', async ({ page }) => {
	test.setTimeout(90_000);
	await register(page);
	await page.locator('[data-testid^="guild-create-menu-"]').first().click();
	await page.getByTestId('guild-create').click();
	await page.getByTestId('create-guild-name').fill('Deckel');
	await page.getByTestId('create-guild-submit').click();
	await page.waitForURL(/\/app\/guilds\/\d+\/channels\/\d+/);
	const teile = new URL(page.url()).pathname.split('/');
	const guildId = teile[3];
	const kanalA = teile[5];
	const kanalB = (await rest(page, `/guilds/${guildId}/channels`, { name: 'zweiter', type: 0 })).id;
	for (const [kanal, content] of [
		[kanalA, 'hallo A'],
		[kanalB, 'hallo B']
	]) {
		await rest(page, `/channels/${kanal}/messages`, {
			content,
			nonce: null,
			reply_to_id: null,
			attachment_ids: []
		});
	}

	await page.goto(`/app/guilds/${guildId}/channels/${kanalA}`);
	await expect(nachrichtText(page, 'hallo A')).toBeVisible();

	// 15 Kanäle, die nur upsert angelegt hat: sie zählen gegen den Deckel (15),
	// stehen aber nicht in der Benutzt-Reihenfolge.
	await fremdeKanaeleEinliefern(page, 15);

	let abrufe = 0;
	page.on('request', (req) => {
		if (req.method() === 'GET' && req.url().includes(`/channels/${kanalB}/messages`)) abrufe++;
	});
	await page.getByTestId(`channel-${kanalB}`).click();
	await page.waitForURL(new RegExp(`/channels/${kanalB}`));

	// Der neu geöffnete Kanal zeigt seine Nachricht ...
	await expect(nachrichtText(page, 'hallo B')).toBeVisible({ timeout: 10_000 });
	// ... und bleibt dabei: kein Neuladen in der Schleife.
	const nachAnzeige = abrufe;
	await page.waitForTimeout(2500);
	expect(abrufe, 'der Kanal wird nicht in einer Schleife neu geladen').toBe(nachAnzeige);
	await expect(nachrichtText(page, 'hallo B')).toBeVisible();

	// Geräumt wurden Kanäle, die nie geöffnet waren — nicht A, nicht B.
	const gehalten = await page.evaluate(async (pfad) => {
		const { messages } = await import(pfad);
		return Object.keys(messages.byChannel);
	}, STORE);
	expect(gehalten.length).toBeLessThanOrEqual(15);
	expect(gehalten).toContain(kanalA);
	expect(gehalten).toContain(kanalB);

	// Zurück in den ersten Kanal: lädt und zeigt ganz normal.
	await page.getByTestId(`channel-${kanalA}`).click();
	await expect(nachrichtText(page, 'hallo A')).toBeVisible({ timeout: 10_000 });
});

test('eine gelöschte Nachricht kehrt nach dem Kappen der Liste nicht zurück', async ({ page }) => {
	await page.goto('/login');
	const r = await page.evaluate(async (pfad) => {
		const { messages } = await import(pfad);
		const kanal = 'kappen-1';
		const nachricht = (n: number, kryptoId?: string) => ({
			id: String(100000000000000000n + BigInt(n)),
			channel_id: kanal,
			author_id: 'x',
			content: `m${n}`,
			nonce: null,
			created_at: '2026-01-01T00:00:00Z',
			...(kryptoId ? { krypto_id: kryptoId } : {})
		});
		const hatKopie = () =>
			messages.for(kanal).some((m: { krypto_id?: string }) => m.krypto_id === 'K-geloescht');
		// 4999 Nachrichten (Kappung bei 5000); die letzte trägt die krypto_id.
		const start = Array.from({ length: 4999 }, (_, i) =>
			nachricht(i + 1, i === 4998 ? 'K-geloescht' : undefined)
		);
		messages.setInitial(kanal, start);
		messages.remove(kanal, start[4998].id);
		// Eine Kopie unter anderer Id (anderes Gerät) wird abgewiesen ...
		messages.upsert(nachricht(6000, 'K-geloescht'));
		const vorKappen = hatKopie();
		// ... und auch, nachdem drei neue Nachrichten die Liste über 5000
		// getrieben haben (das Kappen baut die Dublettenmengen neu auf).
		for (let n = 7000; n < 7003; n++) messages.upsert(nachricht(n));
		const laenge = messages.for(kanal).length;
		messages.upsert(nachricht(8000, 'K-geloescht'));
		return { vorKappen, laenge, nachKappen: hatKopie() };
	}, STORE);
	expect(r.vorKappen).toBe(false);
	expect(r.laenge, 'die Liste wurde tatsächlich gekappt').toBe(5000);
	expect(r.nachKappen, 'die Kopie der gelöschten Nachricht bleibt draußen').toBe(false);
});
