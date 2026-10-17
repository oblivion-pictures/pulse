"""Mitteilungstexte als Schlüssel für iOS (``fcm_texte.py``) und der DM-Schalter
als Einstellung (``fcm_stumm.py``).

Die Schlüssel sind der deutsche Text (Rückfall für Bauten ohne Übersetzung):
ein Test setzt sie wieder ein und vergleicht mit dem, was Android als fertigen
Text bekommt — beide Wege müssen dasselbe sagen.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from dcc_chat_gateway import fcm, fcm_texte
from dcc_chat_gateway.fcm import _build_dm_message
from dcc_chat_gateway.fcm_abarbeiten import _autoren, buendel_mitteilung
from dcc_chat_gateway.fcm_stumm import PUSH_ABSCHNITT

from .conftest import make_auth_header


def _einsetzen(schluessel: str, args: tuple[str, ...]) -> str:
    """Wie iOS: ``%@``/``%1$@`` mit den Argumenten füllen."""
    laufend = iter(args)
    return re.sub(
        r"%(\d+)\$@|%@",
        lambda m: args[int(m.group(1)) - 1] if m.group(1) else next(laufend),
        schluessel,
    )


def _titel(lokal: fcm_texte.Lokal) -> str:
    if lokal.titel is not None:
        return lokal.titel
    assert lokal.titel_schluessel is not None
    return _einsetzen(lokal.titel_schluessel, lokal.titel_args)


def _t(autor: str, anhang: bool = False) -> dict:
    return {"autor": autor, "anhang": anhang}


@pytest.mark.parametrize(
    "offen",
    [
        [_t("Bob")],
        [_t("Bob", True)],
        [_t("Alice"), _t("Alice"), _t("Alice")],
        [_t("Bob", True), _t("Alice")],
        [_t("A"), _t("B"), _t("C")],
        [_t("A"), _t("B"), _t("C"), _t("D"), _t("E")],
        [{}, {}],
    ],
)
def test_schluessel_ergeben_denselben_text_wie_der_fertige(offen):
    titel, text, hat_anhang = buendel_mitteilung(offen)
    lokal = fcm_texte.lokal_aus(_autoren(offen), len(offen), hat_anhang)
    assert _titel(lokal) == titel
    assert _einsetzen(lokal.schluessel, lokal.args) == (text or fcm.dm_body(hat_anhang))


def test_einzeltexte_sind_wortgleich_mit_den_android_texten():
    assert fcm_texte.SCHLUESSEL_NEU == fcm.DM_BODY
    assert fcm_texte.SCHLUESSEL_ANHANG == fcm.DM_BODY_ANHANG


def test_jeder_schluessel_steht_in_der_app_uebersetzt():
    """Ein Schlüssel ohne Eintrag zeigt iOS als Rohtext. Server und App tragen
    dieselbe Liste — ohne diesen Test laufen sie ohne Fehler auseinander."""
    katalog = Path(__file__).parents[3] / "mobile/ios/App/App/Localizable.xcstrings"
    texte = json.loads(katalog.read_text(encoding="utf-8"))["strings"]
    schluessel = [
        v for k, v in vars(fcm_texte).items() if k.startswith("SCHLUESSEL_") and isinstance(v, str)
    ]
    assert len(schluessel) == 6
    for s in schluessel:
        assert set(texte[s]["localizations"]) >= {"de", "en"}, s


def _kodiere(msg):
    from firebase_admin.messaging import _messaging_encoder

    return json.loads(json.dumps(msg, cls=_messaging_encoder.MessageEncoder))


def test_ios_nachricht_traegt_loc_key_ohne_body_und_ohne_notification():
    payload = {"type": "dm", "title": "A, B und 3 weitere", "body": "x", "channel_id": "7"}
    lokal = fcm_texte.lokal_aus(["A", "B", "C", "D", "E"], 5, False)
    d = _kodiere(_build_dm_message(token="t", payload=payload, badge=5, lokal=lokal))
    alert = d["apns"]["payload"]["aps"]["alert"]
    assert alert["loc-key"] == "%@ neue Nachrichten"
    assert alert["loc-args"] == ["5"]
    assert alert["title-loc-key"] == "%1$@, %2$@ und %3$@ weitere"
    assert alert["title-loc-args"] == ["A", "B", "3"]
    assert "body" not in alert and "title" not in alert
    # FCM mischte sonst Titel und Text des Android-Blocks in denselben alert.
    assert "notification" not in d
    # Alles andere der iOS-Nutzlast bleibt.
    aps = d["apns"]["payload"]["aps"]
    assert aps["badge"] == 5 and aps["category"] == "dm" and aps["thread-id"] == "7"
    assert d["data"]["channel_id"] == "7"


def test_ein_absender_bleibt_ein_fester_titel():
    payload = {"type": "dm", "title": "Anna", "body": "x", "channel_id": "7"}
    lokal = fcm_texte.lokal_aus(["Anna"], 1, True)
    alert = _kodiere(_build_dm_message(token="t", payload=payload, lokal=lokal))["apns"][
        "payload"
    ]["aps"]["alert"]
    assert alert == {"title": "Anna", "loc-key": "Hat dir einen Anhang geschickt"}


def test_android_und_geraete_ohne_zusage_bleiben_beim_fertigen_text():
    payload = {"type": "dm", "title": "Anna", "body": "Neue Nachricht", "channel_id": "7"}
    d = _kodiere(_build_dm_message(token="t", payload=payload))
    assert d["notification"] == {"title": "Anna", "body": "Neue Nachricht"}
    assert d["apns"]["payload"]["aps"]["alert"] == {"title": "Anna", "body": "Neue Nachricht"}


async def test_die_vorlieben_route_nimmt_den_dm_schalter_an(client, _auth_signer):
    """Der Klient spiegelt den Schalter über die vorhandene Einstellungs-Route —
    der Abschnittsname muss deren Muster (nur Kleinbuchstaben) erfüllen."""
    token = _auth_signer.issue_access(4711, "u4711")
    r = await client.put(
        f"/preferences/{PUSH_ABSCHNITT}",
        json={"value": {"dm": False}},
        headers=make_auth_header(token),
    )
    assert r.status_code == 200, r.text
    r = await client.get("/preferences", headers=make_auth_header(token))
    assert r.json()[PUSH_ABSCHNITT]["value"] == {"dm": False}
