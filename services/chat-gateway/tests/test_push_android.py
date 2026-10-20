"""Push ans Handy, Push-Bughunt 2026-10-20 — der DM-Weg und der Bau der Nachricht.

Android-Fähigkeiten (``POST /fcm/token``), Schlüssel statt deutschem Text für
Android (``texte_lokal``), ein Tag je Unterhaltung, die Deutung der
Firebase-Fehler, ein einziger WARNING bei kaputtem Schlüssel und die
Gruppen-Mitgliedschaft zur Sendezeit.
"""

from __future__ import annotations

import json
import logging
import random

import pytest
from dcc_chat_gateway import fcm, fcm_nachricht, fcm_texte
from dcc_chat_gateway.fcm_empfaenger import ANDROID_FAEHIG_PRAEFIX, android_faehigkeiten_merken
from dcc_chat_gateway.models import FcmToken, PrivateGroupMember
from sqlalchemy import delete, select

from .conftest import make_auth_header
from .test_fcm_warteschlange import _konto_b, sender  # noqa: F401
from .test_haekchen import _gruppe_mit, gruppen_an  # noqa: F401

pytestmark = pytest.mark.usefixtures("cloud_mode")


def _kodiere(msg) -> dict:
    from firebase_admin.messaging import _messaging_encoder

    return json.loads(json.dumps(msg, cls=_messaging_encoder.MessageEncoder))


class _Manager:
    def __init__(self, redis, wach: set[int] = frozenset()):
        self.redis = redis
        self._wach = wach

    def user_socket_count(self, user_id: int) -> int:
        return 1 if user_id in self._wach else 0


# MARK: - Fähigkeiten bei der Anmeldung


@pytest.mark.asyncio
async def test_fcm_anmeldung_merkt_die_bekannten_faehigkeiten_und_loescht_sie_ohne_feld(
    app, client, _auth_signer
):
    token, uid = _konto_b(_auth_signer)
    schluessel = f"{ANDROID_FAEHIG_PRAEFIX}{uid}:pixel"
    r = await client.post(
        "/fcm/token",
        json={
            "token": f"fcm-{uid}",
            "geraet_id": "pixel",
            "faehigkeiten": ["texte_lokal", "unbekannt", "anruf_push"],
        },
        headers=make_auth_header(token),
    )
    assert r.status_code == 204, r.text
    assert await app.state.redis.get(schluessel) == b"anruf_push,texte_lokal"
    # Ein älterer Bau unter derselben Kennung (ohne Feld) nimmt sie zurück.
    r = await client.post(
        "/fcm/token",
        json={"token": f"fcm-{uid}", "geraet_id": "pixel"},
        headers=make_auth_header(token),
    )
    assert r.status_code == 204
    assert await app.state.redis.get(schluessel) is None


@pytest.mark.asyncio
async def test_fcm_anmeldung_begrenzt_die_faehigkeiten(client, _auth_signer):
    token, uid = _konto_b(_auth_signer)
    r = await client.post(
        "/fcm/token",
        json={"token": f"fcm-{uid}", "geraet_id": "g", "faehigkeiten": ["x"] * 9},
        headers=make_auth_header(token),
    )
    assert r.status_code == 422


# MARK: - Wer bekommt was


@pytest.fixture
def mitschrift(monkeypatch, _isolate_chat_settings):
    """(token, lokal) je Sendung, statt Firebase."""
    gesendet: list[tuple[str, object]] = []

    def _fake(*, token, payload, badge=None, lokal=None):
        gesendet.append((token, lokal))
        return "ok"

    monkeypatch.setattr(fcm, "ensure_fcm", lambda: object())
    monkeypatch.setattr(fcm, "_send_one", _fake)
    return gesendet


