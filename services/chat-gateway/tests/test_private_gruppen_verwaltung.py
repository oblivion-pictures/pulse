"""Private Gruppen verwalten (``routes/private_gruppen_verwaltung.py``,
``routes/gruppen_icons.py``): Aufloesen raeumt mit, Rollen, Besitz-Uebergabe,
Erbe beim Austritt des Owners, Stumm-Flag nur fuer sich selbst, unratbare
Gruppenbild-Adresse."""

from __future__ import annotations

import io
import random
import re

import pytest
import pytest_asyncio
from PIL import Image
from sqlalchemy import select

from .conftest import make_auth_header

pytestmark = pytest.mark.usefixtures("cloud_mode")

_ICON_URL_RE = re.compile(r"^/api/chat/gruppen-icons/(\d+-[A-Za-z0-9_-]{22}\.webp)$")


@pytest_asyncio.fixture(autouse=True)
async def _enable_sqlite_foreign_keys(engine):
    """Wie in ``test_private_gruppen.py``: SQLite kaskadiert nur mit PRAGMA."""
    async with engine.begin() as conn:
        await conn.exec_driver_sql("PRAGMA foreign_keys = ON")


@pytest.fixture
def gruppen_an(_isolate_chat_settings, tmp_path, monkeypatch):
    _isolate_chat_settings.private_groups_enabled = True
    monkeypatch.setattr(_isolate_chat_settings, "gruppen_icon_upload_dir", str(tmp_path))
    return tmp_path


@pytest.fixture
def ereignisse(app, monkeypatch):
    gesehen: list[tuple[str, dict]] = []

    async def _cap(target_user_id, envelope):
        gesehen.append((str(target_user_id), dict(envelope)))

    monkeypatch.setattr(app.state.connection_manager, "publish_user_event", _cap)
    return gesehen


def _konto(_auth_signer) -> tuple[dict[str, str], int]:
    uid = random.randint(1, 1_000_000)
    return make_auth_header(_auth_signer.issue_access(uid, f"u{uid}")), uid


async def _gruppe(client, h_owner, *mitglieder: int) -> str:
    r = await client.post("/gruppen", json={"name": "g"}, headers=h_owner)
    assert r.status_code == 201, r.text
    gid = r.json()["id"]
    for uid in mitglieder:
        r = await client.post(
            f"/gruppen/{gid}/mitglieder", json={"user_id": str(uid)}, headers=h_owner
        )
        assert r.status_code == 201, r.text
    return gid


def _png(mode: str = "RGB") -> bytes:
    buf = io.BytesIO()
    Image.new(mode, (300, 200)).save(buf, "PNG")
    return buf.getvalue()


async def _icon_hochladen(client, gid: str, headers, mode: str = "RGB") -> str:
    r = await client.post(
        f"/gruppen/{gid}/icon", files={"file": ("a.png", _png(mode), "image/png")}, headers=headers
    )
    assert r.status_code == 200, r.text
    return r.json()["icon_url"]


def _zeile(gruppe: dict, uid: int) -> dict:
    return next(m for m in gruppe["members"] if m["user_id"] == str(uid))


async def _db_rolle(session_factory, gid: str, uid: int) -> str:
    from dcc_chat_gateway.models import PrivateGroupMember

    async with session_factory() as s:
        return (
            await s.execute(
                select(PrivateGroupMember.rolle).where(
                    PrivateGroupMember.gruppe_id == int(gid), PrivateGroupMember.user_id == uid
                )
            )
        ).scalar_one()


# ─── Aufloesen + Leerwerden raeumen mit ─────────────────────────────────────


@pytest.mark.asyncio
async def test_aufloesen_raeumt_staende_und_icon(
    client, session_factory, _auth_signer, gruppen_an, ereignisse
):
    from dcc_chat_gateway.models import GruppenLesestand, Zustellstand

    h_a, uid_a = _konto(_auth_signer)
    h_b, uid_b = _konto(_auth_signer)
    gid = await _gruppe(client, h_a, uid_b)
    icon_url = await _icon_hochladen(client, gid, h_b, mode="P")
    async with session_factory() as s:
        s.add(Zustellstand(
            channel_id=int(gid), absender_user_id=uid_a, empfaenger_user_id=uid_b,
            zugestellt_bis=1,
        ))
        s.add(GruppenLesestand(gruppe_id=int(gid), user_id=uid_b, last_read_message_id=1))
        await s.commit()

    # Nur der Owner loest auf.
    r = await client.delete(f"/gruppen/{gid}", headers=h_b)
    assert r.status_code == 403, r.text
    ereignisse.clear()
    r = await client.delete(f"/gruppen/{gid}", headers=h_a)
    assert r.status_code == 204, r.text

    async with session_factory() as s:
        assert (await s.execute(
            select(Zustellstand).where(Zustellstand.channel_id == int(gid))
        )).scalars().all() == []
        assert (await s.execute(
            select(GruppenLesestand).where(GruppenLesestand.gruppe_id == int(gid))
        )).scalars().all() == []
    assert list(gruppen_an.iterdir()) == []
    r = await client.get(icon_url.removeprefix("/api/chat"))
    assert r.status_code == 404
    assert {t for t, e in ereignisse if e.get("op") == "gruppe_neu"} == {str(uid_a), str(uid_b)}


