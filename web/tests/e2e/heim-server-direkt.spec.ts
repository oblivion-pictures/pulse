import { test, expect, type Page } from '@playwright/test';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import { E2E_AUTH_PORT } from './_ports';

/**
 * Heim-Server: die ECHTE WebRTC-Direktverbindung, Komplettlauf.
 *
 * Der Spec fährt ALLES selbst: Owner registriert sich in der Cloud, legt per
 * Selbstbedienung seine Instanz an, mintet + löst den Bootstrap-Token, startet
 * den All-in-One-Container mit genau diesen Creds (docker), gründet Community
 * + Invite — dann kommt Bob über den echten Client-Stack (`/src/lib/direct/*`:
 * RTCPeerConnection, Offer-Signaling, TOFU-Fingerprint-Pinning, HTTP über den
 * DataChannel) auf den Heim-Server und liest den Kanal. Kein HTTP-Fallback.
 *
 * Voraussetzungen: docker + gebautes Image `pulse-allinone:heim-test`
 * (docker build -f infra/self-host/Dockerfile …). Der Adapter bekommt
 * PULSE_DIRECT_EXTRA_HOST_IPS=127.0.0.1, damit die ICE-Strecke über Loopback
 * läuft — auf echten Zwei-Maschinen-Strecken stehen dort STUN-/LAN-IPs.
 *
 * **Das Host-Netz muss FREI sein** (`HOST_PORTS_*` unten): der Container läuft
 * mit `--network host` und belegt dort u. a. 443, 5432, 7881, 7900/udp, 9000.
 * Auf einem Rechner, der schon etwas auf diesen Ports hat — ein Heimserver
 * (`pulse-host-*`), eine fremde Postgres auf 5432, der Dev-Stack —, kann der
 * Lauf nicht gelingen UND ist nicht harmlos: Bobs ICE-Verbindung geht auf
 * 127.0.0.1:7900/udp und träfe dort den fremden Server, und der Container
 * hängt sich an jede Postgres auf 5432 an (`06-run-migrations.sh` fragt nur
 * `pg_isready`, das auch bei unbekanntem Benutzer „bereit" meldet) und liefe
 * seine Migrationen gegen sie. Deshalb prüft der Test die Ports als ERSTES und
 * bricht mit einer klaren Meldung ab, bevor er irgendetwas startet.
 */

const ts = Date.now();
const OWNER = {
  username: `hd_owner_${ts}`,
  email: `hd_owner_${ts}@dcc-test.example.com`,
  password: 'sup3r-secret-pass'
};
const BOB = {
  username: `hd_bob_${ts}`,
  email: `hd_bob_${ts}@dcc-test.example.com`,
  password: 'sup3r-secret-pass'
};
const CONTAINER = 'pulse-heim-e2e';

/** Ports, die der All-in-One-Container im Host-Netz belegt (Kopf von
 *  `infra/self-host/Dockerfile` + `07-render-env.sh`: Caddy, coturn,
 *  MediaMTX, LiveKit, Postgres, Redis, die Python-Dienste).
 *
 *  **9000 (Garage) fehlt mit Absicht.** Den Port hält die Testsuite selbst:
 *  `_globalSetup.ts` startet vor JEDEM Lauf ihre Garage auf `127.0.0.1:9000`.
 *  Stünde er hier, scheiterte die Vorprüfung auf jedem Rechner. Die Garage im
 *  Container bekommt den Port dann nicht — für diesen Test belanglos, er prüft
 *  den Direktpfad über den DataChannel, keine Anhänge. */
const HOST_PORTS_TCP = [
  80, 443, 1936, 3478, 5432, 6379, 7880, 7881, 8002, 8003, 8004, 8005, 8889, 9997
];
/** UDP: coturn, LiveKit-ICE (7882–7892), Direktpfad-Adapter (7900), MediaMTX-ICE. */
const HOST_PORTS_UDP = [3478, 7882, 7883, 7884, 7885, 7886, 7887, 7888, 7889, 7890, 7891, 7892, 7900, 8189];

function sh(cmd: string): string {
  return execSync(cmd, { encoding: 'utf8' });
}

/** Welche der oben genannten Ports lauscht auf diesem Rechner schon jemand?
 *  Liest nur die Socket-Tabelle des Kernels (`ss`), spricht niemanden an.
 *  Ohne `ss` (macOS/Windows) ist nichts prüfbar — dann leer. */
