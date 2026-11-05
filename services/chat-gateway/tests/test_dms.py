"""REST-level tests for the 1:1 DM channel endpoints."""

from __future__ import annotations

import pytest

# DM routes are cloud-only — ensure cloud mode for all tests in this file.
pytestmark = pytest.mark.usefixtures("cloud_mode")


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _register_user(_auth_signer, uid: int | None = None) -> tuple[str, int]:
    import random

    uid = uid or random.randint(1, 1_000_000)
    token = _auth_signer.issue_access(uid, f"user{uid}")
    return token, uid


@pytest.mark.asyncio
async def test_create_dm_channel_returns_201(client, _auth_signer, friend_pair):
    t_a, uid_a = await _register_user(_auth_signer)
    _, uid_b = await _register_user(_auth_signer)
    await friend_pair(uid_a, uid_b)
    r = await client.post(
        "/dm-channels",
        json={"target_user_id": str(uid_b)},
        headers=auth(t_a),
    )
    assert r.status_code == 201
    body = r.json()
    assert isinstance(body["id"], str)  # snowflake → string over the wire
    assert body["other_user_id"] == str(uid_b)
    assert body["last_message_id"] is None
    assert body["can_send"] is True


@pytest.mark.asyncio
async def test_create_dm_channel_idempotent(client, _auth_signer, friend_pair):
    """Same (a, b) returns the existing channel; same id; status 201 still."""
    t_a, uid_a = await _register_user(_auth_signer)
    _, uid_b = await _register_user(_auth_signer)
    await friend_pair(uid_a, uid_b)
    r1 = await client.post(
        "/dm-channels", json={"target_user_id": str(uid_b)}, headers=auth(t_a)
    )
    r2 = await client.post(
        "/dm-channels", json={"target_user_id": str(uid_b)}, headers=auth(t_a)
    )
    assert r1.status_code == 201
    assert r2.status_code == 201
    assert r1.json()["id"] == r2.json()["id"]


@pytest.mark.asyncio
async def test_dm_channel_sorted_pair_invariant(client, _auth_signer, friend_pair):
    """A→B and B→A must resolve to the same channel id."""
    t_a, uid_a = await _register_user(_auth_signer)
    t_b, uid_b = await _register_user(_auth_signer)
    await friend_pair(uid_a, uid_b)
    ra = await client.post(
        "/dm-channels", json={"target_user_id": str(uid_b)}, headers=auth(t_a)
    )
    rb = await client.post(
        "/dm-channels", json={"target_user_id": str(uid_a)}, headers=auth(t_b)
    )
    assert ra.status_code == 201
    assert rb.status_code == 201
    assert ra.json()["id"] == rb.json()["id"]
    # other_user_id is computed from each caller's perspective.
    assert ra.json()["other_user_id"] == str(uid_b)
    assert rb.json()["other_user_id"] == str(uid_a)


@pytest.mark.asyncio
async def test_create_dm_channel_self_rejected(client, _auth_signer):
    t, uid = await _register_user(_auth_signer)
    r = await client.post(
        "/dm-channels", json={"target_user_id": str(uid)}, headers=auth(t)
    )
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_create_dm_channel_requires_auth(client, _auth_signer):
    _, uid_b = await _register_user(_auth_signer)
    r = await client.post("/dm-channels", json={"target_user_id": str(uid_b)})
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_list_dm_channels_only_includes_caller(
    client, _auth_signer, friend_pair
):
    t_a, uid_a = await _register_user(_auth_signer)
    t_b, uid_b = await _register_user(_auth_signer)
    t_c, uid_c = await _register_user(_auth_signer)
    await friend_pair(uid_a, uid_b)
    await friend_pair(uid_b, uid_c)
    # A↔B
    await client.post(
        "/dm-channels", json={"target_user_id": str(uid_b)}, headers=auth(t_a)
    )
    # B↔C (caller A is NOT a member of this one)
    await client.post(
        "/dm-channels", json={"target_user_id": str(uid_c)}, headers=auth(t_b)
    )
    r = await client.get("/dm-channels", headers=auth(t_a))
    assert r.status_code == 200
    body = r.json()
    assert len(body) == 1
    assert body[0]["other_user_id"] == str(uid_b)


