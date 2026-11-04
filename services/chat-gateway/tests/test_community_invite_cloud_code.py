"""Security-Scan 2026-11-04: Beitritt in fremde Cloud-Communities ohne Einladung.

Der Freundes-Weg (``POST /community-invites``) übernahm für ein Cloud-Ziel
``target_guild_id`` und ``code`` ungeprüft, und ``accept`` trat danach direkt
bei — der Code wurde nie angesehen. Zwei befreundete Konten eines Angreifers
genügten, um jeder privaten Community beizutreten, deren Kennung er kennt.

Jetzt gilt für Cloud-Ziele: der Code muss eine lebende ``GuildInvite`` genau
dieser Community sein (beim Anlegen geprüft) und wird beim Annehmen wie auf
dem normalen Einladungsweg atomar verbraucht.
"""

from __future__ import annotations

import random

import pytest
from dcc_chat_gateway.models import CommunityInviteNotification, GuildInvite, GuildMember

pytestmark = pytest.mark.usefixtures("cloud_mode")

CLOUD = "https://howispulse.com"


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _konto(_auth_signer) -> tuple[str, int]:
    uid = random.randint(1, 1_000_000)
    return _auth_signer.issue_access(uid, f"u{uid}"), uid


async def _community(client, token: str) -> str:
    r = await client.post("/guilds", json={"name": "Privat"}, headers=auth(token))
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


async def _code(client, token: str, gid: str) -> str:
    r = await client.post(
        f"/guilds/{gid}/invites",
        json={"max_uses": 1, "expires_in_seconds": 86400},
        headers=auth(token),
    )
    assert r.status_code == 201, r.text
    return r.json()["code"]


def _einladung(invitee: int, gid: str, code: str) -> dict:
    return {
        "invitee_id": str(invitee),
        "target_host": CLOUD,
        "target_guild_id": gid,
        "target_guild_name": "x",
        "code": code,
    }


async def _annehmen(client, token: str) -> int:
    offen = (await client.get("/me/community-invites", headers=auth(token))).json()
    assert len(offen) == 1, offen
    r = await client.post(f"/me/community-invites/{offen[0]['id']}/accept", headers=auth(token))
    return r.status_code


async def test_erfundener_code_fuer_fremde_community_wird_abgelehnt(
    client, _auth_signer, friend_pair, session_factory
):
    t_owner, _ = _konto(_auth_signer)
    gid = await _community(client, t_owner)  # private Community eines Dritten
    t_a, uid_a = _konto(_auth_signer)
    t_b, uid_b = _konto(_auth_signer)
    await friend_pair(uid_a, uid_b)

    r = await client.post(
        "/community-invites", json=_einladung(uid_b, gid, "egal"), headers=auth(t_a)
    )
    assert r.status_code == 404, r.text
    async with session_factory() as s:
        assert await s.get(GuildMember, (int(gid), uid_b)) is None


async def test_code_einer_anderen_community_wird_abgelehnt(
    client, _auth_signer, friend_pair
):
    """Ein echter Code der EIGENEN Community taugt nicht als Schlüssel für eine fremde."""
    t_owner, _ = _konto(_auth_signer)
    fremd = await _community(client, t_owner)
    t_a, uid_a = _konto(_auth_signer)
    _, uid_b = _konto(_auth_signer)
    await friend_pair(uid_a, uid_b)
    eigener_code = await _code(client, t_a, await _community(client, t_a))

    r = await client.post(
        "/community-invites", json=_einladung(uid_b, fremd, eigener_code), headers=auth(t_a)
    )
    assert r.status_code == 404, r.text


async def test_gefaelschte_altzeile_fuehrt_nicht_zum_beitritt(
    client, _auth_signer, session_factory
):
    """Zeilen, die vor dem Fix über die Lücke angelegt wurden, dürfen beim
    Annehmen nicht mehr durchgehen."""
    t_owner, _ = _konto(_auth_signer)
    gid = await _community(client, t_owner)
    t_b, uid_b = _konto(_auth_signer)
    async with session_factory() as s:
        s.add(
            CommunityInviteNotification(
                id=random.randint(10**15, 10**16),
                guild_id=int(gid),
                inviter_user_id=1,
                invitee_user_id=uid_b,
                target_host=None,
                code="GEFAELSCHT",
                guild_name="x",
            )
        )
        await s.commit()

    assert await _annehmen(client, t_b) == 404
    async with session_factory() as s:
        assert await s.get(GuildMember, (int(gid), uid_b)) is None


async def test_echte_einladung_tritt_bei_und_verbraucht_den_code(
    client, _auth_signer, friend_pair, session_factory
):
    t_a, uid_a = _konto(_auth_signer)
    t_b, uid_b = _konto(_auth_signer)
    await friend_pair(uid_a, uid_b)
    gid = await _community(client, t_a)
    code = await _code(client, t_a, gid)

    r = await client.post(
        "/community-invites", json=_einladung(uid_b, gid, code), headers=auth(t_a)
    )
    assert r.status_code == 201, r.text
    assert await _annehmen(client, t_b) == 200
    async with session_factory() as s:
        assert await s.get(GuildMember, (int(gid), uid_b)) is not None
        assert (await s.get(GuildInvite, code)).uses == 1
