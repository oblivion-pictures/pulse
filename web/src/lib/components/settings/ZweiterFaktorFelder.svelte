<!--
  Eingabe des zweiten Faktors: sechsstelliger TOTP-Code ODER ein Backup-Code,
  umschaltbar. Werte über `bind:`, die Prüfung macht der Aufrufer beim Absenden
  (`stripTotpFormatting`/`normalizeBackupCode`). Markup und Texte wie im
  TOTP-Abschalten-Dialog; genutzt vom Passkey-Anlegen, seit der Server dort bei
  TOTP-Konten den zweiten Faktor verlangt (Security-Scan 2026-11-04).
-->
<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import FieldLabel from '$lib/components/form/FieldLabel.svelte';
  import { m } from '$lib/paraglide/messages.js';

  type Props = {
    code?: string;
    backupCode?: string;
    useBackup?: boolean;
    idPrefix: string;
  };
  let {
    code = $bindable(''),
    backupCode = $bindable(''),
    useBackup = $bindable(false),
    idPrefix
  }: Props = $props();
</script>

{#if useBackup}
  <div class="space-y-1.5">
    <FieldLabel for="{idPrefix}-backup" required class="text-text-muted text-xs font-semibold uppercase">
      {m.totp_disable_dialog_label_backup_code()}
    </FieldLabel>
    <Input
      id="{idPrefix}-backup"
      type="text"
      autocapitalize="characters"
      spellcheck={false}
      bind:value={backupCode}
      required
      data-testid="{idPrefix}-backup"
    />
  </div>
{:else}
  <div class="space-y-1.5">
    <FieldLabel for="{idPrefix}-code" required class="text-text-muted text-xs font-semibold uppercase">
      {m.totp_disable_dialog_label_totp_code()}
    </FieldLabel>
    <Input
      id="{idPrefix}-code"
      type="text"
      inputmode="numeric"
      autocomplete="one-time-code"
      bind:value={code}
      required
      maxlength={7}
      class="text-center font-mono tracking-[0.2em]"
      data-testid="{idPrefix}-code"
    />
  </div>
{/if}
<Button variant="link" size="xs" type="button" onclick={() => (useBackup = !useBackup)}>
  {useBackup ? m.totp_disable_dialog_toggle_use_totp() : m.totp_disable_dialog_toggle_use_backup()}
</Button>
