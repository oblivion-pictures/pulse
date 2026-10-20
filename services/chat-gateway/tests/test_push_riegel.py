"""Wer einen Push NICHT bekommt, und was nicht ins Log darf (Push-Bughunt
2026-10-20).

* Gruppen-Push: nicht an Mitglieder, die mit dem Absender eine Blockierung
  haben; nicht an wer in der Wartezeit ausgetreten ist.
* Eine bearbeitete DM mit neuer Erwähnung schickt keinen Erwähnungs-Push
  (er trug den Klartext).
* Web-Push-Abos merken sich ihre Anmelde-Kette (Migration 0108).
* Die Datenbank-Engine verrät keine gebundenen Parameter.
"""

from __future__ import annotations

import pytest
from dcc_chat_gateway import geraetetoken_abgleich
from dcc_chat_gateway.models import PrivateGroupMember, UserBlock, WebPushSubscription
from dcc_chat_gateway.routes import messages as messages_routen
from sqlalchemy import delete, select

from .conftest import make_auth_header
from .test_fcm_warteschlange import _abarbeiten, _leer, _senden, schlange, sender  # noqa: F401
from .test_gruppe_stumm_push import _gruppen_szene, web_push  # noqa: F401
from .test_haekchen import gruppen_an  # noqa: F401

pytestmark = pytest.mark.usefixtures("cloud_mode")


# MARK: - Gruppen-Push


@pytest.mark.asyncio
@pytest.mark.parametrize("richtung", ["b_blockiert_a", "a_blockiert_b"])
async def test_gruppen_push_nicht_bei_blockierung(
    app, client, session_factory, _auth_signer, friend_pair, sender, schlange, gruppen_an,  # noqa: F811
    web_push, richtung,  # noqa: F811
):
    sz = await _gruppen_szene(client, session_factory, _auth_signer, friend_pair)
    blocker, blockiert = (
        (sz["uid_b"], sz["uid_a"]) if richtung == "b_blockiert_a" else (sz["uid_a"], sz["uid_b"])
    )
    async with session_factory() as s:
        s.add(UserBlock(blocker_id=blocker, blocked_id=blockiert))
        await s.commit()
    await _senden(client, sz)  # zugestellt wird trotzdem (Status 200)
    await _abarbeiten(app.state.connection_manager)
    assert sender == []
    assert web_push == []
    assert await _leer(schlange)


@pytest.mark.asyncio
async def test_ausgetreten_in_der_wartezeit_bekommt_den_push_nicht(
    app, client, session_factory, _auth_signer, friend_pair, sender, schlange, gruppen_an,  # noqa: F811
):
    sz = await _gruppen_szene(client, session_factory, _auth_signer, friend_pair)
    await _senden(client, sz)
    async with session_factory() as s:
        await s.execute(
            delete(PrivateGroupMember).where(
                PrivateGroupMember.gruppe_id == int(sz["dm"]),
                PrivateGroupMember.user_id == sz["uid_b"],
            )
        )
        await s.commit()
    await _abarbeiten(app.state.connection_manager)
    assert sender == []
    assert await _leer(schlange)


# MARK: - Bearbeitete DM


@pytest.mark.asyncio
async def test_bearbeitete_dm_mit_neuer_erwaehnung_schickt_keinen_erwaehnungs_push(
    client, _auth_signer, friend_pair, monkeypatch
):
    aufrufe: list[dict] = []

    async def _fake(**kwargs):
        aufrufe.append(kwargs)

    monkeypatch.setattr(messages_routen, "fan_out_mention_push", _fake)
    t_a = _auth_signer.issue_access(810_001, "u810001")
    uid_b = 810_002
    await friend_pair(810_001, uid_b)
    dm = (
        await client.post(
            "/dm-channels", json={"target_user_id": str(uid_b)}, headers=make_auth_header(t_a)
        )
    ).json()["id"]
    r = await client.post(
        f"/channels/{dm}/messages", json={"content": "hallo"}, headers=make_auth_header(t_a)
    )
    assert r.status_code == 201, r.text
    r = await client.patch(
        f"/messages/{r.json()['id']}",
        json={"content": f"hallo <@{uid_b}>"},
        headers=make_auth_header(t_a),
    )
    assert r.status_code == 200, r.text
    # Die Erwähnung zählt (Ereignis, Markierung) — nur der Push entfällt.
    assert any(m["id"] == str(uid_b) for m in r.json()["mentions"])
    assert aufrufe == []


# MARK: - Web-Push-Abo und Anmelde-Kette


_ABO = {
    "endpoint": "https://fcm.googleapis.com/fcm/send/abo-1",
    "keys": {"p256dh": "BLpubkey", "auth": "geheim"},
}


async def _kette_des_abos(session_factory, uid: int) -> list[str | None]:
    async with session_factory() as s:
        zeilen = await s.execute(
            select(WebPushSubscription.kette).where(WebPushSubscription.user_id == uid)
        )
        return list(zeilen.scalars())


@pytest.mark.asyncio
async def test_web_push_abo_merkt_sich_die_kette_und_die_juengste_gewinnt(
    client, _auth_signer, session_factory
):
    uid = 820_001
    for kette in ("kette-1", "kette-2"):
        token = _auth_signer.issue_access(uid, f"u{uid}", kette=kette)
        r = await client.post(
            "/notifications/subscribe", json=_ABO, headers=make_auth_header(token)
        )
        assert r.status_code == 204, r.text
    assert await _kette_des_abos(session_factory, uid) == ["kette-2"]


@pytest.mark.asyncio
async def test_abgleich_fragt_auch_nach_den_ketten_der_web_push_abos(session_factory):
    async with session_factory() as s:
        s.add(
            WebPushSubscription(
                id=830_001, user_id=830_001, endpoint="https://x.example/a",
                p256dh="p", auth_secret="a", kette="kette-web",
            )
        )
        await s.commit()
    async with session_factory() as s:
        paare = await geraetetoken_abgleich._paare(s)
    assert (830_001, "kette-web") in paare


# MARK: - Log


def test_datenbank_fehler_verraten_keine_parameter():
    """Eine Datenbank-Ausnahme trug sonst die gebundenen Werte (Push-Token)
    in ihrer Meldung ins Log."""
    from dcc_chat_gateway.db import engine

    assert engine.sync_engine.hide_parameters is True