@pytest.mark.asyncio
async def test_get_dm_channel_as_member(client, _auth_signer, friend_pair):
    t_a, uid_a = await _register_user(_auth_signer)
    _, uid_b = await _register_user(_auth_signer)
    await friend_pair(uid_a, uid_b)
    r = await client.post(
        "/dm-channels", json={"target_user_id": str(uid_b)}, headers=auth(t_a)
    )
    dm_id = r.json()["id"]
    r2 = await client.get(f"/dm-channels/{dm_id}", headers=auth(t_a))
    assert r2.status_code == 200
    assert r2.json()["id"] == dm_id


@pytest.mark.asyncio
async def test_get_dm_channel_non_member_404(client, _auth_signer, friend_pair):
    """Non-members get 404 (not 403) to avoid leaking channel existence."""
    t_a, uid_a = await _register_user(_auth_signer)
    _, uid_b = await _register_user(_auth_signer)
    t_c, _ = await _register_user(_auth_signer)
    await friend_pair(uid_a, uid_b)
    r = await client.post(
        "/dm-channels", json={"target_user_id": str(uid_b)}, headers=auth(t_a)
    )
    dm_id = r.json()["id"]
    r2 = await client.get(f"/dm-channels/{dm_id}", headers=auth(t_c))
    assert r2.status_code == 404


@pytest.mark.asyncio
async def test_get_dm_channel_not_found(client, _auth_signer):
    t, _ = await _register_user(_auth_signer)
    r = await client.get("/dm-channels/999999999", headers=auth(t))
    assert r.status_code == 404


# ---- Messages on DM channels ------------------------------------------------
# DM messages reuse the polymorphic /channels/{id}/messages endpoint. These
# tests pin the polymorphism: same routes, same wire shape, separate access
# rules (DM membership instead of guild membership).
#
# Seit 2026-11-05 nimmt der Server Klartext in DMs nicht mehr an
# (``DM_KLARTEXT_DETAIL``); verschlüsselt geht es über das Postfach. Lesen,
# Löschen, Vorschau usw. betreffen nur noch den Altbestand — den legt die
# Fixture ``dm_altnachricht`` direkt in die Datenbank.


async def _make_dm(client, _auth_signer, friend_pair):
    t_a, uid_a = await _register_user(_auth_signer)
    t_b, uid_b = await _register_user(_auth_signer)
    await friend_pair(uid_a, uid_b)
    r = await client.post(
        "/dm-channels", json={"target_user_id": str(uid_b)}, headers=auth(t_a)
    )
    return t_a, uid_a, t_b, uid_b, r.json()["id"]


@pytest.mark.asyncio
async def test_dm_klartext_senden_wird_abgelehnt(
    client, session_factory, _auth_signer, friend_pair, monkeypatch
):
    """Klartext in eine DM: 403 mit ``DM_KLARTEXT_DETAIL`` — und keine
    einzige Nebenwirkung des früheren Sendewegs.

    Der Inhalt erwähnt das Gegenüber UND einen Fremden und antwortet auf eine
    Altnachricht: früher wurde daraus eine Zeile, Erwähnungen (für den
    Fremden gefiltert), ein ``last_message_id``-Schub, ein DM-Push. Nichts
    davon darf mehr entstehen.
    """
    from dcc_chat_gateway import push
    from dcc_chat_gateway.models import DM_KLARTEXT_DETAIL, Message, MessageMention
    from dcc_chat_gateway.routes import messages as messages_routen
    from sqlalchemy import func, select

    pushes: list[dict] = []

    async def _fake_push(*args, **kwargs):
        pushes.append({"args": args, **kwargs})

    # Jeder Web-Push läuft über ``_fan_out_payload``; der Erwähnungs-Push
    # zusätzlich über seinen eigenen Namen in der Route.
    monkeypatch.setattr(push, "_fan_out_payload", _fake_push)
    monkeypatch.setattr(messages_routen, "fan_out_mention_push", _fake_push)

    t_a, _, t_b, uid_b, dm_id = await _make_dm(client, _auth_signer, friend_pair)
    vorher = (await client.get("/dm-channels", headers=auth(t_a))).json()[0]
    assert vorher["last_message_id"] is None

    r = await client.post(
        f"/channels/{dm_id}/messages",
        json={"content": f"hallo <@{uid_b}> und <@987654>", "nonce": "n-1"},
        headers=auth(t_a),
    )
    assert r.status_code == 403, r.text
    assert r.json()["detail"] == DM_KLARTEXT_DETAIL
    # Auch das Gegenüber kommt nicht durch.
    r = await client.post(
        f"/channels/{dm_id}/messages", json={"content": "zurück"}, headers=auth(t_b)
    )
    assert r.status_code == 403
    assert r.json()["detail"] == DM_KLARTEXT_DETAIL

    async with session_factory() as s:
        zeilen = await s.scalar(
            select(func.count()).select_from(Message).where(Message.channel_id == int(dm_id))
        )
        erwaehnungen = await s.scalar(select(func.count()).select_from(MessageMention))
    assert zeilen == 0
    assert erwaehnungen == 0
    nachher = (await client.get("/dm-channels", headers=auth(t_a))).json()[0]
    assert nachher["last_message_id"] is None
    assert nachher["last_message_preview"] is None
    assert pushes == []


