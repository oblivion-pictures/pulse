# Drittanbieter-Software

> **Hinweis:** Diese Seite listet die Drittanbieter-Bibliotheken, die in den
> Pulse-Anwendungen (Desktop unter Windows/macOS/Linux, die iOS-App und die
> Android-App) gebündelt oder eingebunden werden, sowie die damit verbundenen
> Lizenzpflichten.
> Keine Rechtsberatung. Pulse selbst steht unter der
> [GNU AGPL v3.0](https://github.com/oblivion-pictures/pulse/blob/main/LICENSE)
> (AGPL-3.0-only); der vollständige Lizenztext liegt als `LICENSE` im
> Quellcode-Repository.

Pulse selbst ist unter der **GNU Affero General Public License v3.0**
(AGPL-3.0-only) lizenziert — nutzen, ändern und weitergeben ist unter den
Lizenzbedingungen erlaubt. Einige seiner Bestandteile für das
HQ-Bildschirm-Streaming stammen jedoch von Drittanbietern und bringen eigene
Lizenzbedingungen mit. Für **LGPL-lizenzierte Komponenten** (FFmpeg) erfüllen
wir die Lizenzpflichten wie folgt:

- Die Komponente wird **dynamisch verlinkt** (als eigene DLL/Dylib/Shared-Object
  neben der Pulse-Anwendung), nicht statisch in Pulse einkompiliert.
- Die Datei ist **austauschbar**: Wer eine eigene, kompatible Version der
  Bibliothek bauen möchte, kann die ausgelieferte Datei ersetzen.
- Der **Quellcode** der jeweils verwendeten Version ist über die unten
  verlinkten öffentlichen Quellen erhältlich. Wo Pulse ihn **ändert**, ist das
  in der jeweiligen Tabelle vermerkt, und die Änderung selbst liegt als
  Patch-Datei im öffentlichen Quellcode-Repository. **Das FFmpeg wird auf allen
  drei Plattformen unverändert gebaut** — bis zum 21. August 2026 trugen die
  Linux- und die Windows-Fassung je einen Pulse-Patch, der ist entfallen.

## Windows

| Komponente | Version / Pin | Lizenz | Einbindung |
|---|---|---|---|
| [FFmpeg](https://ffmpeg.org/) | n8.1, unverändertes LGPL-shared-Fertigpaket (BtbN-Build vom 2026-06-16, eingefroren) | LGPL 2.1 (Build ohne `--enable-gpl`/`--enable-nonfree`/libx264/libx265) | Dynamisch verlinkt: als separate `.dll`-Dateien neben `pulse-win-hq-sidecar.exe` ausgeliefert |
| [nv-codec-headers](https://github.com/FFmpeg/nv-codec-headers) | n13.0.19.0 | MIT | Nur zur Build-Zeit für NVENC-Unterstützung verwendet, nicht als eigene Datei ausgeliefert |

**Das FFmpeg der Windows-Fassung ist unverändert.** Vom 5. bis zum 21. August
2026 war das anders: Pulse baute für diesen Pfad ein eigenes FFmpeg mit einem
Patch, der dem AV1-Encoder für AMD-Karten den rollenden Intra-Refresh freigab.
Diese Betriebsart ist entfallen, der Patch damit auch — ausgeliefert wird
wieder das unveränderte LGPL-shared-Fertigpaket. Die Bibliotheken bleiben
dynamisch eingebunden und austauschbar.

Die FFmpeg-DLLs enthalten u. a. NVENC/AMF/QSV-Hardware-Encoder, Muxer für
FLV/MPEGTS/WHIP und die TLS-Anbindung über SChannel für den verschlüsselten
RTMPS-Push. Neben ihnen liefert dieser Build die Bibliotheken mit, gegen die er
gebaut ist — jede als eigene, austauschbare Datei:

| Bibliothek | Lizenz |
|---|---|
| [libopus](https://opus-codec.org/) (Audio) | BSD-3-Clause |
| [dav1d](https://code.videolan.org/videolan/dav1d) (AV1-Dekodierung) | BSD-2-Clause |
| [SRT](https://github.com/Haivision/srt) | MPL-2.0 |
| [OpenSSL 3](https://www.openssl.org/) | Apache-2.0 |
| [Intel VPL](https://github.com/intel/libvpl) | MIT |
| GNU libiconv | LGPL-2.1 |
| zlib, xz/liblzma, bzip2, winpthreads | Zlib, 0BSD, BSD, MIT |
| GCC-Laufzeit (`libgcc`, `libstdc++`) | GPL-3.0 **mit GCC Runtime Library Exception** — diese Ausnahme erlaubt das Mitliefern ausdrücklich auch neben Programmen unter anderer Lizenz |

## macOS

| Komponente | Version / Pin | Lizenz | Einbindung |
|---|---|---|---|
| [FFmpeg](https://ffmpeg.org/releases/ffmpeg-8.0.1.tar.xz) | 8.0.1, eigener Build | LGPL (Build ohne `--enable-gpl`/libx264/libx265) | Dynamisch verlinkt: als `.dylib`-Dateien neben der App gebündelt |
| [dav1d](https://code.videolan.org/videolan/dav1d) (AV1-Dekodierung) | seit 2026-08-20 | BSD-2-Clause | Dynamisch verlinkt, dieselbe `.dylib`-Auslieferung wie oben |

Für macOS wird FFmpeg aus dem unveränderten offiziellen Quell-Tarball selbst
gebaut (statt Homebrews Standard-Build zu verwenden, der GPL-lizenziert wäre),
mit VideoToolbox-Hardware-Encoding, OpenSSL für TLS/RTMPS und
[libopus](https://opus-codec.org/) (BSD-3-Clause) für Audio. Der Quellcode ist
unverändert und über den obigen Link direkt vom FFmpeg-Projekt erhältlich. Seit
dem 2026-08-20 bindet dieser Build zusätzlich [dav1d](https://code.videolan.org/videolan/dav1d)
(BSD-2-Clause) ein: FFmpegs eigener `av1`-Decoder ist ein reiner
Hardware-Stub, und VideoToolbox kann AV1 erst ab der M3-Generation dekodieren
— ohne dav1d könnte der native HQ-Player auf M1/M2-Macs gar kein AV1
anzeigen. dav1d berührt die LGPL-Aufstellung oben nicht, es ist eine eigene
BSD-2-Clause-Datei, dynamisch eingebunden wie die übrigen.

Der native HQ-Player (`streaming/pulse-player/`, siehe unten) linkt seit
Version 0.1.69 gegen dieselben `.dylib`-Dateien wie der Streaming-Sidecar —
`scripts/bundle-dylibs.sh` baut für beide Programme ein gemeinsames Bündel.

## Linux (Flatpak)

| Komponente | Version / Pin | Lizenz | Einbindung |
|---|---|---|---|
| [Electron](https://www.electronjs.org/) | 43.0.0 | MIT | Offizielles Release-Binary, unverändert gebündelt (`/app/electron/`) |
| [FFmpeg](https://github.com/FFmpeg/FFmpeg) | Tag `n8.1.1`, unverändert | LGPLv3 (Build ohne `--enable-gpl`/libx264/libx265) | Aus Quellcode im Flatpak-Sandbox gebaut, dynamisch verlinkt |

**Das FFmpeg der Linux-Fassung wird aus unverändertem Quellcode gebaut.** Vom
5. bis zum 21. August 2026 war das anders: angewendet wurde ein Patch, der den
rollenden Intra-Refresh der VAAPI-Encoder freilegte. Diese Betriebsart ist
entfallen, der Patch damit auch. Die Bibliothek bleibt dynamisch eingebunden
und austauschbar.

Electrons eigene Drittanbieter-Hinweise (Chromium, Node.js u. a.) liegen
bereits als Teil des offiziellen Electron-Release-Archivs bei und werden hier
nicht dupliziert.

**Seit dem 27. August 2026 enthält die Linux-Fassung kein
`gpu-screen-recorder` mehr.** Bis dahin wurde es zur Build-Zeit aus dem
Quellcode gebaut und als eigenständiges Programm mitgeliefert — nicht mit
Pulse verlinkt —, zusammen mit drei Pulse-Patches gegen seinen Quellcode, die
als Bearbeitung eines GPL-3.0-or-later-Werks selbst unter dieser Lizenz
standen. Es bediente den älteren Weg, den Bildschirm aufzunehmen; dieser Weg
ist durch eine eigene Umsetzung ersetzt worden. Damit liegt in Pulse keine
Komponente mehr unter der GPL.

## Nativer HQ-Player (Desktop, optional)

Die Desktop-App kann HQ-Streams in einem eigenen Fenster darstellen statt im
eingebauten Browser-Player — unter Linux (Flatpak), seit Version 0.1.42 auch
unter Windows, und seit Version 0.1.69 auch unter macOS. Ist die Komponente
nicht vorhanden, läuft die Wiedergabe
unverändert im eingebauten Player weiter. Sie bindet die folgenden Bibliotheken
**statisch** ein; sie sind hier aufgeführt, weil auch freizügige Lizenzen eine
Nennung verlangen.

| Komponente | Version | Lizenz |
|---|---|---|
| [webrtc-rs](https://github.com/webrtc-rs/webrtc) (**von Pulse geändert**, siehe unten) | 0.17.2 | MIT oder Apache-2.0 |
| [wgpu](https://github.com/gfx-rs/wgpu) | 30.0.0 | MIT oder Apache-2.0 |
| [winit](https://github.com/rust-windowing/winit) | 0.30.13 | Apache-2.0 |
| [egui](https://github.com/emilk/egui) (mit `egui-wgpu`, `egui-winit`, `egui_extras`) | 0.36.1 | MIT oder Apache-2.0 |
| [resvg](https://github.com/linebender/resvg) / usvg (Symbol-Zeichner) | 0.45.1 | Apache-2.0 oder MIT |
| [tiny-skia](https://github.com/linebender/tiny-skia) | 0.11.4 | BSD-3-Clause |
| [cpal](https://github.com/RustAudio/cpal) | 0.17.3 | Apache-2.0 |
| [pipewire-rs](https://gitlab.freedesktop.org/pipewire/pipewire-rs) (`pipewire`, `libspa`; nur Linux, Tonausgabe) | 0.10.1 | MIT |
| [ffmpeg-next](https://github.com/zmwangx/rust-ffmpeg) (nur Anbindung) | 8.1.0 | WTFPL |
| [rustls](https://github.com/rustls/rustls) | 0.23.42 | Apache-2.0, ISC oder MIT |
| [aws-lc-rs](https://github.com/aws/aws-lc-rs) | 1.17.3 | ISC, Apache-2.0, MIT, BSD-3-Clause |
| [webpki-root-certs](https://github.com/rustls/webpki-roots) (Wurzelzertifikate) | 1.0.9 | CDLA-Permissive-2.0 |
| [self_cell](https://github.com/Voultapher/self_cell) | 1.3.0 | Apache-2.0 oder GPL-2.0 — Pulse nutzt **Apache-2.0** |
| [ICU4X](https://github.com/unicode-org/icu4x) (`icu_*`, `zerovec`, `tinystr` u. a.) | 2.2.0 | Unicode-3.0 |
| [tokio](https://tokio.rs/) | 1.53.1 | MIT |
| [reqwest](https://github.com/seanmonstar/reqwest) | 0.13.4 | MIT oder Apache-2.0 |

### Eingebettete Schriften und Symbole

Diese liegen fest im Programm, nicht als eigene Dateien daneben — auch dafür
gilt die Nennungspflicht:

| Bestandteil | Herkunft | Lizenz |
|---|---|---|
| Plus Jakarta Sans (Regular, SemiBold) | [tokotype/PlusJakartaSans](https://github.com/tokotype/PlusJakartaSans), Copyright 2020 The Plus Jakarta Sans Project Authors | SIL Open Font License 1.1 |
| Standardschriften von egui (`epaint_default_fonts`, u. a. Ubuntu und Emoji) | [egui](https://github.com/emilk/egui) | SIL Open Font License 1.1 und Ubuntu Font Licence 1.0 |
| Symbole | [Lucide](https://lucide.dev) — Teile stammen aus Feather, Copyright Cole Bemis 2013–2022 (MIT); übrige Copyright Lucide Contributors 2022 | ISC |

### Änderung an webrtc-rs

Pulse verändert drei Stellen der Fassung 0.17.2 und liefert das Ergebnis
statisch eingebunden aus. Betroffen sind `webrtc/src/dtls_transport/mod.rs`
(Lesezugriff auf Datenströme, deren Kennung zu keiner angemeldeten Spur passt —
dort liegen die Pakete zur Verlustkorrektur), der NACK-Generator unter
`interceptor/src/nack/generator/` und der H.264-Depacketizer unter
`rtp/src/codecs/h264/mod.rs` — dort prüft ein Grenzcheck beim Auspacken von
STAP-A-Paketen die Länge, nachdem ein Paket mit überzähligem Byte den
Empfangs-Task abstürzen ließ. Dieser Hinweis erfüllt Apache-2.0 §4(b); die
Patch-Dateien liegen mitsamt eigener Lizenzdatei im öffentlichen
Quellcode-Repository unter
[`streaming/pulse-player/patches/`](https://github.com/oblivion-pictures/pulse/tree/main/streaming/pulse-player/patches).

Für die eigentlichen FFmpeg-Bibliotheken gilt auch hier, was oben steht: Es wird
ein LGPL-Build dynamisch eingebunden und als eigene, austauschbare Datei
ausgeliefert.

## iOS-App

Die iOS-App (eine Capacitor-Hülle) bettet die folgenden nativen Bestandteile
ein oder bindet sie statisch ein; die Web-App selbst lädt sie vom Server, sie
gehört nicht zum App-Paket.

| Komponente | Version | Lizenz | Einbindung |
|---|---|---|---|
| [LiveKit Swift SDK](https://github.com/livekit/client-sdk-swift) | 2.17.0 | Apache-2.0, mit `NOTICE`-Datei (unten) | statisch eingebunden |
| nanopb-Laufzeit, im LiveKit-SDK enthalten | 0.4.9.1 | zlib | statisch eingebunden |
| [WebRTC](https://webrtc.org/), als `LiveKitWebRTC.framework` aus [webrtc-xcframework](https://github.com/livekit/webrtc-xcframework) | 150.7871.2 | WebRTC: BSD-3-Clause (Text unten); die Verpackung als xcframework: MIT | eingebettetes Framework |
| [livekit-uniffi](https://github.com/livekit/livekit-uniffi-xcframework) | 0.1.9 | Apache-2.0 | eingebettetes Framework |
| [Capacitor](https://github.com/ionic-team/capacitor-swift-pm) | 8.5.2 | MIT | eingebettete Frameworks |
| Capacitor-Plugins `@capacitor/app` 8.1.1, `browser` 8.0.5, `camera` 8.2.5, `haptics` 8.0.2, `keyboard` 8.0.6, `status-bar` 8.0.4 | siehe links | MIT | statisch eingebunden |
| [ion-ios-camera](https://github.com/ionic-team/ion-ios-camera) (über `@capacitor/camera`) | 2.0.0 | MIT | eingebettetes Framework |
| `@capawesome/capacitor-badge` | 8.0.3 | MIT | statisch eingebunden |
| `@capacitor-firebase/messaging` | 8.5.2 | Apache-2.0 | statisch eingebunden |
| [Firebase iOS SDK](https://github.com/firebase/firebase-ios-sdk) (Core, Installations, Messaging) | 12.19.2 | Apache-2.0 | statisch eingebunden |
| [GoogleDataTransport](https://github.com/google/GoogleDataTransport) | 10.1.1 | Apache-2.0 | statisch eingebunden |
| [GoogleUtilities](https://github.com/google/GoogleUtilities) | 8.1.4 | Apache-2.0; der Teil `IsAppEncrypted` MIT, Copyright (c) 2017 Landon J. Fuller | statisch eingebunden |
| [Promises](https://github.com/google/promises) | 2.4.1 | Apache-2.0 | statisch eingebunden |
| [nanopb](https://github.com/firebase/nanopb) (Firebase) | 2.30910.1 | zlib | statisch eingebunden |

**Hinweis aus der `NOTICE`-Datei von LiveKit:** „Copyright 2023 LiveKit, Inc."

**WebRTC** — Lizenztext, wie er dem Framework beiliegt:

    Copyright (c) 2011, The WebRTC project authors. All rights reserved.

    Redistribution and use in source and binary forms, with or without
    modification, are permitted provided that the following conditions are
    met:

      * Redistributions of source code must retain the above copyright
        notice, this list of conditions and the following disclaimer.

      * Redistributions in binary form must reproduce the above copyright
        notice, this list of conditions and the following disclaimer in
        the documentation and/or other materials provided with the
        distribution.

      * Neither the name of Google nor the names of its contributors may
        be used to endorse or promote products derived from this software
        without specific prior written permission.

    THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
    "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
    LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
    A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
    HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
    SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
    LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
    DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
    THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
    (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
    OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

### Im WebRTC-Framework eingebaute Bibliotheken

Das WebRTC-Framework der iOS-App enthält weitere Bibliotheken, die fest in sein
Programm einkompiliert sind. Dem Framework liegt außer dem WebRTC-Lizenztext
oben keine Aufstellung dazu bei. Die folgende Liste ist deshalb aus dem
Programm des Frameworks selbst abgelesen und eine Untergrenze, keine
vollständige Aufzählung.

| Bibliothek | Lizenz |
|---|---|
| [BoringSSL](https://boringssl.googlesource.com/boringssl) (Verschlüsselung) | Apache-2.0 |
| [Opus](https://opus-codec.org/) (Audio) | BSD-3-Clause; dazu gebührenfreie Patentlizenzen, im Lizenztext genannt |
| [libvpx](https://chromium.googlesource.com/webm/libvpx) (VP8/VP9-Video), Version 1.16.0 | BSD-3-Clause; dazu eine Patent-Zusage (WebM Project) |
| [libaom](https://aomedia.googlesource.com/aom/) (AV1-Kodierung) | BSD-2-Clause; dazu die Alliance-for-Open-Media-Patentlizenz 1.0 |
| [dav1d](https://code.videolan.org/videolan/dav1d) (AV1-Dekodierung) | BSD-2-Clause |
| [libyuv](https://chromium.googlesource.com/libyuv/libyuv/) (Umrechnung von Bildformaten) | BSD-3-Clause |
| [libsrtp](https://github.com/cisco/libsrtp) (verschlüsselte Medienübertragung) | BSD-3-Clause |
| [Abseil](https://github.com/abseil/abseil-cpp) | Apache-2.0 |
| libc++abi (LLVM-Laufzeit) | Apache-2.0 mit LLVM-Ausnahmen |

Die Lizenzangaben stammen aus der Lizenzliste von Chromium 150 (Electron 43),
derselben Versionslinie wie das Framework; sie benennen die Lizenzen der
jeweiligen Projekte, nicht die der Quellen im iOS-Programm selbst. Die
Lizenztexte der BSD-lizenzierten Bibliotheken stehen in der Datei
[`THIRD-PARTY-NOTICES.md`](https://github.com/oblivion8282-1337/pulse/blob/main/THIRD-PARTY-NOTICES.md)
im öffentlichen Quellcode-Repository; die Apache-2.0-Texte werden dort wie bei
den übrigen Apache-Komponenten nicht wiederholt.

### Rust-Bibliotheken in livekit-uniffi

livekit-uniffi (Apache-2.0) ist in Rust geschrieben und enthält seinerseits
Rust-Bibliotheken. Dem Paket liegt keine Lizenzliste dazu bei, und eine eigene
Aufstellung steht noch aus; sie ist deshalb hier nicht enthalten.

## Android-App

Die Android-App ist wie die iOS-App eine Capacitor-Hülle; die Web-App selbst
lädt sie vom Server, sie gehört nicht zum App-Paket. Der eigene native Code der
Hülle steht unter der AGPL. Eingebunden sind:

| Komponente | Version | Lizenz |
|---|---|---|
| [Capacitor](https://github.com/ionic-team/capacitor) (Android) | 8.4.0 | MIT |
| Capacitor-Plugins `@capacitor/app` 8.1.1 und `camera` 8.2.5 | siehe links | MIT |
| `@capacitor-firebase/messaging` | 8.5.2 | Apache-2.0 |

Weitere Capacitor-Plugins (`@capacitor/browser` 8.0.5, `haptics` 8.0.2,
`keyboard` 8.0.6, `status-bar` 8.0.4 und `@capawesome/capacitor-badge` 8.0.3,
alle MIT) sind im Projekt vorgesehen, aber in der Android-Konfiguration noch
nicht eingetragen.

Die Android-Bibliotheken aus dem Maven-Katalog, die diese Bestandteile
mitbringen, sind noch nicht auf ihre Lizenzen geprüft; ihre Aufstellung steht
aus. Es sind, einschließlich der noch nicht eingetragenen Plugins: AndroidX
(AppCompat, CoordinatorLayout, Core, Core-SplashScreen, Activity, Fragment,
WebKit, ExifInterface, Browser), Material Components, Gson, Apache Cordova,
Firebase Cloud Messaging für Android, die Ionic-Kamerabibliothek
`ioncamera-android` und ShortcutBadger — dazu deren weitere Abhängigkeiten.

## Web-Krypto-Kern (WASM)

Die Ende-zu-Ende-verschlüsselten Direktnachrichten kapseln
[vodozemac](https://github.com/matrix-org/vodozemac) (die Olm/Megolm-Umsetzung
in Rust, aus dem Matrix-Projekt) und werden als WebAssembly in den Browser
eingebettet — Teil des Web-Bundles, gebaut aus `krypto/pulse-krypto/`.

| Komponente | Version | Lizenz |
|---|---|---|
| [vodozemac](https://github.com/matrix-org/vodozemac) | 0.10.0 | Apache-2.0 |
| [wasm-bindgen](https://github.com/rustwasm/wasm-bindgen) | 0.2.127 | MIT oder Apache-2.0 |
| [getrandom](https://github.com/rust-random/getrandom) (0.2 und 0.3) | 0.2.17 / 0.3.4 | MIT oder Apache-2.0 |

## Pulse Server (Heimserver-App) und Self-Host-Server

Sprachkanäle laufen über einen [LiveKit](https://github.com/livekit/livekit)-Server.
Die Windows-Fassung der Pulse-Server-App liefert ihn als eigenes Programm mit
(`livekit-server.exe`); die macOS-Fassung und jeder selbst betriebene Server
bekommen ihn im Server-Container.

| Komponente | Version | Lizenz |
|---|---|---|
| [LiveKit Server](https://github.com/livekit/livekit) (**von Pulse geändert**, siehe unten) | 1.13.3 | Apache-2.0 |
| [mediatransportutil](https://github.com/livekit/mediatransportutil) (Teil davon, **von Pulse geändert**) | Stand `a3417d38cda0` | Apache-2.0 |

Copyright 2023 LiveKit, Inc. Lizenztext, Hinweisdatei (NOTICE) und die
Änderung liegen der ausgelieferten Datei bei.

### Änderung an LiveKit

Pulse baut LiveKit aus dem Quellcode und ändert dabei drei Dateien von
mediatransportutil (`pkg/rtcconfig/config.go`, `webrtc_config.go` und den
zugehörigen Test): eine neue Einstellung `extra_node_ips` kündigt weitere
Adressen neben der Hauptadresse an. Damit erreichen Geräte im eigenen Heimnetz
einen Heimserver über seine LAN-Adresse, während Gäste aus dem Internet die
öffentliche nutzen. Ohne diese Einstellung verhält sich der Server wie das
offizielle LiveKit. Dieser Hinweis erfüllt Apache-2.0 §4(b); die Patch-Datei
liegt mitsamt eigener Lizenzdatei im öffentlichen Quellcode-Repository unter
[`infra/livekit-fork/patches/`](https://github.com/oblivion-pictures/pulse/tree/main/infra/livekit-fork/patches).

## Startseite (howispulse.com)

Die Startseite der Cloud-Instanz liefert ihre beiden Schriften vom eigenen
Server aus, damit kein Browser eines Besuchers Google Fonts kontaktiert.

| Bestandteil | Herkunft | Lizenz |
|---|---|---|
| Plus Jakarta Sans (variabel) | [tokotype/PlusJakartaSans](https://github.com/tokotype/PlusJakartaSans), Copyright 2020 The Plus Jakarta Sans Project Authors | SIL Open Font License 1.1 |
| JetBrains Mono (variabel) | [JetBrains/JetBrainsMono](https://github.com/JetBrains/JetBrainsMono), Copyright 2020 The JetBrains Mono Project Authors | SIL Open Font License 1.1 |

---

Stand: 13. Oktober 2026 (LiveKit, von Pulse geändert; iOS-App, WebRTC-Bibliotheken und Android-App ergänzt)
