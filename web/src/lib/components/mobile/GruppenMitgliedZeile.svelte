<script lang="ts">
  /**
   * Eine Mitgliederzeile im Gruppen-Blatt — Bild, Name, Rollen-Abzeichen,
   * Rauswerfen und (nur für den Owner) die Rollen-Aktionen.
   *
   * Rollen-Aktionen (Rollen-Vertrag 2026-10-19): „Zum Admin machen" /
   * „Admin entziehen" und „Besitz übertragen" — alle drei nur der Owner,
   * nie auf sich selbst. Die Routen antworten mit 204; der Store wird lokal
   * nachgezogen, das Gruppen-Ereignis bringt danach den Server-Stand.
   * Besitz übertragen braucht einen zweiten Tipp, wie Verlassen und
   * Auflösen im Blatt.
   */
  import XIcon from '@lucide/svelte/icons/x';
  import EllipsisVerticalIcon from '@lucide/svelte/icons/ellipsis-vertical';
  import { userCache } from '$lib/stores/users.svelte';
  import { nameStyle } from '$lib/utils/nameColor';
  import { safeAvatarUrl } from '$lib/avatar';
  import { gruppenApi, type GruppenMitglied } from '$lib/api/gruppen';
  import { privateGruppen } from '$lib/stores/privateGruppen.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let {
    gruppeId,
    mm,
    ichId,
    darfKicken,
    istOwner,
    ausfuehren
  }: {
    gruppeId: string;
    mm: GruppenMitglied;
    ichId: string | null;
    /** Rauswerfen erlaubt (Rechnung im Blatt, wie im Backend). */
    darfKicken: boolean;
    /** Bin ICH der Owner? Nur dann gibt es die Rollen-Aktionen. */
    istOwner: boolean;
    /** Eine Mutation zur Zeit, Fehler als Hinweis — gehört dem Blatt. */
    ausfuehren: (fn: () => Promise<void>) => Promise<void>;
  } = $props();

  const istIch = $derived(mm.user_id === ichId);
  const anzName = $derived(userCache.displayName(mm.user_id));
  const bild = $derived(safeAvatarUrl(userCache.get(mm.user_id)?.avatar_url ?? null));
  const rollenAktionen = $derived(istOwner && !istIch && mm.rolle !== 'owner');
  let aktionenOffen = $state(false);
  let besitzBestaetigt = $state(false);

  function entfernen() {
    void ausfuehren(async () => {
      const neu = await gruppenApi.mitgliedEntfernen(gruppeId, mm.user_id);
      // `null` = Gruppe damit aufgelöst — dann ist hier auch Schluss.
      if (neu) privateGruppen.upsert(neu);
      else privateGruppen.entfernen(gruppeId);
    });
  }

  function rolleUmschalten() {
    const rolle = mm.rolle === 'admin' ? 'mitglied' : 'admin';
    const ziel = mm.user_id;
    void ausfuehren(async () => {
      await gruppenApi.rolleSetzen(gruppeId, ziel, rolle);
      privateGruppen.rollenSetzen(gruppeId, { [ziel]: rolle });
      aktionenOffen = false;
    });
  }

  function besitzUebertragen() {
    if (!besitzBestaetigt) {
      besitzBestaetigt = true;
      return;
    }
    const aenderungen: Record<string, string> = { [mm.user_id]: 'owner' };
    if (ichId) aenderungen[ichId] = 'admin';
    void ausfuehren(async () => {
      await gruppenApi.besitzUebertragen(gruppeId, mm.user_id);
      privateGruppen.rollenSetzen(gruppeId, aenderungen);
      aktionenOffen = false;
    }).finally(() => (besitzBestaetigt = false));
  }
</script>

<li class="rounded-xl p-2" data-testid={`group-member-${mm.user_id}`}>
  <div class="flex items-center gap-3">
    {#if bild}
      <img src={bild} alt="" class="size-9 shrink-0 rounded-full object-cover" />
    {:else}
      <span
        class="accent-gradient flex size-9 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white"
        >{anzName.slice(0, 1).toUpperCase()}</span
      >
    {/if}
    <span class="truncate text-sm font-semibold" style={nameStyle(mm.user_id)}>{anzName}</span>
    {#if mm.rolle === 'owner'}
      <span
        class="rounded-full bg-primary/20 px-1.5 py-0.5 text-2xs font-bold text-primary"
        data-testid={`group-member-role-${mm.user_id}`}
      >
        Owner
      </span>
    {:else if mm.rolle === 'admin'}
      <span
        class="rounded-full bg-bg-hover px-1.5 py-0.5 text-2xs font-bold text-text-bright"
        data-testid={`group-member-role-${mm.user_id}`}
      >
        Admin
      </span>
    {/if}
    <div class="ml-auto flex items-center">
      {#if rollenAktionen}
        <button
          type="button"
          class="text-text-muted hover:text-primary flex size-9 handy:size-11 items-center justify-center rounded-full"
          onclick={() => {
            aktionenOffen = !aktionenOffen;
            besitzBestaetigt = false;
          }}
          aria-label={m.gruppen_rolle_aktionen()}
          aria-expanded={aktionenOffen}
          data-testid={`group-member-roles-${mm.user_id}`}
        >
          <EllipsisVerticalIcon class="size-4" />
        </button>
      {/if}
      {#if darfKicken && !istIch}
        <button
          type="button"
          class="text-text-muted hover:text-error flex size-9 handy:size-11 items-center justify-center rounded-full"
          onclick={entfernen}
          aria-label={m.gruppen_mitglied_entfernen()}
          data-testid={`group-member-remove-${mm.user_id}`}
        >
          <XIcon class="size-4" />
        </button>
      {/if}
    </div>
  </div>
  {#if rollenAktionen && aktionenOffen}
    <div class="mt-1 flex flex-wrap gap-x-3 gap-y-1 pl-12 text-xs">
      <button
        type="button"
        class="text-primary hover:underline"
        onclick={rolleUmschalten}
        data-testid={`group-member-role-toggle-${mm.user_id}`}
      >
        {mm.rolle === 'admin' ? m.gruppen_admin_entziehen() : m.gruppen_zum_admin()}
      </button>
      <button
        type="button"
        class="font-semibold text-red-500 hover:underline"
        onclick={besitzUebertragen}
        data-testid={`group-member-transfer-${mm.user_id}`}
      >
        {besitzBestaetigt
          ? m.gruppen_besitz_uebertragen_bestaetigen()
          : m.gruppen_besitz_uebertragen()}
      </button>
    </div>
  {/if}
</li>
