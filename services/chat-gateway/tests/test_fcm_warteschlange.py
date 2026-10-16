"""Zurückgehaltene DM-Pushes ans Handy (``fcm_warteschlange.py`` +
``fcm_gelesen.py``, Eigentümer-Entscheid 2026-10-17).

Ein DM-Push ans Handy wartet 5 s und entfällt, wenn der Empfänger die
Nachricht in dieser Zeit nachweislich an einem anderen Gerät gelesen hat.
Die Tests fahren den echten Weg (Einliefern → Quittung → Lesestand →
Abarbeiter) gegen den Test-Redis und schreiben mit, was an Firebase ginge.
"""

from __future__ import annotations

import asyncio
import base64
import random

import pytest
from dcc_chat_gateway import badgezaehler, fcm
from dcc_chat_gateway import fcm_warteschlange as ws
from dcc_chat_gateway.fcm_gelesen import ist_gelesen
from dcc_chat_gateway.models import FcmToken
from redis.asyncio import Redis

from .conftest import make_auth_header
from .test_anruf_push import _anrufen, _dm, _gesendet, _iphone, _konto, apple  # noqa: F401
from .test_postfach import _abholen, _bundel_seeden_geraet, _dm_erstellen, _einliefern

pytestmark = pytest.mark.usefixtures("cloud_mode")

_DATEN = base64.b64encode(b"olm-umschlag").decode()
#: Weit in der Zukunft (ms): jeder Eintrag ist dann fällig.
SPAETER = 10**15
X = 1760000000000000500


class _Manager:
    """Duck-typed ConnectionManager: Redis, keine Sockets (alle offline)."""

    def __init__(self, redis):
        self.redis = redis

    def user_socket_count(self, user_id: int) -> int:
        return 0


async def _raeumen(redis) -> None:
    async for schluessel in redis.scan_iter(match="push:dm:*"):
        await redis.delete(schluessel)


@pytest.fixture
async def schlange(app):
    await _raeumen(app.state.redis)
    yield app.state.redis
    await _raeumen(app.state.redis)


@pytest.fixture
def sender(monkeypatch, _isolate_chat_settings):
    """FCM gilt als eingerichtet (Schlüsselpfad gesetzt, die App ein Platzhalter);
    statt Firebase eine Mitschrift (token, payload, badge)."""
    gesendet: list[tuple[str, dict, int | None]] = []

    def _fake_send(*, token: str, payload: dict, badge: int | None = None) -> str:
        gesendet.append((token, payload, badge))
        return "ok"

    monkeypatch.setattr(_isolate_chat_settings, "firebase_service_account_key", "/nicht/da.json")
    monkeypatch.setattr(fcm, "ensure_fcm", lambda: object())
    monkeypatch.setattr(fcm, "_send_one", _fake_send)
    return gesendet


def _konto_b(_auth_signer) -> tuple[str, int]:
    uid = random.randint(1, 1_000_000)
    return _auth_signer.issue_access(uid, f"u{uid}"), uid


async def _szene(client, session_factory, _auth_signer, friend_pair, redis) -> dict:
    """A schreibt B; B hat einen Rechner (Schlüsselbündel) und ein Handy (FCM)."""
    t_a, uid_a = _konto_b(_auth_signer)
    t_b, uid_b = _konto_b(_auth_signer)
    await friend_pair(uid_a, uid_b)
    dm_id = await _dm_erstellen(client, t_a, uid_b)
    pub_b = await _bundel_seeden_geraet(session_factory, user_id=uid_b)
    async with session_factory() as s:
        s.add(FcmToken(user_id=uid_b, geraet_id="handy", token=f"tok-{uid_b}"))
        await s.commit()
    await badgezaehler.setzen(redis, uid_b, 0)
    return {"t_a": t_a, "uid_a": uid_a, "t_b": t_b, "uid_b": uid_b, "dm": dm_id, "pub_b": pub_b}


async def _senden(client, sz: dict) -> None:
    r = await _einliefern(
        client, token=sz["t_a"], channel_id=sz["dm"],
        nutzlasten=[{"art": 1, "daten": _DATEN, "empfaenger": [sz["pub_b"]]}],
    )
    assert r.status_code == 200, r.text


