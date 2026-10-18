/**
 * Eine Aktion in einem Zeilen-/Kopfmenü — die EINE Beschreibung, aus der beide
 * Darstellungen entstehen: das Kontextmenü am Rechner (`ZeilenKontextInhalt`)
 * und das Blatt von unten am Handy (`mobile/AktionsBlatt`). Vorher standen die
 * Einträge je Kanalzeile hart im Markup; ein zweites Blatt daneben hätte sie
 * ein zweites Mal abgeschrieben. **Importfrei bis auf Typen** (Pflicht für
 * `pnpm test:unit`).
 */
import type { Component } from 'svelte';

export interface ZeilenAktion {
  /** Schlüssel für die Liste, innerhalb eines Menüs eindeutig. */
  id: string;
  label: string;
  icon?: Component<{ class?: string }>;
  onSelect?: () => void;
  testid?: string;
  variant?: 'default' | 'danger' | 'warning';
  /** Trennlinie VOR dieser Aktion. */
  trenner?: boolean;
  /** Zahl als Plakette rechts (Blatt). */
  zahl?: number;
  zahlTestid?: string;
  /** Umschalter statt Knopf — gibt es nur im Kontextmenü am Rechner. */
  schalter?: { checked: boolean; onChange: (an: boolean) => void };
  /** Zeigt im Blatt rechts einen Haken: die aktuell gewählte Stufe einer Auswahl. */
  haken?: boolean;
  /** Am Handy weder im Blatt noch im Kontextmenü (z. B. Raumklang-Schalter). */
  nurDesktop?: boolean;
}
