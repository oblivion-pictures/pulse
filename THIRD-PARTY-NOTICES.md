# Third-Party Notices

Pulse's own code is licensed under the GNU Affero General Public License v3.0
(`LICENSE`, AGPL-3.0-only; from 2026-07-25 to 2026-10-01 it ran under
proprietary source-available licenses instead, and since 2026-10-02 it is back
under the AGPL). The
HQ-screen-streaming path additionally bundles or dynamically links a small
number of third-party open-source components. This file is the developer/
distributor-facing counterpart to the user-facing page at
`web/src/lib/legal/drittanbieter.md` (served at `/drittanbieter`); both list
the same facts, this one adds repo-internal pointers for maintainers.

This is not a full Software Bill of Materials (SBOM) of every transitive Rust
crate — it covers the components that are separately bundled/dynamically
linked or that carry their own copyleft obligations distinct from Pulse's own
license.

A full sweep **has** been run on 2026-08-05 — this paragraph used to say it
had not been. `cargo metadata` over all three shipped Rust trees (native
player, Windows sidecar, Linux sidecar; the 44 crates unique to the Linux tree
were looked up individually on crates.io because that tree does not resolve on
a Windows host), plus `pnpm licenses list --prod` over the pnpm workspace.
Result: **no AGPL, no GPL-only, no MPL-only anywhere.** Since 2026-08-27 the
only copyleft that ships is FFmpeg (LGPL, dynamically linked everywhere).
Until that date the Flatpak also bundled gpu-screen-recorder (GPL-3.0, shipped
as a separate program, never linked against Pulse) for the older Linux capture
path; that path has been removed in favour of the in-tree Rust sidecar, and
with it the last GPL component. Three dual licences resolve to their permissive side and are recorded
where they occur: `self_cell` (`Apache-2.0 OR GPL-2.0-only` → Apache-2.0),
`r-efi` (`MIT OR Apache-2.0 OR LGPL-2.1-or-later` → MIT) and `dompurify`
(`MPL-2.0 OR Apache-2.0` → Apache-2.0). Re-run the sweep when a dependency
tree changes; it is the only way this file stays true.

## Windows (`streaming/win-hq-sidecar/`)

| Component | Version / pin | License | Declared in |
|---|---|---|---|
| FFmpeg — BtbN prebuilt, **unmodified** | frozen self-hosted mirror of BtbN's `n8.1` LGPL-shared build, dated 2026-06-16 | LGPL (that distribution's own licence text is **v3**, shipped as `LICENSE.txt` at the package root) | `scripts/fetch-ffmpeg.ps1` (`$Url`/`$ExpectedSha`, SHA256-pinned), `.cargo/config.toml` (`FFMPEG_DIR`), `Cargo.toml` (`ffmpeg-next` binding), `.github/workflows/win-build.yml` (CI fetch step) |
| pulse-player (native HQ player) | shipped in the Windows installer since app version `0.1.42`, in the macOS DMG since `0.1.69` | Pulse's own code; its third-party tree is listed in its own section below | `desktop/electron-builder.yml` (`win.extraResources` → `resources/hq-sidecar/pulse-player.exe`), `.github/workflows/win-build.yml` (build steps) |
| nv-codec-headers | `n13.0.19.0` (build-time only, not redistributed as a file) | MIT | Referenced alongside the Linux FFmpeg module, `packaging/com.howispulse.Pulse.yml:169-179` |

**Windows ships an unmodified FFmpeg.** From 2026-08-05 to 2026-08-21 it did
not: Pulse built its own `n8.1.2` with one patch that exposed rolling intra
refresh on `av1_amf`. That operating mode has been removed from Pulse, and with
it the patch, the self-build script and the change notice that had to travel
inside the distribution. What ships now is the frozen mirror of BtbN's
LGPL-shared package, byte-identical to what BtbN published.

How the LGPL obligations are met: the DLLs sit next to
`pulse-win-hq-sidecar.exe` as separate, exchangeable files (dynamic linking);
the source is the unmodified upstream release; and the package's own
`LICENSE.txt` is shipped into `resources/hq-sidecar/FFMPEG-LICENSE.txt` by
`desktop/electron-builder.yml`. Until 2026-08-05 the installer carried only
Electron's and Chromium's licence texts, although seven LGPL DLLs shipped
beside them — that gap is closed and stays closed.

### The libraries that ship next to the sidecar

BtbN's package carries eight files: the seven `av*`/`sw*` libraries plus its
own licence text. Nothing else is bundled — unlike a self-built MinGW tree,
which drags its whole runtime along.

| File | Component | License |
|---|---|---|
| `avcodec-62`, `avformat-62`, `avfilter-11`, `avutil-60`, `swresample-6`, `swscale-9`, `avdevice-62` | FFmpeg (unmodified) | LGPL |

Whoever swaps the FFmpeg package changes this table: re-read
`ffmpeg-dist/n8.1-lgpl-shared/bin/*.dll` afterwards rather than assuming the
set is stable. A self-built tree in particular pulls in a dozen further DLLs
(GCC runtime, libsrt, OpenSSL, dav1d …), each with a licence that asks to be
named.

## macOS (`streaming/mac-hq-sidecar/`)

| Component | Version / pin | License | Declared in |
|---|---|---|---|
| FFmpeg (self-built) | `8.0.1` (`FFMPEG_VERSION` default) | LGPL (no `--enable-gpl`/libx264/libx265) | `streaming/mac-hq-sidecar/scripts/build-ffmpeg.sh:9-42`, `Cargo.toml:46-53`, `.cargo/config.toml`, `.github/workflows/mac-build.yml:14-22,58-81` |
| dav1d | since 2026-08-20 | BSD-2-Clause | `streaming/mac-hq-sidecar/scripts/build-ffmpeg.sh` (`--enable-libdav1d`) |
| pulse-player (native HQ player) | shipped in the macOS DMG since app version `0.1.69` | Pulse's own code; its third-party tree is listed in its own section below | `desktop/electron-builder.yml` (`mac.extraResources` → `Resources/hq-sidecar/`), `.github/workflows/mac-build.yml` (build steps) |