@pytest.mark.asyncio
async def test_letztes_mitglied_geht_icon_verschwindet(client, _auth_signer, gruppen_an):
    h_a, _ = _konto(_auth_signer)
    gid = await _gruppe(client, h_a)
    await _icon_hochladen(client, gid, h_a)
    assert len(list(gruppen_an.iterdir())) == 1

    r = await client.post(f"/gruppen/{gid}/verlassen", headers=h_a)
    assert r.status_code == 200, r.text
    assert r.json() is None
    assert list(gruppen_an.iterdir()) == []


# ─── Rollen ─────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_rolle_setzen_nur_owner(client, session_factory, _auth_signer, gruppen_an, ereignisse):
    h_a, uid_a = _konto(_auth_signer)
    h_b, uid_b = _konto(_auth_signer)
    h_c, uid_c = _konto(_auth_signer)
    h_d, uid_d = _konto(_auth_signer)
    gid = await _gruppe(client, h_a, uid_b, uid_c)

    def pfad(uid: int) -> str:
        return f"/gruppen/{gid}/mitglieder/{uid}/rolle"

    # Mitglied darf nicht, Nichtmitglied sieht die Gruppe nicht.
    assert (await client.put(pfad(uid_c), json={"rolle": "admin"}, headers=h_b)).status_code == 403
    assert (await client.put(pfad(uid_c), json={"rolle": "admin"}, headers=h_d)).status_code == 404
    # Ziel kein Mitglied → 404; Owner-Rolle fest → 400; „owner" nicht waehlbar → 422.
    r = await client.put(pfad(uid_d), json={"rolle": "admin"}, headers=h_a)
    assert r.status_code == 404 and r.json()["detail"] == "not_a_member"
    r = await client.put(pfad(uid_a), json={"rolle": "mitglied"}, headers=h_a)
    assert r.status_code == 400 and r.json()["detail"] == "owner_rolle_fest"
    assert (await client.put(pfad(uid_b), json={"rolle": "owner"}, headers=h_a)).status_code == 422

    ereignisse.clear()
    r = await client.put(pfad(uid_b), json={"rolle": "admin"}, headers=h_a)
    assert r.status_code == 204, r.text
    assert {t for t, e in ereignisse if e.get("op") == "gruppe_neu"} == {
        str(uid_a), str(uid_b), str(uid_c)
    }
    gruppe = (await client.get(f"/gruppen/{gid}", headers=h_c)).json()
    assert _zeile(gruppe, uid_b)["rolle"] == "admin"
    assert await _db_rolle(session_factory, gid, uid_b) == "admin"

    # Admin laedt ein und wirft Mitglieder raus, setzt aber keine Rollen.
    r = await client.post(f"/gruppen/{gid}/mitglieder", json={"user_id": str(uid_d)}, headers=h_b)
    assert r.status_code == 201, r.text
    assert (await client.put(pfad(uid_c), json={"rolle": "admin"}, headers=h_b)).status_code == 403
    r = await client.delete(f"/gruppen/{gid}/mitglieder/{uid_d}", headers=h_b)
    assert r.status_code == 200, r.text

    # Zurueckstufen nimmt das Einladen wieder weg.
    assert (await client.put(pfad(uid_b), json={"rolle": "mitglied"}, headers=h_a)).status_code == 204
    r = await client.post(f"/gruppen/{gid}/mitglieder", json={"user_id": str(uid_d)}, headers=h_b)
    assert r.status_code == 403, r.text


# ─── Besitz ─────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_besitz_uebergeben(client, session_factory, _auth_signer, gruppen_an):
    h_a, uid_a = _konto(_auth_signer)
    h_b, uid_b = _konto(_auth_signer)
    _, uid_d = _konto(_auth_signer)
    gid = await _gruppe(client, h_a, uid_b)
    pfad = f"/gruppen/{gid}/besitz"

    assert (await client.post(pfad, json={"user_id": str(uid_a)}, headers=h_b)).status_code == 403
    r = await client.post(pfad, json={"user_id": str(uid_d)}, headers=h_a)
    assert r.status_code == 404 and r.json()["detail"] == "not_a_member"
    r = await client.post(pfad, json={"user_id": str(uid_a)}, headers=h_a)
    assert r.status_code == 400 and r.json()["detail"] == "bereits_owner"

    r = await client.post(pfad, json={"user_id": str(uid_b)}, headers=h_a)
    assert r.status_code == 204, r.text
    gruppe = (await client.get(f"/gruppen/{gid}", headers=h_a)).json()
    assert gruppe["ersteller_id"] == str(uid_b)
    assert _zeile(gruppe, uid_b)["rolle"] == "owner"
    assert _zeile(gruppe, uid_a)["rolle"] == "admin"
    assert await _db_rolle(session_factory, gid, uid_b) == "owner"
    assert await _db_rolle(session_factory, gid, uid_a) == "admin"

    # Die Rechte sind echt gewandert.
    assert (await client.put(f"/gruppen/{gid}/name", json={"name": "x"}, headers=h_a)).status_code == 403
    assert (await client.put(f"/gruppen/{gid}/name", json={"name": "x"}, headers=h_b)).status_code == 200