async def _quittieren(client, sz: dict, bis: int) -> None:
    """B's Rechner holt ab und quittiert mit dem Zustellstand ``bis``."""
    abgeholt = (await _abholen(client, token=sz["t_b"], pubkey=sz["pub_b"])).json()
    assert abgeholt
    r = await client.post(
        "/postfach/quittung",
        json={
            "device_pubkey": sz["pub_b"],
            "zustellung_ids": [z["id"] for z in abgeholt],
            "zustellstaende": [
                {"channel_id": sz["dm"], "absender_user_id": str(sz["uid_a"]),
                 "zugestellt_bis": str(bis)}
            ],
        },
        headers=make_auth_header(sz["t_b"]),
    )
    assert r.status_code == 204, r.text


async def _lesestand(client, sz: dict, bis: int) -> None:
    r = await client.put(
        f"/dm-channels/{sz['dm']}/lesestand",
        json={"last_read_message_id": str(bis)},
        headers=make_auth_header(sz["t_b"]),
    )
    assert r.status_code == 204, r.text


async def _abarbeiten(manager, jetzt: int = SPAETER) -> int:
    arbeiten = await ws.uebernehmen(manager.redis, jetzt_ms=jetzt)
    for arbeit in arbeiten:
        await ws.abarbeiten(manager, arbeit)
    return len(arbeiten)


async def _leer(redis) -> bool:
    return await redis.zcard(ws.FAELLIG) == 0 and await redis.zcard(ws.INARBEIT) == 0


# MARK: - Zurückhalten, senden, verwerfen


@pytest.mark.asyncio
async def test_push_wartet_und_geht_nach_der_frist_hinaus(
    app, client, session_factory, _auth_signer, friend_pair, sender, schlange
):
    sz = await _szene(client, session_factory, _auth_signer, friend_pair, schlange)
    manager = app.state.connection_manager
    await _senden(client, sz)
    assert sender == []
    # Jetzt noch nicht fällig.
    assert await ws.uebernehmen(schlange) == []
    assert await _abarbeiten(manager) == 1
    assert [(t, p["channel_id"], b) for t, p, b in sender] == [(f"tok-{sz['uid_b']}", sz["dm"], 1)]
    assert await _leer(schlange)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("quittung", "stand", "erwartet"),
    [
        (X, X, 0),  # belegt gelesen → verworfen
        (X, None, 1),  # Gegenprobe: angekommen, aber nicht gelesen
        (None, X, 1),  # Gegenprobe: Lesestand ohne Beleg (keine Quittung)
        (X, X - 1, 1),  # Gegenprobe: Lesestand unter dem Beleg
    ],
)
async def test_verworfen_nur_wenn_belegt_gelesen(
    app, client, session_factory, _auth_signer, friend_pair, sender, schlange,
    quittung, stand, erwartet,
):
    sz = await _szene(client, session_factory, _auth_signer, friend_pair, schlange)
    await _senden(client, sz)
    if quittung is not None:
        await _quittieren(client, sz, quittung)
    if stand is not None:
        await _lesestand(client, sz, stand)
    assert await _abarbeiten(app.state.connection_manager) == 1
    assert len(sender) == erwartet
    # Ein verworfener Push zählt die Plakette nicht hoch.
    assert await badgezaehler.lesen(schlange, sz["uid_b"]) == erwartet
    assert await _leer(schlange)


@pytest.mark.asyncio
async def test_lesestand_der_schon_vorher_drueber_lag_belegt_nichts(
    app, client, session_factory, _auth_signer, friend_pair, sender, schlange
):
    """Regel 2: die IDs stammen aus verschiedenen Uhren. Lag der Lesestand
    schon VOR der Nachricht über ihrer ID, hat niemand sie gelesen."""
    sz = await _szene(client, session_factory, _auth_signer, friend_pair, schlange)
    await _lesestand(client, sz, X + 100)
    await _senden(client, sz)
    await _quittieren(client, sz, X)
    await _lesestand(client, sz, X)  # monoton: bleibt bei X + 100
    await _abarbeiten(app.state.connection_manager)
    assert len(sender) == 1


# MARK: - Bündeln


@pytest.mark.asyncio
async def test_salve_wird_ein_push_und_die_plakette_zaehlt_jede(
    app, client, session_factory, _auth_signer, friend_pair, sender, schlange
):
    sz = await _szene(client, session_factory, _auth_signer, friend_pair, schlange)
    for _ in range(3):
        await _senden(client, sz)
    assert await schlange.zcard(ws.FAELLIG) == 1
    assert await _abarbeiten(app.state.connection_manager) == 1
    assert [b for _t, _p, b in sender] == [3]


