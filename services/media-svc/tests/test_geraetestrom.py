"""Der Strom eines Standplatz-Geräts in media-svc (seit 2026-10-16).

Der chat-gateway entscheidet, wer einem Gerätestrom zusehen darf
(``geraete_zuschauen.py`` dort). media-svc hält die zweite Hälfte: das Merkmal
``device_id`` reist im Token-Datensatz mit, und ``GET /whep`` stellt für einen
Datensatz mit Merkmal nur aus, wenn der Gateway genau dieses Gerät freigegeben
hat — die Entscheidung fällt am selben Datensatz, aus dem der Pfad kommt.
"""

from __future__ import annotations

import json
import uuid

import pytest

from dcc_media_svc.streamkeys import TOKEN_KEY, active_key
from dcc_shared.streaming import read_cache_key


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _cid() -> str:
    return str(abs(hash(uuid.uuid4())) & ((1 << 53) - 1))


@pytest.mark.asyncio
async def test_device_id_reist_im_token_datensatz(client, auth_signer, redis):
    access = auth_signer.issue_access(4244, "alice")
    cid = _cid()
    r = await client.post(
        f"/channels/{cid}/stream-token", json={"device_id": "987"}, headers=_auth(access)
    )
    assert r.status_code == 200, r.text
    token = r.json()["token"]
    try:
        rec = json.loads(await redis.get(TOKEN_KEY.format(token=token)))
        assert rec["device_id"] == "987"
    finally:
        await redis.delete(TOKEN_KEY.format(token=token))
    # Unsinn wird abgewiesen, nicht durchgereicht.
    r = await client.post(
        f"/channels/{cid}/stream-token", json={"device_id": "x1"}, headers=_auth(access)
    )
    assert r.status_code == 422


async def _aktiv(redis, cid: str, slot: int = 0, **extra) -> str:
    key = active_key(cid, "42", slot)
    path = f"channel-{cid}-42{'' if slot == 0 else f'-s{slot}'}-{'deadbeef' * 4}"
    await redis.set(key, json.dumps({"user_id": "42", "path": path, **extra}))
    return key


@pytest.mark.asyncio
async def test_geraetestrom_nur_mit_freigabe_des_gateways(client, auth_signer, redis):
    access = auth_signer.issue_access(9, "bob")
    cid = _cid()
    key = await _aktiv(redis, cid, slot=1, device_id="555")
    cache = read_cache_key("9", cid, "42", 1)
    try:
        # Ohne ``geraet``: 403, und es entsteht kein Lese-Token.
        r = await client.get(f"/channels/{cid}/whep?user_id=42&slot=1", headers=_auth(access))
        assert r.status_code == 403
        assert await redis.get(cache) is None
        # Freigabe für ein ANDERES Gerät: ebenfalls 403 (Wettlauf-Riegel).
        r = await client.get(
            f"/channels/{cid}/whep?user_id=42&slot=1&geraet=556", headers=_auth(access)
        )
        assert r.status_code == 403
        # Für genau dieses Gerät: Token, an den Platz gebunden.
        r = await client.get(
            f"/channels/{cid}/whep?user_id=42&slot=1&geraet=555", headers=_auth(access)
        )
        assert r.status_code == 200, r.text
        token = r.json()["whep_url"].partition("token=")[2]
        rec = json.loads(await redis.get(TOKEN_KEY.format(token=token)))
        assert rec["slot"] == 1
        assert rec["device_id"] == "555"
        await redis.delete(TOKEN_KEY.format(token=token))
    finally:
        await redis.delete(key, cache)


@pytest.mark.asyncio
async def test_normaler_strom_ohne_platzbindung(client, auth_signer, redis):
    """Ein Strom ohne Merkmal bleibt, wie er war — auch wenn der Gateway ein
    Gerät nennt (das Merkmal ist inzwischen weg): Token ohne ``slot``."""
    access = auth_signer.issue_access(10, "carl")
    cid = _cid()
    key = await _aktiv(redis, cid)
    cache = read_cache_key("10", cid, "42", 0)
    try:
        r = await client.get(f"/channels/{cid}/whep?user_id=42&geraet=555", headers=_auth(access))
        assert r.status_code == 200, r.text
        token = r.json()["whep_url"].partition("token=")[2]
        rec = json.loads(await redis.get(TOKEN_KEY.format(token=token)))
        assert "slot" not in rec and "device_id" not in rec
        await redis.delete(TOKEN_KEY.format(token=token))
    finally:
        await redis.delete(key, cache)


@pytest.mark.asyncio
async def test_gast_bekommt_nie_einen_geraetestrom(client, auth_signer, redis):
    cid = _cid()
    key = await _aktiv(redis, cid, device_id="555")
    await redis.delete("gast:gesperrt:gast-88")
    ticket = auth_signer.issue_gast(
        gast_id="gast-88", guild_id="9", channel_id=cid, name="Gast", ttl_s=3600
    )
    try:
        r = await client.get(f"/gast/whep?channel_id={cid}&user_id=42", headers=_auth(ticket))
        assert r.status_code == 403
    finally:
        await redis.delete(key, read_cache_key("gast-88", cid, "42", 0))
