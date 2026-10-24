<script lang="ts">
  /**
   * Kopf des Gruppen-Blatts — Bild (antippen: setzen/ersetzen, ✕: entfernen),
   * Name (Owner: umbenennen) und die eigene Stummschaltung. Der Gruppenanruf
   * sitzt seit 2026-10-20 oben im Chat-Kopf (`ChatView`), nicht mehr hier.
   *
   * Mutationen laufen über `ausfuehren` aus dem Blatt (eine zur Zeit, Fehler
   * als Hinweis). Antwortet die Route mit der Gruppe, ist das die neue
   * Wahrheit für den Store — derselbe Weg wie bei den Mitglieds-Mutationen.
   */
  import XIcon from '@lucide/svelte/icons/x';
  import CheckIcon from '@lucide/svelte/icons/check';
  import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
  import PencilIcon from '@lucide/svelte/icons/pencil';
  import BellOffIcon from '@lucide/svelte/icons/bell-off';
  import { gruppenApi, type PrivateGruppe } from '$lib/api/gruppen';
  import { privateGruppen } from '$lib/stores/privateGruppen.svelte';
  import { m } from '$lib/paraglide/messages.js';
  // Security-Scan 2026-10-24: icon_url filtern wie überall — private Gruppen
  // sind Cloud-only (gruppen.ts cloudRoute), guildIconSrc löst relative Pfade
  // gegen die Cloud-Origin auf und lehnt alles andere ab (http:, data:, …).
  import { guildIconSrc } from '$lib/guildIcon';

  let {
    gruppe,
    ichId,
    istMitglied,
    istOwner,
    ausfuehren,
    onUmbenennenAbbruch
  }: {
    gruppe: PrivateGruppe;
    ichId: string | null;
    istMitglied: boolean;
    istOwner: boolean;
    ausfuehren: (fn: () => Promise<void>) => Promise<void>;
    /** Abbruch des Umbenennens nimmt auch eine offene Auflösen-Bestätigung zurück. */
    onUmbenennenAbbruch: () => void;
  } = $props();

  let iconInput = $state<HTMLInputElement | undefined>();
  /** Umbenennen (Owner): Klick auf den Stift macht den Namen zum Eingabefeld. */
  let umbenennenOffen = $state(false);
  let neuerName = $state('');
  /** Gefiltertes Gruppenbild — null = Initialien-Bahn (s. Import-Kommentar). */
  const icon = $derived(guildIconSrc(gruppe.icon_url));
  /** Persönlich, pro Gerät synchron — einzige Lesestelle im Store. */
  const ichStumm = $derived(privateGruppen.eigenesStumm(gruppe, ichId));

  function umbenennen() {
    const name = neuerName.trim();
    if (!name) return;
    void ausfuehren(async () => {
      const neu = await gruppenApi.umbenennen(gruppe.id, name);
      if (neu) privateGruppen.upsert(neu);
      umbenennenOffen = false;
    });
  }

  function stummUmschalten() {
    const ich = ichId;
    if (!ich) return;
    // Einmal vorher festhalten: nach dem `await` sähe `ichStumm` womöglich
    // schon den Stand, den ein Gruppen-Ereignis inzwischen eingetragen hat.
    const neu = !ichStumm;
    void ausfuehren(async () => {
      await gruppenApi.stummSetzen(gruppe.id, neu);
      privateGruppen.stummSetzen(gruppe.id, ich, neu);
    });
  }

  /** Gruppenbild hochladen (Nutzerwunsch 2026-10-19). */
  function iconHochladen(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    void ausfuehren(async () => {
      const neu = await gruppenApi.iconSetzen(gruppe.id, file);
      if (neu) privateGruppen.upsert(neu);
    });
  }

  function iconEntfernen() {
    void ausfuehren(async () => {
      const neu = await gruppenApi.iconEntfernen(gruppe.id);
      if (neu) privateGruppen.upsert(neu);
    });
  }
</script>

