"""Zugangsdaten ausgeben — ein Weg für Installer-Token und Verbinden.

``zugangsdaten_ausgeben`` rotiert das Secret und stellt die
Besitzer-Mitgliedschaft sicher. Bootstrap-Einlösung und Abholen beim
Verbinden benutzen beide diese Funktion; was hier nicht stimmt, stimmt in
beiden Wegen nicht.
"""

from __future__ import annotations

from sqlalchemy import select

from dcc_auth.config import get_settings
from dcc_auth.models_instances import RegisteredInstance, UserInstanceMembership
from dcc_auth.security import verify_password
from dcc_auth.zugangsdaten import zugangsdaten_ausgeben

_ALT = "$argon2id$v=19$m=65536,t=3,p=4$alterhash"


async def _besitzer(client) -> int:
    reg = {
        "username": "zd_alice",
        "email": "zd_alice@dcc-test.example.com",
        "password": "correct horse battery staple",
        "display_name": "Alice",
    }
    await client.post("/register", json=reg)
    r = await client.post(
        "/login", json={"email_or_username": reg["email"], "password": reg["password"]}
    )
    me = await client.get(
        "/me", headers={"Cookie": f"pulse_session={r.cookies.get('pulse_session')}"}
    )
    return int(me.json()["id"])


async def _instanz(session_factory, besitzer: int) -> None:
    async with session_factory() as s:
        s.add(
            RegisteredInstance(
                id=940001,
                hostname="zugang.example.com",
                client_id="zd-client",
                client_secret=_ALT,
                status="active",
                origin="vps",
                registered_by=besitzer,
            )
        )
        await s.commit()


async def _mitgliedschaften(session_factory) -> list[UserInstanceMembership]:
    async with session_factory() as s:
        return list(
            (
                await s.execute(
                    select(UserInstanceMembership).where(
                        UserInstanceMembership.instance_id == 940001
                    )
                )
            ).scalars()
        )


async def test_felder_secret_und_mitgliedschaft(client, session_factory):
    besitzer = await _besitzer(client)
    await _instanz(session_factory, besitzer)

    async with session_factory() as db:
        inst = await db.get(RegisteredInstance, 940001)
        zugang = await zugangsdaten_ausgeben(db, inst, get_settings())
        await db.commit()

    assert zugang.instance_id == "940001"
    assert zugang.owner_user_id == str(besitzer)
    assert zugang.hostname == "zugang.example.com"
    assert zugang.client_id == "zd-client"
    assert zugang.cloud_origin == get_settings().pulse_oidc_issuer
    assert zugang.admin_email == "zd_alice@dcc-test.example.com"
    async with session_factory() as s:
        gespeichert = (await s.get(RegisteredInstance, 940001)).client_secret
    assert gespeichert != _ALT
    assert verify_password(zugang.client_secret, gespeichert)
    (mitglied,) = await _mitgliedschaften(session_factory)
    assert (mitglied.user_id, mitglied.role) == (besitzer, "owner")


async def test_vorhandene_mitgliedschaft_bleibt_einzeln(client, session_factory):
    besitzer = await _besitzer(client)
    await _instanz(session_factory, besitzer)
    async with session_factory() as s:
        s.add(UserInstanceMembership(user_id=besitzer, instance_id=940001, role="owner"))
        await s.commit()

    for _ in range(2):
        async with session_factory() as db:
            inst = await db.get(RegisteredInstance, 940001)
            await zugangsdaten_ausgeben(db, inst, get_settings())
            await db.commit()

    assert len(await _mitgliedschaften(session_factory)) == 1
