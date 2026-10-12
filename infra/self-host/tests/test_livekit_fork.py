"""Der LiveKit-Fork (infra/livekit-fork/) hängt an vier Stellen — hält jede?

Gebaut wird er von zwei Abläufen (Self-Host-Image, Windows-Server-App), und
beide laufen nur, wenn ein Push ihre `on.push.paths` berührt. Fehlt dort
`infra/livekit-fork/**`, bricht nichts: ein neuer Patch-Stand erreicht dann
still nur einen der beiden Wege (dieselbe Fehlerklasse wie
`streaming/zwillinge/tests/bau_ausloeser.rs`, das nur die Rust-Kisten prüft).
Dazu müssen Image und Windows dieselbe Go-Fassung nehmen und dasselbe Skript
rufen — sonst wäre „eine Quelle" nur behauptet.
"""

from __future__ import annotations

import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
FORK = REPO / "infra" / "livekit-fork"
DOCKERFILE = REPO / "infra" / "self-host" / "Dockerfile"
FETCH_WIN = REPO / "desktop" / "scripts" / "fetch-win-native.ps1"
WORKFLOWS = REPO / ".github" / "workflows"


def _quelle() -> dict[str, str]:
    werte = {}
    for zeile in (FORK / "quelle.env").read_text().splitlines():
        if m := re.fullmatch(r"([A-Z_]+)=(\S+)", zeile):
            werte[m[1]] = m[2]
    return werte


def test_quelle_nennt_fassung_volle_commits_und_revision() -> None:
    q = _quelle()
    assert re.fullmatch(r"\d+\.\d+\.\d+", q["LIVEKIT_VERSION"])
    assert re.fullmatch(r"[0-9a-f]{40}", q["LIVEKIT_COMMIT"])
    assert re.fullmatch(r"[0-9a-f]{40}", q["MTU_COMMIT"])
    assert re.fullmatch(r"\d+", q["PULSE_REVISION"])
    assert sorted((FORK / "patches").glob("*.patch")), "kein Patch unter infra/livekit-fork/patches/"


def test_beide_bau_ablaeufe_loesen_beim_fork_aus() -> None:
    for ablauf in ("allinone.yml", "win-build-server.yml"):
        zeilen = [z.strip() for z in (WORKFLOWS / ablauf).read_text().splitlines()]
        assert any(z.startswith("- 'infra/livekit-fork/**'") for z in zeilen), ablauf


def test_image_und_windows_bauen_mit_demselben_skript() -> None:
    docker = DOCKERFILE.read_text()
    assert "bash livekit-fork/bauen.sh" in docker
    assert "COPY --from=livekit-build /out/livekit-server" in docker
    assert "livekit/livekit/releases/download" not in docker
    win = FETCH_WIN.read_text(encoding="utf-8-sig")
    assert "infra\\livekit-fork\\bauen.sh" in win
    assert "infra\\livekit-fork\\quelle.env" in win
    assert "livekit/livekit-server/releases" not in win
    assert "-LivekitSource" in (WORKFLOWS / "win-build-server.yml").read_text()


def test_image_und_windows_nehmen_dieselbe_go_fassung() -> None:
    bild = re.search(r"FROM --platform=\$BUILDPLATFORM golang:(\d+\.\d+\.\d+)-\S+@sha256:[0-9a-f]{64} AS livekit-build", DOCKERFILE.read_text())
    assert bild, "livekit-build-Stufe nicht (per Digest) gefunden"
    win = re.search(r"go-version: '([^']+)'", (WORKFLOWS / "win-build-server.yml").read_text())
    assert win and win[1] == bild[1], f"Dockerfile {bild[1]} gegen win-build-server.yml {win and win[1]}"


def test_stempel_ist_in_bash_und_powershell_wortgleich_gebaut() -> None:
    # bauen.sh schreibt ihn, fetch-win-native.ps1 vergleicht ihn — beide
    # bauen denselben Text aus quelle.env, jeder auf seine Art.
    sh = (FORK / "bauen.sh").read_text()
    assert 'STEMPEL="${LIVEKIT_VERSION}-pulse${PULSE_REVISION} livekit=${LIVEKIT_COMMIT} mediatransportutil=${MTU_COMMIT}"' in sh
    ps = FETCH_WIN.read_text(encoding="utf-8-sig")
    assert (
        '$LivekitStempel = "$($LivekitQuelle.LIVEKIT_VERSION)-pulse$($LivekitQuelle.PULSE_REVISION) '
        'livekit=$($LivekitQuelle.LIVEKIT_COMMIT) mediatransportutil=$($LivekitQuelle.MTU_COMMIT)"'
    ) in ps