@pytest.mark.asyncio
async def test_dm_altbestand_fuer_beide_lesbar(
    client, _auth_signer, friend_pair, dm_altnachricht
):
    """Alter Klartext-Verlauf bleibt für beide Teilnehmer lesbar."""
    t_a, uid_a, t_b, _, dm_id = await _make_dm(client, _auth_signer, friend_pair)
    mid = await dm_altnachricht(dm_id, uid_a, "hallo b")

    for token in (t_a, t_b):
        r = await client.get(f"/channels/{dm_id}/messages", headers=auth(token))
        assert r.status_code == 200
        body = r.json()
        assert len(body) == 1
        assert body[0]["id"] == mid
        assert body[0]["channel_id"] == dm_id
        assert body[0]["content"] == "hallo b"


@pytest.mark.asyncio
async def test_dm_non_member_cannot_post_or_list(client, _auth_signer, friend_pair):
    """Non-member gets 404 (not 403) on a DM channel — see resolve_channel_or_raise."""
    _, _, _, _, dm_id = await _make_dm(client, _auth_signer, friend_pair)
    t_c, _ = await _register_user(_auth_signer)
    rp = await client.post(
        f"/channels/{dm_id}/messages",
        json={"content": "snoop"},
        headers=auth(t_c),
    )
    assert rp.status_code == 404
    rl = await client.get(f"/channels/{dm_id}/messages", headers=auth(t_c))
    assert rl.status_code == 404


@pytest.mark.asyncio
async def test_dm_altnachricht_bearbeiten_wird_abgelehnt(
    client, session_factory, _auth_signer, friend_pair, dm_altnachricht, monkeypatch
):
    """Bearbeiten ist Schreiben: auch der Autor schreibt alten Klartext nicht
    mehr um. Die Ablehnung kommt VOR der Autorenprüfung, das Gegenüber
    bekommt also dieselbe Meldung.

    Die Bearbeitung fügt eine Erwähnung hinzu — früher schickte genau das
    einen Erwähnungs-Push mit dem Klartext (Push-Bughunt 2026-10-20). Weder
    Push noch Erwähnungszeile dürfen entstehen, der Inhalt bleibt.
    """
    from dcc_chat_gateway.models import DM_KLARTEXT_DETAIL, MessageMention
    from dcc_chat_gateway.routes import messages as messages_routen
    from sqlalchemy import func, select

    pushes: list[dict] = []

    async def _fake_push(**kwargs):
        pushes.append(kwargs)

    monkeypatch.setattr(messages_routen, "fan_out_mention_push", _fake_push)

    t_a, uid_a, t_b, uid_b, dm_id = await _make_dm(client, _auth_signer, friend_pair)
    msg_id = await dm_altnachricht(dm_id, uid_a, "v1")

    for token in (t_a, t_b):
        r = await client.patch(
            f"/messages/{msg_id}", json={"content": f"v2 <@{uid_b}>"}, headers=auth(token)
        )
        assert r.status_code == 403, r.text
        assert r.json()["detail"] == DM_KLARTEXT_DETAIL

    liste = (await client.get(f"/channels/{dm_id}/messages", headers=auth(t_a))).json()
    assert liste[0]["content"] == "v1"
    assert liste[0]["edited_at"] is None
    async with session_factory() as s:
        assert await s.scalar(select(func.count()).select_from(MessageMention)) == 0
    assert pushes == []


