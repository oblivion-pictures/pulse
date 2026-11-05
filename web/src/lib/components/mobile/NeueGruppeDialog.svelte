<script lang="ts">
  /**
   * „Neue Gruppe" — Name wählen, Freunde anhaken, anlegen.
   *
   * Der letzte fehlende Bildschirm des Gruppen-Unterspiels (Backend, Krypto
   * und API-Client standen schon, s. Übergabe §5 P0.4): Angelegt wird über
   * `gruppenApi.erstellen` + `mitgliedHinzufuegen` je Freund, der Bestand
   * landet im `privateGruppen`-Store, und die Ansicht springt direkt in den
   * frischen Gruppen-Chat — dieselbe Adresse wie eine DM (`/app/@me/<id>`).
   *
   * Freunde haken AN, nicht AB: Wer fehlen soll, lässt man aus. Das
   * Einzelspielen einer leeren Gruppe ist erlaubt (man kann später über das
   * Gruppen-Blatt noch jemanden hinzufügen), der Name ist Pflicht.
   */
  import HandyDialog from './HandyDialog.svelte';
  import { friends } from '$lib/stores/friends.svelte';
  import { userCache } from '$lib/stores/users.svelte';
  import { nameStyle } from '$lib/utils/nameColor';
  import { safeAvatarUrl } from '$lib/avatar';
  import { gruppenApi, type PrivateGruppe } from '$lib/api/gruppen';
  import { privateGruppen } from '$lib/stores/privateGruppen.svelte';
  import { m } from '$lib/paraglide/messages.js';
  import { toast } from 'svelte-sonner';

  let {
    open = $bindable(false),
    onErstellt
  }: {
    open?: boolean;
    onErstellt: (gruppeId: string) => void;
  } = $props();

  let name = $state('');
  let ausgewaehlt = $state<Set<string>>(new Set());
  let amAnlegen = $state(false);

  $effect(() => {
    if (open) {
      name = '';
      ausgewaehlt = new Set();
      for (const f of friends.list) userCache.queue(f.user_id);
    }
  });

  function umschalten(userId: string) {
    const next = new Set(ausgewaehlt);
    if (next.has(userId)) next.delete(userId);
    else next.add(userId);
    ausgewaehlt = next;
  }

  async function anlegen() {
    const gekuerzt = name.trim();
    if (!gekuerzt || amAnlegen) return;
    amAnlegen = true;
    let gruppe: PrivateGruppe | null;
    try {
      gruppe = await gruppenApi.erstellen(gekuerzt);
    } catch (e) {
      toast.error(m.chats_new_group_create_failed(), { description: fehlerText(e) });
      amAnlegen = false;
      return;
    }
    if (!gruppe) {
      amAnlegen = false;
      return;
    }
    // Ab hier GIBT es die Gruppe beim Server. Ein gescheitertes Hinzufügen
    // darf sie nicht mehr verschlucken: vorher brach der erste Fehler alles
    // ab, die Gruppe fehlte in der Liste (Waise), und ein zweiter Versuch
    // legte sie doppelt an. Jetzt kommt sie immer in die Liste und in den
    // Chat; wer fehlt, lässt sich über das Gruppen-Blatt nachtragen.
    privateGruppen.upsert(gruppe);
    let fehlgeschlagen = 0;
    let letzterFehler: unknown;
    for (const userId of ausgewaehlt) {
      try {
        const nachMitglied = await gruppenApi.mitgliedHinzufuegen(gruppe.id, userId);
        if (nachMitglied) gruppe = nachMitglied;
      } catch (e) {
        fehlgeschlagen++;
        letzterFehler = e;
      }
    }
    privateGruppen.upsert(gruppe);
    amAnlegen = false;
    open = false;
    if (fehlgeschlagen > 0) {
      toast.error(m.chats_new_group_mitglieder_fehlgeschlagen({ anzahl: fehlgeschlagen }), {
        description: fehlerText(letzterFehler)
      });
    }
    // Die Aufrufer navigieren selbst (onSelectGruppe springt in den Chat) —
    // hier ein zweites goto wäre nur Rennen um dieselbe Adresse.
    onErstellt(gruppe.id);
  }

  function fehlerText(e: unknown): string | undefined {
    return e instanceof Error ? e.message : undefined;
  }

  function initialen(anzName: string): string {
    return anzName.slice(0, 1).toUpperCase();
  }
</script>

<HandyDialog
  {open}
  onOpenChange={(o) => (open = o)}
  class="max-w-sm"
  testid="chats-new-group-dialog"
  titel={m.chats_new_group()}
  beschreibung={m.chats_new_group_hint()}
>
    <input
      type="text"
      bind:value={name}
      placeholder={m.chats_new_group_name_placeholder()}
      class="border-border bg-bg-input focus:border-primary w-full rounded-xl border px-3 py-2.5 text-base outline-none [@media(pointer:fine)]:text-sm"
      data-testid="new-group-name"
      aria-label={m.chats_new_group_name_placeholder()}
    />
    <div class="flex max-h-[45vh] flex-col gap-1 overflow-y-auto">
      {#each friends.list as f (f.user_id)}
        {@const anzName = userCache.displayName(f.user_id)}
        {@const bild = safeAvatarUrl(userCache.get(f.user_id)?.avatar_url ?? null)}
        <button
          type="button"
          class="hover:bg-bg-hover handy-druck flex w-full items-center gap-3 rounded-xl p-2 text-left transition-colors"
          onclick={() => umschalten(f.user_id)}
          data-testid={`new-group-friend-${f.user_id}`}
          data-selected={ausgewaehlt.has(f.user_id)}
        >
          {#if bild}
            <img src={bild} alt="" class="size-10 shrink-0 rounded-full object-cover" />
          {:else}
            <span
              class="accent-gradient flex size-10 shrink-0 items-center justify-center rounded-full text-sm font-bold text-white"
              >{initialen(anzName)}</span
            >
          {/if}
          <span class="truncate text-sm font-semibold" style={nameStyle(f.user_id)}>{anzName}</span>
          <input
            type="checkbox"
            checked={ausgewaehlt.has(f.user_id)}
            class="accent-primary pointer-events-none ml-auto size-4"
            tabindex={-1}
          />
        </button>
      {/each}
    </div>
    <button
      type="button"
      disabled={!name.trim() || amAnlegen}
      class="accent-gradient text-primary-foreground min-h-11 w-full rounded-xl py-2.5 text-sm font-bold disabled:opacity-50"
      onclick={anlegen}
      data-testid="new-group-create"
    >
      {m.chats_new_group_create()}
    </button>
</HandyDialog>
