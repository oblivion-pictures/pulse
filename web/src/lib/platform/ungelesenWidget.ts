/**
 * Die Zahl für das Widget „Ungelesen“ in der iOS-Hülle (iOS-Liste Punkt 45) —
 * die Brücke. Das Native liegt in `mobile/ios/App/App/UngelesenPlugin.swift`
 * (legt die Zahl in den gemeinsamen Container der App Group), gezeichnet wird
 * in der Widget-Erweiterung (`WidgetExtension/UngelesenWidget.swift`).
 *
 * **Es ist dieselbe Zahl wie die Plakette am Symbol** (Punkt 17): ungelesene
 * Nachrichten der privaten Gespräche. Gerufen wird deshalb aus `badgeMelden.ts`
 * — dort steht auch die Regel, ab wann die Zahl etwas bedeutet (`bereit`: vor
 * dem Postfach-Abholweg ist eine 0 ein „weiss ich nicht“, Begründung in
 * `badgeDrossel.ts`). Nur die Zahl reist hinüber, nie ein Name: der Container
 * ist unverschlüsselt.
 *
 * **Ein älterer App-Bau kennt das Plugin nicht** — dann geschieht nichts.
 * Gefragt wird VOR dem Ruf (`huelleKennt`), nicht am Fehlschlag; eine eigene
 * Methode am `SprachePlugin` hätte jeden älteren Bau ganz auf den Web-Sprachweg
 * zurückgeworfen (`SPRACHE_METHODEN`).
 *
 * **Mit `.ts`-Endungen in den Importen**, damit Nodes Läufer die Datei samt
 * echtem `@capacitor/core` lädt (`test/ungelesen-widget.test.ts`, Muster:
 * `iosSpracheWeiche.ts`).
 */

import { registerPlugin } from '@capacitor/core';

import { huelleKennt } from './huelleKann.ts';
import { isCapacitorIOS } from './runtime.ts';

interface UngelesenPlugin {
  setzen(o: { anzahl: number }): Promise<void>;
}

const plugin = registerPlugin<UngelesenPlugin>('Ungelesen');

/** Zuletzt abgelegt — derselbe Wert ist keine Nachricht. `null` heisst
 *  „noch nichts“, dann geht der nächste Wert in jedem Fall hinüber. */
let zuletzt: number | null = null;

/** Die Zahl ablegen. Ausserhalb der iOS-Hülle und ohne Plugin ein No-op. */
export function ungelesenAblegen(anzahl: number): void {
  if (!isCapacitorIOS() || !huelleKennt('Ungelesen', 'setzen')) return;
  const wert = Number.isFinite(anzahl) ? Math.max(0, Math.floor(anzahl)) : 0;
  if (wert === zuletzt) return;
  zuletzt = wert;
  plugin.setzen({ anzahl: wert }).catch(() => {
    // Nicht angekommen: den Merker zurücknehmen, sonst gälte der Wert als
    // abgelegt und der nächste gleiche Stand schwiege.
    if (zuletzt === wert) zuletzt = null;
  });
}

/**
 * Nach dem Abmelden: das Widget zeigt 0. **Nicht bloss Hygiene** — das
 * Widget gehört dem GERÄT, nicht dem Konto (dieselbe Begründung wie bei der
 * Schnellwahl, `schnellwahlLeeren`): der Nächste sähe sonst, wie viele
 * Nachrichten auf den Vorigen warten.
 */
export function ungelesenLeeren(): void {
  zuletzt = null;
  ungelesenAblegen(0);
}