@pytest.mark.asyncio
async def test_android_mit_texte_lokal_bekommt_schluessel_ohne_bleibt_deutsch(
    app, session_factory, mitschrift
):
    uid = random.randint(1, 10**9)
    async with session_factory() as s:
        s.add(FcmToken(user_id=uid, geraet_id="neu", token=f"tok-neu-{uid}"))
        s.add(FcmToken(user_id=uid, geraet_id="alt", token=f"tok-alt-{uid}"))
        await s.commit()
    await android_faehigkeiten_merken(
        app.state.redis, user_id=uid, geraet_id="neu", faehigkeiten=["texte_lokal"]
    )
    lokal = fcm_texte.lokal_aus(["Anna"], 1, False)
    versand = await fcm.dm_push_senden(
        recipient_ids={uid}, author_name="Anna", channel_id=7,
        manager=_Manager(app.state.redis, wach={uid}), lokal=lokal,
    )
    assert versand.gesendet == 2
    assert dict(mitschrift) == {f"tok-neu-{uid}": lokal, f"tok-alt-{uid}": None}


@pytest.mark.asyncio
async def test_gruppen_push_geht_nur_an_wer_jetzt_noch_mitglied_ist(
    client, session_factory, _auth_signer, friend_pair, mitschrift, gruppen_an  # noqa: F811
):
    """Wer in der Wartezeit austritt (oder dessen Gruppe aufgelöst wird),
    bekommt den vorgemerkten Push nicht mehr."""
    t_a, uid_a = _konto_b(_auth_signer)
    _t_b, uid_b = _konto_b(_auth_signer)
    await friend_pair(uid_a, uid_b)
    gruppe = int(await _gruppe_mit(client, t_a, uid_b))
    async with session_factory() as s:
        s.add(FcmToken(user_id=uid_b, geraet_id="handy", token=f"tok-{uid_b}"))
        await s.commit()

    weiter = {"author_name": "a", "channel_id": gruppe, "art": "gruppe"}
    assert (await fcm.dm_push_senden(recipient_ids={uid_b}, **weiter)).gesendet == 1
    async with session_factory() as s:
        await s.execute(
            delete(PrivateGroupMember).where(
                PrivateGroupMember.gruppe_id == gruppe, PrivateGroupMember.user_id == uid_b
            )
        )
        await s.commit()
    mitschrift.clear()
    versand = await fcm.dm_push_senden(recipient_ids={uid_b}, **weiter)
    assert versand.gesendet == 0 and not versand.stoerung
    assert mitschrift == []


# MARK: - Der Bau der Nachricht


def test_android_meldung_traegt_den_kanal_als_tag():
    """Eine neue Meldung derselben Unterhaltung ersetzt die alte, und die App
    kann sie über den Tag gezielt entfernen."""
    payload = {"type": "dm", "title": "Anna", "body": "Neue Nachricht", "channel_id": "42"}
    d = _kodiere(fcm._build_dm_message(token="t", payload=payload))
    assert d["android"]["notification"]["tag"] == "42"
    assert d["android"]["notification"]["channel_id"] == "messages"


def test_android_mit_lokal_bekommt_ressourcennamen_und_keine_notification():
    payload = {"type": "dm", "title": "x", "body": "x", "channel_id": "7"}
    lokal = fcm_texte.lokal_aus(["A", "B", "C", "D"], 4, False)
    d = _kodiere(fcm._build_dm_message(token="t", payload=payload, lokal=lokal))
    android = d["android"]["notification"]
    assert android["body_loc_key"] == "push_anzahl"
    assert android["body_loc_args"] == ["4"]
    assert android["title_loc_key"] == "push_weitere"
    assert android["title_loc_args"] == ["A", "B", "2"]
    assert "notification" not in d
    # Ein Absender: fester Titel, kein Titel-Schlüssel.
    lokal = fcm_texte.lokal_aus(["Anna"], 1, True)
    android = _kodiere(fcm._build_dm_message(token="t", payload=payload, lokal=lokal))[
        "android"
    ]["notification"]
    assert android["title"] == "Anna" and android["body_loc_key"] == "push_anhang"
    assert "title_loc_key" not in android


