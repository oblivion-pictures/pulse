"""Zustimmung zu den Nutzungsbedingungen (``dcc_auth/agb.py``).

Registrierung ohne Häkchen, Nachweis am Konto, nachträgliche Zustimmung von
Bestandskonten und der Self-Host-Fall, in dem die howispulse.com-AGB nicht
gelten. Dazu der Abgleich der Fassung mit dem „Stand“ im AGB-Text.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
from sqlalchemy import select, update

import dcc_auth.config as cfg
import dcc_auth.routes as routes_mod
import dcc_auth.routes_agb as routes_agb_mod
from dcc_auth.agb import AGB_FASSUNG
from dcc_auth.models import User

_PW = "correct horse battery staple"
_AGB_MD = Path(__file__).resolve().parents[3] / "web" / "src" / "lib" / "legal" / "agb.md"
_MONATE = {
    "Januar": 1, "Februar": 2, "März": 3, "April": 4, "Mai": 5, "Juni": 6,
    "Juli": 7, "August": 8, "September": 9, "Oktober": 10, "November": 11, "Dezember": 12,
}


def _reg(name: str, **extra) -> dict:
    return {"username": name, "email": f"{name}@dcc-test.example.com", "password": _PW, **extra}


def _selfhost_settings():
    return cfg.get_settings().model_copy(
        update={"pulse_instance_mode": "self-host", "allow_local_accounts": True}
    )


def _auth(tokens: dict) -> dict:
    return {"Authorization": f"Bearer {tokens['access_token']}"}


@pytest.mark.asyncio
async def test_ohne_haekchen_kein_konto(client, session_factory):
    r = await client.post("/register", json=_reg("ohneagb", agb_akzeptiert=False))
    assert r.status_code == 422, r.text
    assert r.json()["detail"] == {"error": "agb_required"}
    async with session_factory() as s:
        assert await s.scalar(select(User).where(User.username == "ohneagb")) is None


@pytest.mark.asyncio
async def test_mit_haekchen_wird_fassung_gespeichert(client, session_factory):
    r = await client.post("/register", json=_reg("mitagb", agb_akzeptiert=True))
    assert r.status_code == 201, r.text
    async with session_factory() as s:
        user = await s.scalar(select(User).where(User.username == "mitagb"))
        assert user.agb_fassung == AGB_FASSUNG
        assert user.agb_akzeptiert_am is not None
    me = (await client.get("/me", headers=_auth(r.json()))).json()
    assert me["agb_zustimmung_noetig"] is False
    assert me["agb_fassung_aktuell"] == AGB_FASSUNG


@pytest.mark.asyncio
async def test_bestandskonto_stimmt_nachtraeglich_zu(client, session_factory):
    tokens = (await client.post("/register", json=_reg("bestand"))).json()
    # Bestandskonto nachstellen: vor Migration 0059 angelegt, nie zugestimmt.
    async with session_factory() as s:
        await s.execute(
            update(User)
            .where(User.username == "bestand")
            .values(agb_fassung=None, agb_akzeptiert_am=None)
        )
        await s.commit()
    me = (await client.get("/me", headers=_auth(tokens))).json()
    assert me["agb_zustimmung_noetig"] is True

    veraltet = await client.post(
        "/me/agb-zustimmung", json={"fassung": "2000-01-01"}, headers=_auth(tokens)
    )
    assert veraltet.status_code == 409
    assert veraltet.json()["detail"] == {"error": "agb_fassung_veraltet", "aktuell": AGB_FASSUNG}
    me = (await client.get("/me", headers=_auth(tokens))).json()
    assert me["agb_zustimmung_noetig"] is True

    ok = await client.post(
        "/me/agb-zustimmung", json={"fassung": AGB_FASSUNG}, headers=_auth(tokens)
    )
    assert ok.status_code == 204, ok.text
    me = (await client.get("/me", headers=_auth(tokens))).json()
    assert me["agb_zustimmung_noetig"] is False


@pytest.mark.asyncio
async def test_zustimmung_verlangt_anmeldung(client):
    r = await client.post("/me/agb-zustimmung", json={"fassung": AGB_FASSUNG})
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_selfhost_fragt_nicht(client, monkeypatch):
    monkeypatch.setattr(routes_mod, "get_settings", _selfhost_settings)
    monkeypatch.setattr(routes_agb_mod, "get_settings", _selfhost_settings)
    r = await client.post("/register", json=_reg("insel", agb_akzeptiert=False))
    assert r.status_code == 201, r.text
    me = (await client.get("/me", headers=_auth(r.json()))).json()
    assert me["agb_zustimmung_noetig"] is False
    assert me["agb_fassung_aktuell"] is None
    z = await client.post(
        "/me/agb-zustimmung", json={"fassung": AGB_FASSUNG}, headers=_auth(r.json())
    )
    assert z.status_code == 404


def test_fassung_entspricht_dem_stand_der_agb():
    """Wer die AGB ändert und das Datum nachzieht, zieht ``AGB_FASSUNG`` mit.

    Sonst stimmen neue Konten einer Fassung zu, die nicht die angezeigte ist,
    und Bestandskonten sehen den Dialog zur Änderung nie.
    """
    text = _AGB_MD.read_text(encoding="utf-8")
    treffer = re.findall(r"^Stand: (\d{1,2})\. (\w+) (\d{4})$", text, flags=re.MULTILINE)
    assert len(treffer) == 1, f"genau eine Zeile 'Stand: …' erwartet, gefunden: {treffer}"
    tag, monat, jahr = treffer[0]
    assert f"{jahr}-{_MONATE[monat]:02d}-{int(tag):02d}" == AGB_FASSUNG
