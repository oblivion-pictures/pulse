<script lang="ts">
  /**
   * Die Huelle eines Blattes von unten: Abdunkelung, Portal, Griff-Strich.
   *
   * **Warum gemeinsam.** Nach dem Mobil-Umbau gab es drei davon — das
   * Aktionsblatt einer Nachricht, der Kanal-Wechsler und die Profilkarte auf
   * dem Handy — und alle drei trugen dieselben zehn Zeilen samt derselben
   * wortgleich abgeschriebenen Begruendung fuer das Portal. Der INHALT der
   * drei ist voellig verschieden; gemeinsam ist nur der Behaelter, und genau
   * der steht jetzt hier.
   *
   * **Der Portal-Grund, der in allen drei Kopien stand:** `position: fixed`
   * bezieht sich NICHT aufs Fenster, sobald irgendein Vorfahre einen `filter`,
   * `backdrop-filter` oder `transform` hat — und `glass-panel` hat
   * `backdrop-filter`; im Chat steht die Nachricht zusaetzlich in einer
   * virtualisierten Liste. Ohne Portal landet das Blatt mitten im Inhalt
   * statt am unteren Bildschirmrand (nachgemessen: Unterkante bei 168 px
   * statt 844).
   *
   * Die Feinheiten bleiben beim Aufrufer: Eckenradius, Polsterung und die
   * Masse des Griff-Strichs unterscheiden sich zwischen den dreien, und ein
   * Baustein, der sie einebnet, aendert das Aussehen. `panelClass` und
   * `panelTestid` reichen sie durch.
   *
   * **Bedienung (2026-10-18):** nach unten wegwischbar — Griff-Strich und
   * Titelzeile ziehen (`blattAktionen.wischen`, Rechnung in `blattWischen.ts`),
   * Rückfedern unter der Schwelle. Für VoiceOver ist das Blatt ein modaler
   * Dialog (`role`, `aria-modal`); der Rest der Seite wird `inert`, der Fokus
   * bleibt im Blatt (`blattAktionen.fokusFalle`). `ariaLabel` benennt den
   * Dialog; ohne ihn liest VoiceOver nur „Dialog".
   *
   * **Bewegung (2026-10-18):** Das Blatt schiebt sich mit der Feder von unten
   * herein, die Abdunkelung blendet ein; Schliessen läuft umgekehrt
   * (`blattUebergang.ts`, bei „Bewegung reduzieren“ nur eine kurze
   * Überblendung). Warum das `{#if}` INNERHALB des `Portal` sitzt: bits-ui
   * hängt den Inhalt per `mount()`/`unmount()` an, und `unmount` räumt ohne
   * Ausblendung sofort ab — ein `{#if}` ausserhalb liesse nie einen
   * `out:`-Übergang laufen. Warum `gezeigt` statt `open` im `{#if}`: ein von
   * Anfang an offenes Blatt (`open` schon beim Anlegen wahr) bekäme sonst keinen
   * Einblend-Übergang, denn `mount()` spielt beim ersten Aufbau keinen ab.
   */
  import { Portal } from 'bits-ui';
  import type { Snippet } from 'svelte';
  import { fokusFalle, wischen } from './blattAktionen';
  import { abdunkelung, blattFahrt } from './blattUebergang';

  let {
    open,
    testid,
    closeLabel,
    panelClass,
    panelTestid,
    ariaLabel,
    onClose,
    children
  }: {
    open: boolean;
    /** Kennung der aussersten Flaeche (Abdunkelung + Blatt). */
    testid: string;
    /** Vorlesetext der Abdunkelung — sie IST der Schliessen-Knopf. */
    closeLabel: string;
    /** Klassen des Blattes selbst; jeder Aufrufer bringt seine eigenen mit. */
    panelClass: string;
    panelTestid?: string;
    /** Name des Dialogs für Screenreader (meist die Titelzeile des Blattes). */
    ariaLabel?: string;
    onClose: () => void;
    children: Snippet;
  } = $props();

  // Erst nach dem Aufbau wahr (Effekte laufen danach) → der Einblend-Übergang spielt.
  let gezeigt = $state(false);
  $effect(() => {
    gezeigt = open;
  });
</script>

<Portal>
  {#if gezeigt}
    <!-- Während des Ausblendens (`open` schon falsch) keine zweite Eingabe annehmen. -->
    <div
      class="fixed inset-0 z-50 flex flex-col justify-end ios:pr-[var(--safe-right)] ios:pl-[var(--safe-left)]"
      class:pointer-events-none={!open}
      data-testid={testid}
      use:fokusFalle={{ onClose }}
    >
      <button
        type="button"
        class="absolute inset-0 bg-black/50"
        aria-label={closeLabel}
        onclick={onClose}
        in:abdunkelung
        out:abdunkelung
      ></button>
      <div
        class={panelClass}
        data-testid={panelTestid}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        tabindex="-1"
        use:wischen={{ onClose }}
        in:blattFahrt
        out:blattFahrt
      >
        {@render children()}
      </div>
    </div>
  {/if}
</Portal>
