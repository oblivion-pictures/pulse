"""Der MediaMTX-Fork (infra/mediamtx-fork/) auf dem Windows-Weg — hält jede Stelle?

Seit 2026-10-14 baut die Windows-Server-App ihr `mediamtx.exe` selbst aus dem
Fork (`infra/mediamtx-fork/bauen.sh`, gerufen von `fetch-win-native.ps1`);
vorher lud sie das offizielle Release ohne einen Patch. Bricht eine der
Verbindungen unten, bricht nichts sichtbar: der Installer bekäme still einen
anderen Stand als das Linux-Bild. Gegenstück zu `test_livekit_fork.py`.
"""

from __future__ import annotations

import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
FORK = REPO / "infra" / "mediamtx-fork"
FETCH_WIN = REPO / "desktop" / "scripts" / "fetch-win-native.ps1"
WIN_SERVER = REPO / ".github" / "workflows" / "win-build-server.yml"


def _arg(name: str) -> str:
    m = re.search(rf"^ARG {name}=(\S+)$", (FORK / "Dockerfile").read_text(), re.M)
    assert m, f"ARG {name} fehlt im Dockerfile"
    return m[1]


def test_dockerfile_nennt_fassung_und_revision() -> None:
    assert re.fullmatch(r"\d+\.\d+\.\d+", _arg("MEDIAMTX_VERSION"))
    assert re.fullmatch(r"\d+", _arg("PULSE_REVISION"))


def test_windows_bau_loest_beim_fork_aus_und_baut_ihn() -> None:
    wf = WIN_SERVER.read_text()
    zeilen = [z.strip() for z in wf.splitlines()]
    assert any(z.startswith("- 'infra/mediamtx-fork/**'") for z in zeilen)
    assert "-MediamtxSource" in wf


def test_windows_nimmt_den_fork_statt_des_releases() -> None:
    win = FETCH_WIN.read_text(encoding="utf-8-sig")
    assert "infra\\mediamtx-fork\\bauen.sh" in win
    assert "infra\\mediamtx-fork\\Dockerfile" in win
    assert "bluenviron/mediamtx/releases" not in win


def test_windows_go_fassung_passt_zum_dockerfile() -> None:
    win = re.search(r"go-version: '([^']+)'", WIN_SERVER.read_text())
    assert win and win[1].startswith(_arg("GO_VERSION") + "."), (win and win[1], _arg("GO_VERSION"))


def test_stempel_ist_in_bash_und_powershell_wortgleich_gebaut() -> None:
    sh = (FORK / "bauen.sh").read_text()
    assert 'STEMPEL="${MEDIAMTX_VERSION}-pulse${PULSE_REVISION}"' in sh
    ps = FETCH_WIN.read_text(encoding="utf-8-sig")
    assert '$MediamtxStempel = "$($MediamtxArg.MEDIAMTX_VERSION)-pulse$($MediamtxArg.PULSE_REVISION)"' in ps


# ── Schalter des Forks: überall dieselben ──────────────────────────────────

S6_RUN = REPO / "infra" / "self-host" / "s6" / "etc" / "s6-overlay" / "s6-rc.d" / "mediamtx" / "run"
COMPOSES = {
    "Cloud": REPO / "infra" / "prod" / "docker-compose.yml",
    "Remote-Dev-Stack": REPO / "infra" / "dev-remote" / "docker-compose.yml",
    "lokaler Dev-Stack": REPO / "streaming" / "server" / "docker-compose.yml",
}


def _schalter_im_image() -> dict[str, str]:
    return dict(re.findall(r"^(PULSE_[A-Z_]+)=(\S+) \\$", S6_RUN.read_text(), re.M))


def _schalter_in(compose: Path) -> dict[str, str]:
    import yaml

    umgebung = yaml.safe_load(compose.read_text())["services"]["mediamtx"].get("environment") or {}
    return {k: str(v) for k, v in umgebung.items() if k.startswith("PULSE_")}


def test_alle_mediamtx_laufen_mit_denselben_schaltern() -> None:
    """Self-Host-Image, Cloud und beide Dev-Stacks setzen dieselben Schalter.

    **Der Anlass** (2026-10-14): FlexFEC lief in der Cloud und auf dem
    Remote-Dev-Stack, fehlte aber im Self-Host-Image — ohne festgehaltenen
    Grund, unter einem Kommentar, der „identisch zur Cloud" behauptete. Die
    Windows-Server-App gleicht `desktop/test/localBackend/nativeBackend.test.ts`
    gegen das Image ab; zusammen ist damit jede Abweichung ein roter Test.
    """
    image = _schalter_im_image()
    assert len(image) >= 9, f"run-Datei nicht mehr lesbar? {image}"
    for name, compose in COMPOSES.items():
        assert _schalter_in(compose) == image, name
