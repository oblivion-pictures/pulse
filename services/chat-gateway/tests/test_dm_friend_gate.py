"""Friend-gate hart-cut on DM endpoints (Etappe 2).

* POST /dm-channels without friendship → 403 ``not_friends``
* POST /dm-channels with block → 403 ``blocked``
* POST /postfach into a DM without friendship → 403 ``not_friends`` / with
  block → 403 ``blocked`` (bis 2026-11-05 galt das für
  ``POST /channels/{id}/messages``; Klartext nimmt eine DM seither gar nicht
  mehr an)
* GET  /dm-channels / /dm-channels/{id} → ``can_send`` reflects state
"""

from __future__ import annotations

import itertools
import random

import pytest

# DM routes are cloud-only — ensure cloud mode for all tests in this file.
pytestmark = pytest.mark.usefixtures("cloud_mode")


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _register(_auth_signer) -> tuple[str, int]:
    uid = random.randint(1, 1_000_000)
    return _auth_signer.issue_access(uid, f"u{uid}"), uid


# ---- create gate -----------------------------------------------------------


@pytest.mark.asyncio
async def test_create_dm_without_friendship_403_not_friends(
    client, _auth_signer
):
    t_a, _ = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    r = await client.post(
        "/dm-channels",
        json={"target_user_id": str(uid_b)},
        headers=auth(t_a),
    )
    assert r.status_code == 403
    assert r.json()["detail"] == "not_friends"


@pytest.mark.asyncio
async def test_create_dm_when_blocked_403_blocked(client, _auth_signer):
    t_a, uid_a = await _register(_auth_signer)
    t_b, uid_b = await _register(_auth_signer)
    # B blocks A — A still tries to create a DM.
    await client.post(
        "/blocks",
        json={"target_user_id": str(uid_a)},
        headers=auth(t_b),
    )
    r = await client.post(
        "/dm-channels",
        json={"target_user_id": str(uid_b)},
        headers=auth(t_a),
    )
    assert r.status_code == 403
    assert r.json()["detail"] == "blocked"


@pytest.mark.asyncio
async def test_create_dm_with_friendship_succeeds(
    client, _auth_signer, friend_pair
):
    t_a, uid_a = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    r = await client.post(
        "/dm-channels",
        json={"target_user_id": str(uid_b)},
        headers=auth(t_a),
    )
    assert r.status_code == 201
    assert r.json()["can_send"] is True


# ---- send gate -------------------------------------------------------------
#
# Seit 2026-11-05 nimmt eine DM keinen Klartext mehr an (``DM_KLARTEXT_DETAIL``,
# geprüft in ``test_dms.py``). Gesendet wird nur noch verschlüsselt über
# ``POST /postfach`` — und dort sitzt dasselbe Freundschafts-/Block-Gate mit
# denselben Meldungen (``routes/_postfach_deps.py::_channel_zugriff_pruefen``).
# Die beiden Tests prüfen das Gate deshalb auf diesem Weg.

_geraete_zaehler = itertools.count()


async def _geraet(client, token: str) -> str:
    """Veröffentlicht ein frisches Gerät für dieses Konto. Pflicht vor dem
    Einliefern (Spec §3b) — und Empfängergeräte brauchen ein Bündel."""
    pubkey = f"freundgate-{next(_geraete_zaehler):032d}"
    r = await client.put(
        "/keys/bundle",
        json={"device_pubkey": pubkey, "curve25519": "curve-" + pubkey},
        headers=auth(token),
    )
    assert r.status_code == 204, r.text
    return pubkey


async def _einliefern(client, token: str, dm_id: str, absender: str, empfaenger: str):
    return await client.post(
        "/postfach",
        json={
            "channel_id": dm_id,
            "device_pubkey": absender,
            # Base64 von ``olm-umschlag`` — der Inhalt ist dem Server egal.
            "nutzlasten": [{"art": 1, "daten": "b2xtLXVtc2NobGFn", "empfaenger": [empfaenger]}],
        },
        headers=auth(token),
    )


@pytest.mark.asyncio
async def test_send_in_dm_after_unfriend_403(
    client, _auth_signer, friend_pair
):
    t_a, uid_a = await _register(_auth_signer)
    t_b, uid_b = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    dm = (
        await client.post(
            "/dm-channels",
            json={"target_user_id": str(uid_b)},
            headers=auth(t_a),
        )
    ).json()
    geraet_a = await _geraet(client, t_a)
    geraet_b = await _geraet(client, t_b)
    # Send works while friends.
    r0 = await _einliefern(client, t_a, dm["id"], geraet_a, geraet_b)
    assert r0.status_code == 200, r0.text
    # A unfriends B.
    rdel = await client.delete(f"/friends/{uid_b}", headers=auth(t_a))
    assert rdel.status_code == 204
    # Send is now hard-cut.
    r1 = await _einliefern(client, t_a, dm["id"], geraet_a, geraet_b)
    assert r1.status_code == 403
    assert r1.json()["detail"] == "not_friends"


@pytest.mark.asyncio
async def test_send_in_dm_after_block_403(
    client, _auth_signer, friend_pair
):
    t_a, uid_a = await _register(_auth_signer)
    t_b, uid_b = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    dm = (
        await client.post(
            "/dm-channels",
            json={"target_user_id": str(uid_b)},
            headers=auth(t_a),
        )
    ).json()
    geraet_a = await _geraet(client, t_a)
    geraet_b = await _geraet(client, t_b)
    # B blocks A (this also tears down friendship — block_in_place + cut).
    await client.post(
        "/blocks", json={"target_user_id": str(uid_a)}, headers=auth(t_b)
    )
    r = await _einliefern(client, t_a, dm["id"], geraet_a, geraet_b)
    assert r.status_code == 403
    assert r.json()["detail"] == "blocked"


# ---- can_send wire field ---------------------------------------------------


@pytest.mark.asyncio
async def test_list_dm_channels_can_send_true_when_friends(
    client, _auth_signer, friend_pair
):
    t_a, uid_a = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    await client.post(
        "/dm-channels",
        json={"target_user_id": str(uid_b)},
        headers=auth(t_a),
    )
    r = await client.get("/dm-channels", headers=auth(t_a))
    assert r.status_code == 200
    assert r.json()[0]["can_send"] is True


@pytest.mark.asyncio
async def test_list_dm_channels_can_send_false_after_unfriend(
    client, _auth_signer, friend_pair
):
    t_a, uid_a = await _register(_auth_signer)
    _, uid_b = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    await client.post(
        "/dm-channels",
        json={"target_user_id": str(uid_b)},
        headers=auth(t_a),
    )
    await client.delete(f"/friends/{uid_b}", headers=auth(t_a))
    r = await client.get("/dm-channels", headers=auth(t_a))
    assert r.status_code == 200
    # Tombstone DM remains in the list but can_send is false.
    assert len(r.json()) == 1
    assert r.json()[0]["can_send"] is False


@pytest.mark.asyncio
async def test_get_dm_channel_can_send_false_when_blocked(
    client, _auth_signer, friend_pair
):
    t_a, uid_a = await _register(_auth_signer)
    t_b, uid_b = await _register(_auth_signer)
    await friend_pair(uid_a, uid_b)
    dm = (
        await client.post(
            "/dm-channels",
            json={"target_user_id": str(uid_b)},
            headers=auth(t_a),
        )
    ).json()
    await client.post(
        "/blocks", json={"target_user_id": str(uid_a)}, headers=auth(t_b)
    )
    r = await client.get(f"/dm-channels/{dm['id']}", headers=auth(t_a))
    assert r.status_code == 200
    assert r.json()["can_send"] is False