Built from the unmodified official `ffmpeg.org` source tarball with
`--enable-openssl --disable-securetransport --enable-videotoolbox
--enable-audiotoolbox --enable-libopus` and no GPL-triggering flags. The
resulting dylibs are bundled next to the app via `scripts/bundle-dylibs.sh`
(dynamic linking). Note: unlike the Linux Flatpak FFmpeg module, this
configure line does not pass `--enable-version3` — which LGPL minor version
(2.1-or-later vs. 3) that produces was not independently confirmed from
within this repository and is flagged here as an open question rather than
asserted.

**Since 2026-08-20 this FFmpeg additionally embeds `libdav1d`** (BSD-2-Clause,
`--enable-libdav1d`). Reason: FFmpeg's own `av1` decoder is a pure hardware
stub, and VideoToolbox cannot decode AV1 before the M3 generation — without
dav1d, `pulse-player` had no way to show AV1 at all on M1/M2 Macs. dav1d does
not touch the LGPL bookkeeping above; it is a separate BSD-2-Clause dylib
bundled the same way (dynamic, exchangeable file next to the app).

**`streaming/pulse-player/` links against this same dylib set as of app
version `0.1.69`** — `scripts/bundle-dylibs.sh` builds one shared bundle
directory for both the sidecar and the player (`<outdir> <binary...>`), so
everything said above about dynamic linking, exchangeability and source
availability applies equally to the player binary, not just the sidecar.

## Linux (Flatpak, `packaging/com.howispulse.Pulse.yml`)

| Component | Version / pin | License | Declared in |
|---|---|---|---|
| Electron | `43.0.0` | MIT | `com.howispulse.Pulse.yml:267` (official release zip), bundled unmodified into `/app/electron/` |
| FFmpeg — **unmodified** | git tag `n8.1.1`, commit `239f2c733de417201d7ad3b3b8b0d9b63285b2b1` | LGPLv3 (`--enable-version3`, no `--enable-gpl`/libx264) | `com.howispulse.Pulse.yml` (ffmpeg module) |
| nv-codec-headers | git tag `n13.0.19.0`, commit `e844e5b26f46bb77479f063029595293aa8f812d` | MIT (headers only, build-time) | `com.howispulse.Pulse.yml:169-179` |
| pulse-linux-hq-sidecar (Rust) | in-tree at `streaming/linux-hq-sidecar/`, built via `type: dir` | Pulse's own code (not third-party) | `com.howispulse.Pulse.yml` (linux-hq-sidecar module) |
| pulse-player (native HQ player, Rust) | in-tree at `streaming/pulse-player/`, built to `/app/bin/pulse-player` | Pulse's own code; third-party tree in its own section below | `com.howispulse.Pulse.yml` (pulse-player module) |

The sidecar row used to point at a **separate repository** and a pinned commit
(`1afe5f11…`). That repo moved in-tree on 2026-07-29 and was **deleted** on
2026-07-30 — the reference had been dangling since. Nothing about the licence
changes; it is Pulse's own code either way.

Electron's own bundled third-party notices (Chromium, Node.js, etc.) ship
inside the official Electron release archive and are not reproduced here.

## Native HQ player (`streaming/pulse-player/`)

Ships on **Linux** (Flatpak, `/app/bin/pulse-player`), since app version
`0.1.42` on **Windows** (`resources/hq-sidecar/pulse-player.exe`, next to the
FFmpeg DLLs it links against), and since app version `0.1.69` on **macOS**
(`Resources/hq-sidecar/`, `desktop/electron-builder.yml` → `mac.extraResources`,
sharing the same dylib set `scripts/bundle-dylibs.sh` builds for the sidecar —
see the macOS section above). It is additive: without the binary the renderer
stays on the built-in `<video>` WHEP path.

Everything below is **statically linked into that binary**, so the notices
travel with the shipped file even though there are no separate library files.
The user-facing counterpart is the "Nativer HQ-Player" section of
`web/src/lib/legal/drittanbieter.md`; keep both in step.

| Component | Version | License | Note |
|---|---|---|---|
| webrtc-rs | 0.17.2 | MIT OR Apache-2.0 | **Modified by Pulse** — two patches, see below |
| wgpu / winit / egui (+ `egui-wgpu`, `egui-winit`, `egui_extras`) | 30.0.0 / 0.30.13 / 0.36.1 | MIT OR Apache-2.0 (winit: Apache-2.0) | |
| resvg / usvg | 0.45.1 | Apache-2.0 OR MIT | SVG icon rasteriser pulled in by `egui_extras`'s `svg` feature |
| tiny-skia | 0.11.4 | BSD-3-Clause | |
| cpal | 0.17.3 | Apache-2.0 | audio output |
| pipewire / libspa (Rust bindings, Linux only) | 0.10.1 | MIT | audio output on Linux since 2026-10-22; `libpipewire` itself (MIT) comes from the Flatpak runtime and is linked dynamically |
| ffmpeg-next / ffmpeg-sys-next | 8.1.0 | WTFPL | bindings only — FFmpeg itself is the LGPL library above |
| rustls | 0.23.42 | Apache-2.0 OR ISC OR MIT | |
| aws-lc-rs | 1.17.3 | ISC AND (Apache-2.0 OR ISC) AND … | crypto provider chosen in `main.rs` |
| webpki-root-certs | 1.0.9 | CDLA-Permissive-2.0 | Mozilla root store |
| self_cell | 1.3.0 | Apache-2.0 OR GPL-2.0-only | **Pulse takes Apache-2.0.** The only GPL text anywhere in the shipped trees, and it is an either/or |
| ICU4X (`icu_*`, `zerovec`, `tinystr`, `writeable`, `yoke`, …) | 2.2.0 | Unicode-3.0 | |
| epaint_default_fonts | 0.36.1 | (MIT OR Apache-2.0) AND **OFL-1.1** AND **Ubuntu-font-1.0** | egui's default fonts, embedded because `theme.rs` starts from `FontDefinitions::default()` |
| Plus Jakarta Sans (Regular, SemiBold) | — | **SIL OFL 1.1** | `assets/fonts/`, `include_bytes!` in `theme.rs`; origin + notice in `assets/fonts/LICENSE.md` |
| Lucide icons | — | **ISC** (parts from Feather, MIT) | `assets/icons/`, notice in `assets/icons/LICENSE.md` |

