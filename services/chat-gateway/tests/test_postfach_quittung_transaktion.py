"""Die Quittung schreibt Löschung und Zustellstände in EINER Transaktion fest.

Push-Bughunt 2026-10-21, Befund 5: ``postfach_quittung`` committete die
gelöschten Zustellungen (das ``commit`` stand eingerückt IN der Schleife über
die Nutzlasten), BEVOR ``zustellstaende_speichern`` lief. Warf das, antwortete
der Server 500 — der Klient wertete die Quittung als gescheitert, die
Zustellungen waren aber schon weg. Jetzt fällt die Löschung mit dem Fehler
zurück, und die Zustellung kommt beim nächsten Abholen wieder.
"""

from __future__ import annotations

import base64
import random

import pytest
import pytest_asyncio

pytestmark = pytest.mark.usefixtures("cloud_mode")


@pytest_asyncio.fixture(autouse=True)
async def _enable_sqlite_foreign_keys(engine):
    """Wie in ``test_postfach.py``: ohne PRAGMA ignoriert SQLite die Kaskaden."""
    async with engine.begin() as conn:
        await conn.exec_driver_sql("PRAGMA foreign_keys = ON")


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _konto(_auth_signer) -> tuple[str, int]:
    uid = random.randint(1, 1_000_000)
    return _auth_signer.issue_access(uid, f"u{uid}"), uid


async def _geraet(client, token: str, name: str) -> str:
    pubkey = f"geraet-{name}-{random.randint(0, 10**12):030d}"
    r = await client.put(
        "/keys/bundle",
        json={"device_pubkey": pubkey, "curve25519": "curve-" + pubkey},
        headers=_auth(token),
    )
    assert r.status_code == 204, r.text
    return pubkey


@pytest.mark.asyncio
async def test_scheiternde_zustellstaende_lassen_die_zustellung_liegen(
    client, session_factory, _auth_signer, friend_pair, monkeypatch
):
    from dcc_chat_gateway.models import DmNutzlast, DmZustellung
    from dcc_chat_gateway.routes import postfach_abholen
    from sqlalchemy import select

    token_a, uid_a = await _konto(_auth_signer)
    token_b, uid_b = await _konto(_auth_signer)
    await friend_pair(uid_a, uid_b)
    r = await client.post(
        "/dm-channels", json={"target_user_id": str(uid_b)}, headers=_auth(token_a)
    )
    assert r.status_code == 201, r.text
    dm_id = r.json()["id"]

    sender = await _geraet(client, token_a, "a")
    empfaenger = await _geraet(client, token_b, "b")
    r = await client.post(
        "/postfach",
        json={
            "channel_id": dm_id,
            "device_pubkey": sender,
            "nutzlasten": [
                {
                    "art": 1,
                    "daten": base64.b64encode(b"olm-umschlag").decode(),
                    "empfaenger": [empfaenger],
                }
            ],
        },
        headers=_auth(token_a),
    )
    assert r.status_code == 200, r.text

    r = await client.post(
        "/postfach/abholen", json={"device_pubkey": empfaenger}, headers=_auth(token_b)
    )
    zustellung_id = r.json()[0]["id"]

    async def _kaputt(*_args, **_kwargs):
        raise RuntimeError("Zustellstand nicht schreibbar")

    echt = postfach_abholen.zustellstaende_speichern
    monkeypatch.setattr(postfach_abholen, "zustellstaende_speichern", _kaputt)

    with pytest.raises(RuntimeError):
        await client.post(
            "/postfach/quittung",
            json={"device_pubkey": empfaenger, "zustellung_ids": [zustellung_id]},
            headers=_auth(token_b),
        )

    async with session_factory() as s:
        zustellungen = (await s.execute(select(DmZustellung.id))).scalars().all()
        nutzlasten = (await s.execute(select(DmNutzlast.id))).scalars().all()
    assert [str(z) for z in zustellungen] == [zustellung_id]
    assert len(nutzlasten) == 1

    # Und ohne Störung gelingt dieselbe Quittung beim nächsten Versuch.
    monkeypatch.setattr(postfach_abholen, "zustellstaende_speichern", echt)
    r = await client.post(
        "/postfach/quittung",
        json={"device_pubkey": empfaenger, "zustellung_ids": [zustellung_id]},
        headers=_auth(token_b),
    )
    assert r.status_code == 204, r.text
    r = await client.post(
        "/postfach/abholen", json={"device_pubkey": empfaenger}, headers=_auth(token_b)
    )
    assert r.json() == []