# MARK: - Firebase-Fehler


@pytest.mark.parametrize(
    ("fehler", "ausgang"),
    [
        ("unregistered", "dead"),
        ("invalid", "ungueltig"),
        ("sender", "warn"),
        ("anderes", "warn"),
    ],
)
def test_nur_ein_abgemeldeter_token_gilt_als_tot(monkeypatch, fehler, ausgang):
    """``InvalidArgumentError`` kann ebenso ein Feld der Nachricht meinen — ein
    Löschen kostete bei einem Baufehler JEDEN Token. Bis zum 2026-10-20 stand
    dort ``messaging.InvalidArgumentError``, das es nicht gibt: jede andere
    Ausnahme als ``UnregisteredError`` wurde zum ``AttributeError``."""
    from firebase_admin import exceptions, messaging

    ausnahmen = {
        "unregistered": messaging.UnregisteredError("weg"),
        "invalid": exceptions.InvalidArgumentError("kaputt"),
        "sender": messaging.SenderIdMismatchError("anderes Projekt"),
        "anderes": TimeoutError(),
    }

    def _wirft(_nachricht):
        raise ausnahmen[fehler]

    monkeypatch.setattr(messaging, "send", _wirft)
    payload = {"type": "dm", "title": "a", "body": "b", "channel_id": "1"}
    assert fcm._send_one(token="t", payload=payload) == ausgang


@pytest.mark.asyncio
async def test_abgelehnte_anfrage_loescht_keinen_token_und_wird_nicht_wiederholt(
    app, session_factory, monkeypatch, _isolate_chat_settings
):
    uid = random.randint(1, 10**9)
    async with session_factory() as s:
        s.add(FcmToken(user_id=uid, geraet_id="g", token=f"tok-{uid}"))
        await s.commit()
    monkeypatch.setattr(fcm, "ensure_fcm", lambda: object())
    monkeypatch.setattr(fcm, "_send_one", lambda **_k: "ungueltig")
    versand = await fcm.dm_push_senden(recipient_ids={uid}, author_name="a", channel_id=1)
    assert versand.gesendet == 0 and not versand.stoerung
    async with session_factory() as s:
        zeile = (await s.execute(select(FcmToken).where(FcmToken.user_id == uid))).scalar()
    assert zeile is not None


# MARK: - Kaputter Schlüssel


def test_kaputter_schluessel_warnt_nur_einmal(tmp_path, monkeypatch, _isolate_chat_settings, caplog):
    datei = tmp_path / "kaputt.json"
    datei.write_text("{kein json")
    monkeypatch.setattr(_isolate_chat_settings, "firebase_service_account_key", str(datei))
    # ``fcm`` bindet ``get_settings`` beim Import — die Test-Einstellungen
    # erreichen es nur so.
    monkeypatch.setattr(fcm, "get_settings", lambda: _isolate_chat_settings)
    fcm.reset_fcm_cache_for_tests()
    caplog.set_level(logging.DEBUG, logger="dcc_chat_gateway.fcm")
    try:
        for _ in range(3):
            assert fcm.ensure_fcm() is None
    finally:
        fcm.reset_fcm_cache_for_tests()
    zeilen = [r for r in caplog.records if r.name == "dcc_chat_gateway.fcm"]
    assert len(zeilen) == 1
    assert zeilen[0].levelno == logging.WARNING
    assert zeilen[0].exc_info is None


def test_daten_nachricht_ist_ohne_notification_und_dringend():
    d = _kodiere(fcm_nachricht.daten_nachricht(token="t", daten={"type": "anruf"}, ttl_s=45))
    assert "notification" not in d and "notification" not in d["android"]
    assert d["android"]["priority"] == "high"
    assert d["android"]["ttl"] == "45s"
    assert d["data"] == {"type": "anruf"}
