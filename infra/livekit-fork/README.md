# Pulse-Fork von LiveKit

LiveKit **1.13.3 + ein Pulse-Patch**, aus dem Quelltext gebaut. Fassung,
Commits und Patch-Stand stehen allein in [`quelle.env`](quelle.env); gebaut
wird mit [`bauen.sh`](bauen.sh) — von beiden Stellen, die LiveKit ausliefern:

| Wo | Wie |
|---|---|
| Self-Host-Image (`infra/self-host/Dockerfile`, Stufe `livekit-build`) | `bauen.sh --os linux --arch $TARGETARCH`, amd64 und arm64 nativ je Läufer (`allinone.yml`) |
| Windows-Server-App (`desktop/scripts/fetch-win-native.ps1 -LivekitSource`) | `bauen.sh --os windows --arch amd64` in Git Bash (`win-build-server.yml`) |

Die macOS-Server-App bündelt kein eigenes LiveKit: sie startet das
Self-Host-Image in der Podman-VM und bekommt den Fork damit von selbst.

## Warum

Der Heimserver der Server-App kündigt LiveKit seit dem 2026-10-08 die
öffentliche IPv4 als feste `node_ip` an (statt STUN — sonst schaltet LiveKit
Firefox auf „nur öffentliche Adresse" um). Im `node_ip`-Weg ersetzt LiveKit
aber **jede** lokale Adresse durch diese eine:
`mediatransportutil/pkg/rtcconfig/webrtc_config.go` setzt eine
Catch-all-Regel, und `advertise_internal_ip` wirkt dort nicht (nur im
STUN-Weg). Jedes Gerät im Heimnetz — auch der Rechner, auf dem der Server
läuft — musste damit über die öffentliche Adresse zurück ins eigene Netz. Die
Fritz!Box kann kein Hairpin-NAT: „could not establish pc connection" (live
gemessen am 2026-10-12).

Über die Konfiguration allein geht „LAN + öffentlich" nicht: `node_ip` nimmt
genau eine IPv4 (`NodeIP{V4,V6}`). Pion (ice v4.2.7,
`external_ip_mapper.go`) kann einer lokalen Adresse mehrere externe zuordnen —
LiveKit reicht nur keine zweite durch.

## Was der Patch tut

[`patches/0001-extra-node-ips.patch`](patches/0001-extra-node-ips.patch), gegen
`github.com/livekit/mediatransportutil` (nicht gegen LiveKit selbst — LiveKit
wird per `go mod edit -replace` gegen den gepatchten Stand gebaut):

- neue Option `rtc.extra_node_ips` (Liste von IP-Adressen);
- im `node_ip`-Weg (`use_external_ip: false`) werden sie an die
  Catch-all-Regel angehängt — LiveKit kündigt dann je lokalem Socket `node_ip`
  **und** jede Zusatzadresse als Host-Kandidaten an;
- `node_ip` bleibt die primäre Adresse (Routing, TURN); ungültige Einträge
  werden mit Warnung übergangen, doppelte zusammengelegt;
- Go-Test, der echte ICE-Kandidaten einer PeerConnection sammelt. Gegenprobe
  am 2026-10-12: mit zurückgedrehtem Aufruf meldet er 22 Kandidaten, alle mit
  `node_ip`, keinen mit der Zusatzadresse — rot.

**Ohne `extra_node_ips` ändert sich nichts.** Im STUN-Weg
(`use_external_ip: true`, alle VPS-Self-Hosts — Installer und Compose setzen
keine feste Adresse) wird der neue Code gar nicht erreicht, und im
`node_ip`-Weg ohne die Option bekommt die Regel wie bisher genau `node_ip`.

Benutzt wird die Option an zwei Stellen: `infra/self-host/livekit-node-ip.sh`
(Container) und `desktop/electron/localBackend/nativeBackend/configs.ts`
(Windows, nativ). Die LAN-Adresse wählt
`desktop/electron/localBackend/hostNetz.ts::standardLanIpv4`.

## Wer `extra_node_ips` schreiben darf

Das offizielle `livekit-server` liest seine Konfiguration im strengen Modus
(`decoder.KnownFields(true)`, `pkg/config/config.go`; abschaltbar nur per
`--disable-strict-config`) und **startet mit dem Feld nicht**:

```
could not parse config: yaml: unmarshal errors:
  line 10: field extra_node_ips not found in type config.RTCConfig
```

(nachgefahren mit dem offiziellen 1.13.3 am 2026-10-12). Das Feld schreibt
deshalb nur, wer nachweislich neben dem Fork-Binary sitzt:

