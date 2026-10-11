/**
 * Welcher Ausgang auf iOS gerade spielt — vom Porttyp der Audio-Session zu
 * dem, was die Ausgabe-Wahl anzeigt (`VoiceAusgabeMenue.svelte`).
 *
 * **Gelesen wird die Session der App, und die ist auf dem nativen Weg
 * LiveKits Session.** `AudioSessionPlugin.routen` liest
 * `AVAudioSession.sharedInstance()`, und der native Raum spielt in genau
 * dieser (eine Session je Prozess). Der native Raum muss für die Anzeige also
 * nichts zusätzlich melden; ein Wechsel kommt über `routeGewechselt` desselben
 * Plugins, dessen Beobachter beim Start der Hülle angelegt wird (`load()`).
 *
 * **Warum die Art und nicht nur „ein Gerät".** Bis zum 2026-10-11 zeigte die
 * Leiste für jeden fremden Ausgang das Bluetooth-Zeichen — auch für einen
 * Kabel-Kopfhörer, einen AirPlay-Lautsprecher oder das Auto —, und im Menü
 * stand das Gerät gar nicht: weder Lautsprecher noch Hörmuschel war markiert,
 * und wohin der Ton ging, sagte nichts. Den Namen (`AirPods Pro`) liefert iOS
 * mit (`portName`), er wurde nur verworfen.
 *
 * Die Porttypen sind die Rohwerte von `AVAudioSession.Port`, im Simulator
 * ausgelesen (iOS 26) — sie sind nicht immer der Name der Konstante:
 * `.bluetoothA2DP` ist `BluetoothA2DPOutput`, `.HDMI` ist `HDMIOutput`. Ein
 * leerer heißt „kein Ausgang bekannt" (mitten in einem Wechsel) und ist kein
 * Gerät.
 *
 * Importfrei, damit Nodes Läufer es prüfen kann (CLAUDE.md, `pnpm test:unit`).
 */

/** Welche Art Gerät ein fremder Ausgang ist — bestimmt das Zeichen. */
export type AusgangArt = 'funk' | 'kabel' | 'airplay' | 'auto' | 'sonst';

export type IosAusgang =
  | { wahl: 'speaker' | 'earpiece' | 'auto' }
  | { wahl: 'device'; art: AusgangArt };

const ARTEN: Record<string, AusgangArt> = {
  BluetoothHFP: 'funk',
  BluetoothA2DPOutput: 'funk',
  BluetoothLE: 'funk',
  Headphones: 'kabel',
  USBAudio: 'kabel',
  LineOut: 'kabel',
  HDMIOutput: 'kabel',
  DisplayPort: 'kabel',
  AirPlay: 'airplay',
  CarAudio: 'auto'
};

export function iosAusgang(porttyp: string): IosAusgang {
  if (porttyp === 'Speaker') return { wahl: 'speaker' };
  if (porttyp === 'Receiver') return { wahl: 'earpiece' };
  if (porttyp === '') return { wahl: 'auto' };
  return { wahl: 'device', art: ARTEN[porttyp] ?? 'sonst' };
}
