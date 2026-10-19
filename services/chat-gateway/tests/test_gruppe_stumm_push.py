"""Persönliche Gruppen-Stummschaltung (Migration 0107) auf allen Push-Wegen.

Geprüft wird beim SENDEN (``fcm_stumm``), nicht beim Vormerken: wer während
der Wartezeit der Warteschlange stummschaltet, bekommt den vorgemerkten
Handy-Push nicht mehr. Der Web-Push prüft denselben Merker. DMs bleiben
unberührt.
"""

from __future__ import annotations

import pytest
from dcc_chat_gateway import badgezaehler, fcm_stumm, push
from dcc_chat_gateway import fcm_warteschlange as ws
from dcc_chat_gateway.models import FcmToken, PrivateGroupMember
from sqlalchemy import update

from .test_fcm_warteschlange import (  # noqa: F401
    _abarbeiten,
    _konto_b,
    _leer,
    _senden,
    _szene,
    schlange,
    sender,
)
from .test_haekchen import _gruppe_mit, gruppen_an  # noqa: F401
from .test_postfach import _bundel_seeden_geraet

pytestmark = pytest.mark.usefixtures("cloud_mode")


@pytest.fixture
def web_push(monkeypatch):
    """Statt VAPID und Abos: wer den Web-Push bekäme."""
    an: list[set[int]] = []

    async def _fake(user_ids, payload):
        an.append(set(user_ids))

    monkeypatch.setattr(push, "_fan_out_payload", _fake)
    return an


async def _gruppen_szene(client, session_factory, _auth_signer, friend_pair) -> dict:
    """A schreibt in eine Gruppe mit B; B hat einen Rechner und ein Handy."""
    t_a, uid_a = _konto_b(_auth_signer)
    t_b, uid_b = _konto_b(_auth_signer)
    await friend_pair(uid_a, uid_b)
    gruppe = await _gruppe_mit(client, t_a, uid_b)
    pub_b = await _bundel_seeden_geraet(session_factory, user_id=uid_b)
    async with session_factory() as s:
        s.add(FcmToken(user_id=uid_b, geraet_id="handy", token=f"tok-{uid_b}"))
        await s.commit()
    return {"t_a": t_a, "uid_a": uid_a, "t_b": t_b, "uid_b": uid_b, "dm": gruppe, "pub_b": pub_b}


async def _stumm(session_factory, gruppe: str | int, uid: int, wert: bool = True) -> None:
    async with session_factory() as s:
        await s.execute(
            update(PrivateGroupMember)
            .where(PrivateGroupMember.gruppe_id == int(gruppe), PrivateGroupMember.user_id == uid)
            .values(stumm=wert)
        )
        await s.commit()


@pytest.mark.asyncio
async def test_stumm_nach_dem_vormerken_haelt_den_handy_push_zurueck(
    app, client, session_factory, _auth_signer, friend_pair, sender, schlange, gruppen_an,  # noqa: F811
):
    sz = await _gruppen_szene(client, session_factory, _auth_signer, friend_pair)
    await _senden(client, sz)
    # Vorgemerkt, noch nicht gesendet — erst jetzt schaltet B stumm.
    assert await schlange.zcard(ws.FAELLIG) == 1
    await _stumm(session_factory, sz["dm"], sz["uid_b"])
    await _abarbeiten(app.state.connection_manager)
    assert sender == []
    assert await _leer(schlange)
    # Die stumme Gruppe hält auch die Plakette an (anders als „Nicht stören“).
    assert not await badgezaehler.lesen(schlange, sz["uid_b"])


@pytest.mark.asyncio
async def test_nicht_stummes_mitglied_bekommt_beide_pushes(
    app, client, session_factory, _auth_signer, friend_pair, sender, schlange, gruppen_an,  # noqa: F811
    web_push,
):
    sz = await _gruppen_szene(client, session_factory, _auth_signer, friend_pair)
    # Gegenprobe: ein- und wieder ausgeschaltet zählt wie nie stumm.
    await _stumm(session_factory, sz["dm"], sz["uid_b"])
    await _stumm(session_factory, sz["dm"], sz["uid_b"], False)
    await _senden(client, sz)
    await _abarbeiten(app.state.connection_manager)
    assert [t for t, _p, _b in sender] == [f"tok-{sz['uid_b']}"]
    assert web_push == [{sz["uid_b"]}]
    assert await badgezaehler.lesen(schlange, sz["uid_b"]) == 1


@pytest.mark.asyncio
async def test_stummes_mitglied_bekommt_keinen_web_push(
    app, client, session_factory, _auth_signer, friend_pair, sender, schlange, gruppen_an,  # noqa: F811
    web_push,
):
    sz = await _gruppen_szene(client, session_factory, _auth_signer, friend_pair)
    await _stumm(session_factory, sz["dm"], sz["uid_b"])
    await _senden(client, sz)
    await _abarbeiten(app.state.connection_manager)
    assert web_push == [set()]
    assert sender == []


@pytest.mark.asyncio
async def test_sofort_weg_ohne_redis_respektiert_die_stummschaltung(
    client, session_factory, _auth_signer, friend_pair, sender, gruppen_an,  # noqa: F811
):
    sz = await _gruppen_szene(client, session_factory, _auth_signer, friend_pair)
    await _stumm(session_factory, sz["dm"], sz["uid_b"])
    await ws.vormerken(
        recipient_ids={sz["uid_b"]}, author_name="a", channel_id=int(sz["dm"]),
        manager=None, art="gruppe",
    )
    assert sender == []


@pytest.mark.asyncio
async def test_dm_bleibt_unberuehrt_auch_wenn_eine_gruppe_stumm_ist(
    app, client, session_factory, _auth_signer, friend_pair, sender, schlange, gruppen_an,  # noqa: F811
    web_push,
):
    sz = await _szene(client, session_factory, _auth_signer, friend_pair, schlange)
    gruppe = await _gruppe_mit(client, sz["t_a"], sz["uid_b"])
    await _stumm(session_factory, gruppe, sz["uid_b"])
    await _senden(client, sz)
    await _abarbeiten(app.state.connection_manager)
    assert [t for t, _p, _b in sender] == [f"tok-{sz['uid_b']}"]
    assert web_push == [{sz["uid_b"]}]


@pytest.mark.asyncio
async def test_web_push_pruefung_ist_fail_open():
    """Eine Datenbankstörung verschluckt den Web-Push nicht."""

    def _kaputt():
        raise RuntimeError("Datenbank weg")

    assert await fcm_stumm.ohne_stumme_gruppenmitglieder(_kaputt, 1, {7, 8}) == {7, 8}
