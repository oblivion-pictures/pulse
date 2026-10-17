"""Handy-Push-Konfiguration muss in der Cloud SICHTBAR fehlen (warning).

Anlass: ``FIREBASE_SERVICE_ACCOUNT_KEY`` fehlte monatelang in der Cloud, kein
Handy bekam einen Push, und nichts im Log verriet es — die einzige Meldung
stand auf ``info``, die Cloud loggt erst ab ``warning``. ``caplog`` sieht auch
``info``-Zeilen, die im Betrieb verschwinden; deshalb prüfen diese Tests die
Stufe ausdrücklich (``levelname == "WARNING"``), nicht nur den Text.
"""

from __future__ import annotations

import logging

import pytest

from dcc_chat_gateway.config import get_settings
from dcc_chat_gateway.models import FcmToken
from dcc_chat_gateway.push_konfig_pruefung import pruefe_push_konfiguration

_LOGGER = "dcc_chat_gateway.push_konfig_pruefung"


def _einstellungen(**aenderungen):
    return get_settings().model_copy(
        update={
            "pulse_instance_mode": "cloud",
            "firebase_service_account_key": None,
            "apns_key_file": None,
            "apns_key_id": None,
            "apns_team_id": None,
            "apns_bundle_id": None,
            **aenderungen,
        }
    )


def _warnungen(caplog) -> list[logging.LogRecord]:
    return [r for r in caplog.records if r.name == _LOGGER]


def test_cloud_ohne_firebase_schluessel_warnt(caplog):
    with caplog.at_level(logging.DEBUG, logger=_LOGGER):
        pruefe_push_konfiguration(_einstellungen())
    treffer = [r for r in _warnungen(caplog) if "fcm_nicht_konfiguriert" in r.getMessage()]
    assert len(treffer) == 1
    # Die Stufe ist der Punkt: info wäre in der Cloud unsichtbar.
    assert treffer[0].levelname == "WARNING"
    assert "FIREBASE_SERVICE_ACCOUNT_KEY" in treffer[0].getMessage()


def test_cloud_mit_unlesbarer_firebase_datei_warnt(caplog, tmp_path):
    fehlt = tmp_path / "gibt-es-nicht.json"
    with caplog.at_level(logging.DEBUG, logger=_LOGGER):
        pruefe_push_konfiguration(_einstellungen(firebase_service_account_key=str(fehlt)))
    treffer = [r for r in _warnungen(caplog) if "fcm_nicht_konfiguriert" in r.getMessage()]
    assert len(treffer) == 1
    assert treffer[0].levelname == "WARNING"


def test_cloud_mit_lesbarer_firebase_datei_ist_still(caplog, tmp_path):
    datei = tmp_path / "firebase.json"
    datei.write_text("{}")
    with caplog.at_level(logging.DEBUG, logger=_LOGGER):
        pruefe_push_konfiguration(_einstellungen(firebase_service_account_key=str(datei)))
    assert not [r for r in _warnungen(caplog) if "fcm_nicht_konfiguriert" in r.getMessage()]


def test_apns_unvollstaendig_nennt_nur_namen_der_fehlenden(caplog):
    with caplog.at_level(logging.DEBUG, logger=_LOGGER):
        pruefe_push_konfiguration(
            _einstellungen(apns_key_id="GEHEIM-KEY-ID", apns_bundle_id="com.example.app")
        )
    treffer = [r for r in _warnungen(caplog) if "apns_voip_nicht_konfiguriert" in r.getMessage()]
    assert len(treffer) == 1
    assert treffer[0].levelname == "WARNING"
    text = treffer[0].getMessage()
    assert "APNS_KEY_FILE" in text
    assert "APNS_TEAM_ID" in text
    # Gesetzte Werte erscheinen weder als Name noch als Wert.
    assert "APNS_KEY_ID" not in text
    assert "APNS_BUNDLE_ID" not in text
    assert "GEHEIM-KEY-ID" not in text


def test_apns_vollstaendig_aber_datei_fehlt_warnt(caplog, tmp_path):
    with caplog.at_level(logging.DEBUG, logger=_LOGGER):
        pruefe_push_konfiguration(
            _einstellungen(
                apns_key_file=str(tmp_path / "AuthKey.p8"),
                apns_key_id="K",
                apns_team_id="T",
                apns_bundle_id="B",
            )
        )
    treffer = [r for r in _warnungen(caplog) if "apns_voip_nicht_konfiguriert" in r.getMessage()]
    assert len(treffer) == 1
    assert treffer[0].levelname == "WARNING"


def test_apns_vollstaendig_ist_still(caplog, tmp_path):
    p8 = tmp_path / "AuthKey.p8"
    p8.write_text("x")
    with caplog.at_level(logging.DEBUG, logger=_LOGGER):
        pruefe_push_konfiguration(
            _einstellungen(apns_key_file=str(p8), apns_key_id="K", apns_team_id="T", apns_bundle_id="B")
        )
    assert not [r for r in _warnungen(caplog) if "apns_voip_nicht_konfiguriert" in r.getMessage()]


def test_self_host_bleibt_still(caplog):
    with caplog.at_level(logging.DEBUG, logger=_LOGGER):
        pruefe_push_konfiguration(_einstellungen(pulse_instance_mode="self-host"))
    assert not _warnungen(caplog)


def test_startpfad_ruft_die_pruefung():
    """Die Prüfung nützt nichts, wenn der Start sie nicht ruft."""
    import inspect

    import dcc_chat_gateway.app as app_mod

    assert "pruefe_push_konfiguration(settings)" in inspect.getsource(app_mod.lifespan)


async def test_tote_tokens_werden_als_warning_gemeldet(
    client, session_factory, monkeypatch, caplog
):
    import dcc_chat_gateway.fcm as fcm_mod

    async with session_factory() as s:
        s.add(FcmToken(user_id=777, geraet_id="g1", token="tok-sehr-geheim"))
        await s.commit()
    monkeypatch.setattr(fcm_mod, "ensure_fcm", lambda: object())
    monkeypatch.setattr(fcm_mod, "_send_one", lambda *, token, payload, badge=None: "dead")
    with caplog.at_level(logging.DEBUG, logger=fcm_mod.log.name):
        await fcm_mod.fan_out_fcm_dm_push(recipient_ids={777}, author_name="Anna", channel_id=42)
    treffer = [r for r in caplog.records if "fcm_token_tot" in r.getMessage()]
    assert len(treffer) == 1
    assert treffer[0].levelname == "WARNING"
    assert "1 Token" in treffer[0].getMessage()
    assert "tok-sehr-geheim" not in caplog.text