- im Container das Skript `pulse-livekit-node-ip` — es liegt im selben Image
  wie das Binary. Die Server-App schreibt nie selbst in den Container; ein
  älteres Image ohne LAN-Teil erkennt sie daran, dass es `--zeige-lan` als
  ungültige IPv4 abweist (Exit 2), und gleicht dann nur die öffentliche
  Adresse ab;
- nativ unter Windows die Server-App, aber nur, wenn neben
  `livekit-server.exe` der Stempel `livekit-server.exe.fork` liegt
  (`nativeBackend/livekitIp.ts::livekitKenntExtraNodeIps`).

## Der Stempel

`bauen.sh` legt neben jedes Binary `<binary>.fork` mit
`<LIVEKIT_VERSION>-pulse<PULSE_REVISION> livekit=<commit> mediatransportutil=<commit>`.
`fetch-win-native.ps1` vergleicht ihn mit `quelle.env` und baut neu, wenn er
fehlt oder abweicht — sonst bliebe eine zwischengespeicherte
`resources-native/` beim alten Stand (oder beim offiziellen Binary aus der Zeit
vor dem Fork). `PULSE_REVISION` **hochzählen, sobald sich der Patch-Satz
ändert**; das Binary selbst meldet weiter `livekit-server version 1.13.3`.

## Lokal bauen

```sh
bash infra/livekit-fork/bauen.sh --aus /tmp/lk/livekit-server            # Plattform des Rechners
bash infra/livekit-fork/bauen.sh --aus /tmp/lk/livekit-server.exe --os windows --arch amd64
/tmp/lk/livekit-server --version
```

Braucht `git` und Go ≥ 1.26 (LiveKits `go.mod`). Das Image baut mit
`golang:1.26.8-bookworm` (per Digest gepinnt), `win-build-server.yml` mit
`actions/setup-go` auf `1.26.8` — beim Heben beide Stellen mitziehen.

## Bei einem LiveKit-Update nachziehen

1. Neuen Tag nachschlagen und den Commit festhalten:
   `git ls-remote https://github.com/livekit/livekit.git refs/tags/v<neu>`.
2. In dessen `go.mod` den `mediatransportutil`-Stand ablesen
   (`v0.0.0-<datum>-<12 Zeichen>`) und den vollen Commit dazu suchen.
3. `quelle.env`: `LIVEKIT_VERSION`, `LIVEKIT_COMMIT`, `MTU_COMMIT` setzen,
   `PULSE_REVISION` zurück auf `1`.
4. `bauen.sh` einmal lokal fahren. Es bricht ab, wenn LiveKits `go.mod` einen
   anderen `mediatransportutil`-Stand nennt als `MTU_COMMIT`, wenn
   `version/version.go` nicht zur Fassung passt, wenn der Patch nicht sauber
   anwendbar ist oder sein Test rot wird. Passt der Patch nicht mehr: gegen
   den neuen Stand neu schneiden (die Änderung ist ein Feld, eine
   Hilfsfunktion und ein geänderter Aufruf).
5. Prüfen, ob LiveKits `go.mod` eine neuere Go-Fassung verlangt — dann das
   Basisbild im Dockerfile und `go-version` in `win-build-server.yml` heben.
6. Windows-Server-App: Version-Bump in `desktop/package.json`, sonst erreicht
   das neue Binary keinen installierten Heimserver (electron-updater
   ignoriert gleiche Versionen).

## Wann der Fork entfallen kann

Sobald LiveKit (bzw. mediatransportutil) selbst mehrere Adressen im
`node_ip`-Weg ankündigen kann. Dann `infra/livekit-fork/` löschen, das
Dockerfile auf den Release-Tarball zurückstellen, `fetch-win-native.ps1` auf
den Release-Download, und den Feldnamen in `livekit-node-ip.sh` und
`nativeBackend/configs.ts` nachziehen. Vorher `git grep -n livekit-fork`.

## Lizenz

LiveKit und mediatransportutil stehen unter Apache-2.0 (Copyright 2023
LiveKit, Inc.). Der Patch ist eine Bearbeitung dieses Quelltexts und steht
selbst unter Apache-2.0 ([`patches/LICENSE`](patches/LICENSE)). Mit dem
veränderten Binary reisen `LICENSE`, `NOTICE` und der Patch
(`bauen.sh --lizenz`; im Image unter `/usr/share/doc/livekit-server/`, in der
Windows-Server-App unter `native/native-bin/livekit-lizenz/`).
Übersicht: `THIRD-PARTY-NOTICES.md`.