@pytest.mark.asyncio
async def test_owner_geht_admin_erbt_vor_dienstaelterem_mitglied(
    client, session_factory, _auth_signer, gruppen_an
):
    h_a, uid_a = _konto(_auth_signer)
    _, uid_b = _konto(_auth_signer)
    _, uid_c = _konto(_auth_signer)
    gid = await _gruppe(client, h_a, uid_b, uid_c)  # B dienstaelter als C
    r = await client.put(
        f"/gruppen/{gid}/mitglieder/{uid_c}/rolle", json={"rolle": "admin"}, headers=h_a
    )
    assert r.status_code == 204, r.text

    r = await client.post(f"/gruppen/{gid}/verlassen", headers=h_a)
    assert r.status_code == 200, r.text
    assert r.json()["ersteller_id"] == str(uid_c)
    assert _zeile(r.json(), uid_c)["rolle"] == "owner"
    assert await _db_rolle(session_factory, gid, uid_c) == "owner"
    assert await _db_rolle(session_factory, gid, uid_b) == "mitglied"


@pytest.mark.asyncio
async def test_owner_geht_ohne_admin_dienstaeltestes_mitglied_erbt(
    client, session_factory, _auth_signer, gruppen_an
):
    h_a, _ = _konto(_auth_signer)
    _, uid_b = _konto(_auth_signer)
    _, uid_c = _konto(_auth_signer)
    gid = await _gruppe(client, h_a, uid_b, uid_c)

    r = await client.post(f"/gruppen/{gid}/verlassen", headers=h_a)
    assert r.status_code == 200, r.text
    assert r.json()["ersteller_id"] == str(uid_b)
    assert await _db_rolle(session_factory, gid, uid_b) == "owner"


# ─── Stumm-Flag nur fuer sich selbst ────────────────────────────────────────


@pytest.mark.asyncio
async def test_stumm_flag_nur_in_der_eigenen_zeile(client, _auth_signer, gruppen_an, ereignisse):
    h_a, uid_a = _konto(_auth_signer)
    h_b, uid_b = _konto(_auth_signer)
    gid = await _gruppe(client, h_a, uid_b)

    ereignisse.clear()
    r = await client.post(f"/gruppen/{gid}/stumm", json={"stumm": True}, headers=h_b)
    assert r.status_code == 204, r.text
    # Geweckt werden nur B's eigene Geraete, und das Ereignis traegt kein Flag.
    assert ereignisse == [(str(uid_b), {"op": "gruppe_neu", "gruppe_id": gid})]

    sicht_a = (await client.get(f"/gruppen/{gid}", headers=h_a)).json()
    assert _zeile(sicht_a, uid_a)["stumm"] is False
    assert _zeile(sicht_a, uid_b)["stumm"] is None
    sicht_b = next(g for g in (await client.get("/gruppen", headers=h_b)).json() if g["id"] == gid)
    assert _zeile(sicht_b, uid_b)["stumm"] is True
    assert _zeile(sicht_b, uid_a)["stumm"] is None
    # Auch Mutations-Antworten (hier: Anheften durch A) verraten B's Flag nicht.
    r = await client.post(f"/gruppen/{gid}/anheften", json={"anker": "x"}, headers=h_a)
    assert _zeile(r.json(), uid_b)["stumm"] is None


# ─── Gruppenbild: unratbare Adresse ─────────────────────────────────────────


@pytest.mark.asyncio
async def test_icon_adresse_unratbar(client, _auth_signer, gruppen_an):
    h_a, _ = _konto(_auth_signer)
    gid = await _gruppe(client, h_a)
    icon_url = await _icon_hochladen(client, gid, h_a)
    treffer = _ICON_URL_RE.fullmatch(icon_url)
    assert treffer and treffer.group(1).startswith(f"{gid}-")

    r = await client.get(icon_url.removeprefix("/api/chat"))
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/webp"
    # Aus der Gruppen-ID allein, mit falschem Token oder per Traversal: 404.
    for falsch in (
        f"/gruppen-icons/{gid}.webp",
        f"/gruppen-icons/{gid}-{'A' * 22}.webp",
        "/gruppen-icons/..%2F..%2Fsecrets.webp",
        f"/gruppen-icons/{treffer.group(1)}.tmp",
    ):
        assert (await client.get(falsch)).status_code == 404, falsch

    # Neu hochladen: neuer Name, die alte Datei ist weg.
    neu = await _icon_hochladen(client, gid, h_a)
    assert neu != icon_url
    assert [p.name for p in gruppen_an.iterdir()] == [_ICON_URL_RE.fullmatch(neu).group(1)]
    assert (await client.get(icon_url.removeprefix("/api/chat"))).status_code == 404

    # Entfernen raeumt die Datei.
    r = await client.delete(f"/gruppen/{gid}/icon", headers=h_a)
    assert r.status_code == 200 and r.json()["icon_url"] is None
    assert list(gruppen_an.iterdir()) == []
