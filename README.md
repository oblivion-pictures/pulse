# Pulse

Chat, voice and high-quality screen sharing for communities and friends — on
Windows, macOS, Linux, Android and in the browser. Use it at
[howispulse.com](https://howispulse.com) or run your own server.

## What you can do

### Chat

- **Communities** with text and voice channels, roles and per-channel
  permissions.
- **Direct messages and private groups, end-to-end encrypted.** The server only
  ever stores ciphertext (Olm/Megolm via [vodozemac](https://github.com/matrix-org/vodozemac)).
- Read receipts, reactions, editing, file attachments and link previews for
  YouTube, Vimeo and Spotify.
- Invite links, plus an optional public directory for communities that want to
  be found.
- **Encrypted drive channels:** shared folders whose files are stored,
  encrypted, in a connected cloud drive (Google Drive, Dropbox).
- **Your history stays yours:** an encrypted backup of your message history to
  your own cloud drive, and device pairing to bring it to a new device.

### Voice, video and calls

- Voice channels with noise suppression, push-to-talk and camera.
- One-to-one and group calls from direct messages.
- **Guest links:** invite someone into a voice channel without an account.
- **Watch parties:** watch YouTube together, in sync, with subtitles.

### Screen sharing

- Native capture and hardware encoding on Windows, macOS and Linux (NVIDIA,
  AMD, Intel and Apple GPUs) with H.264, HEVC and AV1 — well above 4K or native
  resolution and well above 500 frames per second.
- **HDR** (AV1, 10 bit) on Windows with AMD and NVIDIA graphics cards.
- Viewers watch in the browser or in the native player of the desktop app;
  several people can share their screens in the same channel.
- **Remote control:** let someone take over the mouse and keyboard of a shared
  screen, or leave a computer in a voice channel to be controlled later.

### Accounts and security

- Sign-in with passkeys and two-factor authentication (TOTP).
- One account for everything: sign in to any self-hosted Pulse server with
  your howispulse.com account, no separate registration.

## Platforms

| Platform | Download | Good to know |
|---|---|---|
| Browser | [howispulse.com](https://howispulse.com) | Installable as an app |
| Windows | [Pulse-Setup-latest.exe](https://howispulse.com/updates/win/Pulse-Setup-latest.exe) | Updates itself. On first launch SmartScreen asks: “More info” → “Run anyway” |
| macOS (Apple Silicon) | [Pulse-latest.dmg](https://howispulse.com/downloads/Pulse-latest.dmg) | Signed and notarized by Apple |
| Linux | [Flatpak](https://howispulse.com/flatpak/com.howispulse.Pulse.flatpakref) | Open the file with GNOME Software or Discover, or use the command below. Updates with `flatpak update` |
| Android | [pulse-latest.apk](https://howispulse.com/downloads/pulse-latest.apk) | Allow “Install from unknown sources” during installation |

Linux from the terminal:

```bash
flatpak install --from https://howispulse.com/flatpak/com.howispulse.Pulse.flatpakref
```

In the browser the same links are under Settings → Apps.

## Run your own server

A server is yours from the start, no application and no approval:

```bash
curl -fsSL https://howispulse.com/install | bash
```

on a Linux machine with Docker and a domain. At the end the installer shows a
link; confirm it with your Pulse account and the server is connected. Docker
Compose works as well, with the public image `ghcr.io/oblivion-pictures/pulse`
(amd64 and arm64). Servers set up with the installer update themselves;
`:stable` follows releases, `:edge` every change.

No domain? The **Pulse Server app** turns your own computer into a server for
as long as it runs: [Windows](https://howispulse.com/updates/win-server/Pulse-Server-Setup-latest.exe)
· [macOS](https://howispulse.com/downloads/Pulse-Server-latest.dmg)
· [Linux (Flatpak)](https://howispulse.com/flatpak/com.howispulse.PulseServer.flatpakref).

Full guide: [howispulse.com/self-host/guide](https://howispulse.com/self-host/guide)

## Repository

| Directory | Contents |
|---|---|
| `services/` | Backend services (Python, FastAPI): sign-in, chat, voice signalling, media |
| `shared/` | Code shared by the services |
| `web/` | The app (SvelteKit), served to the browser and to the desktop and Android apps |
| `desktop/` | Desktop app and Server app (Electron) |
| `streaming/` | Screen capture and encoding per platform, native player (Rust) |
| `krypto/` | End-to-end encryption core (Rust, compiled to WebAssembly) |
| `mobile/` | Android app (Capacitor) |
| `infra/` | Self-host image, installer support, deployment |
| `packaging/` | Flatpak and Android packaging |
| `plugins/` | Example plugins |

Voice runs on [LiveKit](https://livekit.io) (self-hosted servers ship it with
one small Pulse patch, see `infra/livekit-fork/`), screen sharing on a patched
[MediaMTX](https://github.com/bluenviron/mediamtx).

Comments in the code that point to `CLAUDE.md`, `PLAN.md`, `docs/plans`,
`docs/superpowers` or to lab and measurement folders under `streaming/` refer
to internal working documents that are not part of this repository.

## License

Copyright (C) 2026 Oblivion Pictures

Pulse is free software: you can redistribute it and/or modify it under the
terms of the **GNU Affero General Public License**, version 3
(**AGPL-3.0-only**), as published by the Free Software Foundation. The full
text is in [`LICENSE`](LICENSE). Anyone who runs Pulse — including as a web
service — must offer its source code to their users (AGPL §13).

Pulse is distributed in the hope that it will be useful, but **without any
warranty**; without even the implied warranty of merchantability or fitness for
a particular purpose. See the GNU Affero General Public License for details.

Excluded are the **brand assets** in [`Logo/`](Logo) (all rights reserved) and
third-party components, which keep their own licenses (overview:
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)).

License history: AGPL-3.0 until 2026-07-24 · PolyForm 2026-07-25 to 2026-07-28
· Pulse Client/Server License 1.0 (source-available) 2026-07-29 to 2026-10-01 ·
AGPL-3.0 again since 2026-10-02. Versions published under an earlier license
remain available under that license.

### Contributing

Contributions require a Contributor License Agreement ([`CLA.md`](CLA.md), a
license grant modelled on the Apache ICLA). Pulse stays available to everyone
under the AGPL; the CLA additionally allows the copyright holder to offer
commercial licenses.

### Third-party software

The screen-sharing components in `streaming/` link dynamically against a
pinned FFmpeg build (LGPL). FFmpeg is not part of this repository; it is built
from upstream or bundled in the Flatpak under its own license.
