"""Anruf-Push an Android-Geräte und wer gar nicht per Push klingelt
(Push-Bughunt 2026-10-20).

Android-Bauten mit der Fähigkeit ``anruf_push`` bekommen einen FCM-Datenpush
nach denselben Regeln wie die iOS-Geräte ihren VoIP-Push (``anruf_push.py``).
„Nicht stören“ und die stumme Gruppe schweigen den Push; wer in einer Gruppe
mit dem Anrufer eine Blockierung hat, wird gar nicht angeklingelt.
"""

from __future__ import annotations

import pytest
from dcc_chat_gateway import anruf_push_fcm
from dcc_chat_gateway.models import FcmToken, PrivateGroupMember, UserBlock
from dcc_chat_gateway.presence_keys import PRESENCE_STATUS_KEY
from dcc_chat_gateway.routes import anrufe as anrufe_routen
from sqlalchemy import select, update

from .test_anruf_push import _anrufen, _dm, _gesendet, _iphone, _konto, apple  # noqa: F401

pytestmark = pytest.mark.usefixtures("cloud_mode")


@pytest.fixture
def telefone(apple, monkeypatch):  # noqa: F811
    """Wie ``apple``, dazu Firebase: beide schreiben (token, art) in dieselbe
    Mitschrift; die vollen Android-Nutzlasten zusätzlich nach ``daten``."""
    daten: list[dict[str, str]] = []

    def _fcm(*, token, daten: dict[str, str]):  # noqa: F811
        apple.append((token, daten["art"]))
        _fcm.alle.append(daten)
        return _fcm.ausgang

    _fcm.alle = daten
    _fcm.ausgang = "ok"
    monkeypatch.setattr(anruf_push_fcm, "verfuegbar", lambda: True)
    monkeypatch.setattr(anruf_push_fcm, "_send_one", _fcm)
    return _fcm


async def _android(client, heads: dict, uid: int, gid: str, faehig: bool = True) -> str:
    token = f"fcm-{uid}-{gid}"
    r = await client.post(
        "/fcm/token",
        json={
            "token": token,
            "geraet_id": gid,
            **({"faehigkeiten": ["anruf_push"]} if faehig else {}),
        },
        headers=heads,
    )
    assert r.status_code == 204, r.text
    return token


# MARK: - Android


@pytest.mark.asyncio
async def test_android_mit_faehigkeit_klingelt_aeltere_bauten_nicht(
    client, _auth_signer, friend_pair, apple, telefone  # noqa: F811
):
    heads_a, uid_a = _konto(_auth_signer)
    heads_b, uid_b = _konto(_auth_signer)
    b1 = await _iphone(client, heads_b, uid_b, "b1")
    pixel = await _android(client, heads_b, uid_b, "pixel")
    await _android(client, heads_b, uid_b, "alt", faehig=False)
    dm = await _dm(client, friend_pair, heads_a, uid_a, uid_b)

    call_id = await _anrufen(client, heads_a, "dm", dm)
    assert await _gesendet(apple) == sorted([(b1, "klingelt"), (pixel, "klingelt")])
    assert telefone.alle == [
        {
            "type": "anruf",
            "art": "klingelt",
            "call_id": call_id,
            "anruf_art": "dm",
            "channel_id": dm,
            "einleiter_id": str(uid_a),
            "einleiter_name": f"u{uid_a}",
        }
    ]

    r = await client.post(f"/anrufe/{call_id}/auflegen", json={"geraet_id": "a1"}, headers=heads_a)
    assert r.status_code == 204
    assert await _gesendet(apple) == sorted([(b1, "abbruch"), (pixel, "abbruch")])
    assert telefone.alle[-1] == {"type": "anruf", "art": "abbruch", "call_id": call_id}


@pytest.mark.asyncio
async def test_annehmendes_android_geraet_bekommt_keinen_abbruch(
    client, _auth_signer, friend_pair, apple, telefone  # noqa: F811
):
    heads_a, uid_a = _konto(_auth_signer)
    heads_b, uid_b = _konto(_auth_signer)
    b1 = await _iphone(client, heads_b, uid_b, "b1")
    await _android(client, heads_b, uid_b, "pixel")
    dm = await _dm(client, friend_pair, heads_a, uid_a, uid_b)
    call_id = await _anrufen(client, heads_a, "dm", dm)
    await _gesendet(apple)

    r = await client.post(
        f"/anrufe/{call_id}/annehmen", json={"geraet_id": "pixel"}, headers=heads_b
    )
    assert r.status_code == 204
    assert await _gesendet(apple) == [(b1, "abbruch")]


