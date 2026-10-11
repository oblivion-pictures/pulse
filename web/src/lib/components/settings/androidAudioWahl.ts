/**
 * Android-Auswahlfelder der Ton-Einstellungen (`SettingsAudioVideo.svelte`):
 * die Ausgabe über die nativen Routen, die Eingabe kuratiert auf verbundene
 * Geräte. Importfrei, damit `pnpm test:unit` die Rechnung direkt prüft
 * (`test/android-audio-wahl.test.ts`).
 */

/** Ein Gerät aus dem nativen Route-Plugin (`platform/audioRoute.ts`). */
export interface RoutenGeraet {
  id: number;
  type: string;
  name: string;
}

/** Der Ausschnitt aus `AudioRouteList`, den die Auswahlfelder lesen. */
export interface RoutenStand {
  current: string;
  currentDeviceId: number;
  devices: RoutenGeraet[];
}

export interface AuswahlOption {
  value: string;
  label: string;
}

const istBt = (d: { type: string }): boolean =>
  d.type.startsWith('BLUETOOTH') || d.type === 'BLE_HEADSET';

/** Optionen: Hörmuschel/Lautsprecher fix + jedes verbundene BT-Gerät. */
export function routenOptionen(
  liste: RoutenStand | null,
  namen: { hoermuschel: string; lautsprecher: string; bt: string }
): AuswahlOption[] {
  if (!liste) return [];
  return [
    { value: 'earpiece', label: namen.hoermuschel },
    { value: 'speaker', label: namen.lautsprecher },
    ...liste.devices.filter(istBt).map((d) => ({
      value: 'device:' + d.id,
      label: d.name && d.name.trim() ? d.name : namen.bt
    }))
  ];
}

/** Der geschlossene Select zeigt das AKTUELLE Ausgabegerät. */
export function routenWert(liste: RoutenStand | null): string {
  if (!liste) return '';
  if (liste.current === 'device') {
    return 'device:' + liste.currentDeviceId;
  }
  return liste.current === 'earpiece' ? 'earpiece' : 'speaker';
}

/** Android, Eingabe kuratiert (Nutzerwunsch 2026-10-04): NUR verbundene
 *  Geräte — das Telefonmikrofon plus das BT-Mikrofon, wenn ein BT-Gerät
 *  verbunden ist. Keine Geister-Einträge von bereits getrennten Geräten. */
export function androidEingaben(
  eingaenge: { deviceId: string; label: string }[],
  routen: RoutenGeraet[],
  telefonName: string
): AuswahlOption[] {
  const verbundeneBtNamen = routen
    .filter(istBt)
    .map((d) => (d.name && d.name.trim() ? d.name.trim().toLowerCase() : ''))
    .filter(Boolean);
  // Chromium labelt BT-Mikrofone generisch („Bluetooth headset") statt mit
  // dem Produktnamen — erkenne sie am Label-Teil „bluetooth" ODER am
  // Produktnamen (manche Versionen tragen ihn doch).
  const btEingaenge = eingaenge.filter(
    (d) =>
      d.label &&
      (d.label.toLowerCase().includes('bluetooth') ||
        verbundeneBtNamen.some((n) => d.label.toLowerCase().includes(n)))
  );
  // Telefonmikrofon = default oder das erste Eingabegerät OHNE BT-Namen.
  const telefon =
    eingaenge.find((d) => d.deviceId === 'default') ??
    eingaenge.find((d) => !btEingaenge.some((b) => b.deviceId === d.deviceId));
  // Anzeige-Name: der hübsche native Produktname (EarFun …), wenn bekannt.
  const hübsch = (label: string): string => {
    const treffer = routen.find(istBt);
    return treffer?.name && treffer.name.trim() ? treffer.name : label;
  };
  const optionen: AuswahlOption[] = [];
  if (telefon) {
    optionen.push({ value: telefon.deviceId, label: telefonName });
  }
  for (const b of btEingaenge) {
    optionen.push({
      value: b.deviceId,
      label: b.label.toLowerCase().includes('bluetooth') ? hübsch(b.label) : b.label
    });
  }
  return optionen;
}

/** Geschlossener Select: das aktuell aktive Eingabegerät — und wenn das
 *  nicht mehr in der kuratierten Liste liegt (BT gerade getrennt), das
 *  Telefonmikrofon als Default. */
export function androidEingabeWert(optionen: AuswahlOption[], gewaehlt: string): string {
  if (optionen.some((o) => o.value === gewaehlt)) {
    return gewaehlt;
  }
  return optionen[0]?.value ?? '';
}