**Modification notice for webrtc-rs (Apache-2.0 §4(b)):** Pulse changes
`webrtc/src/dtls_transport/mod.rs` (read access to streams whose SSRC matches no
declared track — where the FlexFEC parity packets sit) and the NACK generator
under `interceptor/src/nack/generator/`. The patches live in
`streaming/pulse-player/patches/` with their own `LICENSE` file; that file was
missing until 2026-08-05, which left MIT/Apache-derived material looking as if
it were Pulse-proprietary.

FFmpeg for this target is built from an unmodified pinned upstream commit; the
`--enable-version3` flag is an explicit LGPLv3 opt-in (documented at
`com.howispulse.Pulse.yml:103-105`), and `x264`/`--enable-gpl` are deliberately
left out (`com.howispulse.Pulse.yml:147-160`, verified 2026-07-24 to produce
bit-identical `libav*` symbols with or without it) so the resulting build
stays LGPL rather than GPL.

**`gpu-screen-recorder` is no longer part of this package (2026-08-27).** It
was fetched and built at Flatpak build time and bundled as a separate program
(never linked against Pulse's own binary), together with three Pulse patches
against its source that were themselves GPL-3.0-or-later. It served the older
Linux capture path; that path is gone, replaced by the in-tree Rust sidecar.
The patches and their carve-out in the Pulse licenses have been removed with
it. Nothing GPL-licensed ships any more.

`pulse-linux-hq-sidecar` is in-tree at `streaming/linux-hq-sidecar/` (moved in
2026-07-29 — see the Linux section above) and is Pulse's own code
(AGPL-3.0, not this notice file); its transitive
Cargo dependency tree was part of the 2026-08-05 sweep described at the top.

## Native HQ player — statically linked Rust dependencies

Unlike the capture sidecars, this component links its Rust dependencies
statically into its own binary; they are listed here because their permissive
licenses still require attribution.

**Heading renamed on 2026-08-20**: it read "Native HQ player
(`streaming/pulse-player/`)" — word for word the same as the section further up,
which covers where the binary ships. Two identical headings in an attribution
file are a real hazard: whoever updates one has no reason to suspect the other,
and that is exactly how the "macOS does not ship it" line survived the macOS
rollout. It also opened with "New in this branch", which stopped being true
several releases ago. Versions here are read from
`streaming/pulse-player/Cargo.lock`; wgpu and egui were two minor versions stale
until the same day.

| Component | Version | License |
|---|---|---|
| [webrtc-rs](https://github.com/webrtc-rs/webrtc) | 0.17.2 | MIT OR Apache-2.0 |
| [wgpu](https://github.com/gfx-rs/wgpu) | 30.0.0 | MIT OR Apache-2.0 |
| [winit](https://github.com/rust-windowing/winit) | 0.30.13 | Apache-2.0 |
| [egui](https://github.com/emilk/egui) (+ `egui-wgpu`, `egui-winit`) | 0.36.1 | MIT OR Apache-2.0 |
| [cpal](https://github.com/RustAudio/cpal) | 0.17.3 | Apache-2.0 |
| [pipewire-rs](https://gitlab.freedesktop.org/pipewire/pipewire-rs) (`pipewire`, `libspa`; Linux only) | 0.10.1 | MIT |
| [ffmpeg-next](https://github.com/zmwangx/rust-ffmpeg) (binding only) | 8.1.0 | WTFPL |
| [rustls](https://github.com/rustls/rustls) | 0.23.42 | Apache-2.0 OR ISC OR MIT |
| [aws-lc-rs](https://github.com/aws/aws-lc-rs) / aws-lc-sys | 1.17.3 / 0.43.0 | ISC, Apache-2.0, MIT, BSD-3-Clause |
| [tokio](https://tokio.rs/) | 1.53.1 | MIT |
| [reqwest](https://github.com/seanmonstar/reqwest) | 0.13.4 | MIT OR Apache-2.0 |

`rustls` and `aws-lc-rs` are not optional: `webrtc-rs` requires them for DTLS.

**FFmpeg applies here too.** `ffmpeg-next` is only the binding (WTFPL); the
FFmpeg libraries themselves must be an LGPL build, dynamically linked and
shipped as separate files, exactly as the Windows and macOS sidecars already do
it. The system FFmpeg of many distributions is built with `--enable-gpl` (the
Arch package on the development machine reports GPL-3.0-only) and is therefore
suitable for local development only. This is enforced by convention, not by the
build — see `streaming/pulse-player/Cargo.toml` and `README.md`.

The AV1 RTP depacketizer in `src/depacket/av1.rs` is Pulse's own code, written
because the `rtp` crate ships only an AV1 payloader.

## iOS app (`mobile/ios/`)

The iOS shell (Capacitor) embeds or statically links the native components
below; the web app itself is loaded from the server and is not part of the app
bundle. Versions come from
`mobile/ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved`
and the installed npm packages under `mobile/node_modules`; licences were read
from the SwiftPM checkouts and binary artefacts on 2026-10-11. Only products
that are actually linked are listed: the package graph of `firebase-ios-sdk`
also resolves Analytics, App Check, gRPC, abseil, leveldb, gtm-session-fetcher
and the Google Ads on-device-conversion SDK — none of them is linked (checked
against the products of a Debug simulator build).

| Component | Version | License | Shipped as |
|---|---|---|---|
| [LiveKit Swift SDK](https://github.com/livekit/client-sdk-swift) | 2.17.0 | Apache-2.0, with a `NOTICE` file (below) | statically linked |
| nanopb runtime, vendored in the LiveKit SDK (`CLiveKitProto`) | 0.4.9.1 | zlib | statically linked |
| [WebRTC](https://webrtc.org/), as `LiveKitWebRTC.framework` from [webrtc-xcframework](https://github.com/livekit/webrtc-xcframework) | 150.7871.2 | WebRTC: BSD-3-Clause (text below); the xcframework packaging: MIT | embedded framework |
| [livekit-uniffi](https://github.com/livekit/livekit-uniffi-xcframework) (`RustLiveKitUniFFI.framework`) | 0.1.9 | Apache-2.0 | embedded framework |
| [Capacitor](https://github.com/ionic-team/capacitor-swift-pm) (`Capacitor`, `Cordova`) | 8.5.2 | MIT | embedded frameworks |
| Capacitor plugins `@capacitor/app` 8.1.1, `browser` 8.0.5, `camera` 8.2.5, `haptics` 8.0.2, `keyboard` 8.0.6, `status-bar` 8.0.4 | see left | MIT | statically linked |
| [ion-ios-camera](https://github.com/ionic-team/ion-ios-camera) (`IONCameraLib`, via `@capacitor/camera`) | 2.0.0 | MIT | embedded framework |
| `@capawesome/capacitor-badge` | 8.0.3 | MIT | statically linked |
| `@capacitor-firebase/messaging` | 8.5.2 | Apache-2.0 | statically linked |
| [Firebase iOS SDK](https://github.com/firebase/firebase-ios-sdk) (FirebaseCore, FirebaseCoreInternal, FirebaseInstallations, FirebaseMessaging) | 12.19.2 | Apache-2.0 | statically linked |
| [GoogleDataTransport](https://github.com/google/GoogleDataTransport) | 10.1.1 | Apache-2.0 | statically linked |
| [GoogleUtilities](https://github.com/google/GoogleUtilities) | 8.1.4 | Apache-2.0; its `third_party/IsAppEncrypted` is MIT, Copyright (c) 2017 Landon J. Fuller | statically linked |
| [Promises](https://github.com/google/promises) (`FBLPromises`) | 2.4.1 | Apache-2.0 | statically linked |
| [nanopb](https://github.com/firebase/nanopb) (Firebase) | 2.30910.1 | zlib | statically linked |

**LiveKit `NOTICE`** (Apache-2.0 §4(d)): "Copyright 2023 LiveKit, Inc." —
followed in the file by the Apache-2.0 licence header, nothing else.

**WebRTC** — the licence text as it ships in `LiveKitWebRTC.xcframework/LICENSE`
(BSD-3-Clause requires it with every binary redistribution):

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

### Libraries compiled into the WebRTC binary

**What the package itself says.** Nothing beyond the WebRTC text above. The
xcframework root holds `Info.plist` and that one `LICENSE`; each slice holds the
binary, `Headers/`, `Modules/`, `Info.plist` and `PrivacyInfo.xcprivacy`. There
is no `NOTICE` file and no third-party list, neither in the downloaded
artefact nor in the SwiftPM checkout (`webrtc-xcframework` 150.7871.2: the MIT
`LICENSE` for the packaging, `README.md`, `LiveKitWebRTC.podspec`,
`Package.swift`; the README names `webrtc-sdk/webrtc` and `webrtc-sdk/webrtc-build`
as build sources and lists no libraries). A Debug simulator build of the app
contains no file named like a licence, notice or acknowledgements file.

**What the binary shows.** `LiveKitWebRTC` (arm64 device slice) links only Apple
system frameworks (`otool -L`), so every library below is statically inside it.
Read with `strings` on 2026-10-11; "source path" means a
`…/webrtc/src/third_party/<name>/…` path embedded in an assertion message. The
list is a **lower bound**: a library that leaves no string behind does not appear.

| Library | Evidence in the binary | Licence |
|---|---|---|
| BoringSSL | source paths `third_party/boringssl/src/{crypto,ssl}/…` | Apache-2.0 (text not reproduced here) |
| Opus (libopus) | source paths `third_party/opus/src/src/opus_decoder.c` and others | BSD-3-Clause; royalty-free patent licences named in the text |
| libvpx | version banner `WebM Project VP8/VP9 Encoder/Decoder v1.16.0-132-g31af37b1b` | BSD-3-Clause, with the "Additional IP Rights Grant (Patents)" |
| libaom | encoder wrapper `LibaomAv1Encoder` and its `aom_codec_enc_init` / `aom_codec_encode` messages | BSD-2-Clause, with the Alliance for Open Media Patent License 1.0 |
| dav1d | decoder wrapper `Dav1dDecoder`, thread name `dav1d-worker` | BSD-2-Clause |
| libyuv | assertion strings with `libyuv::I420Copy`, `I420Rotate`, `I444Copy`, … | BSD-3-Clause |
| libsrtp | `srtp_protect`, `srtp_shutdown`, "libsrtp log handler" | BSD-3-Clause |
| Abseil | source paths `third_party/abseil-cpp/absl/…` | Apache-2.0 (text not reproduced here) |
| libc++abi | source paths `third_party/libc++abi/src/src/{fallback_malloc,private_typeinfo}.cpp` | Apache-2.0 with LLVM Exceptions (text not reproduced here) |

**Where the licences and texts come from.** The framework carries none of them.
The only licence collection for these libraries on this machine is
`LICENSES.chromium.html` in the Electron distribution under
`desktop/node_modules/electron/dist/` — Electron 43.0.0, Chromium
150.0.7871.46, the same branch number (7871) as the framework's 150.7871.2.
The licence column and the texts below are taken from there. That identifies
the licences of the same upstream projects; it is **not** a reading of the
sources inside the iOS binary. That the revisions in `LiveKitWebRTC` carry
word-for-word the same texts was not checked (only libvpx's version, above, is
visible in the binary). The Apache-2.0 components follow the practice of the
rest of this file: named, text not reproduced. In that list BoringSSL's
licence file also holds a Go-licence block for its TLS test suite, which the
file itself says is not compiled into libcrypto/libssl.

The texts that follow are copied from that list. Only the indentation and
blank-line runs were changed here; for libsrtp the C comment markers around
the text were removed too.

**Opus:**

    Copyright 2001-2023 Xiph.Org, Skype Limited, Octasic,
                        Jean-Marc Valin, Timothy B. Terriberry,
                        CSIRO, Gregory Maxwell, Mark Borgerding,
                        Erik de Castro Lopo, Mozilla, Amazon

    Redistribution and use in source and binary forms, with or without
    modification, are permitted provided that the following conditions
    are met:

    - Redistributions of source code must retain the above copyright
    notice, this list of conditions and the following disclaimer.

    - Redistributions in binary form must reproduce the above copyright
    notice, this list of conditions and the following disclaimer in the
    documentation and/or other materials provided with the distribution.

    - Neither the name of Internet Society, IETF or IETF Trust, nor the
    names of specific contributors, may be used to endorse or promote
    products derived from this software without specific prior written
    permission.

    THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
    ``AS IS'' AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
    LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
    A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER
    OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
    EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
    PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
    PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
    LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
    NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
    SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

    Opus is subject to the royalty-free patent licenses which are
    specified at:

    Xiph.Org Foundation:
    https://datatracker.ietf.org/ipr/1524/

    Microsoft Corporation:
    https://datatracker.ietf.org/ipr/1914/

    Broadcom Corporation:
    https://datatracker.ietf.org/ipr/1526/

**libvpx:**

    Copyright (c) 2010, The WebM Project authors. All rights reserved.

    Redistribution and use in source and binary forms, with or without
    modification, are permitted provided that the following conditions are
    met:

      * Redistributions of source code must retain the above copyright
        notice, this list of conditions and the following disclaimer.

      * Redistributions in binary form must reproduce the above copyright
        notice, this list of conditions and the following disclaimer in
        the documentation and/or other materials provided with the
        distribution.

      * Neither the name of Google, nor the WebM Project, nor the names
        of its contributors may be used to endorse or promote products
        derived from this software without specific prior written
        permission.

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

    Additional IP Rights Grant (Patents)
    ------------------------------------

    "These implementations" means the copyrightable works that implement the WebM
    codecs distributed by Google as part of the WebM Project.

    Google hereby grants to you a perpetual, worldwide, non-exclusive, no-charge,
    royalty-free, irrevocable (except as stated in this section) patent license to
    make, have made, use, offer to sell, sell, import, transfer, and otherwise
    run, modify and propagate the contents of these implementations of WebM, where
    such license applies only to those patent claims, both currently owned by
    Google and acquired in the future, licensable by Google that are necessarily
    infringed by these implementations of WebM. This grant does not include claims
    that would be infringed only as a consequence of further modification of these
    implementations. If you or your agent or exclusive licensee institute or order
    or agree to the institution of patent litigation or any other patent
    enforcement activity against any entity (including a cross-claim or
    counterclaim in a lawsuit) alleging that any of these implementations of WebM
    or any code incorporated within any of these implementations of WebM
    constitute direct or contributory patent infringement, or inducement of
    patent infringement, then any patent rights granted to you under this License
    for these implementations of WebM shall terminate as of the date such
    litigation is filed.

**libaom:**

    Copyright (c) 2016, Alliance for Open Media. All rights reserved.

    Redistribution and use in source and binary forms, with or without
    modification, are permitted provided that the following conditions
    are met:

    1. Redistributions of source code must retain the above copyright
       notice, this list of conditions and the following disclaimer.

    2. Redistributions in binary form must reproduce the above copyright
       notice, this list of conditions and the following disclaimer in
       the documentation and/or other materials provided with the
       distribution.

    THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
    "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
    LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS
    FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE
    COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT,
    INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING,
    BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
    LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
    CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT
    LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN
    ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
    POSSIBILITY OF SUCH DAMAGE.

    Alliance for Open Media Patent License 1.0

    1. License Terms.

    1.1. Patent License. Subject to the terms and conditions of this License, each
         Licensor, on behalf of itself and successors in interest and assigns,
         grants Licensee a non-sublicensable, perpetual, worldwide, non-exclusive,
         no-charge, royalty-free, irrevocable (except as expressly stated in this
         License) patent license to its Necessary Claims to make, use, sell, offer
         for sale, import or distribute any Implementation.

    1.2. Conditions.

    1.2.1. Availability. As a condition to the grant of rights to Licensee to make,
           sell, offer for sale, import or distribute an Implementation under
           Section 1.1, Licensee must make its Necessary Claims available under
           this License, and must reproduce this License with any Implementation
           as follows:

           a. For distribution in source code, by including this License in the
              root directory of the source code with its Implementation.

           b. For distribution in any other form (including binary, object form,
              and/or hardware description code (e.g., HDL, RTL, Gate Level Netlist,
              GDSII, etc.)), by including this License in the documentation, legal
              notices, and/or other written materials provided with the
              Implementation.

    1.2.2. Additional Conditions. This license is directly from Licensor to
           Licensee.  Licensee acknowledges as a condition of benefiting from it
           that no rights from Licensor are received from suppliers, distributors,
           or otherwise in connection with this License.

    1.3. Defensive Termination. If any Licensee, its Affiliates, or its agents
         initiates patent litigation or files, maintains, or voluntarily
         participates in a lawsuit against another entity or any person asserting
         that any Implementation infringes Necessary Claims, any patent licenses
         granted under this License directly to the Licensee are immediately
         terminated as of the date of the initiation of action unless 1) that suit
         was in response to a corresponding suit regarding an Implementation first
         brought against an initiating entity, or 2) that suit was brought to
         enforce the terms of this License (including intervention in a third-party
         action by a Licensee).

    1.4. Disclaimers. The Reference Implementation and Specification are provided
         "AS IS" and without warranty. The entire risk as to implementing or
         otherwise using the Reference Implementation or Specification is assumed
         by the implementer and user. Licensor expressly disclaims any warranties
         (express, implied, or otherwise), including implied warranties of
         merchantability, non-infringement, fitness for a particular purpose, or
         title, related to the material. IN NO EVENT WILL LICENSOR BE LIABLE TO
         ANY OTHER PARTY FOR LOST PROFITS OR ANY FORM OF INDIRECT, SPECIAL,
         INCIDENTAL, OR CONSEQUENTIAL DAMAGES OF ANY CHARACTER FROM ANY CAUSES OF
         ACTION OF ANY KIND WITH RESPECT TO THIS LICENSE, WHETHER BASED ON BREACH
         OF CONTRACT, TORT (INCLUDING NEGLIGENCE), OR OTHERWISE, AND WHETHER OR
         NOT THE OTHER PARTY HAS BEEN ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

    2. Definitions.

    2.1. Affiliate.  "Affiliate" means an entity that directly or indirectly
         Controls, is Controlled by, or is under common Control of that party.

    2.2. Control. "Control" means direct or indirect control of more than 50% of
         the voting power to elect directors of that corporation, or for any other
         entity, the power to direct management of such entity.

    2.3. Decoder.  "Decoder" means any decoder that conforms fully with all
         non-optional portions of the Specification.

    2.4. Encoder.  "Encoder" means any encoder that produces a bitstream that can
         be decoded by a Decoder only to the extent it produces such a bitstream.

    2.5. Final Deliverable.  "Final Deliverable" means the final version of a
         deliverable approved by the Alliance for Open Media as a Final
         Deliverable.

    2.6. Implementation.  "Implementation" means any implementation, including the
         Reference Implementation, that is an Encoder and/or a Decoder. An
         Implementation also includes components of an Implementation only to the
         extent they are used as part of an Implementation.

    2.7. License. "License" means this license.

    2.8. Licensee. "Licensee" means any person or entity who exercises patent
         rights granted under this License.

    2.9. Licensor.  "Licensor" means (i) any Licensee that makes, sells, offers
         for sale, imports or distributes any Implementation, or (ii) a person
         or entity that has a licensing obligation to the Implementation as a
         result of its membership and/or participation in the Alliance for Open
         Media working group that developed the Specification.

    2.10. Necessary Claims.  "Necessary Claims" means all claims of patents or
          patent applications, (a) that currently or at any time in the future,
          are owned or controlled by the Licensor, and (b) (i) would be an
          Essential Claim as defined by the W3C Policy as of February 5, 2004
          (https://www.w3.org/Consortium/Patent-Policy-20040205/#def-essential)
          as if the Specification was a W3C Recommendation; or (ii) are infringed
          by the Reference Implementation.

    2.11. Reference Implementation. "Reference Implementation" means an Encoder
          and/or Decoder released by the Alliance for Open Media as a Final
          Deliverable.

    2.12. Specification. "Specification" means the specification designated by
          the Alliance for Open Media as a Final Deliverable for which this
          License was issued.

**dav1d:**

    Copyright © 2018, VideoLAN and dav1d authors
    All rights reserved.

    Redistribution and use in source and binary forms, with or without
    modification, are permitted provided that the following conditions are met:

    1. Redistributions of source code must retain the above copyright notice, this
       list of conditions and the following disclaimer.

    2. Redistributions in binary form must reproduce the above copyright notice,
       this list of conditions and the following disclaimer in the documentation
       and/or other materials provided with the distribution.

    THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
    ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
    WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
    DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR
    ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
    (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
    LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
    ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
    (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
    SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

**libyuv:**

    Copyright 2011 The LibYuv Project Authors. All rights reserved.

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

**libsrtp:**

    Copyright (c) 2001-2017 Cisco Systems, Inc.
    All rights reserved.

    Redistribution and use in source and binary forms, with or without
    modification, are permitted provided that the following conditions
    are met:

      Redistributions of source code must retain the above copyright
      notice, this list of conditions and the following disclaimer.

      Redistributions in binary form must reproduce the above
      copyright notice, this list of conditions and the following
      disclaimer in the documentation and/or other materials provided
      with the distribution.

      Neither the name of the Cisco Systems, Inc. nor the names of its
      contributors may be used to endorse or promote products derived
      from this software without specific prior written permission.

    THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
    "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
    LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS
    FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE
    COPYRIGHT HOLDERS OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT,
    INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
    (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
    SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
    HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT,
    STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
    ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED
    OF THE POSSIBILITY OF SUCH DAMAGE.

### Rust crates inside livekit-uniffi — open gap

`livekit-uniffi-xcframework` 0.1.9 (tag `0.1.9`, commit `7a9bf91`) brings **no
licence list** for what is compiled into `RustLiveKitUniFFI.framework`. The
SwiftPM checkout tracks nine files: `LICENSE` (Apache-2.0, the standard text
unchanged — it covers the package itself), `Package.swift`,
`Package@swift-6.2.swift`, `LiveKitUniFFI.podspec`, `PrivacyInfo.xcprivacy`,
`.gitignore` and three generated Swift binding files. The downloaded
`RustLiveKitUniFFI.xcframework` holds no licence, notice or dependency file at
all — not even that Apache-2.0 text. So nothing in the package says which
Rust crates are inside or under which licences; **none of those licences has
been looked up or assumed here.**

What the binary reveals about its contents (a lower bound — only code that
left a source path behind, for instance in a panic message, shows up; the
framework links only `libiconv` and `libSystem` besides itself):

- LiveKit's own workspace crates `livekit-uniffi`, `livekit-datatrack`,
  `livekit-protocol`, `livekit-token`, `livekit-runtime` and `livekit-common`.
  The package `LICENSE` is the only licence statement that exists for them.
- 26 crates from crates.io (versions as in the embedded paths): anyhow 1.0.104,
  async-compat 0.2.5, base64 0.22.1, block-buffer 0.10.4, bytes 1.12.1,
  digest 0.10.7, generic-array 0.14.7, hashbrown 0.17.1, hmac 0.12.1,
  indexmap 2.14.0, itoa 1.0.18, jsonwebtoken 10.4.0, log 0.4.33,
  once_cell 1.21.4, ppv-lite86 0.2.21, rand 0.9.5, rand_chacha 0.9.0,
  serde 1.0.229, serde_core 1.0.229, serde_json 1.0.151, sha2 0.10.9,
  signature 2.2.0, tokio 1.53.1, tokio-stream 0.1.19, tokio-util 0.7.19,
  uniffi_core 0.31.2.
- the Rust standard library.

Closing the gap needs the resolved dependency tree of that release (the
package contains no `Cargo.lock`) and a licence sweep like the one at the top
of this file.

## Android app (`mobile/android/`)

The Android shell is the same Capacitor wrapper as the iOS one: the web app is
loaded from the server (`server.url` in `mobile/capacitor.config.json`) and is
not part of the app package. Its own native code lives in
`mobile/android/app/src/main/java/com/howispulse/app/` and is Pulse's code
under the AGPL (`mobile/LICENSE`); those classes import only `com.getcapacitor.*`,
the Android platform (`android.*`, `java.*`) and `androidx.core.*`.

**What was read, and what could not be.** The Gradle files
(`mobile/android/build.gradle`, `variables.gradle`, `app/build.gradle`,
`app/capacitor.build.gradle`, `capacitor.settings.gradle`), the
`android/build.gradle` of each Capacitor plugin, and each plugin's
`package.json` and `LICENSE` under `mobile/node_modules/`, on 2026-10-11. This
machine holds **no Gradle or Maven cache and no POM or AAR file** (no
`~/.gradle`, no `~/.m2`, none found elsewhere), so the licence of **no** Maven
artefact could be read. Those rows say "not verified" instead of naming a
licence.

Capacitor packages — licence read from the package (`package.json` `license`
field and `LICENSE` file), versions as installed here:

| Package | Version | Licence | In the Android Gradle build |
|---|---|---|---|
| `@capacitor/android` | 8.4.0 | MIT, Copyright (c) 2017-present Drifty Co. | yes (`:capacitor-android`) |
| `@capacitor/app` | 8.1.1 | MIT, Copyright 2020-present Ionic | yes |
| `@capacitor/camera` | 8.2.5 | MIT, Copyright 2020-present Ionic | yes |
| `@capacitor-firebase/messaging` | 8.5.2 | Apache-2.0 | yes |
| `@capacitor/browser` 8.0.5, `haptics` 8.0.2, `keyboard` 8.0.6, `status-bar` 8.0.4 | see left | MIT, Copyright 2020-present Ionic | **not yet** — arrive with the next `npx cap sync android` |
| `@capawesome/capacitor-badge` | 8.0.3 | MIT, Copyright (c) 2021 Robin Genz | **not yet** — same |

**The Android Gradle configuration in the repo is behind `package.json`.**
`capacitor.build.gradle` lists only firebase-messaging, app and camera, while
`package.json` also lists browser, haptics, keyboard, status-bar and badge.
`capacitor.settings.gradle` points at a pnpm layout
(`../node_modules/.pnpm/@capacitor+android@8.5.1_…`, firebase-messaging 8.5.1,
camera 8.2.4) that does not exist in this checkout, which uses npm
(`package-lock.json`: android 8.4.0, firebase-messaging 8.5.2, camera 8.2.5).
So the versions above are the lockfile's, not a verified APK content; what an
APK contains depends on the building machine and on a fresh `cap sync`.

Maven artefacts named in the Gradle files (versions as written there). The
licence of every one of them is **not verified** — nothing to read it from is
present:

| Artefact | Version | Pulled in by |
|---|---|---|
| `androidx.appcompat:appcompat` | 1.7.1 | the app, capacitor-android and all plugins |
| `androidx.coordinatorlayout:coordinatorlayout` | 1.3.0 | the app, capacitor-android |
| `androidx.core:core-splashscreen` | 1.2.0 | the app |
| `androidx.core:core` | 1.17.0 | capacitor-android, status-bar plugin |
| `androidx.activity:activity` | 1.11.0 | capacitor-android |
| `androidx.fragment:fragment` | 1.8.9 | capacitor-android |
| `androidx.webkit:webkit` | 1.14.0 | capacitor-android |
| `org.apache.cordova:framework` | 14.0.1 | capacitor-android |
| `com.google.firebase:firebase-messaging` | 25.0.1 (plugin default; the app does not override it) | `@capacitor-firebase/messaging` |
| `io.ionic.libs:ioncamera-android` | 1.0.2 | `@capacitor/camera` |
| `androidx.exifinterface:exifinterface` | 1.4.1 | `@capacitor/camera` |
| `com.google.android.material:material` | 1.13.0 | `@capacitor/camera` |
| `androidx.core:core-ktx` | 1.17.0 | `@capacitor/camera` |
| `com.google.code.gson:gson` | 2.10.1 | `@capacitor/camera` |
| `androidx.browser:browser` | 1.9.0 | `@capacitor/browser` (after the next sync) |
| `me.leolin:ShortcutBadger` | 1.1.22 (`@aar`) | `@capawesome/capacitor-badge` (after the next sync) |

Not in the table because they are not read from any file: the **transitive**
dependencies of all of these (the Firebase/Google libraries behind
firebase-messaging, the Kotlin standard library behind the camera plugin, the
further AndroidX libraries that the AndroidX components depend on). They
appear only in a resolved dependency tree or in the built APK, neither of
which exists here.

Not shipped in the app: the test-only dependencies (`junit` 4.13.2,
`androidx.test.ext:junit` 1.3.0, `espresso-core` 3.7.0) and the build tools
(Android Gradle Plugin 8.13.0, `com.google.gms:google-services` 4.4.4, the
Gradle 8.14.3 wrapper, the Kotlin Gradle plugin 2.2.20 that the camera plugin
declares).

## Open — mobile apps

1. **WebRTC sub-libraries:** licences and texts come from the Chromium list in
   the local Electron 43.0.0, not from the iOS binary; the revisions were not
   compared. Whether BoringSSL, Abseil or libc++abi come with `NOTICE` files
   that Apache-2.0 §4(d) would pass on was not established (only the Chromium
   list was available). The Apache-2.0 texts are not reproduced.
2. **livekit-uniffi:** no licence list in the package; the Rust crates above
   are neither looked up nor covered.
3. **Android:** no licence of any Maven artefact read; transitive tree not
   resolved; the checked-in Gradle configuration is stale against
   `package.json` and has to be synced before the real set of plugins is known.
4. The sweep of 2026-08-05 at the top of this file predates both mobile apps
   and does not cover them.

## Web crypto core (WASM, `krypto/pulse-krypto/`)

The end-to-end-encrypted DM crypto core wraps
[vodozemac](https://github.com/matrix-org/vodozemac) (Matrix's Olm/Megolm
implementation in Rust) and is compiled to WebAssembly for the browser via
`wasm-pack`/`wasm-bindgen`; the resulting `pulse_krypto.js`/`.wasm` ship as
part of the web bundle (see `web/Dockerfile` and `infra/self-host/Dockerfile`,
`wasm-builder`/`wasm-build` stage).

| Component | Version | License |
|---|---|---|
| [vodozemac](https://github.com/matrix-org/vodozemac) | 0.10.0 | Apache-2.0 |
| [wasm-bindgen](https://github.com/rustwasm/wasm-bindgen) | 0.2.127 | MIT OR Apache-2.0 |
| [getrandom](https://github.com/rust-random/getrandom) (0.2 + 0.3, both with the `js`/`wasm_js` feature) | 0.2.17 / 0.3.4 | MIT OR Apache-2.0 |

`vodozemac`'s own transitive dependency tree (curve25519-dalek, ed25519-dalek,
hkdf, sha2, aes, ...) is not separately re-verified here — same scope as the
"Not covered here" note below for the statically-linked sidecar crates; all
are permissively licensed by upstream convention.

## LiveKit server (self-host image and Pulse Server app, `infra/livekit-fork/`)

Voice runs through a LiveKit SFU. Until 2026-10-12 the self-host image and the
Windows Pulse Server installer bundled the **unmodified** official release
binary — and this file did not list it at all. Since then both ship a
**modified** build: LiveKit is compiled from source with one Pulse patch
against its dependency mediatransportutil.

| Component | Version / pin | License | Notes |
|---|---|---|---|
| [LiveKit server](https://github.com/livekit/livekit) | v1.13.3, commit `8f6a9cb8b735549f0c5770df8ea70ac51f860ecb` | Apache-2.0 | Built from source; reports `version 1.13.3` |
| [mediatransportutil](https://github.com/livekit/mediatransportutil) | commit `a3417d38cda0c840ef8c7ebe9628472028921d58` (the one v1.13.3 requires) | Apache-2.0 | **Modified by Pulse** — one patch, see below |

Where it ships: the self-host image (`/usr/local/bin/livekit-server`; LICENSE,
NOTICE and the patch in `/usr/share/doc/livekit-server/`), the Windows Pulse
Server installer (`native/native-bin/livekit-server.exe`, the same three in
`native/native-bin/livekit-lizenz/`), and the macOS Pulse Server through the
self-host image it runs. Pins: `infra/livekit-fork/quelle.env`.

**Modification notice for mediatransportutil (Apache-2.0 §4(b)):** Pulse
changes `pkg/rtcconfig/config.go`, `pkg/rtcconfig/webrtc_config.go` and
`pkg/rtcconfig/webrtc_config_test.go` — a new option `extra_node_ips` whose
addresses are announced as host candidates next to `node_ip`
(`infra/livekit-fork/patches/0001-extra-node-ips.patch`, with its own
`LICENSE`). Without that option the build behaves like the official one.

**NOTICE (Apache-2.0 §4(d))**, reproduced from both upstream repositories:
"Copyright 2023 LiveKit, Inc. Licensed under the Apache License, Version 2.0."

## MediaMTX (streaming relay, `infra/mediamtx-fork/`)

HQ streams are relayed by MediaMTX. Cloud, self-host image and — since
2026-10-14 — the Windows Pulse Server installer all run a **modified** build:
upstream MediaMTX with the Pulse patches in `infra/mediamtx-fork/patches/` and
`patches-vendor/` (the latter against the vendored pion FlexFEC interceptor).
Until 2026-10-14 the Windows installer bundled the unmodified official release
binary, and this file did not list MediaMTX at all.

| Component | Version / pin | License | Notes |
|---|---|---|---|
| [MediaMTX](https://github.com/bluenviron/mediamtx) | v1.19.1, Pulse patch level in `PULSE_REVISION` (`infra/mediamtx-fork/Dockerfile`) | MIT | **Modified by Pulse** — patches listed and explained in `infra/mediamtx-fork/README.md` |

Where it ships: the image `ghcr.io/oblivion-pictures/pulse-mediamtx` (copied
into the self-host image as `/usr/local/bin/mediamtx`) and the Windows Pulse
Server installer (`native/native-bin/mediamtx.exe`, with MediaMTX's LICENSE
and the applied patches in `native/native-bin/mediamtx-lizenz/`). The two
images carry the binary only — no license file next to it yet; the notice
below is, for them, the only place it is reproduced. The Go modules compiled
into the binary (gortsplib, pion and others) are not listed here.

**License notice:** "MIT License. Copyright (c) 2019 aler9."

## Landing page (`web/static/landing.html`, cloud only)

The marketing page at https://howispulse.com/ ships its two typefaces from the
same origin (`web/static/fonts/`) so that no visitor's browser contacts Google
Fonts. Variable fonts, Latin subset, from fontsource packages (the same
builds Google Fonts serves): Plus Jakarta Sans is byte-identical to the file in
`@fontsource-variable/plus-jakarta-sans` 5.2.8 (already a `web/` dependency);
JetBrains Mono was fetched from `@fontsource-variable/jetbrains-mono` 5.2.6 via
jsDelivr — source URL and SHA-256 in `web/static/fonts/LICENSE.md`.

| Font | Copyright | License |
|---|---|---|
| Plus Jakarta Sans (variable, 200–800) | 2020 The Plus Jakarta Sans Project Authors, https://github.com/tokotype/PlusJakartaSans | **SIL OFL 1.1** |
| JetBrains Mono (variable, 100–800) | 2020 The JetBrains Mono Project Authors, https://github.com/JetBrains/JetBrainsMono | **SIL OFL 1.1** |

Notice + origin: `web/static/fonts/LICENSE.md`.


## Not covered here

Rust crates statically compiled into Pulse's own sidecar binaries (e.g.
`windows-capture`, `wasapi`, `sysinfo`, `windows-rs`, `ffmpeg-next` itself,
`objc2` and its framework crates, `serde`/`serde_json`/`anyhow`) are not
separately redistributed files in the LGPL sense — they become part of
Pulse's own compiled client binary. Their individual licence texts are not
reproduced in this file; they **have** been covered by the sweep described at
the top (2026-08-05, `cargo metadata` over all shipped Rust trees — result:
no AGPL, no GPL-only, no MPL-only). Re-run that sweep when a dependency tree
changes; this section is only about attribution presentation, not about an
outstanding audit.

---

Stand / last updated: 14. Oktober 2026 (MediaMTX und LiveKit, von Pulse verändert; iOS-App, WebRTC-Bibliotheken, Android-Hülle ergänzt)