<div class="flex items-center gap-3">
  <div class="relative shrink-0">
    <!-- Tipp auf den Kreis = Bild wählen (Nutzerwunsch 2026-10-19); der
         Pfeil unten rechts zeigt, dass hier etwas zu holen ist, das ✕ oben
         rechts nimmt ein gesetztes Bild wieder weg. Die Text-Links darunter
         sind bewusst weg. Beides nur für Mitglieder — dieselbe Grenze wie
         beim Server (`gruppen_icons.py`). -->
    <button
      type="button"
      class="relative block rounded-full {istMitglied ? 'cursor-pointer' : 'cursor-default'}"
      onclick={() => iconInput?.click()}
      disabled={!istMitglied}
      aria-label={gruppe.icon_url ? m.gruppen_bild_ersetzen() : m.gruppen_bild_setzen()}
      data-testid="group-icon-change"
    >
      {#if icon}
        <img
          src={icon}
          alt=""
          class="size-14 rounded-full object-cover"
          data-testid="group-icon"
        />
      {:else}
        <span
          class="accent-gradient flex size-14 items-center justify-center rounded-full text-lg font-bold text-white"
          data-testid="group-icon-initials"
        >
          {gruppe.name.slice(0, 1).toUpperCase()}
        </span>
      {/if}
      {#if istMitglied}
        <span
          class="bg-bg-panel ring-border text-text-muted absolute -right-0.5 -bottom-0.5 flex size-5 items-center justify-center rounded-full ring-2"
          aria-hidden="true"
        >
          <ChevronRightIcon class="size-3" />
        </span>
      {/if}
    </button>
    {#if istMitglied && gruppe.icon_url}
      <button
        type="button"
        class="bg-bg-panel ring-border text-text-muted hover:text-destructive absolute -top-0.5 -right-0.5 flex size-5 items-center justify-center rounded-full ring-2 before:absolute before:-inset-3 before:content-['']"
        onclick={iconEntfernen}
        aria-label={m.gruppen_bild_entfernen()}
        data-testid="group-icon-remove"
      >
        <!-- Sichtbar 20 px, greifbar 44 px (`before:-inset-3`): sonst wäre das
             ✕ am Handy kaum zu treffen. -->
        <XIcon class="size-3" />
      </button>
    {/if}
  </div>
  <div class="min-w-0 flex-1">
    {#if umbenennenOffen}
      <!-- Umbenennen (Owner): Eingabe + Haken, Abbruch mit dem X. -->
      <div class="flex items-center gap-2">
        <input
          bind:value={neuerName}
          class="text-text-bright border-primary min-w-0 flex-1 rounded-lg border px-2 py-1 text-base font-bold outline-none"
          maxlength="64"
          data-testid="group-rename-input"
        />
        <button
          type="button"
          class="text-primary flex size-8 shrink-0 items-center justify-center"
          onclick={umbenennen}
          aria-label={m.gruppen_speichern()}
          data-testid="group-rename-save"
        >
          <CheckIcon class="size-4" />
        </button>
        <button
          type="button"
          class="text-text-muted flex size-8 shrink-0 items-center justify-center"
          onclick={() => {
            umbenennenOffen = false;
            onUmbenennenAbbruch();
          }}
          aria-label={m.gruppen_abbrechen()}
        >
          <XIcon class="size-4" />
        </button>
      </div>
    {:else}
      <div class="flex items-center gap-2">
        <p class="text-text-bright truncate text-base font-bold">{gruppe.name}</p>
        {#if istOwner}
          <button
            type="button"
            class="text-text-muted hover:text-primary shrink-0"
            onclick={() => {
              neuerName = gruppe.name;
              umbenennenOffen = true;
            }}
            aria-label={m.gruppen_umbenennen()}
            data-testid="group-rename-open"
          >
            <PencilIcon class="size-3.5" />
          </button>
        {/if}
      </div>
    {/if}
    <p class="text-text-muted text-xs">
      {m.gruppen_blatt_mitglieder({ count: gruppe.members.length })}
    </p>
  </div>
</div>
<input
  bind:this={iconInput}
  type="file"
  accept="image/png,image/jpeg,image/webp"
  class="hidden"
  onchange={iconHochladen}
/>
{#if istMitglied}
  <!-- Stumm: persönlich, pro Gerät synchronisiert — der Handy-Push der
       Gruppe ruht, der Chat selbst bleibt normal. -->
  <button
    type="button"
    class="hover:bg-bg-hover mt-2 flex w-full items-center justify-between rounded-xl border border-border px-3 py-2 text-sm font-semibold {ichStumm
      ? 'text-text-bright'
      : 'text-text-base'}"
    onclick={stummUmschalten}
    data-testid="group-mute"
  >
    <span class="flex items-center gap-2">
      <BellOffIcon class="size-4" />
      {m.gruppen_stumm()}
    </span>
    <span class={ichStumm ? 'text-primary' : 'text-text-muted'}>
      {ichStumm ? m.gruppen_stumm_an() : m.gruppen_stumm_aus()}
    </span>
  </button>
{/if}