@pytest.mark.asyncio
async def test_gelesenes_fehlt_in_der_plakette_ungelesenes_nicht(
    app, client, session_factory, _auth_signer, friend_pair, sender, schlange
):
    sz = await _szene(client, session_factory, _auth_signer, friend_pair, schlange)
    await _senden(client, sz)
    await _quittieren(client, sz, X)
    await _lesestand(client, sz, X)
    await _senden(client, sz)
    await _senden(client, sz)
    await _abarbeiten(app.state.connection_manager)
    assert [b for _t, _p, b in sender] == [2]


# MARK: - Neustart, Absturz, zwei Abarbeiter


@pytest.mark.asyncio
async def test_neustart_sendet_liegengebliebenes_sofort(
    app, client, session_factory, _auth_signer, friend_pair, sender, schlange
):
    sz = await _szene(client, session_factory, _auth_signer, friend_pair, schlange)
    await _senden(client, sz)
    # Wie nach einem Deploy: der Eintrag ist längst überfällig.
    await schlange.zadd(ws.FAELLIG, {f"{sz['uid_b']}:{sz['dm']}": 0})
    aufgabe = asyncio.create_task(ws.abarbeiter_loop(app.state.connection_manager))
    try:
        for _ in range(40):
            if sender:
                break
            await asyncio.sleep(0.05)
    finally:
        aufgabe.cancel()
        await asyncio.gather(aufgabe, return_exceptions=True)
    assert len(sender) == 1
    assert await _leer(schlange)


@pytest.mark.asyncio
async def test_absturz_mitten_in_der_arbeit_verliert_nichts(
    app, client, session_factory, _auth_signer, friend_pair, sender, schlange
):
    sz = await _szene(client, session_factory, _auth_signer, friend_pair, schlange)
    manager = app.state.connection_manager
    await _senden(client, sz)
    [arbeit] = await ws.uebernehmen(schlange, jetzt_ms=SPAETER)
    # ... und hier stirbt der Prozess. Eine Nachricht, die jetzt kommt, wartet
    # in einem EIGENEN Eintrag (nicht in der übernommenen Liste).
    await _senden(client, sz)
    assert await schlange.zcard(ws.FAELLIG) == 1
    # Solange die Pacht läuft, bekommt niemand die alte Arbeit.
    assert arbeit not in await ws.uebernehmen(schlange, jetzt_ms=SPAETER)
    sender.clear()
    nach_pacht = SPAETER + ws.PACHT_S * 1000 + 1
    wieder = await ws.uebernehmen(schlange, jetzt_ms=nach_pacht + ws.PACHT_S * 1000)
    assert arbeit in wieder
    for a in wieder:
        await ws.abarbeiten(manager, a)
    assert len(sender) == 2  # die übernommene Arbeit und die neue Nachricht
    assert await _leer(schlange)


@pytest.mark.asyncio
async def test_herunterfahren_gibt_die_pacht_sofort_zurueck(
    app, client, session_factory, _auth_signer, friend_pair, sender, schlange, monkeypatch
):
    sz = await _szene(client, session_factory, _auth_signer, friend_pair, schlange)
    await _senden(client, sz)
    [arbeit] = await ws.uebernehmen(schlange, jetzt_ms=SPAETER)
    angehalten = asyncio.Event()

    async def _haengt(**_kw):
        angehalten.set()
        await asyncio.sleep(3600)

    monkeypatch.setattr(fcm, "fan_out_fcm_dm_push", _haengt)
    aufgabe = asyncio.create_task(ws._einer(app.state.connection_manager, arbeit))
    await asyncio.wait_for(angehalten.wait(), 2)
    aufgabe.cancel()
    await asyncio.gather(aufgabe, return_exceptions=True)
    assert await schlange.zscore(ws.INARBEIT, arbeit) == 0
    # Der nächste Start nimmt sie ohne Wartezeit (jetzt, nicht SPAETER).
    assert await ws.uebernehmen(schlange) == [arbeit]


@pytest.mark.asyncio
async def test_zwei_abarbeiter_senden_nie_doppelt(
    client, session_factory, _auth_signer, friend_pair, sender, schlange, _isolate_chat_settings
):
    zweiter = Redis.from_url(_isolate_chat_settings.redis_url, decode_responses=False)
    try:
        sz = await _szene(client, session_factory, _auth_signer, friend_pair, schlange)
        await _senden(client, sz)
        a, b = await asyncio.gather(
            ws.uebernehmen(schlange, jetzt_ms=SPAETER), ws.uebernehmen(zweiter, jetzt_ms=SPAETER)
        )
        assert len(a) + len(b) == 1
        await _raeumen(schlange)

        # Und als echte Schleifen nebeneinander.
        await _senden(client, sz)
        await schlange.zadd(ws.FAELLIG, {f"{sz['uid_b']}:{sz['dm']}": 0})
        aufgaben = [
            asyncio.create_task(ws.abarbeiter_loop(_Manager(schlange))),
            asyncio.create_task(ws.abarbeiter_loop(_Manager(zweiter))),
        ]
        await asyncio.sleep(1.2)
        for t in aufgaben:
            t.cancel()
        await asyncio.gather(*aufgaben, return_exceptions=True)
        assert len(sender) == 1
    finally:
        await zweiter.aclose()


