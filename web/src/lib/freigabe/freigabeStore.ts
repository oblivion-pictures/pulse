/**
 * Ablage für einen geteilten Inhalt (Übergabe P1.8, Share-Target) —
 * importfreier Zustand, damit der Node-Testlauf die Ablauf-Regeln prüft
 * und die Brücke (platform/shareEmpfang.ts) ohne Krypto-Importkegel
 * auskommt.
 *
 * Regel: die Freigabe bleibt liegen, BIS ein Verbraucher sie übernimmt
 * (Composer der geöffneten Unterhaltung) — nicht „bis zum nächsten
 * Klick“. Ein zweiter Share ERSETZT den ersten (der Nutzer teilt erneut,
 * der alte war nicht mehr gemeint).
 */

import type { GeteilteDatei } from './freigabeRechnung';

type GeteilteFreigabe = {
  text: string | null;
  bild: { base64: string; mime: string } | null;
  /** iOS: Dateien, die noch in der Hülle liegen (nur das Verzeichnis — geholt
   *  werden sie beim Übernehmen, `freigabeDateien.ts`). Fehlt ohne Dateien. */
  dateien?: GeteilteDatei[];
  paketId?: string;
  /** Wie viele Elemente die Hülle nicht mitgenommen hat. */
  uebersprungen?: number;
};

let freigabe: GeteilteFreigabe | null = null;

export function freigabeAnkommen(paket: {
  text?: string | null;
  bild?: { base64: string; mime: string } | null;
  dateien?: GeteilteDatei[];
  paketId?: string | null;
  uebersprungen?: number;
}): void {
  const text = typeof paket.text === 'string' && paket.text !== '' ? paket.text : null;
  const bild =
    paket.bild && typeof paket.bild.base64 === 'string' && paket.bild.base64 !== ''
      ? { base64: paket.bild.base64, mime: paket.bild.mime || 'image/jpeg' }
      : null;
  const verzeichnis =
    paket.paketId && paket.dateien?.length
      ? {
          dateien: paket.dateien,
          paketId: paket.paketId,
          uebersprungen: paket.uebersprungen ?? 0
        }
      : null;
  freigabe = text || bild || verzeichnis ? { text, bild, ...verzeichnis } : null;
}

export function freigabeHolen(): GeteilteFreigabe | null {
  return freigabe;
}

export function freigabeLeeren(): void {
  freigabe = null;
}