@pytest.mark.asyncio
async def test_toter_android_token_faellt(
    client, _auth_signer, friend_pair, apple, telefone, session_factory  # noqa: F811
):
    heads_a, uid_a = _konto(_auth_signer)
    heads_b, uid_b = _konto(_auth_signer)
    await _android(client, heads_b, uid_b, "pixel")
    dm = await _dm(client, friend_pair, heads_a, uid_a, uid_b)
    telefone.ausgang = "dead"
    await _anrufen(client, heads_a, "dm", dm)
    await _gesendet(apple)
    async with session_factory() as s:
        zeile = (await s.execute(select(FcmToken).where(FcmToken.user_id == uid_b))).scalar()
    assert zeile is None


# MARK: - Wer nicht per Push klingelt


@pytest.mark.asyncio
async def test_nicht_stoeren_schweigt_den_push_aber_nicht_die_websocket(
    app, client, _auth_signer, friend_pair, apple, telefone, monkeypatch  # noqa: F811
):
    heads_a, uid_a = _konto(_auth_signer)
    heads_b, uid_b = _konto(_auth_signer)
    await _iphone(client, heads_b, uid_b, "b1")
    await _android(client, heads_b, uid_b, "pixel")
    dm = await _dm(client, friend_pair, heads_a, uid_a, uid_b)
    await app.state.redis.set(PRESENCE_STATUS_KEY.format(user_id=uid_b), "dnd", ex=60)
    gemeldet: list[int] = []

    async def _publish(_request, konten, _ereignis):
        gemeldet.extend(konten)

    monkeypatch.setattr(anrufe_routen, "_publish", _publish)
    try:
        await _anrufen(client, heads_a, "dm", dm)
        assert await _gesendet(apple) == []
        assert gemeldet == [uid_b]
    finally:
        await app.state.redis.delete(PRESENCE_STATUS_KEY.format(user_id=uid_b))


async def _gruppe(client, heads_a, *mitglieder: int) -> str:
    gid = (await client.post("/gruppen", json={"name": "G"}, headers=heads_a)).json()["id"]
    for uid in mitglieder:
        r = await client.post(
            f"/gruppen/{gid}/mitglieder", json={"user_id": str(uid)}, headers=heads_a
        )
        assert r.status_code == 201, r.text
    return gid


@pytest.mark.asyncio
async def test_stumme_gruppe_klingelt_nicht_per_push(
    client, _auth_signer, apple, telefone, session_factory, _isolate_chat_settings  # noqa: F811
):
    _isolate_chat_settings.private_groups_enabled = True
    heads_a, _ = _konto(_auth_signer)
    heads_b, uid_b = _konto(_auth_signer)
    heads_c, uid_c = _konto(_auth_signer)
    gid = await _gruppe(client, heads_a, uid_b, uid_c)
    await _android(client, heads_b, uid_b, "pixel")
    c1 = await _iphone(client, heads_c, uid_c, "c1")
    async with session_factory() as s:
        await s.execute(
            update(PrivateGroupMember)
            .where(PrivateGroupMember.gruppe_id == int(gid), PrivateGroupMember.user_id == uid_b)
            .values(stumm=True)
        )
        await s.commit()

    await _anrufen(client, heads_a, "gruppe", gid)
    assert await _gesendet(apple) == [(c1, "klingelt")]


@pytest.mark.asyncio
async def test_blockierung_in_der_gruppe_laesst_gar_nicht_klingeln(
    client, _auth_signer, apple, telefone, session_factory, monkeypatch,  # noqa: F811
    _isolate_chat_settings,
):
    """Beide Richtungen: B hat A blockiert, A hat C blockiert — nur D klingelt,
    weder per Push noch über die WebSocket."""
    _isolate_chat_settings.private_groups_enabled = True
    heads_a, uid_a = _konto(_auth_signer)
    heads_b, uid_b = _konto(_auth_signer)
    heads_c, uid_c = _konto(_auth_signer)
    heads_d, uid_d = _konto(_auth_signer)
    gid = await _gruppe(client, heads_a, uid_b, uid_c, uid_d)
    await _iphone(client, heads_b, uid_b, "b1")
    await _android(client, heads_c, uid_c, "pixel")
    d1 = await _iphone(client, heads_d, uid_d, "d1")
    async with session_factory() as s:
        s.add(UserBlock(blocker_id=uid_b, blocked_id=uid_a))
        s.add(UserBlock(blocker_id=uid_a, blocked_id=uid_c))
        await s.commit()
    gemeldet: list[int] = []

    async def _publish(_request, konten, _ereignis):
        gemeldet.extend(konten)

    monkeypatch.setattr(anrufe_routen, "_publish", _publish)
    await _anrufen(client, heads_a, "gruppe", gid)
    assert await _gesendet(apple) == [(d1, "klingelt")]
    assert gemeldet == [uid_d]
