"""Datenmodell für das Verbinden per Gerätecode (Migration 0056).

Ein verbundener Server entsteht ohne Antrag und ohne Worker-IDs. Er muss
trotzdem in jeder Liste erscheinen, in der heute ein freigegebener steht —
sonst sähe der Besitzer seinen Server auf dem zweiten Gerät nie.
"""

from __future__ import annotations

import inspect
from datetime import UTC, datetime
from pathlib import Path

from dcc_auth.models import User
from dcc_auth.models_instances import RegisteredInstance, UserInstanceMembership


async def _konto(client, name: str) -> dict:
    reg = {
        "username": name,
        "email": f"{name}@dcc-test.example.com",
        "password": "correct horse battery staple",
        "display_name": name,
    }
    r = await client.post("/register", json=reg)
    assert r.status_code == 201, r.text
    r = await client.post(
        "/login", json={"email_or_username": reg["email"], "password": reg["password"]}
    )
    assert r.status_code == 200, r.text
    cookie = f"pulse_session={r.cookies.get('pulse_session')}"
    me = await client.get("/me", headers={"Cookie": cookie})
    return {"cookie": cookie, "id": int(me.json()["id"]), "token": r.json()["access_token"]}


async def _verbundener_eintrag(
    session_factory, *, iid: int, hostname: str, besitzer: int, verbunden: bool
) -> None:
    async with session_factory() as s:
        s.add(
            RegisteredInstance(
                id=iid,
                hostname=hostname,
                client_id=f"verb-{iid}",
                client_secret="$argon2id$v=19$m=65536,t=3,p=4$egal",
                status="active",
                origin="vps",
                registered_by=besitzer,
                ohne_freigabe=True,
                verbunden_at=datetime.now(UTC) if verbunden else None,
            )
        )
        s.add(UserInstanceMembership(user_id=besitzer, instance_id=iid, role="owner"))
        await s.commit()


def _migration_0056():
    import importlib.util

    pfad = next(
        (Path(__file__).resolve().parents[1] / "alembic" / "versions").glob("*_0056_*.py")
    )
    spec = importlib.util.spec_from_file_location(pfad.stem, pfad)
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


def test_migration_0056_haengt_an_0055_und_kann_zurueck():
    mod = _migration_0056()
    assert mod.revision == "0056_verbinden"
    assert len(mod.revision) <= 32
    assert mod.down_revision == "0055_instanz_anzeige"
    hin = inspect.getsource(mod.upgrade)
    zurueck = inspect.getsource(mod.downgrade)
    for spalte in ("ohne_freigabe", "verbunden_at", "server_verbinden_gesperrt"):
        assert spalte in hin
        assert spalte in zurueck
    assert "nullable=True" in hin


async def test_neues_konto_darf_verbinden(client, session_factory):
    konto = await _konto(client, "dm_neu")
    async with session_factory() as s:
        user = await s.get(User, konto["id"])
    assert user.server_verbinden_gesperrt is False


async def test_neuer_heim_server_bekommt_keine_worker_ids(client, session_factory):
    """E7: der Vorrat an Worker-IDs war die einzige harte Obergrenze für die
    Zahl der Server, und der Container hat die Nummern nie gelesen."""
    konto = await _konto(client, "dm_heim")
    r = await client.post("/me/instances", headers={"Cookie": konto["cookie"]})
    assert r.status_code == 201, r.text
    assert r.json()["instance"]["worker_id_chat"] is None
    async with session_factory() as s:
        inst = await s.get(RegisteredInstance, int(r.json()["instance"]["id"]))
    assert (inst.worker_id_chat, inst.worker_id_voice, inst.worker_id_media) == (None, None, None)


async def test_verbundener_server_zaehlt_erst_nach_dem_abholen_als_eingerichtet(
    client, session_factory
):
    konto = await _konto(client, "dm_vps")
    await _verbundener_eintrag(
        session_factory, iid=930001, hostname="fertig.example.com",
        besitzer=konto["id"], verbunden=True,
    )
    await _verbundener_eintrag(
        session_factory, iid=930002, hostname="halb.example.com",
        besitzer=konto["id"], verbunden=False,
    )
    r = await client.get("/me/instances", headers={"Cookie": konto["cookie"]})
    assert r.status_code == 200, r.text
    nach_id = {i["id"]: i for i in r.json()}
    assert nach_id["930001"]["set_up"] is True
    assert nach_id["930001"]["ohne_freigabe"] is True
    assert nach_id["930001"]["worker_id_chat"] is None
    assert nach_id["930001"]["role"] == "owner"
    assert nach_id["930002"]["set_up"] is False


async def test_admin_liste_zeigt_den_vermerk(client, session_factory):
    admin = await _konto(client, "dm_admin")  # erstes Konto = Bootstrap-Admin
    await _verbundener_eintrag(
        session_factory, iid=930003, hostname="admin-sicht.example.com",
        besitzer=admin["id"], verbunden=True,
    )
    r = await client.get(
        "/admin/instances", headers={"Authorization": f"Bearer {admin['token']}"}
    )
    assert r.status_code == 200, r.text
    (eintrag,) = [i for i in r.json() if i["id"] == "930003"]
    assert eintrag["ohne_freigabe"] is True
    assert eintrag["worker_id_chat"] is None