function belegteHostPorts(): string[] {
  let tcp: string;
  let udp: string;
  try {
    tcp = sh('ss -H -ltn');
    udp = sh('ss -H -lun');
  } catch {
    return [];
  }
  // Spalten: Zustand, Recv-Q, Send-Q, Lokal (Adresse:Port), Gegenstelle.
  const lauschend = (ausgabe: string): Set<number> =>
    new Set(
      ausgabe
        .split('\n')
        .map((zeile) => zeile.trim().split(/\s+/)[3])
        .filter((adresse): adresse is string => Boolean(adresse))
        .map((adresse) => Number(adresse.slice(adresse.lastIndexOf(':') + 1)))
    );
  const tcpBelegt = lauschend(tcp);
  const udpBelegt = lauschend(udp);
  return [
    ...HOST_PORTS_TCP.filter((p) => tcpBelegt.has(p)).map((p) => `${p}/tcp`),
    ...HOST_PORTS_UDP.filter((p) => udpBelegt.has(p)).map((p) => `${p}/udp`)
  ];
}

async function register(page: Page, u: { username: string; email: string; password: string }) {
  await page.goto('/register');
  await page.getByTestId('reg-username').fill(u.username);
  await page.getByTestId('reg-email').fill(u.email);
  await page.getByTestId('reg-password').fill(u.password);
  for (let versuch = 0; versuch < 2; versuch++) {
    await page.getByTestId('reg-submit').click();
    try {
      await page.waitForURL(/\/app/, { timeout: 20_000 });
      break;
    } catch {
      if (versuch === 1) throw new Error('register blieb hängen');
    }
  }
  await page
    .locator('[data-testid=backup-onboarding-skip-btn]')
    .click({ timeout: 2500 })
    .catch(() => undefined);
}

/** Container-API via curl (self-signed Cert → Browser ausgeschlossen). */
function containerApi(
  hostname: string,
  path: string,
  method: string,
  token: string | null,
  body?: unknown
): { status: number; json: any } {
  const auth = token ? `-H "Authorization: Bearer ${token}"` : '';
  const data = body !== undefined ? `-d '${JSON.stringify(body).replace(/'/g, "'\\''")}'` : '';
  const raw = sh(
    `curl -sk -w "\\n%{http_code}" --resolve "${hostname}:443:127.0.0.1" ` +
      `-X ${method} ${auth} ${data} "https://${hostname}${path}"`
  );
  const idx = raw.lastIndexOf('\n');
  const status = Number(raw.slice(idx + 1));
  const text = raw.slice(0, idx);
  return { status, json: text ? JSON.parse(text) : {} };
}