@pytest.mark.asyncio
async def test_dm_delete_message_no_owner_override(
    client, _auth_signer, friend_pair, dm_altnachricht
):
    """In a DM there is no guild owner — only the author may delete."""
    t_a, uid_a, t_b, _, dm_id = await _make_dm(client, _auth_signer, friend_pair)
    msg_id = await dm_altnachricht(dm_id, uid_a, "to be deleted")
    # Other DM member tries to delete — 403 (no owner-override exists).
    r1 = await client.delete(f"/messages/{msg_id}", headers=auth(t_b))
    assert r1.status_code == 403
    # Author deletes — 204.
    r2 = await client.delete(f"/messages/{msg_id}", headers=auth(t_a))
    assert r2.status_code == 204


# --- Vorschautext in der DM-Liste (Mobil-Umbau 2026-08-22) -------------------
#
# Die Chats-Liste des Handys zeigt unter jedem Namen die letzte Nachricht. Der
# Server lieferte bis dahin nur `last_message_id` — also die Information, DASS
# es eine gibt, nicht was drinsteht.


@pytest.mark.asyncio
async def test_dm_liste_traegt_vorschautext(client, _auth_signer, friend_pair, dm_altnachricht):
    t_a, uid_a, _, _, dm_id = await _make_dm(client, _auth_signer, friend_pair)
    mid = await dm_altnachricht(dm_id, uid_a, "Hallo Welt")
    posted_at = (await client.get(f"/channels/{dm_id}/messages", headers=auth(t_a))).json()[0][
        "created_at"
    ]
    eintrag = (await client.get("/dm-channels", headers=auth(t_a))).json()[0]
    assert eintrag["last_message_id"] == mid
    assert eintrag["last_message_preview"] == "Hallo Welt"
    assert eintrag["last_message_author_id"] == str(uid_a)
    assert eintrag["last_message_at"] == posted_at


@pytest.mark.asyncio
async def test_dm_vorschau_ohne_nachricht_ist_null(client, _auth_signer, friend_pair):
    t_a, _, _, _, _ = await _make_dm(client, _auth_signer, friend_pair)
    eintrag = (await client.get("/dm-channels", headers=auth(t_a))).json()[0]
    assert eintrag["last_message_preview"] is None
    assert eintrag["last_message_author_id"] is None
    assert eintrag["last_message_at"] is None


@pytest.mark.asyncio
async def test_dm_vorschau_wird_gekuerzt(client, _auth_signer, friend_pair, dm_altnachricht):
    """Eine lange Nachricht darf die Liste nicht aufblaehen — 80 Zeichen."""
    t_a, uid_a, _, _, dm_id = await _make_dm(client, _auth_signer, friend_pair)
    await dm_altnachricht(dm_id, uid_a, "a" * 500)
    eintrag = (await client.get("/dm-channels", headers=auth(t_a))).json()[0]
    assert len(eintrag["last_message_preview"]) <= 80


@pytest.mark.asyncio
async def test_dm_vorschau_ohne_zeilenumbrueche(
    client, _auth_signer, friend_pair, dm_altnachricht
):
    """Eine Zeile in der Liste ist EINE Zeile — sonst springt das Layout."""
    t_a, uid_a, _, _, dm_id = await _make_dm(client, _auth_signer, friend_pair)
    await dm_altnachricht(dm_id, uid_a, "erste\nzweite\r\ndritte")
    vorschau = (await client.get("/dm-channels", headers=auth(t_a))).json()[0][
        "last_message_preview"
    ]
    assert "\n" not in vorschau and "\r" not in vorschau
    assert vorschau == "erste zweite dritte"


@pytest.mark.asyncio
async def test_dm_vorschau_einer_geloeschten_nachricht_ist_null(
    client, _auth_signer, friend_pair, dm_altnachricht
):
    """Geloescht heisst geloescht — auch in der Vorschau der Liste."""
    t_a, uid_a, _, _, dm_id = await _make_dm(client, _auth_signer, friend_pair)
    mid = await dm_altnachricht(dm_id, uid_a, "weg damit")
    d = await client.delete(f"/messages/{mid}", headers=auth(t_a))
    assert d.status_code in (200, 204)
    eintrag = (await client.get("/dm-channels", headers=auth(t_a))).json()[0]
    assert eintrag["last_message_preview"] is None