# MARK: - Fail-open, Wartezeit 0, Anrufe


@pytest.mark.asyncio
async def test_ohne_redis_geht_der_push_sofort(app, session_factory, sender):
    uid = random.randint(1, 1_000_000)
    async with session_factory() as s:
        s.add(FcmToken(user_id=uid, geraet_id="handy", token=f"tok-{uid}"))
        await s.commit()
    tot = Redis.from_url("redis://127.0.0.1:1/0", decode_responses=False)
    try:
        await ws.vormerken(
            recipient_ids={uid}, author_name="a", channel_id=1, manager=_Manager(tot)
        )
    finally:
        await tot.aclose()
    assert [t for t, _p, _b in sender] == [f"tok-{uid}"]
    sender.clear()
    await ws.vormerken(recipient_ids={uid}, author_name="a", channel_id=1, manager=None)
    assert [t for t, _p, _b in sender] == [f"tok-{uid}"]


@pytest.mark.asyncio
async def test_wartezeit_null_heisst_sofort(
    client, session_factory, _auth_signer, friend_pair, sender, schlange,
    _isolate_chat_settings, monkeypatch,
):
    monkeypatch.setattr(_isolate_chat_settings, "fcm_dm_push_verzoegerung_s", 0.0)
    sz = await _szene(client, session_factory, _auth_signer, friend_pair, schlange)
    await _senden(client, sz)
    assert len(sender) == 1
    assert await _leer(schlange)


@pytest.mark.asyncio
async def test_anruf_pushes_warten_nie(
    client, _auth_signer, friend_pair, apple, schlange  # noqa: F811
):
    heads_a, uid_a = _konto(_auth_signer)
    heads_b, uid_b = _konto(_auth_signer)
    b1 = await _iphone(client, heads_b, uid_b, "b1")
    dm = await _dm(client, friend_pair, heads_a, uid_a, uid_b)
    await _anrufen(client, heads_a, "dm", dm)
    assert await _gesendet(apple) == [(b1, "klingelt")]
    assert await _leer(schlange)


@pytest.mark.asyncio
async def test_klartext_weg_vergleicht_die_snowflake(
    app, client, session_factory, _auth_signer, friend_pair, sender, schlange
):
    sz = await _szene(client, session_factory, _auth_signer, friend_pair, schlange)
    manager = app.state.connection_manager
    # Erst darunter (gesendet), dann bis zur Nachricht (verworfen) — der
    # Lesestand ist monoton, die Reihenfolge ist deshalb nicht beliebig.
    for gelesen_bis, erwartet in ((899, 1), (900, 0)):
        sender.clear()
        await ws.vormerken(
            recipient_ids={sz["uid_b"]}, author_name="a", channel_id=int(sz["dm"]),
            manager=manager, message_id=900,
        )
        await _lesestand(client, sz, gelesen_bis)
        await _abarbeiten(manager)
        assert len(sender) == erwartet


# MARK: - Die reine Regel


def test_regel_gruppe_braucht_alle_zustellungen_eines_geraets():
    """Bei einer Gruppe hängen Verteilschlüssel und Nachricht als zwei
    Zustellungen am selben Gerät — beide müssen belegt sein."""
    teil = {"geraete": {"rechner": [1, 2], "handy": [3, 4]}, "l0": None}
    assert not ist_gelesen(teil, X, {"1": X})
    assert ist_gelesen(teil, X, {"1": X - 5, "2": X})
    assert not ist_gelesen(teil, X - 1, {"1": X - 5, "2": X})
    assert not ist_gelesen({**teil, "l0_fehlt": True}, X, {"1": X, "2": X})
    assert not ist_gelesen(teil, None, {"1": X, "2": X})
    assert not ist_gelesen({"geraete": {}, "l0": None}, X, {})


@pytest.mark.asyncio
async def test_ohne_fcm_schluessel_endet_der_abarbeiter_sofort(schlange):
    """Ohne Schlüssel entsteht nie ein Eintrag — kein Takt gegen Redis."""
    await asyncio.wait_for(ws.abarbeiter_loop(_Manager(schlange)), 1)
