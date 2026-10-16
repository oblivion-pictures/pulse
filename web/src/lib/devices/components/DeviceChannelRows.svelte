<!--
  DeviceChannelRows — die Geräte, die in DIESEM Sprachkanal stehen.

  **Unter dem Kanal, nicht in einer eigenen Kategorie** (Änderung 2026-08-16).
  Bis dahin standen alle Geräte einer Community in einem eigenen Abschnitt unten
  in der Kanalliste. Die Begründung dafür war richtig — ein Gerät ist kein Kanal
  —, sie führte aber zu einer Liste, die den Standplatz nicht mehr nannte: bei
  mehreren Sprachkanälen war der Zeile nicht anzusehen, wo der Rechner steht.
  Ihn zu beschriften hätte eine zweite Zeile je Gerät gekostet und den Kanalnamen
  wiederholt; hier zu stehen kostet nichts und sagt dasselbe.

  **Ein Gerät bleibt trotzdem kein Teilnehmer.** Es steht in der Einrückung der
  Menschen, aber mit den Merkmalen der Maschine: eckige Kachel statt rundem
  Avatar, Monospace-Name, entsättigter Stahlton. Der Unterschied muss vor dem
  Lesen wirken. Es hat keinen Sprechring, keine Namensfarbe und keinen
  Anwesenheitsstatus — es hat einen Zustandspunkt, und der beantwortet die eine
  Frage, die zählt: kann ich diesen Rechner jetzt übernehmen.

  **Ziehen stellt den Standplatz um** (seit 2026-08-16) — dieselbe Geste, mit
  der man einen Nutzer in einen Sprachkanal zieht, und derselbe Mechanismus
  (`geraetZug.ts` neben `voice/userDrag.ts`). Ziehbar ist die Zeile **nur für
  den Besitzer**: der Server weist einen Kanalwechsel durch andere ab, auch mit
  `MANAGE_GUILD` (der Standplatz ist der Rechteanker). Eine Zeile, die sich
  ziehen lässt und beim Ablegen 403 einfängt, verspräche etwas, das es nicht
  gibt.

  **Zusehen und Übernehmen sind zwei Wege.** Das LIVE-Abzeichen öffnet nur das
  Bild (`onWatch`), der Rest der Zeile führt in die Geräteansicht (`onSelect`),
  wo „Übernehmen" sitzt. Ohne diese Trennung löste ein Dritter, der
  bloss zuschauen wollte, eine Fernsteuer-Anfrage aus — womöglich während schon
  jemand steuert.

  **Wer nicht freigegeben ist, kommt nicht hinein** (seit 2026-10-16): die
  Zeile ist dann gesperrt (`aria-disabled`, Tooltip „Nicht für dich
  freigegeben"), und der Punkt eines wachen Geräts ist neutral statt grün —
  Grün hiesse „kannst du übernehmen". Bewusst `aria-disabled` statt
  `disabled`: ein abgeschalteter Knopf schluckt auch die Klicks seiner Kinder,
  und LIVE muss klickbar bleiben, solange jemand steuert. Die Regel für
  Klick, Punkt und LIVE steht in `zugang.ts::zeilenZustand`.

  **LIVE nur, solange jemand steuert** (für den Besitzer immer): ein bloss
  geweckter Rechner zeigt seinen unbewachten Desktop niemandem, und der
  Server gäbe dafür ohnehin kein Zuschauer-Token heraus. Der Klick öffnet nur
  die Plätze DIESES Geräts (`stream_slots`), nicht jeden Strom des Besitzers.

  **Warum LIVE hier hängt und nicht beim Besitzer:** der Strom läuft technisch
  unter dessen Konto, aber gesendet hat der Rechner. Beim Besitzer stand das
  Abzeichen an einem Menschen, der im Kanal gar nicht anwesend sein muss — und
  war überhaupt nur zu sehen, wenn sonst jemand im Kanal sass (die Teilnehmer-
  liste erscheint nur bei besetztem Kanal). Für ein unbeaufsichtigtes Gerät ist
  das genau der Fall, der nie eintritt.
-->
<script lang="ts">
  import MonitorIcon from '@lucide/svelte/icons/monitor';
  import { deviceStore } from '$lib/devices/store.svelte';
  import { punktKlasse, zeileFuer, zustandsText } from '$lib/devices/darstellung';
  import { startGeraetZug } from '$lib/devices/geraetZug';
  import { currentServerUserId } from '$lib/stores/currentServerUser';
  import type { Device } from '$lib/api/devices';
  import { m } from '$lib/paraglide/messages.js';

  let {
    guildId,
    channelId,
    activeDeviceId = null,
    onSelect,
    onWatch,
    onDragEnd,
  }: {
    guildId: string;
    channelId: string;
    activeDeviceId?: string | null;
    onSelect: (device: Device) => void;
    /** Klick auf LIVE: nur zusehen — nur die Plätze dieses Geräts. */
    onWatch: (device: Device) => void;
    /** Der Zug ist vorbei (abgelegt oder abgebrochen). Die Kanalliste räumt
     *  damit ihre Hervorhebung weg — die Zielzeile gehört ihr, nicht uns. */
    onDragEnd?: () => void;
  } = $props();

  // Beim Betreten der Community einmal laden; die Änderungen danach kommen als
  // `device_changed`/`device_state` über die WebSocket. Der Ruf steht je
  // Sprachkanal, ist aber ein No-op ab dem ersten — der Store merkt sich
  // geladene Communitys und laufende Abrufe.
  $effect(() => {
    void deviceStore.ensureLoaded(guildId);
  });

  const geraete = $derived(deviceStore.forGuild(guildId).filter((d) => d.channel_id === channelId));

  // Überträgt dieses Gerät gerade? Die Bedingung liegt in `darstellung.ts`
  // (`geraetSendet`, über `zeileFuer`) direkt neben ihrem Gegenstück für die
  // Menschen-Zeile — die beiden müssen sich ergänzen, und getrennt gepflegt
  // sind sie schon einmal auseinandergelaufen (Doppel-Abzeichen, 2026-08-18).

  // Die Kennung auf DIESEM Server, nicht die des Kontos: `owner_user_id` ist
  // serverlokal, und auf einem Self-Host ist die Cloud-Kennung eine andere —
  // mit `auth.user.id` verglichen wäre dort das eigene Gerät nie das eigene.
  const meine = $derived(currentServerUserId());
</script>

{#each geraete as d (d.id)}
  {@const zeile = zeileFuer(d)}
  {@const live = zeile.live}
  {@const meins = d.owner_user_id === meine}
  <div class="ml-4 flex flex-col" data-testid="device-channel-rows" data-channel-id={channelId}>
    <button
      class="group flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left
        data-[active=true]:bg-bg-hover {zeile.klickbar ? 'hover:bg-bg-hover' : 'cursor-default opacity-70'}"
      data-active={activeDeviceId === d.id}
      aria-disabled={!zeile.klickbar}
      data-gesperrt={!zeile.klickbar}
      onclick={() => {
        if (zeile.klickbar) onSelect(d);
      }}
      draggable={meins}
      ondragstart={(e) => startGeraetZug(e, d.id)}
      ondragend={onDragEnd}
      data-testid={`device-${d.id}`}
      title={zeile.klickbar ? zustandsText(zeile.punkt) : m.device_row_not_granted()}
    >
      <!-- Eckig, nicht rund: das ist der Unterschied, der vor dem Lesen wirkt. -->
      <span
        class="text-text-muted grid size-[18px] shrink-0 place-items-center rounded-[4px]
          border border-current/40"
      >
        <MonitorIcon class="size-3" />
      </span>
      <span class="text-text-base truncate font-mono text-sm nicht-handy:text-xs">{d.name}</span>
      {#if live}
        <!-- Eigener Klickbereich IM Knopf: `stopPropagation`, sonst landete der
             Zuschauer in der Geräteansicht statt im Bild. Als `<span role>` und
             nicht als `<button>`, weil ein Knopf im Knopf ungültiges HTML wäre. -->
        <span
          class="bg-badge-live hover:bg-badge-live-hover ml-auto shrink-0 rounded px-1.5 py-0.5
            text-2xs leading-none font-bold text-white"
          role="button"
          tabindex="0"
          data-testid={`device-live-${d.id}`}
          onclick={(e) => {
            e.stopPropagation();
            onWatch(d);
          }}
          onkeydown={(e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            e.stopPropagation();
            onWatch(d);
          }}>LIVE</span
        >
      {:else}
        <span
          class="ml-auto size-2 shrink-0 rounded-full {punktKlasse(zeile.punkt)}"
          aria-hidden="true"
        ></span>
      {/if}
    </button>
  </div>
{/each}
