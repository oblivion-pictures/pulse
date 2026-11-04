import type { Page } from '@playwright/test';

/**
 * Macht einen Nutzer über den echten Einladungsweg zum Mitglied von `guildId`:
 * `einladender` legt eine Einmal-Einladung an, das Ziel löst sie mit SEINEM
 * Token ein. Ersatz für das abgeschaffte `POST /guilds/{id}/members`
 * (Security-Scan 2026-11-04) — dasselbe `guild_member_added` wie früher.
 *
 * `ziel` ist entweder die angemeldete Seite des Eingeladenen oder, wenn es die
 * (noch) nicht gibt, sein Access-Token; dann löst die Seite des Einladenden
 * im Namen dieses Tokens ein. Wirft bei jedem unerwarteten Statuscode.
 */
export async function beitretenPerEinladung(
  einladender: Page,
  ziel: Page | string,
  guildId: string
): Promise<void> {
  const erzeugt = await einladender.evaluate(async (gid) => {
    const token = localStorage.getItem('dcc.tokens.access');
    const r = await fetch(`/api/chat/guilds/${gid}/invites`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ max_uses: 1 })
    });
    return { status: r.status, body: await r.text() };
  }, guildId);
  if (erzeugt.status !== 201) {
    throw new Error(`Einladung anlegen fehlgeschlagen ${erzeugt.status}: ${erzeugt.body}`);
  }
  const code = (JSON.parse(erzeugt.body) as { code: string }).code;

  const seite = typeof ziel === 'string' ? einladender : ziel;
  const zielToken = typeof ziel === 'string' ? ziel : null;
  const angenommen = await seite.evaluate(
    async ({ code, zielToken }) => {
      const token = zielToken ?? localStorage.getItem('dcc.tokens.access');
      const r = await fetch(`/api/chat/invites/${code}/accept`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      return { status: r.status, body: await r.text() };
    },
    { code, zielToken }
  );
  if (angenommen.status !== 200) {
    throw new Error(`Einladung einlösen fehlgeschlagen ${angenommen.status}: ${angenommen.body}`);
  }
}
