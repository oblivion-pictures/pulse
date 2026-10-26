/**
 * Zustimmung zu den Nutzungsbedingungen (services/auth/src/dcc_auth/agb.py):
 * das Pflicht-Häkchen bei der Registrierung und der Sperrbildschirm
 * `/agb-zustimmung` für ein Konto, das der aktuellen Fassung nie zugestimmt hat.
 *
 * Ein Bestandskonto stellt der Test nach, indem er die gespeicherte Fassung in
 * der Datenbank löscht — so sieht jedes Konto von vor Migration 0059 aus.
 */

import { test, expect, type Page } from '@playwright/test';
import { execSync } from 'node:child_process';
import { E2E_DB } from './_db';

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
const USER = {
  username: `agb_${ts}`,
  email: `agb_${ts}@dcc-test.example.com`,
  password: 'sup3r-secret-pass'
};

function sql(befehl: string): string {
  return execSync(
    `${CONTAINER_EXEC} exec -i dcc_night_postgres psql -U dcc -d ${E2E_DB} -tA -c "${befehl}"`
  )
    .toString()
    .trim();
}

async function formularFuellen(page: Page) {
  await page.goto('/register');
  await page.getByTestId('reg-username').fill(USER.username);
  await page.getByTestId('reg-email').fill(USER.email);
  await page.getByTestId('reg-password').fill(USER.password);
}

test.describe.serial('Nutzungsbedingungen', () => {
  test('ohne Häkchen bleibt die Registrierung stehen', async ({ page }) => {
    await formularFuellen(page);
    await page.getByTestId('reg-submit').click();
    // Das Pflichtfeld hält das Formular im Browser an — kein Konto, keine App.
    await expect(page).toHaveURL(/\/register/);
    await expect(page.getByTestId('reg-agb')).not.toBeChecked();
    expect(sql(`SELECT count(*) FROM auth.users WHERE username='${USER.username}'`)).toBe('0');
  });

  test('mit Häkchen entsteht das Konto samt Nachweis', async ({ page }) => {
    await formularFuellen(page);
    await page.getByTestId('reg-agb').check();
    await page.getByTestId('reg-submit').click();
    await page.waitForURL(/\/app/, { timeout: 20_000 });
    const fassung = sql(
      `SELECT agb_fassung FROM auth.users WHERE username='${USER.username}' AND agb_akzeptiert_am IS NOT NULL`
    );
    expect(fassung).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('ein Bestandskonto stimmt auf dem Sperrbildschirm zu', async ({ page }) => {
    sql(
      `UPDATE auth.users SET agb_fassung=NULL, agb_akzeptiert_am=NULL WHERE username='${USER.username}'`
    );
    await page.goto('/login');
    await page.getByTestId('login-identifier').fill(USER.username);
    await page.getByTestId('login-password').fill(USER.password);
    await page.getByTestId('login-submit').click();
    await page.waitForURL(/\/agb-zustimmung/, { timeout: 20_000 });

    const weiter = page.getByTestId('agb-zustimmung-weiter');
    await expect(weiter).toBeDisabled();
    await page.getByTestId('agb-zustimmung-haekchen').check();
    await weiter.click();
    await page.waitForURL(/\/app/, { timeout: 20_000 });
    await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 15_000 });
    expect(
      sql(`SELECT agb_akzeptiert_am IS NOT NULL FROM auth.users WHERE username='${USER.username}'`)
    ).toBe('t');
  });
});