test('Direktpfad-Komplettlauf: Selbstbedienung → Container → Bob über DataChannel', async ({
  browser
}) => {
  test.setTimeout(420_000);

  // ── 0. Voraussetzung: das Host-Netz gehört dem Test (s. Kopf) ──
  const belegt = belegteHostPorts();
  if (belegt.length > 0) {
    throw new Error(
      `Der Container braucht das Host-Netz für sich, aber auf diesem Rechner lauscht schon ` +
        `etwas auf: ${belegt.join(', ')}. Der Lauf würde fremde Dienste treffen (ein Heimserver ` +
        `auf 7900/udp, eine fremde Postgres auf 5432) und kann nicht gelingen. Auf einem Rechner ` +
        `ohne diese Dienste fahren (CI-Runner, frische VM) — nichts wurde gestartet.`
    );
  }

  // ── 1. Owner: Konto + Selbstbedienung + Bootstrap (Cloud) ──
  const ownerCtx = await browser.newContext();
  const owner = await ownerCtx.newPage();
  await register(owner, OWNER);

  const { iid, hostname, clientSecret, clientId, ownerUserId, adminEmail } =
    await owner.evaluate(async () => {
    const token = localStorage.getItem('dcc.tokens.access');
    const kopf = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    let r = await fetch('/api/auth/me/instances', {
      method: 'POST',
      headers: kopf,
      body: JSON.stringify({})
    });
    let secret = '';
    let clientIdOut = '';
    const me = (await (await fetch('/api/auth/me', { headers: kopf })).json()) as {
      id: number;
      email: string;
    };
    if (r.status === 409) {
      const liste = (await (
        await fetch('/api/auth/me/instances', { headers: kopf })
      ).json()) as { id: string; hostname: string; status: string; origin: string }[];
      const alt = liste.find((i) => i.status === 'active' && i.origin === 'app_host')!;
      // Secret ist unbekannt (nur beim ersten Mal gezeigt) → Reset-Mint + Redeem.
      const mint = (await (
        await fetch(`/api/auth/me/instances/${alt.id}/bootstrap-token`, {
          method: 'POST',
          headers: kopf,
          body: JSON.stringify({ reset: true })
        })
      ).json()) as { token: string };
      const creds = (await (
        await fetch('/api/auth/selfhost/bootstrap', {
          method: 'POST',
          headers: { Authorization: `Bearer ${mint.token}` }
        })
      ).json()) as { client_id: string; client_secret: string };
      secret = creds.client_secret;
      clientIdOut = creds.client_id;
      return {
        iid: alt.id,
        hostname: alt.hostname,
        clientSecret: secret,
        clientId: clientIdOut,
        ownerUserId: String(me.id),
        adminEmail: me.email
      };
    }
    if (r.status !== 201) throw new Error(`Selbstbedienung → ${r.status}`);
    const body = (await r.json()) as { instance: { id: string; hostname: string } };
    const mint = (await (
      await fetch(`/api/auth/me/instances/${body.instance.id}/bootstrap-token`, {
        method: 'POST',
        headers: kopf,
        body: JSON.stringify({})
      })
    ).json()) as { token: string };
    const creds = (await (
      await fetch('/api/auth/selfhost/bootstrap', {
        method: 'POST',
        headers: { Authorization: `Bearer ${mint.token}` }
      })
    ).json()) as { client_id: string; client_secret: string };
    secret = creds.client_secret;
    return {
      iid: body.instance.id,
      hostname: body.instance.hostname,
      clientSecret: secret,
      clientId: creds.client_id,
      ownerUserId: String(me.id),
      adminEmail: me.email
    };
  });
  expect(iid).toMatch(/^\d+$/);
  expect(hostname).toContain('app-');

  // ── 2. Container mit den Selbstbedienungs-Creds starten ──
  // Eigener Ordner je Lauf: der Container chowned das Cert-Dir auf seinen
  // pulse-User — Wiederverwendung würde das rmSync des Playwright-Users
  // mit EACCES bestrafen.
  const certDir = `/tmp/heim-e2e-certs-${ts}`;
  fs.mkdirSync(certDir, { recursive: true });
  sh(
    `openssl req -x509 -newkey rsa:2048 -keyout ${certDir}/key.pem ` +
      `-out ${certDir}/cert.pem -days 2 -nodes -subj "/CN=${hostname}" ` +
      `-addext "subjectAltName=DNS:${hostname},DNS:localhost" 2>/dev/null`
  );
  try {
    sh(`docker rm -f ${CONTAINER} >/dev/null 2>&1`);
  } catch {
    /* kein alter Container */
  }
  sh(
    `docker run -d --name ${CONTAINER} --network host ` +
      `-v ${certDir}:/data/certs -v pulse-heim-e2e-data:/data ` +
      `-e PULSE_HOSTNAME=${hostname} ` +
      `-e PULSE_INSTANCE_ID=${iid} ` +
      `-e PULSE_INSTANCE_OWNER_ID=${ownerUserId} ` +
      `-e PULSE_CLOUD_CLIENT_ID=${clientId} ` +
      `-e PULSE_CLOUD_CLIENT_SECRET=${clientSecret} ` +
      `-e PULSE_ADMIN_EMAIL=${adminEmail} ` +
      `-e PULSE_CLOUD_ORIGIN=http://127.0.0.1:${E2E_AUTH_PORT} ` +
      `-e PULSE_CLOUD_API_PREFIX= ` +
      `-e PULSE_TLS_MODE=provided ` +
      `-e PULSE_DIRECT_EXTRA_HOST_IPS=127.0.0.1 ` +
      `pulse-allinone:heim-test`
  );

  // Auf Container-Health über TLS warten.
  let healthy = false;
  for (let i = 0; i < 50; i++) {
    try {
      const code = sh(
        `curl -sk -o /dev/null -w "%{http_code}" --resolve "${hostname}:443:127.0.0.1" ` +
          `https://${hostname}/api/chat/health`
      ).trim();
      if (code === '200') {
        healthy = true;
        break;
      }
    } catch {
      /* noch nicht bereit */
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
  expect(healthy, 'Container-Health über TLS').toBe(true);

  // ── 3. Owner-Session am Container + Community/Kanal/Invite + Nachricht ──
  const ownerTicket = await owner.evaluate(async (hn) => {
    const token = localStorage.getItem('dcc.tokens.access');
    const r = await fetch('/api/auth/me/server-ticket', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ hostname: hn })
    });
    if (!r.ok) throw new Error(`ticket → ${r.status}`);
    return (await r.json()) as { ticket: string };
  }, hostname);
  const ownerSess = (await (async () => {
    const raw = sh(
      `curl -sk --resolve "${hostname}:443:127.0.0.1" -X POST ` +
        `-H "Content-Type: application/json" ` +
        `-d '${JSON.stringify({ ticket: ownerTicket.ticket }).replace(/'/g, "'\\''")}' ` +
        `"https://${hostname}/api/chat/session"`
    );
    const body = JSON.parse(raw) as { session_token: string };
    return body.session_token;
  })());
  expect(ownerSess).toBeTruthy();

  const guild = containerApi(hostname, '/api/chat/guilds', 'POST', ownerSess, {
    name: 'Direkt-Lounge'
  });
  expect(guild.status).toBe(201);
  const chan = containerApi(hostname, `/api/chat/guilds/${guild.json.id}/channels`, 'POST', ownerSess, {
    name: 'general',
    type: 0,
    position: 0
  });
  expect(chan.status).toBe(201);
  const invite = containerApi(hostname, `/api/chat/guilds/${guild.json.id}/invites`, 'POST', ownerSess, {
    max_uses: 5,
    expires_in_seconds: 86400
  });
  expect(invite.status).toBe(201);
  const code = invite.json.code as string;
  const nachricht = `direkt-test-${ts}`;
  expect(
    containerApi(hostname, `/api/chat/channels/${chan.json.id}/messages`, 'POST', ownerSess, {
      content: nachricht
    }).status
  ).toBe(201);

  // ── 4. Bob: Cloud-Konto, Ticket mit Invite-Code, Container-Session ──
  const bobCtx = await browser.newContext();
  const bob = await bobCtx.newPage();
  await register(bob, BOB);
  await bob.evaluate(async (iid) => {
    const token = localStorage.getItem('dcc.tokens.access');
    await fetch(`/api/auth/me/instances/${iid}/membership`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` }
    });
  }, iid);
  const bobTicket = await bob.evaluate(
    async ({ iid, hostname, code }) => {
      const token = localStorage.getItem('dcc.tokens.access');
      const r = await fetch('/api/auth/me/server-ticket', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ hostname, community_grant_code: code })
      });
      if (!r.ok) throw new Error(`bob ticket → ${r.status}`);
      return (await r.json()) as { ticket: string };
    },
    { iid, hostname, code }
  );
  const bobSessRaw = sh(
    `curl -sk --resolve "${hostname}:443:127.0.0.1" -X POST ` +
      `-H "Content-Type: application/json" ` +
      `-d '${JSON.stringify({ ticket: bobTicket.ticket, community_grant_code: code }).replace(/'/g, "'\\''")}' ` +
      `"https://${hostname}/api/chat/session"`
  );
  const bobSess = (JSON.parse(bobSessRaw) as { session_token: string }).session_token;
  expect(bobSess).toBeTruthy();

  // ── 5. Bob verbindet über den ECHTEN Client-Stack und liest den Kanal ──
  const ergebnis = await bob.evaluate(
    async ({ iid, hostname, chan, bobSess, nachricht }) => {
      // @ts-expect-error - Vite-served path resolved at browser runtime
      const direct = await import('/src/lib/direct/connection.ts');
      const tb = await (
        await fetch(`/api/auth/me/instances/${iid}/direct-endpoint`)
      ).json();
      const conn = await direct.DirectConnection.open({
        postOffer: async (sdp: string) => {
          const r = await fetch(`/api/auth/me/instances/${iid}/direct-offer`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sdp })
          });
          if (!r.ok) throw new Error(`offer rejected ${r.status}`);
          return ((await r.json()) as { sdp: string }).sdp;
        },
        expectedFingerprint: tb.fingerprint,
        iceServers: []
      });
      const antwort = await conn.fetch(`/api/chat/channels/${chan}/messages`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${bobSess}` }
      } as RequestInit);
      const text = await antwort.text();
      conn.close();
      return { status: antwort.status, text: text.slice(0, 400) };
    },
    { iid, hostname, chan: chan.json.id, bobSess, nachricht }
  );

  console.log('[direkt]', JSON.stringify(ergebnis).slice(0, 300));
  expect(ergebnis.status).toBe(200);
  expect(ergebnis.text).toContain(nachricht);

  await bobCtx.close();
  await ownerCtx.close();
});

test.afterAll(() => {
  try {
    sh(`docker rm -f ${CONTAINER} >/dev/null 2>&1`);
  } catch {
    /* Container war schon weg */
  }
});
