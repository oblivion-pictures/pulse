<!--
  DeviceFreigaben — die Freigabeliste eines Standplatz-Geräts („Wer diesen
  Rechner steuern darf").

  **Seit 2026-10-16 die einzige Erlaubnis** (Eigentümer-Entscheid): wecken und
  steuern darf, wen eine nicht abgelaufene Zeile deckt UND wer den
  Standplatz-Kanal sieht; `REMOTE_CONTROL` zählt dafür nicht mehr. Leere
  Liste = niemand, „jeder" = jeder, der den Kanal sehen kann. Vorgeschlagen
  wird nur, wer den Kanal sieht (`kanalSicht.ts`, geladen in
  `freigabeAuswahl.ts` — eine Untergrenze, Instanz-Admins kennt der Client
  nicht); vorhandene Einträge ohne Sicht tragen einen Hinweis.

  **Nur für den Besitzer** — nicht bloss ausgeblendet, sondern gar nicht erst
  im DOM (DevTools sieht ausgeblendetes Markup). Deshalb steht die Bedingung
  beim Aufrufer (`SettingsStandplatzRechner`, `SettingsStandplatzGeraete`),
  nicht hier — dieselbe Form wie bei `DeviceVerwaltung`.

  **Jede Änderung schickt die GANZE Liste** (`freigaben.setzen`, Bau in
  `freigabenBearbeitung.ts`, Stufen in `freigabeDauer.ts`) — sonst entstünde
  ein Zwischenzustand „scharf, aber für niemanden".
-->
<script lang="ts">
  import { errText } from '$lib/utils/errText';
  import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
  import Select from '$lib/components/form/Select.svelte';
  import Switch from '$lib/components/form/Switch.svelte';
  import { freigaben } from '$lib/devices/freigaben.svelte';
  import FieldError from '$lib/components/feedback/FieldError.svelte';
  import { restzeit } from '$lib/devices/restzeit';
  import { restText } from '$lib/devices/restanzeige';
  import { mitNeuem, ohne } from '$lib/devices/freigabenBearbeitung';
  import {
    ablaufAb,
    FREIGABE_DAUERN,
    FREIGABE_DAUER_VORGABE,
    type FreigabeDauer,
  } from '$lib/devices/freigabeDauer';
  import { userCache } from '$lib/stores/users.svelte';
  import { roles } from '$lib/stores/roles.svelte';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { freigabeAuswahlLaden, type FreigabeAuswahl } from '$lib/devices/freigabeAuswahl';
  import { eintragWirkt } from '$lib/devices/kanalSicht';
  import DeviceFreigabeZeilen from './DeviceFreigabeZeilen.svelte';
  import { m } from '$lib/paraglide/messages.js';
  import type { Device, Grant } from '$lib/api/devices';

  /** `eingebettet`: ohne eigenen Rahmen, weil die Karte darum herum schon
   *  einer ist (`SettingsStandplatzRechner`). In der Geräteansicht steht die
   *  Liste für sich und trägt den Rahmen selbst. */
  let { device, eingebettet = false }: { device: Device; eingebettet?: boolean } = $props();

  // An den Kennungen, nicht am Objekt: jede Zustandsmeldung (`device_state`)
  // legt ein neues `device` an, und jeder Lauf hier kostet Server-Abrufe.
  const guildId = $derived(device.guild_id);
  const deviceId = $derived(device.id);
  const channelId = $derived(device.channel_id);

  $effect(() => {
    void freigaben.laden(guildId, deviceId);
  });

  const liste = $derived(freigaben.fuer(deviceId));
  const einzelne = $derived(liste.filter((g) => g.subject_type !== 'everyone'));
  const jederGrant = $derived(liste.find((g) => g.subject_type === 'everyone') ?? null);

  $effect(() => {
    for (const g of liste) {
      if (g.subject_type === 'user' && g.subject_id) userCache.queue(g.subject_id);
    }
  });

  // Halbminütlich statt sekündlich — Chromium drosselt Zeitgeber in
  // verdeckten Fenstern, und genau so steht ein Standplatz-Rechner meist da.
  let jetzt = $state(Date.now());
  $effect(() => {
    const t = setInterval(() => (jetzt = Date.now()), 30_000);
    return () => clearInterval(t);
  });

  let auswahl = $state<FreigabeAuswahl>({ mitglieder: [], rollen: [], sicht: null });
  $effect(() => {
    let veraltet = false; // eine späte Antwort für ein anderes Gerät verwerfen
    void freigabeAuswahlLaden(guildId, channelId).then((a) => !veraltet && (auswahl = a));
    void guilds.ensureChannels(guildId);
    return () => (veraltet = true);
  });
  const kanalName = $derived(
    (guilds.channelsByGuild[guildId] ?? []).find((c) => c.id === channelId)?.name ?? '…',
  );

  // Rollen aus der Route; scheiterte sie, bleibt der Rollen-Store als Rückfall.
  const rollenListe = $derived(
    auswahl.rollen.length > 0
      ? auswahl.rollen
      : (roles.byGuild[guildId] ?? []).filter((r) => !r.is_everyone),
  );
  const vergeben = $derived(new Set(einzelne.map((g) => `${g.subject_type}:${g.subject_id}`)));
  const wirkt = (g: Pick<Grant, 'subject_type' | 'subject_id'>): boolean =>
    eintragWirkt(auswahl.sicht, g);
  const unwirksam = $derived(einzelne.some((g) => !wirkt(g)));

  // Ein Feld für beides: Nutzer zuerst, dann Rollen mit Zusatz. Der Wert trägt
  // die Art als Präfix, damit `hinzufuegen` sie nicht raten muss. Nur wer den
  // Kanal sieht — ein Eintrag ohne Sicht wirkte nicht.
  const kandidaten = $derived([
    ...auswahl.mitglieder
      .filter((id) => !vergeben.has(`user:${id}`) && wirkt({ subject_type: 'user', subject_id: id }))
      .map((id) => ({ value: `user:${id}`, label: userCache.displayName(id) })),
    ...rollenListe
      .filter((r) => !vergeben.has(`role:${r.id}`) && wirkt({ subject_type: 'role', subject_id: r.id }))
      .map((r) => ({ value: `role:${r.id}`, label: `${r.name} · ${m.device_grants_role_suffix()}` })),
  ]);

  const dauerOptionen = FREIGABE_DAUERN.map((d) => ({ value: d, label: dauerText(d) }));
  function dauerText(d: FreigabeDauer): string {
    if (d === '1h') return m.device_grants_dauer_1h();
    if (d === '8h') return m.device_grants_dauer_8h();
    if (d === '1d') return m.device_grants_dauer_1d();
    if (d === '1w') return m.device_grants_dauer_1w();
    return m.standplatz_settings_duration_permanent();
  }

  let dauer = $state<FreigabeDauer>(FREIGABE_DAUER_VORGABE);
  let fehler = $state<string | null>(null);

  async function speichern(naechste: ReturnType<typeof mitNeuem>): Promise<void> {
    fehler = null;
    try {
      await freigaben.setzen(guildId, deviceId, naechste);
    } catch (e) {
      fehler = errText(e);
    }
  }

  function hinzufuegen(wert: string): void {
    const [art, id] = wert.split(':', 2);
    if ((art !== 'user' && art !== 'role') || !id) return;
    void speichern(
      mitNeuem(liste, { subject_type: art, subject_id: id, expires_at: ablaufAb(dauer, Date.now()) }),
    );
  }

  function jederSetzen(an: boolean): void {
    if (an) {
      void speichern(
        mitNeuem(liste, { subject_type: 'everyone', subject_id: null, expires_at: ablaufAb(dauer, Date.now()) }),
      );
    } else if (jederGrant) {
      void speichern(ohne(liste, jederGrant.id));
    }
  }

  /** Dauer gewählt — wirkt SOFORT auf eine laufende Jeder-Freigabe, nicht
   *  erst bei der nächsten (Remote-UI-Runde 2026-09-09: die Anzeige „noch
   *  x Std." blieb sonst stehen, obwohl man „1 Tag" gewählt hatte). */
  function dauerSetzen(wert: FreigabeDauer): void {
    dauer = wert;
    if (jederGrant) {
      void speichern(
        mitNeuem(liste, {
          subject_type: 'everyone',
          subject_id: null,
          expires_at: ablaufAb(wert, Date.now()),
        }),
      );
    }
  }

  function entfernen(grant: Grant): void {
    void speichern(ohne(liste, grant.id));
  }

  function zeilenName(g: Grant): string {
    if (g.subject_type === 'role') {
      return rollenListe.find((r) => r.id === g.subject_id)?.name ?? (g.subject_id ?? '');
    }
    return g.subject_id ? userCache.displayName(g.subject_id) : '';
  }

  function geltungText(g: Grant): string {
    const rest = restzeit(g.expires_at, jetzt);
    if (rest === null) return m.standplatz_settings_duration_permanent();
    if (rest === 'abgelaufen') return m.device_grants_expired();
    return restText(rest);
  }
</script>

<div
  class={eingebettet
    ? 'flex flex-col gap-3'
    : 'border-border flex w-full max-w-sm flex-col gap-3 rounded-2xl border p-4 text-left'}
  data-testid="device-grants"
>
  <span class="text-text-bright text-sm font-medium">{m.device_grants_title()}</span>

  {#if liste.length === 0}
    <p class="text-text-muted text-xs" data-testid="device-grants-empty">{m.device_grants_empty()}</p>
  {:else if einzelne.length > 0}
    <DeviceFreigabeZeilen
      eintraege={einzelne}
      name={zeilenName}
      geltung={geltungText}
      {wirkt}
      onEntfernen={entfernen}
    />
    {#if unwirksam}
      <p class="flex items-start gap-1.5 text-xs text-amber-500" data-testid="device-grants-unwirksam">
        <TriangleAlertIcon class="mt-0.5 size-3.5 shrink-0" />
        {m.device_grants_wirkt_nicht()}
      </p>
    {/if}
  {/if}

  <div class="flex items-center gap-2">
    <Select
      class="min-w-0 flex-1"
      value=""
      options={kandidaten}
      placeholder={m.device_grants_add_placeholder()}
      onchange={hinzufuegen}
      disabled={kandidaten.length === 0}
      data-testid="device-grant-add"
    />
    <Select
      class="w-auto shrink-0"
      value={dauer}
      options={dauerOptionen}
      onchange={(v) => dauerSetzen(v as FreigabeDauer)}
      data-testid="device-grant-dauer"
    />
  </div>

  <div class="flex items-center justify-between gap-3 pt-1">
    <div class="flex min-w-0 flex-col">
      <span class="text-text-bright text-sm">{m.device_grants_everyone_label({ kanal: kanalName })}</span>
      <span class="text-text-muted text-xs">
        {m.device_grants_everyone_hint()}{jederGrant ? ` · ${geltungText(jederGrant)}` : ''}
      </span>
    </div>
    <Switch
      checked={jederGrant !== null}
      onCheckedChange={jederSetzen}
      aria-label={m.device_grants_everyone_label({ kanal: kanalName })}
      data-testid="device-grant-everyone"
    />
  </div>

  <FieldError message={fehler === null ? null : m.device_manage_error({ error: fehler })} testId="device-grants-error" />
</div>
